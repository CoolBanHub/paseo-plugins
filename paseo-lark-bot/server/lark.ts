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
    for (const version of readdirSync(versionsDir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
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
  throw new Error((label + "失败：" + (detail || "lark-cli 无输出")).slice(0, 400));
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
  /** App ID currently configured in lark-cli, used to stop its event bus. */
  previousAppId?: string | null;
  /** Injectable for tests. */
  fetchImpl?: (url: string, init: { method: string; body: string; signal?: AbortSignal }) => Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
  runInit?: (cliPath: string, appId: string, secret: string) => Promise<void>;
  stopEventBus?: (cliPath: string, appId: string | null) => Promise<void>;
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
    (async (cliPath: string, previousAppId: string | null) => {
      const args = ["event", "stop"];
      if (previousAppId) args.push("--app-id", previousAppId);
      await execFileAsync(cliPath, args, { timeout: CLI_TIMEOUT_MS }).catch(() => undefined);
    });

  const response = await (async () => {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), CLI_TIMEOUT_MS);
    try {
      return await fetchImpl("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
        method: "POST",
        body: JSON.stringify({ app_id: options.appId, app_secret: options.appSecret }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(abortTimer);
    }
  })();
  const payload = (await response.json()) as TokenResponse;
  if (!response.ok || payload.code !== 0) {
    throw new Error(
      `飞书应用凭证无效（${payload.msg ?? "HTTP " + response.status}），未写入 lark-cli，请检查 App ID / App Secret`,
    );
  }
  await runInit(options.cliPath, options.appId, options.appSecret);
  // The shared event bus daemon keeps tokens in memory; stop the old app's bus
  // so the consumer reconnects with the new credentials.
  await stopEventBus(options.cliPath, options.previousAppId ?? null);
}

/**
 * execFile cannot feed stdin; spawn and pipe data without exposing it in argv.
 * Returns stdout so callers such as message replies can parse the JSON result.
 */
async function runWithStdin(cliPath: string, args: string[], stdinData: string): Promise<string> {
  const child = spawn(cliPath, args, { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.stdin?.on("error", () => {
    // The child may exit before reading stdin; the exit path reports the error.
  });
  const done = new Promise<string>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error("lark-cli 执行失败：" + stderr.trim().slice(0, 300)));
    });
  });
  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), CLI_TIMEOUT_MS).unref?.();
  });
  // Avoid an unhandled rejection if the timeout wins and the child exits later.
  void done.catch(() => undefined);
  child.stdin?.end(stdinData);
  if ((await Promise.race([done.then((value) => value), timeout])) === "timeout") {
    child.kill("SIGTERM");
    throw new Error("lark-cli 执行超时");
  }
  return await done;
}

/**
 * Raw message body as JSON (text: {"text":…}, image: {"image_key":…},
 * media/file: {"file_key":…}) — the pre-rendered content loses these keys.
 */
export async function readRawContent(cliPath: string, messageId: string): Promise<Record<string, unknown> | null> {
  const payload = await runCli(cliPath, ["api", "GET", "/open-apis/im/v1/messages/" + messageId, "--as", "bot"], "读取原始消息");
  const items = (payload.data as { items?: unknown[] } | undefined)?.items;
  const first = Array.isArray(items) ? items[0] : null;
  if (!first || typeof first !== "object") return null;
  const body = (first as { body?: { content?: unknown } }).body;
  if (typeof body?.content !== "string") return null;
  try {
    return JSON.parse(body.content) as Record<string, unknown>;
  } catch {
    return null;
  }
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
    ["im", "+messages-mget", "--message-ids", messageId, "--as", "bot", "--format", "json"],
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

export interface LarkChatMember {
  openId: string;
  name: string;
}

/** Human members of a chat, for the settings UI allowlist picker. */
export async function listChatMembers(cliPath: string, chatId: string): Promise<LarkChatMember[]> {
  const payload = await runCli(
    cliPath,
    [
      "im",
      "+chat-members-list",
      "--chat-id",
      chatId,
      "--member-types",
      "user",
      "--page-all",
      "--format",
      "json",
    ],
    "拉取群成员",
  );
  // The shortcut returns separate users[] / bots[] buckets; only users can be
  // allowlisted, and --page-all already walked the pages.
  const items = (payload.data as { users?: unknown } | undefined)?.users;
  if (!Array.isArray(items)) return [];
  const members: LarkChatMember[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const openId = record.member_id;
    const name = record.name;
    if (typeof openId === "string" && openId.startsWith("ou_")) {
      members.push({ openId, name: typeof name === "string" ? name : "" });
    }
  }
  return members;
}

export interface ReplyOptions {
  /** Stable per logical reply; lets a retry never duplicate a send. */
  idempotencyKey?: string;
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
  if (options.idempotencyKey) args.push("--idempotency-key", options.idempotencyKey.slice(0, 50));
  let stdin: string;
  if (options.format === "markdown") {
    // "-" reads the body from stdin, keeping the reply out of `ps` output.
    args.push("--markdown", "-");
    stdin = options.text;
  } else if (options.format === "text") {
    args.push("--text", "-");
    stdin = options.text;
  } else {
    args.push("--msg-type", "post", "--content", "-");
    stdin = buildPostContent(options.text);
  }
  const stdout = await runWithStdin(options.cliPath, args, stdin);
  const payload = parseLarkJson(stdout);
  if (payload?.ok !== true) {
    const error = payload?.error;
    throw new Error("回复消息失败：" + (error?.message || stdout.trim() || "lark-cli 无输出").slice(0, 400));
  }
  const messageId = (payload.data as { message_id?: unknown } | undefined)?.message_id;
  return typeof messageId === "string" ? messageId : null;
}
