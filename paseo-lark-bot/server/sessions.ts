import { homedir } from "node:os";
import type { ChatBinding } from "../shared/settings.ts";

/** Minimal structural slice of PaseoApi so tests can inject fakes. */
export interface SessionAgentHandle {
  readonly id: string;
  send(text: string): Promise<void>;
  run(text: string, options?: { timeoutMs?: number }): Promise<SessionRunResult>;
}

export interface SessionRunResult {
  status: "idle" | "error" | "permission" | "timeout";
  error: string | null;
  lastMessage: string | null;
}

export interface SessionPaseoApi {
  agents: {
    create(options: {
      config: { provider: string; systemPrompt?: string };
      cwd: string;
      title?: string;
      labels?: Record<string, string>;
      prompt?: string;
    }): Promise<SessionAgentHandle>;
    ref(id: string): SessionAgentHandle;
  };
}

export interface ChatSessionStatus {
  chatId: string;
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
}

interface ChatState {
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
}

const RUN_TIMEOUT_MS = 10 * 60_000;
/** If a turn never ends (stuck provider), give up waiting and rebuild. */
const STUCK_BUSY_MS = 30 * 60_000;

export interface SessionCallbacks {
  /** Send the agent's answer back under the trigger message. */
  onReply(chatId: string, messageId: string, outcome: TurnOutcome): void;
  /** Informational notice (errors, stuck sessions, unmatched chats). */
  onNotice(chatId: string | null, messageId: string, text: string): void;
  log?(message: string): void;
}

/**
 * Per-chat agent lifecycle and serial queue. Each bound chat owns one agent
 * session (rebuilt after the idle window); messages are applied one turn at a
 * time. Replies are emitted from turn_ended — the single authoritative
 * "turn finished" signal — while run() only drives queue progression.
 */
export function createSessionRegistry(options: {
  paseo: SessionPaseoApi;
  callbacks: SessionCallbacks;
  getIdleMs: () => number;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const chats = new Map<string, ChatState>();
  const agentToChat = new Map<string, string>();

  function stateFor(chatId: string): ChatState {
    let state = chats.get(chatId);
    if (!state) {
      state = {
        agentId: null,
        handle: null,
        pendingTargets: [],
        queue: [],
        busy: false,
        busySince: null,
        lastActivityAt: 0,
        lastSeenMessageId: null,
      };
      chats.set(chatId, state);
    }
    return state;
  }

  /** Register the newest message seen for a chat (fallback reply target). */
  function noteMessage(chatId: string, messageId: string): void {
    const state = stateFor(chatId);
    state.lastSeenMessageId = messageId;
  }

  /** Queue a prompt for a bound chat; the queue drains one turn at a time. */
  function enqueue(chatId: string, messageId: string, prompt: string, binding: ChatBinding): void {
    const state = stateFor(chatId);
    // lastActivityAt stays at the previous turn's end here so ensureAgent can
    // measure the real idle window; drain() refreshes it once a turn starts.
    state.lastSeenMessageId = messageId;
    if (state.busy && state.busySince !== null && now() - state.busySince > STUCK_BUSY_MS) {
      // The previous turn looks stuck; drop the session and start over.
      options.callbacks.log?.(`chat ${chatId} busy for too long; rebuilding session`);
      resetChat(chatId);
    }
    state.queue.push({ messageId, prompt, binding });
    drain(chatId);
  }

  function setBusy(state: ChatState, busy: boolean): void {
    state.busy = busy;
    state.busySince = busy ? now() : null;
  }

  function resetChat(chatId: string): void {
    const state = chats.get(chatId);
    if (!state) return;
    if (state.agentId) agentToChat.delete(state.agentId);
    state.agentId = null;
    state.handle = null;
    setBusy(state, false);
  }

  async function drain(chatId: string): Promise<void> {
    const state = stateFor(chatId);
    if (state.busy) return;
    const item = state.queue.shift();
    if (!item) return;

    setBusy(state, true);
    try {
      // ensureAgent() passes the prompt to agents.create() for fresh sessions,
      // which already starts the first turn — running it again would duplicate
      // the message. lastActivityAt refreshes only after the idle check so the
      // window measures the real gap since the previous turn.
      const { handle, created } = await ensureAgent(chatId, item);
      state.lastActivityAt = now();
      agentToChat.set(handle.id, chatId);
      state.pendingTargets.push(item.messageId);
      if (created) {
        // The first turn is driven by create(); wait for turn_ended.
        return;
      }
      const result = await handle.run(item.prompt, { timeoutMs: RUN_TIMEOUT_MS });
      if (result.status === "error") {
        // The turn failed before any turn_ended reply can be expected.
        const target = state.pendingTargets.shift() ?? state.lastSeenMessageId;
        if (target) {
          options.callbacks.onReply(chatId, target, {
            outcome: "failed",
            lastText: null,
            lastError: result.error ?? "智能体执行出错",
          });
        }
        // A failed turn leaves the session in an unknown state; rebuild.
        resetChat(chatId);
        drain(chatId);
        return;
      }
      if (result.status === "timeout") {
        // Still running; turn_ended will reply and release the queue.
        const target = state.lastSeenMessageId;
        if (target) {
          options.callbacks.onNotice(
            chatId,
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
      setBusy(state, false);
      drain(chatId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.callbacks.log?.(`chat ${chatId} turn failed: ${message}`);
      const target = state.pendingTargets.shift() ?? state.lastSeenMessageId;
      if (target) {
        options.callbacks.onReply(chatId, target, { outcome: "failed", lastText: null, lastError: message });
      }
      resetChat(chatId);
      drain(chatId);
    }
  }

  async function ensureAgent(
    chatId: string,
    item: QueueItem,
  ): Promise<{ handle: SessionAgentHandle; created: boolean }> {
    const state = stateFor(chatId);
    const idleMs = options.getIdleMs();
    const expired = idleMs > 0 && now() - state.lastActivityAt > idleMs;
    if (state.handle && !expired) return { handle: state.handle, created: false };

    if (state.agentId) agentToChat.delete(state.agentId);
    const handle = await options.paseo.agents.create({
      config: {
        provider: item.binding.provider,
        ...(item.binding.systemPrompt ? { systemPrompt: item.binding.systemPrompt } : {}),
      },
      cwd: item.binding.cwd || homedir(),
      title: `飞书 · ${item.binding.chatName || chatId}`,
      labels: { "lark-bot-chat": chatId },
      prompt: item.prompt,
    });
    state.agentId = handle.id;
    state.handle = handle;
    return { handle, created: true };
  }

  /**
   * turn_ended is the authoritative reply signal: it also covers turns that
   * finished after a permission was resolved or after run() timed out.
   */
  function handleTurnEnded(agentId: string, outcome: TurnOutcome): void {
    const chatId = agentToChat.get(agentId);
    if (!chatId) return;
    const state = chats.get(chatId);
    if (!state) return;
    const target = state.pendingTargets.shift() ?? state.lastSeenMessageId;
    setBusy(state, false);
    if (target) {
      options.callbacks.onReply(chatId, target, outcome);
    }
    state.lastActivityAt = now();
    drain(chatId);
  }

  /** Permission requests only surface in the chat; resolution happens in Paseo. */
  function ownsAgent(agentId: string): boolean {
    return agentToChat.has(agentId);
  }

  function chatIdForAgent(agentId: string): string | null {
    return agentToChat.get(agentId) ?? null;
  }

  function status(): ChatSessionStatus[] {
    return [...chats.entries()].map(([chatId, state]) => ({
      chatId,
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
