import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import {
  formatPermissionMessage,
  formatSessionEndMessage,
  summarizeTimeline,
  type SessionSummary,
} from "./format.ts";
import { readSelfOpenId, resolveLarkCli, sendDm, type SendDmOptions } from "./lark.ts";
import type { NotifyValues } from "./settings.ts";

export type CreatedEvent = PluginLifecycleEvents["agent.created"];
export type TurnStartedEvent = PluginLifecycleEvents["agent.turn_started"];
export type TurnEndedEvent = PluginLifecycleEvents["agent.turn_ended"];
export type PermissionEvent = PluginLifecycleEvents["agent.permission_requested"];
export type ClosedEvent = PluginLifecycleEvents["agent.closed"];

const MAX_SEEN = 500;
const MAX_AGENTS = 500;
/** Daemon restarts close many agents at once; stay quiet during startup. */
const DEFAULT_WARMUP_MS = 60_000;

interface AgentState {
  startedAt: number;
  turns: number;
  outcome: SessionSummary["outcome"];
  lastText: string | null;
  lastAction: string | null;
  lastError: string | null;
}

export interface NotifierOptions {
  readValues: () => Promise<NotifyValues>;
  resolveCli?: (explicit: string) => string | null;
  readOpenId?: (cliPath: string) => Promise<string | null>;
  send?: (options: SendDmOptions) => Promise<string | null>;
  now?: () => number;
  warmupMs?: number;
  log?: (message: string, detail?: unknown) => void;
}

export function createNotifier(options: NotifierOptions) {
  const now = options.now || (() => Date.now());
  const startedAt = now();
  const resolveCli = options.resolveCli || ((explicit: string) => resolveLarkCli(explicit));
  const readOpenId = options.readOpenId || readSelfOpenId;
  const send = options.send || sendDm;
  const warmupMs = options.warmupMs === undefined ? DEFAULT_WARMUP_MS : options.warmupMs;
  const log =
    options.log ||
    ((message: string, detail?: unknown) => {
      console.log("[lark-notify] " + message, detail === undefined ? "" : detail);
    });

  const agents = new Map<string, AgentState>();
  const seenPermissions = new Set<string>();
  const seenCloses = new Set<string>();
  let cachedOpenId: string | null = null;
  let warnedMissingCli = false;
  let warnedMissingOpenId = false;

  const remember = (seen: Set<string>, key: string) => {
    if (seen.size >= MAX_SEEN) seen.clear();
    seen.add(key);
  };

  function ensureAgent(agentId: string): AgentState {
    let state = agents.get(agentId);
    if (state) return state;
    state = {
      startedAt: now(),
      turns: 0,
      outcome: null,
      lastText: null,
      lastAction: null,
      lastError: null,
    };
    agents.set(agentId, state);
    if (agents.size > MAX_AGENTS) {
      const oldest = agents.keys().next().value;
      if (oldest) agents.delete(oldest);
    }
    return state;
  }

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

    try {
      const messageId = await send({
        cliPath,
        openId,
        identity: values.identity,
        text,
      });
      log("已发送通知", messageId || "");
    } catch (error) {
      log("发送失败", error instanceof Error ? error.message : String(error));
    }
  }

  function handleCreated(event: CreatedEvent): void {
    agents.set(event.agent.id, {
      startedAt: now(),
      turns: 0,
      outcome: null,
      lastText: null,
      lastAction: null,
      lastError: null,
    });
  }

  function handleTurnStarted(event: TurnStartedEvent): void {
    ensureAgent(event.agent.id);
  }

  function handleTurnEnded(event: TurnEndedEvent): void {
    const state = ensureAgent(event.agent.id);
    state.turns += 1;
    state.outcome = event.outcome.kind;
    if (event.outcome.kind === "failed") {
      state.lastError = event.outcome.error.message;
    }
    const summary = summarizeTimeline(event.timeline);
    if (summary.lastText) state.lastText = summary.lastText;
    if (summary.lastAction) state.lastAction = summary.lastAction;
  }

  async function handlePermission(event: PermissionEvent): Promise<void> {
    try {
      const values = await options.readValues();
      if (!values.notifyPermission) return;
      if (seenPermissions.has(event.request.id)) return;
      remember(seenPermissions, event.request.id);
      await deliver(values, formatPermissionMessage(event.agent, event.request));
    } catch (error) {
      log("权限通知处理失败", error instanceof Error ? error.message : String(error));
    }
  }

  async function handleClosed(event: ClosedEvent): Promise<void> {
    try {
      const state = agents.get(event.agent.id);
      const summary: SessionSummary = {
        outcome: state ? state.outcome : null,
        turns: state ? state.turns : 0,
        durationMs: state ? now() - state.startedAt : null,
        lastText: state ? state.lastText : null,
        lastAction: state ? state.lastAction : null,
        lastError: state ? state.lastError : null,
      };
      agents.delete(event.agent.id);

      const values = await options.readValues();
      if (!values.notifySessionEnd) return;
      if (event.agent.parentAgentId && !values.includeSubagents) return;
      if (now() - startedAt < warmupMs) return;
      if (seenCloses.has(event.agent.id)) return;
      remember(seenCloses, event.agent.id);
      await deliver(values, formatSessionEndMessage(event.agent, summary));
    } catch (error) {
      log("会话结束通知处理失败", error instanceof Error ? error.message : String(error));
    }
  }

  return { handleCreated, handleTurnStarted, handleTurnEnded, handlePermission, handleClosed };
}
