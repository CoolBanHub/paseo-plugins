import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import {
  formatPermissionMessage,
  formatTurnEndMessage,
  summarizeTimeline,
  type SessionSummary,
} from "./format.ts";
import { readSelfOpenId, resolveLarkCli, sendDm, type SendDmOptions } from "./lark.ts";
import type { NotifyValues } from "./settings.ts";

export type CreatedEvent = PluginLifecycleEvents["agent.created"];
export type TurnStartedEvent = PluginLifecycleEvents["agent.turn_started"];
export type TurnEndedEvent = PluginLifecycleEvents["agent.turn_ended"];
export type PermissionEvent = PluginLifecycleEvents["agent.permission_requested"];

const MAX_SEEN = 500;
const MAX_AGENTS = 500;
const RETRY_DELAY_MS = 3_000;

/** Helper sessions carry this label; their lifecycle stays silent. */
const HELPER_PURPOSE_LABEL = "lark-bot-purpose";
const HELPER_PURPOSE_VALUE = "title";

/**
 * Minimal PaseoApi slice for label lookups; supplied per event by the host
 * wiring so tests can inject fakes.
 */
export interface NotifyPaseoApi {
  agents: {
    ref(agentId: string): {
      refresh(): Promise<{ agent: { labels?: Record<string, string> } | null } | null>;
    };
  };
}

/**
 * True for one-shot helper sessions (e.g. lark-bot's topic-naming agents):
 * their turns would only produce noise. Lookup failures fail open — the
 * notification still goes out.
 */
async function isHelperSession(
  paseo: NotifyPaseoApi | undefined,
  agentId: string,
): Promise<boolean> {
  if (!paseo) return false;
  try {
    const result = await paseo.agents.ref(agentId).refresh();
    return result?.agent?.labels?.[HELPER_PURPOSE_LABEL] === HELPER_PURPOSE_VALUE;
  } catch {
    return false;
  }
}

interface AgentState {
  turns: number;
  /** When the last turn-end notification was actually delivered. */
  lastSentAt: number;
  /** Completions held back by the quiet window, flushed once when it ends. */
  suppressed: number;
  flushTimer: { unref?: () => void } | null;
  /** Last held-back summary line, quoted once in the flush message. */
  lastSummary: string | null;
}

export interface NotifierOptions {
  readValues: () => Promise<NotifyValues>;
  resolveCli?: (explicit: string) => string | null;
  readOpenId?: (cliPath: string) => Promise<string | null>;
  send?: (options: SendDmOptions) => Promise<string | null>;
  log?: (message: string, detail?: unknown) => void;
  now?: () => number;
  /** Retry delay override for tests. */
  retryDelayMs?: number;
  /** Timer scheduler override for tests. */
  schedule?: (fn: () => void, delayMs: number) => { unref?: () => void };
}

export function createNotifier(options: NotifierOptions) {
  const resolveCli = options.resolveCli || ((explicit: string) => resolveLarkCli(explicit));
  const readOpenId = options.readOpenId || readSelfOpenId;
  const send = options.send || sendDm;
  const now = options.now || (() => Date.now());
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  const schedule =
    options.schedule || ((fn: () => void, delayMs: number) => setTimeout(fn, delayMs));
  const log =
    options.log ||
    ((message: string, detail?: unknown) => {
      console.log("[lark-notify] " + message, detail === undefined ? "" : detail);
    });

  const agents = new Map<string, AgentState>();
  // Ordered set: at capacity the oldest entry is evicted, never a full clear
  // that would briefly re-notify every remembered permission.
  const seenPermissions = new Map<string, true>();
  let cachedOpenId: string | null = null;
  let warnedMissingCli = false;
  let warnedMissingOpenId = false;
  let notificationSequence = 0;

  const remember = (key: string) => {
    if (seenPermissions.has(key)) return;
    if (seenPermissions.size >= MAX_SEEN) {
      const oldest = seenPermissions.keys().next().value;
      if (oldest !== undefined) seenPermissions.delete(oldest);
    }
    seenPermissions.set(key, true);
  };

  function ensureAgent(agentId: string): AgentState {
    let state = agents.get(agentId);
    if (state) return state;
    state = {
      turns: 0,
      lastSentAt: 0,
      suppressed: 0,
      flushTimer: null,
      lastSummary: null,
    };
    agents.set(agentId, state);
    if (agents.size > MAX_AGENTS) {
      const oldest = agents.keys().next().value;
      if (oldest) agents.delete(oldest);
    }
    return state;
  }

  /**
   * One stable key per logical notification so the single retry below cannot
   * produce a duplicate message (lark-cli enforces --idempotency-key).
   */
  const idempotencyKey = (): string => `ln-${process.pid}-${++notificationSequence}`;

  async function deliver(values: NotifyValues, text: string): Promise<void> {
    const cliPath = resolveCli(values.larkCliPath);
    if (!cliPath) {
      if (!warnedMissingCli) {
        warnedMissingCli = true;
        log("找不到 lark-cli，通知已跳过（可在设置里填写 larkCliPath）");
      }
      return;
    }

    let openId = values.openId.trim();
    if (!openId) {
      if (!cachedOpenId) {
        try {
          cachedOpenId = await readOpenId(cliPath);
        } catch (error) {
          log("读取 lark-cli 身份失败", error instanceof Error ? error.message : String(error));
        }
      }
      openId = cachedOpenId || "";
    }
    if (!openId) {
      if (!warnedMissingOpenId) {
        warnedMissingOpenId = true;
        log("无法确定接收人 openId，通知已跳过（可在设置里填写 openId）");
      }
      return;
    }

    const payload: SendDmOptions = {
      cliPath,
      openId,
      identity: values.identity,
      text,
      idempotencyKey: idempotencyKey(),
    };
    for (let attempt = 1; ; attempt += 1) {
      try {
        const messageId = await send({ ...payload });
        log("已发送通知", messageId || "");
        return;
      } catch (error) {
        // A transient lark-cli failure used to drop the notification
        // silently; one retry with the same idempotency key is safe.
        if (attempt >= 2) {
          log("发送失败（已重试一次）", error instanceof Error ? error.message : String(error));
          return;
        }
        log("发送失败，稍后重试", error instanceof Error ? error.message : String(error));
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  function handleCreated(event: CreatedEvent): void {
    agents.set(event.agent.id, {
      turns: 0,
      lastSentAt: 0,
      suppressed: 0,
      flushTimer: null,
      lastSummary: null,
    });
  }

  function handleTurnStarted(event: TurnStartedEvent): void {
    ensureAgent(event.agent.id);
  }

  /** Send the held-back completions once the session's quiet window expires. */
  const scheduleFlush = (state: AgentState, quietMs: number): void => {
    if (state.flushTimer) return;
    const dueAt = state.lastSentAt + quietMs;
    const delay = Math.max(0, dueAt - now());
    state.flushTimer = schedule(() => {
      state.flushTimer = null;
      if (state.suppressed <= 0) return;
      const count = state.suppressed;
      state.suppressed = 0;
      state.lastSentAt = now();
      const summary = state.lastSummary;
      state.lastSummary = null;
      void (async () => {
        try {
          const values = await options.readValues();
          if (!values.notifySessionEnd) return;
          await deliver(values, [
            `🔕 静默期内另有 ${count} 轮任务完成（每会话 ${Math.round(quietMs / 60_000)} 分钟内不重复通知，可在设置中调整）`,
            ...(summary ? [`最近一轮：${summary}`] : []),
          ].join("\n"));
        } catch (error) {
          log("静默期汇总通知处理失败", error instanceof Error ? error.message : String(error));
        }
      })();
    }, delay);
    state.flushTimer.unref?.();
  };

  async function handleTurnEnded(event: TurnEndedEvent, paseo?: NotifyPaseoApi): Promise<void> {
    if (await isHelperSession(paseo, event.agent.id)) return;
    const state = ensureAgent(event.agent.id);
    state.turns += 1;
    const summary = summarizeTimeline(event.timeline);

    try {
      const values = await options.readValues();
      if (!values.notifySessionEnd) return;
      if (event.agent.parentAgentId && !values.includeSubagents) return;

      const quietMs = values.quietMinutes * 60_000;
      const body = formatTurnEndMessage(event.agent, {
        outcome: event.outcome.kind,
        turns: state.turns,
        durationMs: null,
        lastText: summary.lastText,
        lastAction: summary.lastAction,
        lastError: event.outcome.kind === "failed" ? event.outcome.error.message : null,
      });

      // Agentic sessions end dozens of turns in a row; within one quiet
      // window only the first completion notifies, the rest are summarized
      // once when the window expires (0 disables the window).
      if (quietMs > 0 && state.lastSentAt > 0 && now() - state.lastSentAt < quietMs) {
        state.suppressed += 1;
        state.lastSummary = summary.lastText ?? summary.lastAction ?? null;
        scheduleFlush(state, quietMs);
        return;
      }
      const held = state.suppressed;
      state.suppressed = 0;
      state.lastSummary = null;
      if (state.flushTimer) {
        state.flushTimer = null;
      }
      state.lastSentAt = now();
      await deliver(values, held > 0 ? `${body}\n\n（静默期内已抑制 ${held} 轮完成通知）` : body);
    } catch (error) {
      log("本轮任务完成通知处理失败", error instanceof Error ? error.message : String(error));
    }
  }

  async function handlePermission(event: PermissionEvent, paseo?: NotifyPaseoApi): Promise<void> {
    try {
      if (await isHelperSession(paseo, event.agent.id)) return;
      const values = await options.readValues();
      if (!values.notifyPermission) return;
      if (seenPermissions.has(event.request.id)) return;
      remember(event.request.id);
      // Permissions need attention; they always notify immediately.
      await deliver(values, formatPermissionMessage(event.agent, event.request));
    } catch (error) {
      log("权限通知处理失败", error instanceof Error ? error.message : String(error));
    }
  }

  return { handleCreated, handleTurnStarted, handleTurnEnded, handlePermission };
}
