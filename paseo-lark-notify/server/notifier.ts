import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { formatPermissionMessage, formatSessionEndMessage } from "./format.ts";
import { readSelfOpenId, resolveLarkCli, sendDm, type SendDmOptions } from "./lark.ts";
import type { NotifyValues } from "./settings.ts";

export type PermissionEvent = PluginLifecycleEvents["agent.permission_requested"];
export type ClosedEvent = PluginLifecycleEvents["agent.closed"];

const MAX_SEEN = 500;
/** Daemon restarts close many agents at once; stay quiet during startup. */
const DEFAULT_WARMUP_MS = 60_000;

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

  const seenPermissions = new Set<string>();
  const seenCloses = new Set<string>();
  let cachedOpenId: string | null = null;
  let warnedMissingCli = false;
  let warnedMissingOpenId = false;

  const remember = (seen: Set<string>, key: string) => {
    if (seen.size >= MAX_SEEN) seen.clear();
    seen.add(key);
  };

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
      const values = await options.readValues();
      if (!values.notifySessionEnd) return;
      if (event.agent.parentAgentId && !values.includeSubagents) return;
      if (now() - startedAt < warmupMs) return;
      if (seenCloses.has(event.agent.id)) return;
      remember(seenCloses, event.agent.id);
      await deliver(values, formatSessionEndMessage(event.agent));
    } catch (error) {
      log("会话结束通知处理失败", error instanceof Error ? error.message : String(error));
    }
  }

  return { handlePermission, handleClosed };
}
