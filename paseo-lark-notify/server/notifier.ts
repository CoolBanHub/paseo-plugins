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

interface AgentState {
  turns: number;
}

export interface NotifierOptions {
  readValues: () => Promise<NotifyValues>;
  resolveCli?: (explicit: string) => string | null;
  readOpenId?: (cliPath: string) => Promise<string | null>;
  send?: (options: SendDmOptions) => Promise<string | null>;
  log?: (message: string, detail?: unknown) => void;
}

export function createNotifier(options: NotifierOptions) {
  const resolveCli = options.resolveCli || ((explicit: string) => resolveLarkCli(explicit));
  const readOpenId = options.readOpenId || readSelfOpenId;
  const send = options.send || sendDm;
  const log =
    options.log ||
    ((message: string, detail?: unknown) => {
      console.log("[lark-notify] " + message, detail === undefined ? "" : detail);
    });

  const agents = new Map<string, AgentState>();
  const seenPermissions = new Set<string>();
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
      turns: 0,
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
      turns: 0,
    });
  }

  function handleTurnStarted(event: TurnStartedEvent): void {
    ensureAgent(event.agent.id);
  }

  async function handleTurnEnded(event: TurnEndedEvent): Promise<void> {
    const state = ensureAgent(event.agent.id);
    state.turns += 1;
    const summary = summarizeTimeline(event.timeline);

    try {
      const values = await options.readValues();
      if (!values.notifySessionEnd) return;
      if (event.agent.parentAgentId && !values.includeSubagents) return;
      await deliver(values, formatTurnEndMessage(event.agent, {
        outcome: event.outcome.kind,
        turns: state.turns,
        durationMs: null,
        lastText: summary.lastText,
        lastAction: summary.lastAction,
        lastError: event.outcome.kind === "failed" ? event.outcome.error.message : null,
      }));
    } catch (error) {
      log("本轮任务完成通知处理失败", error instanceof Error ? error.message : String(error));
    }
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

  return { handleCreated, handleTurnStarted, handleTurnEnded, handlePermission };
}
