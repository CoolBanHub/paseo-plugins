import { homedir } from "node:os";
import { join } from "node:path";
import {
  DSH_DEFAULT_PERMISSION,
  isDshProvider,
  type ChatBinding,
} from "../shared/settings.ts";
import { sanitizeTopicText } from "./format.ts";
import { generateTopicTitle } from "./title.ts";

/** Expand a leading `~`; empty cwd still means the user's home directory. */
function resolveCwd(cwd: string): string {
  const trimmed = cwd.trim();
  if (!trimmed) return homedir();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

/** dsh permission preset ids are the only values accepted for that provider. */
function dshPermissionPreset(permission: string): string {
  return permission.trim() || DSH_DEFAULT_PERMISSION;
}

/**
 * Build the agents.create() config from a binding. dsh sessions created by the
 * bot default to the deepest reasoning effort and full tool access (so group
 * turns do not stop on an approval prompt); both are now overridable per chat.
 * Other providers keep their own defaults unless the binding selects a mode,
 * model, or thinking depth.
 */
function providerCreateConfig(provider: string, binding: ChatBinding): {
  provider: string;
  systemPrompt?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
} {
  const config: {
    provider: string;
    systemPrompt?: string;
    modeId?: string;
    thinkingOptionId?: string;
    featureValues?: Record<string, unknown>;
  } = { provider, ...(binding.systemPrompt ? { systemPrompt: binding.systemPrompt } : {}) };

  if (isDshProvider(provider)) {
    config.thinkingOptionId = binding.thinkingOptionId.trim() || "max";
    config.featureValues = {
      paseo_dsh_permission_preset: dshPermissionPreset(binding.permission),
    };
    return config;
  }

  if (binding.permission.trim()) {
    config.modeId = binding.permission.trim();
  }
  if (binding.thinkingOptionId.trim()) {
    config.thinkingOptionId = binding.thinkingOptionId.trim();
  }
  return config;
}

/** Minimal structural slice of PaseoApi so tests can inject fakes. */
export interface SessionImage {
  data: string;
  mimeType: string;
}

export interface SessionAgentHandle {
  readonly id: string;
  send(text: string): Promise<void>;
  run(text: string, options?: { timeoutMs?: number; images?: SessionImage[] }): Promise<SessionRunResult>;
}

export interface SessionRunResult {
  status: "idle" | "error" | "permission" | "timeout";
  error: string | null;
  lastMessage: string | null;
}

/** Minimal timeline slice for fallback reply lookups. */
export interface SessionTimelineHandle {
  refetch(options?: { limit?: number }): Promise<{
    entries?: { item?: { type?: string; text?: string } }[];
  }>;
}

export interface SessionPaseoApi {
  agents: {
    create(options: {
      config: {
        provider: string;
        systemPrompt?: string;
        modeId?: string;
        thinkingOptionId?: string;
        featureValues?: Record<string, unknown>;
      };
      cwd: string;
      title?: string;
      labels?: Record<string, string>;
      prompt?: string;
      images?: SessionImage[];
      /** One-shot sessions (topic naming) archive themselves when done. */
      autoArchive?: boolean;
      /** Keep helper sessions out of the interactive workspace focus. */
      background?: boolean;
    }): Promise<SessionAgentHandle>;
    ref(id: string): SessionAgentHandle & { timeline?: SessionTimelineHandle };
  };
  /** Optional slice used to normalize bare provider ids to provider/model. */
  providers?: {
    waitForReady(options?: { timeoutMs?: number }): Promise<SessionProviderSnapshot>;
  };
}

export interface SessionProviderSnapshot {
  entries: {
    provider: string;
    label?: string;
    enabled?: boolean;
    defaultModeId?: string | null;
    modes?: { id: string; label: string; description?: string }[];
    models?: {
      id: string;
      label?: string;
      isDefault?: boolean;
      isSelectable?: boolean;
      thinkingOptions?: { id: string; label: string }[];
      defaultThinkingOptionId?: string;
    }[];
  }[];
}

export interface ChatSessionStatus {
  chatId: string;
  /** Thread root message id (om_…) the session serves. */
  topicKey: string;
  agentId: string | null;
  busy: boolean;
  queued: number;
}

/** One turn of the source message's timeline, as delivered by turn_ended. */
export interface TurnOutcome {
  outcome: "completed" | "failed" | "canceled" | null;
  lastText: string | null;
  lastError: string | null;
}

interface QueueItem {
  messageId: string;
  prompt: string;
  /** Sanitized thread-root text; seeds the AI/fallback session title. */
  topicRootText?: string;
  binding: ChatBinding;
  images?: SessionImage[];
}

interface TopicState {
  chatId: string;
  agentId: string | null;
  handle: SessionAgentHandle | null;
  /** FIFO of trigger message ids awaiting a thread reply. */
  pendingTargets: string[];
  queue: QueueItem[];
  busy: boolean;
  /** When the current turn started; drives the stuck-busy bailout. */
  busySince: number | null;
  lastActivityAt: number;
  lastSeenMessageId: string | null;
  /** run()'s lastMessage for the most recent idle turn, a reply fallback. */
  lastRunText: string | null;
  /** Monotonic token of the turn currently owning the topic. */
  activeTurn: number | null;
  turnCounter: number;
  /** Fires if run() returns idle but turn_ended never arrives. */
  turnFallback: ReturnType<typeof setTimeout> | null;
}

const RUN_TIMEOUT_MS = 10 * 60_000;
/** If a turn never ends (stuck provider), give up waiting and rebuild. */
const STUCK_BUSY_MS = 30 * 60_000;
/** Give turn_ended a short window after run() resolves before synthesizing it. */
const DEFAULT_TURN_FALLBACK_MS = 5_000;
/** Hard cap for queued messages per topic; prevents unbounded group spam. */
const MAX_QUEUE_PER_TOPIC = 20;
/** Bound topic state for long-running daemons. */
const MAX_TOPICS = 500;
/** Clip for the fallback (non-AI) session title snippet. */
const TITLE_FALLBACK_SNIPPET = 40;

export interface SessionCallbacks {
  /** Send the agent's answer back under the trigger message. */
  onReply(chatId: string, messageId: string, outcome: TurnOutcome): void;
  /** Informational notice (errors, stuck sessions, unmatched chats). */
  onNotice(chatId: string | null, messageId: string, text: string): void;
  log?(message: string): void;
}

/**
 * Per-topic agent lifecycle and serial queue. Every Feishu thread (keyed by
 * its root message id) owns an independent agent session, so separate topics
 * in one chat run in parallel without sharing context; messages inside a
 * topic are applied one turn at a time. Replies are emitted from turn_ended —
 * the single authoritative "turn finished" signal — while run() only drives
 * queue progression.
 */
export function createSessionRegistry(options: {
  paseo: SessionPaseoApi;
  callbacks: SessionCallbacks;
  getIdleMs: () => number;
  /**
   * Newer daemons reject bare provider ids: normalize `dsh` to
   * `dsh/<default-model>` before agents.create(). An explicit model from the
   * binding takes precedence. Returning the input unchanged lets older hosts
   * keep working.
   */
  resolveProvider?: (provider: string, model: string) => Promise<string>;
  /**
   * Fallback when turn_ended carries no assistant text: refetch the agent
   * timeline and pull the latest reply from there.
   */
  fetchLastReply?: (agentId: string) => Promise<string | null>;
  now?: () => number;
  /** Grace period for a missing turn_ended after run() resolves idle. */
  turnFallbackMs?: number;
  /**
   * Whether new topic sessions get an AI-generated title (default true). On
   * failure or timeout the sanitized topic text is used instead.
   */
  getAiTitle?: () => boolean;
}) {
  const resolveProvider =
    options.resolveProvider ??
    (async (provider: string, model: string) => {
      const chosen = model.trim();
      return chosen && !provider.includes("/") ? provider + "/" + chosen : provider;
    });
  const fetchLastReply = options.fetchLastReply ?? (async () => null);
  const now = options.now ?? Date.now;
  const turnFallbackMs = options.turnFallbackMs ?? DEFAULT_TURN_FALLBACK_MS;
  const getAiTitle = options.getAiTitle ?? (() => true);
  const topics = new Map<string, TopicState>();
  const agentToTopic = new Map<string, string>();
  /** turn_ended can arrive before agents.create() resolves and maps the id. */
  const deferredTurnEnds = new Map<string, TurnOutcome>();

  function stateFor(topicKey: string, chatId: string): TopicState {
    let state = topics.get(topicKey);
    if (!state) {
      if (topics.size >= MAX_TOPICS) {
        for (const [key, candidate] of topics) {
          if (!candidate.busy && candidate.queue.length === 0) {
            if (candidate.agentId) agentToTopic.delete(candidate.agentId);
            topics.delete(key);
            break;
          }
        }
      }
      state = {
        chatId,
        agentId: null,
        handle: null,
        pendingTargets: [],
        queue: [],
        busy: false,
        busySince: null,
        lastActivityAt: 0,
        lastSeenMessageId: null,
        lastRunText: null,
        activeTurn: null,
        turnCounter: 0,
        turnFallback: null,
      };
      topics.set(topicKey, state);
    }
    return state;
  }

  /** Register the newest message seen for a topic (fallback reply target). */
  function noteMessage(topicKey: string, chatId: string, messageId: string): void {
    const state = stateFor(topicKey, chatId);
    state.lastSeenMessageId = messageId;
  }

  /** Queue a prompt for a topic; the queue drains one turn at a time. */
  function enqueue(
    topicKey: string,
    chatId: string,
    messageId: string,
    prompt: string,
    binding: ChatBinding,
    images?: SessionImage[],
    topicRootText?: string | null,
  ): boolean {
    const state = stateFor(topicKey, chatId);
    // lastActivityAt stays at the previous turn's end here so ensureAgent can
    // measure the real idle window; drain() refreshes it once a turn starts.
    state.lastSeenMessageId = messageId;
    if (state.queue.length >= MAX_QUEUE_PER_TOPIC) {
      options.callbacks.onNotice(state.chatId, messageId, "当前话题排队消息过多，请稍后再试。");
      return false;
    }
    if (state.busy && state.busySince !== null && now() - state.busySince > STUCK_BUSY_MS) {
      // The previous turn looks stuck; drop the session and start over.
      const stuckTarget = state.pendingTargets[0] ?? state.lastSeenMessageId;
      options.callbacks.log?.(`topic ${topicKey} busy for too long; rebuilding session`);
      if (stuckTarget) {
        options.callbacks.onNotice(state.chatId, stuckTarget, "上一轮处理超时，已重建会话；你的消息会继续排队处理。");
      }
      resetTopic(topicKey);
    }
    state.queue.push({
      messageId,
      prompt,
      topicRootText: topicRootText ?? undefined,
      binding,
      images,
    });
    drain(topicKey);
    return true;
  }

  function setBusy(state: TopicState, busy: boolean): void {
    state.busy = busy;
    state.busySince = busy ? now() : null;
    if (!busy) {
      state.activeTurn = null;
      if (state.turnFallback) {
        clearTimeout(state.turnFallback);
        state.turnFallback = null;
      }
    }
  }

  function resetTopic(topicKey: string): void {
    const state = topics.get(topicKey);
    if (!state) return;
    if (state.agentId) agentToTopic.delete(state.agentId);
    state.agentId = null;
    state.handle = null;
    // The old turn is abandoned: its pending targets must not be consumed by
    // the next turn. Keep the queue itself so newly arrived messages survive.
    state.pendingTargets = [];
    state.lastRunText = null;
    setBusy(state, false);
  }

  async function drain(topicKey: string): Promise<void> {
    const state = stateFor(topicKey, "");
    if (state.busy) return;
    const item = state.queue.shift();
    if (!item) return;

    // Only turn_ended (or the fallback timer) may finish this turn. The run()
    // promise resolving idle is not authoritative: turn_ended can arrive
    // before or after it, and releasing on both would drain the queue twice.
    const turn = ++state.turnCounter;
    setBusy(state, true);
    state.activeTurn = turn;
    try {
      // ensureAgent() passes the prompt to agents.create() for fresh sessions,
      // which already starts the first turn — running it again would duplicate
      // the message. lastActivityAt refreshes only after the idle check so the
      // window measures the real gap since the previous turn.
      const { handle, created } = await ensureAgent(topicKey, item);
      if (state.activeTurn !== turn) return;
      state.lastActivityAt = now();
      agentToTopic.set(handle.id, topicKey);
      state.pendingTargets.push(item.messageId);
      if (created) {
        // The first turn is driven by create(); wait for turn_ended. If the
        // completion raced ahead of the mapping, replay it now.
        const deferred = deferredTurnEnds.get(handle.id);
        if (deferred) {
          deferredTurnEnds.delete(handle.id);
          void handleTurnEnded(handle.id, deferred);
        }
        return;
      }
      const result = await handle.run(item.prompt, { timeoutMs: RUN_TIMEOUT_MS, images: item.images });
      if (state.activeTurn !== turn) return;
      if (result.status === "error") {
        // The turn failed before any turn_ended reply can be expected.
        const target = state.pendingTargets.shift() ?? state.lastSeenMessageId;
        if (target) {
          options.callbacks.onReply(state.chatId, target, {
            outcome: "failed",
            lastText: null,
            lastError: result.error ?? "智能体执行出错",
          });
        }
        // A failed turn leaves the session in an unknown state; rebuild.
        resetTopic(topicKey);
        drain(topicKey);
        return;
      }
      if (result.status === "timeout") {
        // Still running; turn_ended will reply and release the queue.
        const target = state.lastSeenMessageId;
        if (target) {
          options.callbacks.onNotice(
            state.chatId,
            target,
            "仍在处理中（已超过 10 分钟）。本轮完成后结果会回到本话题。",
          );
        }
        return;
      }
      if (result.status === "permission") {
        // Waiting on the user in the Paseo client; turn_ended replies later.
        return;
      }
      // idle: wait briefly for turn_ended. If it never arrives, synthesize the
      // completion from run()'s lastMessage so the queue is not stuck forever.
      state.lastRunText = result.lastMessage?.trim() || null;
      scheduleTurnFallback(topicKey, turn);
    } catch (error) {
      if (state.activeTurn !== turn) return;
      const message = error instanceof Error ? error.message : String(error);
      options.callbacks.log?.(`topic ${topicKey} turn failed: ${message}`);
      const target = state.pendingTargets.shift() ?? state.lastSeenMessageId;
      if (target) {
        options.callbacks.onReply(state.chatId, target, { outcome: "failed", lastText: null, lastError: message });
      }
      resetTopic(topicKey);
      drain(topicKey);
    }
  }

  function scheduleTurnFallback(topicKey: string, turn: number): void {
    const state = topics.get(topicKey);
    if (!state) return;
    if (state.turnFallback) clearTimeout(state.turnFallback);
    const timer = setTimeout(() => {
      state.turnFallback = null;
      if (state.activeTurn !== turn || !state.busy || !state.agentId) return;
      options.callbacks.log?.(`topic ${topicKey} turn_ended missing; using run() result`);
      void handleTurnEnded(state.agentId, {
        outcome: "completed",
        lastText: state.lastRunText,
        lastError: null,
      });
    }, turnFallbackMs);
    timer.unref?.();
    state.turnFallback = timer;
  }

  /**
   * Fallback snippet when AI titling is off or the naming turn fails: the
   * sanitized thread-root text, else the current instruction extracted from
   * the assembled prompt.
   */
  function fallbackTitleText(item: QueueItem): string {
    if (item.topicRootText) return sanitizeTopicText(item.topicRootText, TITLE_FALLBACK_SNIPPET);
    const marker = item.prompt.indexOf("【本次消息】");
    const instruction = marker >= 0 ? item.prompt.slice(marker + "【本次消息】".length) : item.prompt;
    return sanitizeTopicText(instruction, TITLE_FALLBACK_SNIPPET);
  }

  /** Prefer an AI one-line title; anything less becomes the sanitized text. */
  async function resolveTitle(
    topicKey: string,
    item: QueueItem,
    provider: string,
  ): Promise<string> {
    const state = stateFor(topicKey, "");
    const prefix = `飞书 · ${item.binding.chatName || state.chatId} · `;
    if (getAiTitle()) {
      const generated = await generateTopicTitle({
        paseo: options.paseo,
        provider,
        cwd: resolveCwd(item.binding.cwd),
        chatId: state.chatId,
        topicKey,
        topicRootText: item.topicRootText ?? null,
        instruction: item.prompt,
      });
      if (generated) return prefix + generated;
    }
    return prefix + (fallbackTitleText(item) || "新话题");
  }

  async function ensureAgent(
    topicKey: string,
    item: QueueItem,
  ): Promise<{ handle: SessionAgentHandle; created: boolean }> {
    const state = stateFor(topicKey, "");
    const idleMs = options.getIdleMs();
    const expired = idleMs > 0 && now() - state.lastActivityAt > idleMs;
    if (state.handle && !expired) return { handle: state.handle, created: false };

    if (state.agentId) agentToTopic.delete(state.agentId);
    const provider = await resolveProvider(item.binding.provider, item.binding.model);
    const handle = await options.paseo.agents.create({
      config: providerCreateConfig(provider, item.binding),
      cwd: resolveCwd(item.binding.cwd),
      title: await resolveTitle(topicKey, item, provider),
      labels: { "lark-bot-chat": state.chatId, "lark-bot-topic": topicKey },
      prompt: item.prompt,
      images: item.images,
    });
    state.agentId = handle.id;
    state.handle = handle;
    return { handle, created: true };
  }

  /**
   * turn_ended is the authoritative reply signal: it also covers turns that
   * finished after a permission was resolved or after run() timed out.
   */
  async function handleTurnEnded(agentId: string, outcome: TurnOutcome): Promise<void> {
    const topicKey = agentToTopic.get(agentId);
    if (!topicKey) {
      // create() is still in flight; replay this completion when the id maps.
      if (deferredTurnEnds.size >= 50) {
        const oldest = deferredTurnEnds.keys().next().value;
        if (oldest) deferredTurnEnds.delete(oldest);
      }
      deferredTurnEnds.set(agentId, outcome);
      return;
    }
    const state = topics.get(topicKey);
    // Ignore manual Paseo turns and duplicate/late completions. Only a turn
    // currently owned by this plugin may release the queue.
    if (!state || !state.busy || state.activeTurn === null) return;
    // Capture and clear the token before any await so a late fallback or a
    // duplicate turn_ended cannot release the next turn as well.
    state.activeTurn = null;
    if (state.turnFallback) {
      clearTimeout(state.turnFallback);
      state.turnFallback = null;
    }
    const target = state.pendingTargets.shift() ?? state.lastSeenMessageId;

    // turn_ended timelines occasionally miss the final assistant text
    // (provider-specific projections, permission-continued turns). Try the
    // run() result, then refetch the timeline before giving up.
    if (!outcome.lastText && outcome.outcome === "completed") {
      if (state.lastRunText) {
        outcome = { ...outcome, lastText: state.lastRunText };
      } else {
        const fetched = await fetchLastReply(agentId).catch(() => null);
        if (fetched) outcome = { ...outcome, lastText: fetched };
      }
    }
    state.lastRunText = null;
    setBusy(state, false);
    if (target) {
      options.callbacks.onReply(state.chatId, target, outcome);
    }
    state.lastActivityAt = now();
    drain(topicKey);
  }

  /** Permission requests only surface in the chat; resolution happens in Paseo. */
  function ownsAgent(agentId: string): boolean {
    return agentToTopic.has(agentId);
  }

  function chatIdForAgent(agentId: string): string | null {
    const topicKey = agentToTopic.get(agentId);
    return topicKey ? (topics.get(topicKey)?.chatId ?? null) : null;
  }

  /** Reply target for notices about this agent (its own topic, not the chat). */
  function targetForAgent(agentId: string): string | null {
    const topicKey = agentToTopic.get(agentId);
    const state = topicKey ? topics.get(topicKey) : undefined;
    return state?.pendingTargets[0] ?? state?.lastSeenMessageId ?? null;
  }

  /** True when the next message will start a fresh agent (no reusable context). */
  function needsRebuild(topicKey: string): boolean {
    const state = topics.get(topicKey);
    if (!state?.handle) return true;
    const idleMs = options.getIdleMs();
    return idleMs > 0 && now() - state.lastActivityAt > idleMs;
  }

  function status(): ChatSessionStatus[] {
    return [...topics.entries()].map(([topicKey, state]) => ({
      chatId: state.chatId,
      topicKey,
      agentId: state.agentId,
      busy: state.busy,
      queued: state.queue.length,
    }));
  }

  return {
    noteMessage,
    enqueue,
    handleTurnEnded,
    ownsAgent,
    chatIdForAgent,
    targetForAgent,
    needsRebuild,
    status,
  };
}

export type SessionRegistry = ReturnType<typeof createSessionRegistry>;
