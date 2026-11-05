import { execFile } from "node:child_process";
import { accessSync, constants, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { buildPostContent } from "./format.ts";
import type { ReplyFormat } from "../shared/settings.ts";

const execFileAsync = promisify(execFile);

const CLI_TIMEOUT_MS = 25_000;
const CLI_MAX_BUFFER = 4 * 1024 * 1024;

export interface LarkPayload {
  ok?: boolean;
  data?: Record<string, unknown>;
  error?: { message?: string; hint?: string };
}

/**
 * lark-cli may print warnings before the JSON body; parse from the first
 * opening brace so a noisy login still yields a usable result.
 */
export function parseLarkJson(stdout: string): LarkPayload | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start)) as LarkPayload;
  } catch {
    return null;
  }
}

/**
 * The Paseo daemon is usually launched from Finder, so PATH lacks nvm's bin
 * directory. Walk explicit config, PATH, nvm versions, then common prefixes.
 */
export function resolveLarkCli(
  explicit = "",
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string | null {
  const candidates: string[] = [];
  const push = (value: string | undefined) => {
    if (value && value.trim()) candidates.push(value.trim());
  };

  push(explicit);
  push(env.LARK_CLI_PATH);
  for (const dir of (env.PATH || "").split(delimiter)) {
    if (dir) candidates.push(join(dir, "lark-cli"));
  }
  try {
    const versionsDir = join(home, ".nvm", "versions", "node");
    for (const version of readdirSync(versionsDir).sort().reverse()) {
      candidates.push(join(versionsDir, version, "bin", "lark-cli"));
    }
  } catch {
    // No nvm install on this machine.
  }
  candidates.push(
    join(home, ".local", "bin", "lark-cli"),
    "/opt/homebrew/bin/lark-cli",
    "/usr/local/bin/lark-cli",
  );

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

async function runCli(cliPath: string, args: string[], label: string): Promise<LarkPayload> {
  const { stdout, stderr } = await execFileAsync(cliPath, args, {
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: CLI_MAX_BUFFER,
  });
  const payload = parseLarkJson(stdout);
  if (payload?.ok === true) return payload;

  const error = payload?.error;
  const detail = error?.message
    ? error.message + (error.hint ? " — " + error.hint : "")
    : stderr.trim() || stdout.trim();
  throw new Error(label + "失败：" + detail.slice(0, 400) || label + "失败：lark-cli 无输出");
}

/** The bot's own open_id (ou_…), used to detect @-mentions of this bot. */
export async function readBotOpenId(cliPath: string): Promise<string | null> {
  const payload = await runCli(cliPath, ["api", "GET", "/open-apis/bot/v3/info", "--as", "bot"], "读取机器人信息");
  const openId = (payload.data as { open_id?: unknown } | undefined)?.open_id;
  return typeof openId === "string" && openId.startsWith("ou_") ? openId : null;
}

export interface LarkChat {
  chatId: string;
  name: string;
}

/** Group chats the bot has joined, for the settings UI picker. */
export async function listChats(cliPath: string): Promise<LarkChat[]> {
  const payload = await runCli(
    cliPath,
    ["im", "+chat-list", "--as", "bot", "--page-all", "--format", "json"],
    "拉取群列表",
  );
  // The shortcut returns {chats: […] | null, has_more, page_token}; --page-all
  // already walked the pages.
  const items = (payload.data as { chats?: unknown } | undefined)?.chats;
  if (!Array.isArray(items)) return [];
  const chats: LarkChat[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const chatId = record.chat_id;
    const name = record.name;
    if (typeof chatId === "string" && chatId.startsWith("oc_")) {
      chats.push({ chatId, name: typeof name === "string" ? name : "" });
    }
  }
  return chats;
}

export interface ReplyOptions {
  cliPath: string;
  /** The @-mention message the reply attaches to (om_…). */
  messageId: string;
  text: string;
  format: ReplyFormat;
  replyInThread: boolean;
}

/**
 * Reply inside the source message's context via im +messages-reply, so each
 * answer lands under the message that triggered it.
 */
export async function replyMessage(options: ReplyOptions): Promise<string | null> {
  const args = ["im", "+messages-reply", "--message-id", options.messageId, "--as", "bot"];
  if (options.replyInThread) args.push("--reply-in-thread");
  if (options.format === "markdown") {
    args.push("--markdown", options.text);
  } else if (options.format === "text") {
    args.push("--text", options.text);
  } else {
    args.push("--msg-type", "post", "--content", buildPostContent(options.text));
  }
  const payload = await runCli(options.cliPath, args, "回复消息");
  const messageId = (payload.data as { message_id?: unknown } | undefined)?.message_id;
  return typeof messageId === "string" ? messageId : null;
}
