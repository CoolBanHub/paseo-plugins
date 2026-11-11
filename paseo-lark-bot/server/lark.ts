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

/**
 * Stop the shared event-bus daemon for one app. Used when the plugin switches
 * to another app (via settings or the one-click creation flow) so the old
 * process does not keep reconnecting with stale credentials.
 */
export async function stopLarkEventBus(cliPath: string, appId: string | null): Promise<void> {
  const args = ["event", "stop"];
  if (appId) args.push("--app-id", appId);
  await execFileAsync(cliPath, args, { timeout: CLI_TIMEOUT_MS }).catch(() => undefined);
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
  const stopEventBus = options.stopEventBus ?? stopLarkEventBus;

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

/**
 * Reply with an interactive card (Card 2.0) under the source message. The
 * card JSON goes through stdin so large forms do not show up in `ps`.
 */
export async function replyCard(options: {
  cliPath: string;
  messageId: string;
  card: Record<string, unknown>;
  replyInThread: boolean;
  idempotencyKey?: string;
}): Promise<string | null> {
  const args = [
    "im",
    "+messages-reply",
    "--message-id",
    options.messageId,
    "--as",
    "bot",
    "--msg-type",
    "interactive",
    "--content",
    "-",
  ];
  if (options.replyInThread) args.push("--reply-in-thread");
  if (options.idempotencyKey) args.push("--idempotency-key", options.idempotencyKey.slice(0, 50));
  const stdout = await runWithStdin(options.cliPath, args, JSON.stringify(options.card));
  const payload = parseLarkJson(stdout);
  if (payload?.ok !== true) {
    const error = payload?.error;
    throw new Error("发送问题卡片失败：" + (error?.message || stdout.trim() || "lark-cli 无输出").slice(0, 400));
  }
  const messageId = (payload.data as { message_id?: unknown } | undefined)?.message_id;
  return typeof messageId === "string" ? messageId : null;
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

export interface LarkChatBot {
  openId: string;
  name: string;
  /** App id (`cli_…`) when the member payload carries one. */
  appId?: string;
}

/** Bots in a chat, for agent-to-agent @ handoff discovery. */
export async function listChatBots(cliPath: string, chatId: string): Promise<LarkChatBot[]> {
  const payload = await runCli(
    cliPath,
    [
      "im",
      "+chat-members-list",
      "--chat-id",
      chatId,
      "--member-types",
      "bot",
      "--page-all",
      "--format",
      "json",
    ],
    "拉取群机器人",
  );
  // The shortcut returns separate users[] / bots[] buckets; bots also expose
  // an open_id suitable for <at user_id="…"> mentions.
  const items = (payload.data as { bots?: unknown } | undefined)?.bots;
  if (!Array.isArray(items)) return [];
  const bots: LarkChatBot[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const openId = record.member_id;
    const name = record.name;
    const appId = record.app_id ?? record.bot_id;
    if (typeof openId === "string" && openId.startsWith("ou_")) {
      bots.push({
        openId,
        name: typeof name === "string" ? name : "",
        ...(typeof appId === "string" && appId ? { appId } : {}),
      });
    }
  }
  return bots;
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

/** lark-cli version string, e.g. "1.0.98"; null when the binary cannot run. */
export async function readCliVersion(cliPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cliPath, ["version"], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(stdout);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Add an emoji reaction (e.g. "OnIt" / "DONE"). Returns the reaction id so a
 * later removal targets exactly this reaction instead of someone else's.
 */
export async function addReaction(options: {
  cliPath: string;
  messageId: string;
  emojiType: string;
}): Promise<string | null> {
  const payload = await runCli(
    options.cliPath,
    [
      "im",
      "reactions",
      "create",
      "--params",
      JSON.stringify({ message_id: options.messageId }),
      "--data",
      JSON.stringify({ reaction_type: { emoji_type: options.emojiType } }),
      "--as",
      "bot",
      "--format",
      "json",
    ],
    "添加表情回执",
  );
  const reactionId = (payload.data as { reaction_id?: unknown } | undefined)?.reaction_id;
  return typeof reactionId === "string" && reactionId ? reactionId : null;
}

/** Best-effort removal of a reaction this plugin added. */
export async function removeReaction(options: {
  cliPath: string;
  messageId: string;
  reactionId: string;
}): Promise<void> {
  await runCli(
    options.cliPath,
    [
      "im",
      "reactions",
      "delete",
      "--params",
      JSON.stringify({ message_id: options.messageId, reaction_id: options.reactionId }),
      "--as",
      "bot",
      "--format",
      "json",
    ],
    "移除表情回执",
  );
}

/**
 * Patch an interactive card in place. Feishu expects `content` as a
 * stringified card JSON; updates do not push a notification, which is why the
 * dispatcher adds a DONE reaction when the turn finishes.
 */
export async function updateCard(options: {
  cliPath: string;
  messageId: string;
  card: Record<string, unknown>;
}): Promise<void> {
  const content = JSON.stringify(options.card);
  if (content.length > 30 * 1024) throw new Error("进度卡片超过 30KB，无法更新");
  // Feishu occasionally returns internal error 2200 on a valid PATCH; retry a
  // few times with a short backoff before giving up (the caller keeps the old
  // card and logs the failure).
  for (let attempt = 1; ; attempt += 1) {
    try {
      const stdout = await runWithStdin(
        options.cliPath,
        [
          "im",
          "messages",
          "patch",
          "--message-id",
          options.messageId,
          "--data",
          "-",
          "--as",
          "bot",
          "--format",
          "json",
        ],
        JSON.stringify({ content }),
      );
      const payload = parseLarkJson(stdout);
      if (payload?.ok !== true) {
        const error = payload?.error;
        throw new Error(
          "更新卡片失败：" + (error?.message || stdout.trim() || "lark-cli 无输出").slice(0, 400),
        );
      }
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 3 || !/2200|internal error|internal_error|系统繁忙/i.test(message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
}

/** Upload a local image and return its image_key. */
export async function uploadImage(cliPath: string, path: string): Promise<string> {
  const payload = await runCli(
    cliPath,
    ["im", "images", "create", "--data", '{"image_type":"message"}', "--file", path, "--as", "bot", "--format", "json"],
    "上传图片",
  );
  const imageKey = (payload.data as { image_key?: unknown } | undefined)?.image_key;
  if (typeof imageKey !== "string" || !imageKey) throw new Error("上传图片失败：lark-cli 未返回 image_key");
  return imageKey;
}

/** Upload a local file and return its file_key (file_type by extension). */
export async function uploadFile(cliPath: string, path: string, name: string): Promise<string> {
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const type =
    extension === "pdf"
      ? "pdf"
      : extension === "doc" || extension === "docx"
        ? "doc"
        : extension === "xls" || extension === "xlsx"
          ? "xls"
          : extension === "ppt" || extension === "pptx"
            ? "ppt"
            : extension === "mp4"
              ? "mp4"
              : extension === "opus" || extension === "ogg"
                ? "opus"
                : "stream";
  const payload = await runCli(
    cliPath,
    [
      "im",
      "files",
      "create",
      "--data",
      JSON.stringify({ file_name: name, file_type: type }),
      "--file",
      path,
      "--as",
      "bot",
      "--format",
      "json",
    ],
    "上传文件",
  );
  const fileKey = (payload.data as { file_key?: unknown } | undefined)?.file_key;
  if (typeof fileKey !== "string" || !fileKey) throw new Error("上传文件失败：lark-cli 未返回 file_key");
  return fileKey;
}

/** Reply with an already-uploaded image/file key, inside the topic. */
export async function replyMedia(options: {
  cliPath: string;
  messageId: string;
  kind: "image" | "file";
  key: string;
  replyInThread: boolean;
  idempotencyKey?: string;
}): Promise<string | null> {
  const args = [
    "im",
    "+messages-reply",
    "--message-id",
    options.messageId,
    "--as",
    "bot",
    "--msg-type",
    options.kind,
    "--content",
    JSON.stringify(options.kind === "image" ? { image_key: options.key } : { file_key: options.key }),
  ];
  if (options.replyInThread) args.push("--reply-in-thread");
  if (options.idempotencyKey) args.push("--idempotency-key", options.idempotencyKey.slice(0, 50));
  const payload = await runCli(options.cliPath, args, "回复附件");
  return typeof (payload.data as { message_id?: unknown } | undefined)?.message_id === "string"
    ? ((payload.data as { message_id: string }).message_id)
    : null;
}

/**
 * Send a new message to a chat (scheduled jobs have no source message to
 * reply under). Returns the message id when lark-cli reports one.
 */
export async function sendChatMessage(options: {
  cliPath: string;
  chatId: string;
  text: string;
  format: ReplyFormat;
}): Promise<string | null> {
  const args = ["im", "+messages-send", "--chat-id", options.chatId, "--as", "bot"];
  let stdin: string;
  if (options.format === "text") {
    args.push("--text", "-");
    stdin = options.text;
  } else if (options.format === "post") {
    args.push("--msg-type", "post", "--content", "-");
    stdin = buildPostContent(options.text);
  } else {
    args.push("--markdown", "-");
    stdin = options.text;
  }
  const stdout = await runWithStdin(options.cliPath, args, stdin);
  const payload = parseLarkJson(stdout);
  if (payload?.ok !== true) {
    const error = payload?.error;
    throw new Error("发送消息失败：" + (error?.message || stdout.trim() || "lark-cli 无输出").slice(0, 400));
  }
  const messageId = (payload.data as { message_id?: unknown } | undefined)?.message_id;
  return typeof messageId === "string" ? messageId : null;
}
