import { execFile, spawn } from "node:child_process";
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

/**
 * The appId lark-cli currently uses. `config show` prints the config object
 * at the top level (no ok/data envelope), so it is parsed separately.
 */
export async function readCurrentAppId(cliPath: string): Promise<string | null> {
  const { stdout } = await execFileAsync(cliPath, ["config", "show"], {
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: CLI_MAX_BUFFER,
  });
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start)) as { appId?: unknown };
    return typeof parsed.appId === "string" && parsed.appId ? parsed.appId : null;
  } catch {
    return null;
  }
}

export interface ApplyCredentialsOptions {
  cliPath: string;
  appId: string;
  appSecret: string;
  /** Injectable for tests. */
  fetchImpl?: (url: string, init: { method: string; body: string }) => Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
  runInit?: (cliPath: string, appId: string, secret: string) => Promise<void>;
  stopEventBus?: (cliPath: string) => Promise<void>;
}

interface TokenResponse {
  code?: number;
  msg?: string;
}

/**
 * Apply user-configured app credentials: validate them against the public
 * tenant_access_token endpoint first (so a bad secret never overwrites a
 * working lark-cli config), then write them into lark-cli non-interactively
 * and restart the event bus so it picks up the new identity.
 */
export async function applyAppCredentials(options: ApplyCredentialsOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const runInit =
    options.runInit ??
    (async (cliPath: string, appId: string, secret: string) => {
      await runWithStdin(cliPath, [
        "config",
        "init",
        "--app-id",
        appId,
        "--app-secret-stdin",
        "--brand",
        "feishu",
      ], secret);
    });
  const stopEventBus =
    options.stopEventBus ??
    (async (cliPath: string) => {
      await execFileAsync(cliPath, ["event", "stop"], { timeout: CLI_TIMEOUT_MS }).catch(() => undefined);
    });

  const response = await fetchImpl("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    body: JSON.stringify({ app_id: options.appId, app_secret: options.appSecret }),
  });
  const payload = (await response.json()) as TokenResponse;
  if (!response.ok || payload.code !== 0) {
    throw new Error(
      `飞书应用凭证无效（${payload.msg ?? "HTTP " + response.status}），未写入 lark-cli，请检查 App ID / App Secret`,
    );
  }
  await runInit(options.cliPath, options.appId, options.appSecret);
  // The shared event bus daemon keeps tokens in memory; restart it so the
  // consumer reconnects with the new credentials.
  await stopEventBus(options.cliPath);
}

/** execFile cannot feed stdin; spawn and pipe the secret without argv exposure. */
async function runWithStdin(cliPath: string, args: string[], stdinData: string): Promise<void> {
  const child = spawn(cliPath, args, { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error("lark-cli config init 失败：" + stderr.trim().slice(0, 300)));
    });
  });
  child.stdin?.write(stdinData);
  child.stdin?.end();
  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), CLI_TIMEOUT_MS).unref?.();
  });
  if ((await Promise.race([done.then(() => "done" as const), timeout])) === "timeout") {
    child.kill("SIGTERM");
    throw new Error("lark-cli config init 超时");
  }
  await done;
}

/** A single message with its sender, used for thread-root context. */
export interface MessageDetail {
  text: string | null;
  senderOpenId: string | null;
  senderName: string | null;
}

/** Fetch one message (thread roots) with its pre-rendered text and sender. */
export async function readMessageDetail(cliPath: string, messageId: string): Promise<MessageDetail | null> {
  const payload = await runCli(
    cliPath,
    ["im", "+messages-mget", "--message-id", messageId, "--as", "bot", "--format", "json"],
    "读取消息",
  );
  const items = (payload.data as { messages?: unknown } | undefined)?.messages;
  const first = Array.isArray(items) ? items[0] : null;
  if (!first || typeof first !== "object") return null;
  const record = first as Record<string, unknown>;
  const content = record.content;
  const sender = record.sender as { id?: unknown; name?: unknown } | undefined;
  return {
    text: typeof content === "string" && content.trim() ? content.trim() : null,
    senderOpenId: typeof sender?.id === "string" ? sender.id : null,
    senderName: typeof sender?.name === "string" && sender.name ? sender.name : null,
  };
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
