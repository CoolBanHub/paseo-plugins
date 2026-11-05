import { homedir } from "node:os";
import type { ChatBinding } from "../shared/settings.ts";

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
  refetch(options?: { limit?: number }): Promise<{ entries?: { type?: string; text?: string }[] }>;
}

export interface SessionPaseoApi {
  agents: {
    create(options: {
      config: { provider: string; systemPrompt?: string };
      cwd: string;
      title?: string;
      labels?: Record<string, string>;
      prompt?: string;
      images?: SessionImage[];
    }): Promise<SessionAgentHandle>;
    ref(id: string): SessionAgentHandle & { timeline?: SessionTimelineHandle };
  };
  /** Optional slice used to normalize bare provider ids to provider/model. */
  providers?: {
    waitForReady(options?: { timeoutMs?: number }): Promise<SessionProviderSnapshot>;
  };
}

export interface SessionProviderSnapshot {
  entries: { provider: string; models?: { id: string; isDefault?: boolean }[] }[];
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
}

const RUN_TIMEOUT_MS = 10 * 60_000;
/** If a turn never ends (stuck provider), give up waiting and rebuild. */
const STUCK_BUSY_MS = 30 * 60_000;
const TITLE_SNIPPET = 16;

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
   * `dsh/<default-model>` before agents.create(). Returning the input
   * unchanged lets older hosts keep working.
   */
  resolveProvider?: (provider: string) => Promise<string>;
  /**
   * Fallback when turn_ended carries no assistant text: refetch the agent
   * timeline and pull the latest reply from there.
   */
  fetchLastReply?: (agentId: string) => Promise<string | null>;
  now?: () => number;
}) {
  const resolveProvider = options.resolveProvider ?? (async (provider: string) => provider);
  const fetchLastReply = options.fetchLastReply ?? (async () => null);
  const now = options.now ?? Date.now;
  const topics = new Map<string, TopicState>();
  const agentToTopic = new Map<string, string>();

  function stateFor(topicKey: string, chatId: string): TopicState {
    let state = topics.get(topicKey);
    if (!state) {
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
  ): void {
    const state = stateFor(topicKey, chatId);
    // lastActivityAt stays at the previous turn's end here so ensureAgent can
    // measure the real idle window; drain() refreshes it once a turn starts.
    state.lastSeenMessageId = messageId;
    if (state.busy && state.busySince !== null && now() - state.busySince > STUCK_BUSY_MS) {
      // The previous turn looks stuck; drop the session and start over.
      options.callbacks.log?.(`topic ${topicKey} busy for too long; rebuilding session`);
      resetTopic(topicKey);
    }
    state.queue.push({ messageId, prompt, binding, images });
    drain(topicKey);
  }

  function setBusy(state: TopicState, busy: boolean): void {
    state.busy = busy;
    state.busySince = busy ? now() : null;
  }

  function resetTopic(topicKey: string): void {
    const state = topics.get(topicKey);
    if (!state) return;
    if (state.agentId) agentToTopic.delete(state.agentId);
    state.agentId = null;
    state.handle = null;
    setBusy(state, false);
  }

  async function drain(topicKey: string): Promise<void> {
    const state = stateFor(topicKey, "");
    if (state.busy) return;
    const item = state.queue.shift();
    if (!item) return;

    setBusy(state, true);
    try {
      // ensureAgent() passes the prompt to agents.create() for fresh sessions,
      // which already starts the first turn — running it again would duplicate
      // the message. lastActivityAt refreshes only after the idle check so the
      // window measures the real gap since the previous turn.
      const { handle, created } = await ensureAgent(topicKey, item);
      state.lastActivityAt = now();
      agentToTopic.set(handle.id, topicKey);
      state.pendingTargets.push(item.messageId);
      if (created) {
        // The first turn is driven by create(); wait for turn_ended.
        return;
      }
      const result = await handle.run(item.prompt, { timeoutMs: RUN_TIMEOUT_MS, images: item.images });
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
      // idle: the turn finished. turn_ended normally arrived already and
      // released the queue; if it is still in flight the next drain runs on it.
      state.lastRunText = result.lastMessage?.trim() || null;
      setBusy(state, false);
      drain(topicKey);
    } catch (error) {
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

  async function ensureAgent(
    topicKey: string,
    item: QueueItem,
  ): Promise<{ handle: SessionAgentHandle; created: boolean }> {
    const state = stateFor(topicKey, "");
    const idleMs = options.getIdleMs();
    const expired = idleMs > 0 && now() - state.lastActivityAt > idleMs;
    if (state.handle && !expired) return { handle: state.handle, created: false };

    if (state.agentId) agentToTopic.delete(state.agentId);
    const handle = await options.paseo.agents.create({
      config: {
        provider: await resolveProvider(item.binding.provider),
        ...(item.binding.systemPrompt ? { systemPrompt: item.binding.systemPrompt } : {}),
      },
      cwd: item.binding.cwd || homedir(),
      title: `飞书 · ${item.binding.chatName || state.chatId} · ${item.prompt.slice(0, TITLE_SNIPPET)}`,
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
    if (!topicKey) return;
    const state = topics.get(topicKey);
    if (!state) return;
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
    status,
  };
}

export type SessionRegistry = ReturnType<typeof createSessionRegistry>;
