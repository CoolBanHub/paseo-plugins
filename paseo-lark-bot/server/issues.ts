import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { BotValues, ChatBinding } from "../shared/settings.ts";
import type { LarkMessageEvent } from "./lark-events.ts";
import { parseLarkJson, resolveLarkCli, type LarkPayload } from "./lark.ts";
import { sanitizeTopicText } from "./format.ts";

const execFileAsync = promisify(execFile);
const CLI_TIMEOUT_MS = 30_000;
const CREATE_TIMEOUT_MS = 60_000;
const CLI_MAX_BUFFER = 8 * 1024 * 1024;
const ISSUE_TIME_ZONE = "Asia/Shanghai";
const MAX_RECORDS = 1_000;
const ACTIVITY_WRITE_MS = 10 * 60_000;
const RECORD_STORE_VERSION = 1;

/**
 * Status order matters for the flow, not for the API: the ledger is a single
 * select. "已修复" means the fix was accepted; "已发布" means it is live.
 * Those are deliberately different states — a fix is not a release.
 */
export const ISSUE_STATUSES = ["待处理", "处理中", "待验收", "已修复", "已发布", "已关闭"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_TABLE_NAME = "问题与需求";
const DEFAULT_BASE_NAME = "问题跟踪";
const OPEN_STATUSES: IssueStatus[] = ["待处理", "处理中", "待验收", "已修复"];

export const ISSUE_FIELD_NAMES = [
  "标题",
  "状态",
  "类型",
  "提出人",
  "提出人ID",
  "群",
  "群ID",
  "根消息ID",
  "话题ID",
  "最近进展",
  "处理人",
  "Paseo 会话",
  "最后活跃",
  "是否跟踪",
  "验收人",
  "验收时间",
  "创建时间",
  "更新时间",
] as const;

/** Fixed schema used by `base +base-create --fields`. */
export const ISSUE_FIELD_DEFINITIONS: Record<string, unknown>[] = [
  { type: "text", name: "标题" },
  {
    type: "select",
    name: "状态",
    multiple: false,
    options: [
      { name: "待处理", hue: "Blue" },
      { name: "处理中", hue: "Orange" },
      { name: "待验收", hue: "Yellow" },
      { name: "已修复", hue: "Green" },
      { name: "已发布", hue: "Purple" },
      { name: "已关闭", hue: "Gray" },
    ],
  },
  {
    type: "select",
    name: "类型",
    multiple: false,
    options: [
      { name: "问题", hue: "Red" },
      { name: "需求", hue: "Blue" },
      { name: "咨询", hue: "Gray" },
    ],
  },
  { type: "user", name: "提出人", multiple: false },
  { type: "text", name: "提出人ID" },
  { type: "text", name: "群" },
  { type: "text", name: "群ID" },
  { type: "text", name: "根消息ID" },
  { type: "text", name: "话题ID" },
  { type: "text", name: "最近进展" },
  { type: "user", name: "处理人", multiple: false },
  { type: "text", name: "Paseo 会话" },
  { type: "datetime", name: "最后活跃", style: { format: "yyyy-MM-dd HH:mm" } },
  { type: "checkbox", name: "是否跟踪" },
  { type: "user", name: "验收人", multiple: false },
  { type: "datetime", name: "验收时间", style: { format: "yyyy-MM-dd HH:mm" } },
  { type: "created_at", name: "创建时间" },
  { type: "updated_at", name: "更新时间", style: { format: "yyyy/MM/dd HH:mm" } },
];

export const issueBaseConfigSchema = z.object({
  version: z.number().default(1),
  baseToken: z.string().min(1),
  tableId: z.string().min(1),
  baseUrl: z.string().default(""),
  name: z.string().default(DEFAULT_BASE_NAME),
  createdAt: z.number().default(0),
});
export type IssueBaseConfig = z.output<typeof issueBaseConfigSchema>;

const issueRecordSchema = z.object({
  recordId: z.string().min(1),
  chatId: z.string().min(1),
  rootMessageId: z.string().min(1),
  threadId: z.string().nullable().default(null),
  requesterOpenId: z.string().nullable().default(null),
  title: z.string().default(""),
  status: z.enum(ISSUE_STATUSES).default("待处理"),
  lastActiveAt: z.number().default(0),
  messageCount: z.number().default(1),
  updatedAt: z.number().default(0),
});
export type IssueRecord = z.output<typeof issueRecordSchema>;

const recordStoreSchema = z.object({
  version: z.number().default(RECORD_STORE_VERSION),
  records: z.array(issueRecordSchema).default([]),
});

export interface IssueQueryItem {
  recordId: string;
  title: string;
  status: IssueStatus;
  type: string;
  lastActive: string;
  progress: string;
  url: string;
}

export interface IssueQueryResult {
  items: IssueQueryItem[];
  total: number;
  error: string | null;
}

export interface IssueTrackerOptions {
  readValues: () => Promise<BotValues>;
  /** Topic → record mapping; omitted keeps the mapping in memory only. */
  storePath?: string;
  /** Auto-created Base coordinates; settings values take precedence. */
  baseStorePath?: string;
  now?: () => number;
  log?: (message: string, detail?: unknown) => void;
  /** Injectable lark-cli runner for tests. */
  run?: (cliPath: string, args: string[], label: string) => Promise<LarkPayload>;
}

export interface IssueTracker {
  /** Record every new topic root; no agent turn is started here. */
  observe(event: LarkMessageEvent, binding: ChatBinding, values?: BotValues): void;
  /** First @ in a topic: 待处理 → 处理中 (never reopens a closed item). */
  markWorking(event: LarkMessageEvent, binding: ChatBinding, values?: BotValues): void;
  /** A turn finished: update the progress column, leave the status alone. */
  updateProgress(input: {
    chatId: string;
    topicKey: string;
    summary: string | null;
    agentId?: string | null;
    values?: BotValues;
  }): void;
  /** Agent/helper says the fix is done: move to 待验收. */
  markDone(input: {
    chatId: string;
    topicKey: string;
    summary: string | null;
    agentId?: string | null;
    values?: BotValues;
  }): Promise<IssueRecord | null>;
  accept(recordId: string, operatorOpenId: string, values?: BotValues): Promise<IssueRecord | null>;
  reject(
    recordId: string,
    operatorOpenId: string,
    note: string | null,
    values?: BotValues,
  ): Promise<IssueRecord | null>;
  release(recordId: string, operatorOpenId: string, values?: BotValues): Promise<IssueRecord | null>;
  close(recordId: string, operatorOpenId: string, reason: string | null, values?: BotValues): Promise<IssueRecord | null>;
  query(
    chatId: string,
    filter: "open" | "mine" | "pending" | "all",
    senderId: string,
    values?: BotValues,
  ): Promise<IssueQueryResult>;
  recordFor(recordId: string): IssueRecord | null;
  recordForTopic(chatId: string, topicKey: string): IssueRecord | null;
  config(values?: BotValues): Promise<IssueBaseConfig | null>;
  /** Create the fixed ledger with the bot identity and grant chat access. */
  createBase(values: BotValues, chatIds?: string[]): Promise<IssueBaseConfig>;
  /** Validate that an existing table has every required field. */
  verifyBase(values: BotValues): Promise<{ ok: boolean; missing: string[] }>;
  flush(): void;
}

function defaultLog(message: string, detail?: unknown): void {
  console.log("[lark-bot] " + message, detail === undefined ? "" : detail);
}

function clip(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit - 1) + "…" : flat;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Base datetime cell value in the tenant's configured time zone. */
export function formatIssueDateTime(ms: number, timeZone = ISSUE_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function readJson<T>(path: string | undefined, schema: z.ZodType<T>): T | null {
  if (!path) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const result = schema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(path: string | undefined, value: unknown): void {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // The caller logs; a failed store write must not break chat handling.
  }
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Extract a useful message from lark-cli's JSON error or raw output. */
function payloadError(payload: LarkPayload, stderr: string, stdout: string): string {
  const message = payload.error?.message;
  if (message) return payload.error?.hint ? `${message} — ${payload.error.hint}` : message;
  return stderr.trim() || stdout.trim() || "lark-cli 无输出";
}

function recordIdOf(payload: LarkPayload): string | null {
  const data = payload.data as Record<string, unknown> | undefined;
  const ids = data?.record_id_list;
  if (Array.isArray(ids) && typeof ids[0] === "string") return ids[0];
  return null;
}

function baseCoordinates(payload: LarkPayload): { baseToken: string; baseUrl: string; tableId: string | null } {
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const base = (data.base ?? {}) as Record<string, unknown>;
  const table = (data.table ?? {}) as Record<string, unknown>;
  const token =
    (typeof base.base_token === "string" && base.base_token) ||
    (typeof data.base_token === "string" && data.base_token) ||
    "";
  const url = (typeof base.url === "string" && base.url) || "";
  const tableId =
    (typeof table.id === "string" && table.id) ||
    (typeof data.table_id === "string" && data.table_id) ||
    (typeof data.default_table_id === "string" && data.default_table_id) ||
    null;
  return { baseToken: token, baseUrl: url, tableId };
}

function parseRecordMatrix(payload: LarkPayload): {
  fields: string[];
  rows: unknown[][];
  ids: string[];
  hasMore: boolean;
} {
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const fields = Array.isArray(data.fields) ? data.fields.filter((item): item is string => typeof item === "string") : [];
  const rows = Array.isArray(data.data)
    ? data.data.filter((row): row is unknown[] => Array.isArray(row))
    : [];
  const ids = Array.isArray(data.record_id_list)
    ? data.record_id_list.filter((id): id is string => typeof id === "string")
    : [];
  return { fields, rows, ids, hasMore: data.has_more === true };
}

function cell(row: unknown[], fields: string[], name: string): unknown {
  const index = fields.indexOf(name);
  return index >= 0 ? row[index] : undefined;
}

function cellText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((entry) => cellText(entry)).filter(Boolean).join(", ");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.name === "string") return record.name;
    if (typeof record.id === "string") return record.id;
  }
  return "";
}

function cellStatus(value: unknown): IssueStatus {
  const text = cellText(value);
  return (ISSUE_STATUSES as readonly string[]).includes(text) ? (text as IssueStatus) : "待处理";
}

/**
 * Owns the "topic → Base record" lifecycle. It never starts an agent; the
 * dispatcher calls observe() for every bound-chat message and markWorking()
 * only when an @ actually queues a turn.
 */
export function createIssueTracker(options: IssueTrackerOptions): IssueTracker {
  const now = options.now ?? Date.now;
  const log = options.log ?? defaultLog;
  const run =
    options.run ??
    (async (cliPath: string, args: string[], label: string): Promise<LarkPayload> => {
      try {
        const { stdout, stderr } = await execFileAsync(cliPath, args, {
          timeout: args.includes("+base-create") ? CREATE_TIMEOUT_MS : CLI_TIMEOUT_MS,
          maxBuffer: CLI_MAX_BUFFER,
        });
        const payload = parseLarkJson(stdout);
        if (payload?.ok === true) return payload;
        throw new Error(`${label}失败：${payload ? payloadError(payload, stderr, stdout) : stderr.trim() || "lark-cli 无输出"}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith(label)) throw error;
        throw new Error(`${label}失败：${errorDetail(error)}`);
      }
    });

  const records = new Map<string, IssueRecord>();
  const byThread = new Map<string, IssueRecord>();
  const byRoot = new Map<string, IssueRecord>();
  const byRecord = new Map<string, IssueRecord>();
  const creating = new Set<string>();
  const lastActivityWrite = new Map<string, number>();
  let baseConfig: IssueBaseConfig | null | undefined;
  let baseLoadedAt = 0;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let warnedMissingBase = false;

  const stored = readJson(options.storePath, recordStoreSchema);
  if (stored) {
    for (const record of stored.records.slice(-MAX_RECORDS)) {
      register(record, false);
    }
  }

  function register(record: IssueRecord, persist = true): void {
    records.set(record.recordId, record);
    byRecord.set(record.recordId, record);
    if (record.threadId) byThread.set(record.threadId, record);
    byRoot.set(record.rootMessageId, record);
    if (records.size > MAX_RECORDS) {
      const oldest = records.keys().next().value;
      if (oldest && oldest !== record.recordId) {
        const removed = records.get(oldest);
        records.delete(oldest);
        if (removed) {
          byRecord.delete(removed.recordId);
          byRoot.delete(removed.rootMessageId);
          if (removed.threadId) byThread.delete(removed.threadId);
        }
      }
    }
    if (persist) scheduleSave();
  }

  function scheduleSave(): void {
    if (!options.storePath || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      flush();
    }, 300);
    saveTimer.unref?.();
  }

  function flush(): void {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!options.storePath) return;
    writeJsonAtomic(options.storePath, {
      version: RECORD_STORE_VERSION,
      records: [...records.values()].slice(-MAX_RECORDS),
    });
  }

  function find(chatId: string, topicKey: string): IssueRecord | null {
    for (const record of [byThread.get(topicKey), byRoot.get(topicKey), byRecord.get(topicKey)]) {
      if (record && record.chatId === chatId) return record;
    }
    return null;
  }

  function allForChat(chatId: string): IssueRecord[] {
    return [...records.values()].filter((record) => record.chatId === chatId);
  }

  async function valuesFor(values?: BotValues): Promise<BotValues> {
    return values ?? options.readValues();
  }

  async function cliPath(values: BotValues): Promise<string> {
    const path = resolveLarkCli(values.larkCliPath);
    if (!path) throw new Error("找不到 lark-cli，请先在全局设置填写路径");
    return path;
  }

  async function call(values: BotValues, args: string[], label: string): Promise<LarkPayload> {
    return run(await cliPath(values), args, label);
  }

  function configFromValues(values: BotValues): IssueBaseConfig | null {
    const baseToken = values.issueBaseToken.trim();
    const tableId = values.issueTableId.trim();
    if (!baseToken || !tableId) return null;
    return {
      version: 1,
      baseToken,
      tableId,
      baseUrl: values.issueBaseUrl.trim(),
      name: values.issueBaseName.trim() || DEFAULT_BASE_NAME,
      createdAt: 0,
    };
  }

  function localConfig(): IssueBaseConfig | null {
    return readJson(options.baseStorePath, issueBaseConfigSchema);
  }

  async function loadConfig(values?: BotValues, refresh = false): Promise<IssueBaseConfig | null> {
    const current = await valuesFor(values);
    const fromSettings = configFromValues(current);
    if (fromSettings) return fromSettings;
    if (!refresh && baseConfig !== undefined && now() - baseLoadedAt < 5_000) return baseConfig;
    baseConfig = localConfig();
    baseLoadedAt = now();
    return baseConfig;
  }

  function saveLocalConfig(config: IssueBaseConfig): void {
    baseConfig = config;
    baseLoadedAt = now();
    writeJsonAtomic(options.baseStorePath, config);
  }

  async function ensureBase(values: BotValues, chatId: string): Promise<IssueBaseConfig | null> {
    const existing = await loadConfig(values, true);
    if (existing) return existing;
    if (!values.issueAutoCreate) return null;
    try {
      log("未配置问题跟踪表，正在用机器人身份创建");
      return await createBase(values, [chatId]);
    } catch (error) {
      if (!warnedMissingBase) {
        warnedMissingBase = true;
        log("自动创建问题跟踪表失败", errorDetail(error));
      }
      return null;
    }
  }

  async function findBaseRecord(
    values: BotValues,
    config: IssueBaseConfig,
    rootMessageId: string,
    threadId: string | null,
  ): Promise<{ recordId: string; title: string; status: IssueStatus } | null> {
    const lookups: Array<[string, string]> = [["根消息ID", rootMessageId]];
    if (threadId && threadId !== rootMessageId) lookups.push(["话题ID", threadId]);
    for (const [field, value] of lookups) {
      try {
        const payload = await call(
          values,
          [
            "base",
            "+record-list",
            "--base-token",
            config.baseToken,
            "--table-id",
            config.tableId,
            "--as",
            "bot",
            "--format",
            "json",
            "--limit",
            "1",
            "--filter-json",
            JSON.stringify({ logic: "and", conditions: [[field, "==", value]] }),
            "--field-id",
            "标题",
            "--field-id",
            "状态",
          ],
          "查询问题记录",
        );
        const { fields, rows, ids } = parseRecordMatrix(payload);
        if (rows[0] && ids[0]) {
          return {
            recordId: ids[0],
            title: cellText(cell(rows[0], fields, "标题")),
            status: cellStatus(cell(rows[0], fields, "状态")),
          };
        }
      } catch (error) {
        log(`按 ${field} 查询问题记录失败`, errorDetail(error));
      }
    }
    return null;
  }

  async function createRecord(
    values: BotValues,
    config: IssueBaseConfig,
    input: {
      chatId: string;
      chatName: string;
      rootMessageId: string;
      threadId: string | null;
      title: string;
      senderOpenId: string | null;
      at: number;
    },
  ): Promise<IssueRecord | null> {
    const fields: Record<string, unknown> = {
      标题: input.title,
      状态: ["待处理"],
      提出人ID: input.senderOpenId ?? "",
      群: input.chatName,
      群ID: input.chatId,
      根消息ID: input.rootMessageId,
      话题ID: input.threadId ?? "",
      最近进展: "",
      最后活跃: formatIssueDateTime(input.at),
      是否跟踪: true,
    };
    if (input.senderOpenId?.startsWith("ou_")) {
      fields["提出人"] = [{ id: input.senderOpenId }];
    }
    const create = async (payloadFields: Record<string, unknown>) =>
      call(
        values,
        [
          "base",
          "+record-batch-create",
          "--base-token",
          config.baseToken,
          "--table-id",
          config.tableId,
          "--as",
          "bot",
          "--json",
          JSON.stringify({ create_records: [payloadFields] }),
        ],
        "创建问题记录",
      );
    let payload: LarkPayload;
    try {
      payload = await create(fields);
    } catch (error) {
      // A cross-tenant user field can reject the whole record; the open_id
      // text column is the durable fallback.
      if (!fields["提出人"]) throw error;
      log("写入提出人失败，改为只记录 open_id", errorDetail(error));
      delete fields["提出人"];
      payload = await create(fields);
    }
    const recordId = recordIdOf(payload);
    if (!recordId) {
      log("创建问题记录失败：lark-cli 未返回 record_id");
      return null;
    }
    const record: IssueRecord = {
      recordId,
      chatId: input.chatId,
      rootMessageId: input.rootMessageId,
      threadId: input.threadId,
      requesterOpenId: input.senderOpenId,
      title: input.title,
      status: "待处理",
      lastActiveAt: input.at,
      messageCount: 1,
      updatedAt: now(),
    };
    register(record);
    log(`已登记话题到问题跟踪表：${input.title}`);
    return record;
  }

  async function ensureRecord(
    event: LarkMessageEvent,
    binding: ChatBinding,
    values: BotValues,
  ): Promise<IssueRecord | null> {
    const existing = find(event.chat_id, event.thread_id || event.root_id || event.message_id);
    if (existing) return existing;
    const config = await ensureBase(values, event.chat_id);
    if (!config) return null;
    const rootMessageId = event.root_id || event.message_id;
    const threadId = event.thread_id || null;
    const key = threadId || rootMessageId;
    if (creating.has(key)) return null;
    creating.add(key);
    try {
      const found = await findBaseRecord(values, config, rootMessageId, threadId);
      if (found) {
        const record: IssueRecord = {
          recordId: found.recordId,
          chatId: event.chat_id,
          rootMessageId,
          threadId,
          requesterOpenId: event.sender_id.startsWith("ou_") ? event.sender_id : null,
          title: found.title,
          status: found.status,
          lastActiveAt: now(),
          messageCount: 1,
          updatedAt: now(),
        };
        register(record);
        return record;
      }
      const title = sanitizeTopicText(event.content, 60) || "未命名话题";
      return await createRecord(values, config, {
        chatId: event.chat_id,
        chatName: binding.chatName,
        rootMessageId,
        threadId,
        title,
        senderOpenId: event.sender_id.startsWith("ou_") ? event.sender_id : null,
        at: now(),
      });
    } catch (error) {
      log("登记话题失败", errorDetail(error));
      return null;
    } finally {
      creating.delete(key);
    }
  }

  async function ensureFromRootMessage(
    event: LarkMessageEvent,
    binding: ChatBinding,
    values: BotValues,
    rootMessageId: string,
  ): Promise<IssueRecord | null> {
    const existing = find(event.chat_id, rootMessageId);
    if (existing) return existing;
    try {
      const cli = await cliPath(values);
      const { readMessageDetail } = await import("./lark.ts");
      const detail = await readMessageDetail(cli, rootMessageId);
      const title = sanitizeTopicText(detail?.text ?? "", 60) || "未命名话题";
      const config = await ensureBase(values, event.chat_id);
      if (!config) return null;
      const found = await findBaseRecord(values, config, rootMessageId, event.thread_id ?? null);
      if (found) {
        const record: IssueRecord = {
          recordId: found.recordId,
          chatId: event.chat_id,
          rootMessageId,
          threadId: event.thread_id ?? null,
          requesterOpenId: detail?.senderOpenId ?? null,
          title: found.title,
          status: found.status,
          lastActiveAt: now(),
          messageCount: 1,
          updatedAt: now(),
        };
        register(record);
        return record;
      }
      return await createRecord(values, config, {
        chatId: event.chat_id,
        chatName: binding.chatName,
        rootMessageId,
        threadId: event.thread_id ?? null,
        title,
        senderOpenId: detail?.senderOpenId ?? null,
        at: now(),
      });
    } catch (error) {
      log("补建话题记录失败", errorDetail(error));
      return null;
    }
  }

  async function noteActivity(
    event: LarkMessageEvent,
    binding: ChatBinding,
    values: BotValues,
  ): Promise<void> {
    const key = event.thread_id || event.root_id || "";
    let record = key ? find(event.chat_id, key) : null;
    if (!record && event.root_id) {
      record = await ensureFromRootMessage(event, binding, values, event.root_id);
    }
    if (!record) return;
    record.messageCount += 1;
    record.lastActiveAt = now();
    record.updatedAt = now();
    const last = lastActivityWrite.get(record.recordId) ?? 0;
    if (now() - last < ACTIVITY_WRITE_MS) {
      scheduleSave();
      return;
    }
    lastActivityWrite.set(record.recordId, now());
    try {
      await updateRecord(values, record, {
        最后活跃: formatIssueDateTime(record.lastActiveAt),
      });
    } catch (error) {
      log("更新话题活跃时间失败", errorDetail(error));
    }
    scheduleSave();
  }

  async function updateRecord(
    values: BotValues,
    record: IssueRecord | { recordId: string },
    fields: Record<string, unknown>,
  ): Promise<void> {
    const config = await loadConfig(values, true);
    if (!config) throw new Error("问题跟踪表未配置");
    await call(
      values,
      [
        "base",
        "+record-batch-update",
        "--base-token",
        config.baseToken,
        "--table-id",
        config.tableId,
        "--as",
        "bot",
        "--json",
        JSON.stringify({ update_records: { [record.recordId]: fields } }),
      ],
      "更新问题记录",
    );
  }

  async function setStatus(
    values: BotValues,
    record: IssueRecord,
    status: IssueStatus,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await updateRecord(values, record, { 状态: [status], ...extra });
    record.status = status;
    record.updatedAt = now();
    scheduleSave();
  }

  function createBaseViews(config: IssueBaseConfig, values: BotValues): void {
    const base = ["base", "--base-token", config.baseToken, "--table-id", config.tableId, "--as", "bot"];
    const view = async (args: string[], label: string) => {
      try {
        await call(values, [...base, ...args], label);
      } catch (error) {
        log(`${label}失败（不影响台账使用）`, errorDetail(error));
      }
    };
    void (async () => {
      await view(["+view-create", "--json", JSON.stringify({ name: "问题看板", type: "kanban" })], "创建看板视图");
      await view(["+view-set-group", "--view-id", "问题看板", "--json", JSON.stringify({ group_config: [{ field: "状态", desc: false }] })], "配置看板分组");
      await view(
        ["+view-set-visible-fields", "--view-id", "问题看板", "--json", JSON.stringify({ visible_fields: ["标题", "类型", "提出人", "最后活跃", "最近进展"] })],
        "配置看板字段",
      );
      await view(["+view-create", "--json", JSON.stringify({ name: "待验收", type: "grid" })], "创建待验收视图");
      await view(
        ["+view-set-filter", "--view-id", "待验收", "--json", JSON.stringify({ logic: "and", conditions: [["状态", "intersects", ["待验收"]]] })],
        "配置待验收筛选",
      );
      await view(
        ["+view-set-visible-fields", "--view-id", "待验收", "--json", JSON.stringify({ visible_fields: ["标题", "提出人", "最后活跃", "最近进展"] })],
        "配置待验收字段",
      );
      await view(["+view-create", "--json", JSON.stringify({ name: "已修复待发布", type: "grid" })], "创建待发布视图");
      await view(
        ["+view-set-filter", "--view-id", "已修复待发布", "--json", JSON.stringify({ logic: "and", conditions: [["状态", "intersects", ["已修复"]]] })],
        "配置待发布筛选",
      );
      await view(
        ["+view-set-visible-fields", "--view-id", "已修复待发布", "--json", JSON.stringify({ visible_fields: ["标题", "类型", "提出人", "最后活跃", "最近进展"] })],
        "配置待发布字段",
      );
      await view(["+view-create", "--json", JSON.stringify({ name: "未关闭", type: "grid" })], "创建未关闭视图");
      await view(
        ["+view-set-filter", "--view-id", "未关闭", "--json", JSON.stringify({ logic: "and", conditions: [["状态", "intersects", ["待处理", "处理中", "待验收", "已修复"]]] })],
        "配置未关闭筛选",
      );
      await view(
        ["+view-set-visible-fields", "--view-id", "未关闭", "--json", JSON.stringify({ visible_fields: ["标题", "状态", "类型", "提出人", "最后活跃", "最近进展"] })],
        "配置未关闭字段",
      );
    })();
  }

  async function createBase(values: BotValues, chatIds: string[] = []): Promise<IssueBaseConfig> {
    const name = values.issueBaseName.trim() || DEFAULT_BASE_NAME;
    const payload = await call(
      values,
      [
        "base",
        "+base-create",
        "--name",
        name,
        "--table-name",
        ISSUE_TABLE_NAME,
        "--time-zone",
        ISSUE_TIME_ZONE,
        "--as",
        "bot",
        "--fields",
        JSON.stringify(ISSUE_FIELD_DEFINITIONS),
      ],
      "创建问题跟踪表",
    );
    const coordinates = baseCoordinates(payload);
    if (!coordinates.baseToken) throw new Error("创建成功但 lark-cli 未返回 base_token");
    let tableId = coordinates.tableId;
    if (!tableId) {
      const tables = await call(
        values,
        ["base", "+table-list", "--base-token", coordinates.baseToken, "--as", "bot", "--format", "json"],
        "读取问题跟踪表",
      );
      const data = (tables.data ?? {}) as Record<string, unknown>;
      const list = Array.isArray(data.tables) ? data.tables : [];
      const match = list.find(
        (item) => item && typeof item === "object" && (item as Record<string, unknown>).name === ISSUE_TABLE_NAME,
      ) as Record<string, unknown> | undefined;
      const first = (match ?? (list[0] as Record<string, unknown> | undefined))?.id;
      if (typeof first === "string" && first) tableId = first;
    }
    if (!tableId) throw new Error("创建成功但找不到首表 table_id");
    const config: IssueBaseConfig = {
      version: 1,
      baseToken: coordinates.baseToken,
      tableId,
      baseUrl: coordinates.baseUrl,
      name,
      createdAt: now(),
    };
    saveLocalConfig(config);
    const targets = chatIds.length > 0
      ? chatIds
      : values.chats.filter((chat) => chat.issueTracking === "auto").map((chat) => chat.chatId);
    for (const chatId of [...new Set(targets)]) {
      if (!chatId.startsWith("oc_")) continue;
      try {
        await call(
          values,
          [
            "drive",
            "+member-add",
            "--token",
            config.baseToken,
            "--type",
            "bitable",
            "--member-type",
            "openchat",
            "--member-id",
            chatId,
            "--perm",
            "edit",
            "--as",
            "bot",
            "--yes",
          ],
          "授权群访问问题跟踪表",
        );
      } catch (error) {
        log(`授权群 ${chatId} 访问问题跟踪表失败`, errorDetail(error));
      }
    }
    createBaseViews(config, values);
    return config;
  }

  async function verifyBase(values: BotValues): Promise<{ ok: boolean; missing: string[] }> {
    const config = await loadConfig(values, true);
    if (!config) return { ok: false, missing: [...ISSUE_FIELD_NAMES] };
    const payload = await call(
      values,
      ["base", "+field-list", "--base-token", config.baseToken, "--table-id", config.tableId, "--as", "bot", "--format", "json"],
      "检查问题跟踪表字段",
    );
    const data = (payload.data ?? {}) as Record<string, unknown>;
    const list = Array.isArray(data.fields) ? data.fields : [];
    const names = new Set(
      list
        .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>).name : null))
        .filter((name): name is string => typeof name === "string"),
    );
    const missing = ISSUE_FIELD_NAMES.filter((name) => !names.has(name));
    return { ok: missing.length === 0, missing };
  }

  function observe(event: LarkMessageEvent, binding: ChatBinding, values?: BotValues): void {
    if (binding.issueTracking !== "auto") return;
    if (event.sender_type === "bot" || event.message_type === "system") return;
    const isRoot = !event.root_id && !event.reply_to && Boolean(event.thread_id);
    void (async () => {
      const current = await valuesFor(values);
      if (isRoot) {
        await ensureRecord(event, binding, current);
        return;
      }
      await noteActivity(event, binding, current);
    })().catch((error) => log("问题跟踪采集失败", errorDetail(error)));
  }

  function markWorking(event: LarkMessageEvent, binding: ChatBinding, values?: BotValues): void {
    if (binding.issueTracking !== "auto") return;
    if (event.sender_type === "bot") return;
    void (async () => {
      const current = await valuesFor(values);
      const record =
        find(event.chat_id, event.thread_id || event.root_id || event.message_id) ??
        (event.root_id
          ? await ensureFromRootMessage(event, binding, current, event.root_id)
          : await ensureRecord(event, binding, current));
      if (!record) return;
      if (record.status === "已修复" || record.status === "已发布" || record.status === "已关闭") return;
      const fields: Record<string, unknown> = {
        状态: ["处理中"],
        最后活跃: formatIssueDateTime(now()),
      };
      await updateRecord(current, record, fields);
      record.status = "处理中";
      record.updatedAt = now();
      scheduleSave();
    })().catch((error) => log("更新问题状态为处理中失败", errorDetail(error)));
  }

  function updateProgress(input: {
    chatId: string;
    topicKey: string;
    summary: string | null;
    agentId?: string | null;
    values?: BotValues;
  }): void {
    void (async () => {
      const current = await valuesFor(input.values);
      const record = find(input.chatId, input.topicKey);
      if (!record) return;
      const summary = clip(input.summary ?? "", 500);
      const fields: Record<string, unknown> = {
        最后活跃: formatIssueDateTime(now()),
      };
      if (summary) fields["最近进展"] = summary;
      if (input.agentId) fields["Paseo 会话"] = input.agentId;
      if (record.status === "待处理") {
        fields["状态"] = ["处理中"];
        record.status = "处理中";
      }
      await updateRecord(current, record, fields);
      record.updatedAt = now();
      scheduleSave();
    })().catch((error) => log("更新问题进展失败", errorDetail(error)));
  }

  async function markDone(input: {
    chatId: string;
    topicKey: string;
    summary: string | null;
    agentId?: string | null;
    values?: BotValues;
  }): Promise<IssueRecord | null> {
    const current = await valuesFor(input.values);
    const record = find(input.chatId, input.topicKey);
    if (!record) return null;
    if (record.status === "已修复" || record.status === "已发布" || record.status === "已关闭") return record;
    const summary = clip(input.summary ?? "", 500) || "已处理完成，等待验收";
    const fields: Record<string, unknown> = {
      状态: ["待验收"],
      最近进展: summary,
      最后活跃: formatIssueDateTime(now()),
    };
    if (input.agentId) fields["Paseo 会话"] = input.agentId;
    await updateRecord(current, record, fields);
    record.status = "待验收";
    record.updatedAt = now();
    scheduleSave();
    return record;
  }

  function recordFor(recordId: string): IssueRecord | null {
    return byRecord.get(recordId) ?? null;
  }

  function recordForTopic(chatId: string, topicKey: string): IssueRecord | null {
    return find(chatId, topicKey);
  }

  async function accept(recordId: string, operatorOpenId: string, values?: BotValues): Promise<IssueRecord | null> {
    const current = await valuesFor(values);
    const record = byRecord.get(recordId);
    if (!record || record.status !== "待验收") return null;
    const fields: Record<string, unknown> = {
      状态: ["已修复"],
      验收人: operatorOpenId.startsWith("ou_") ? [{ id: operatorOpenId }] : [],
      验收时间: formatIssueDateTime(now()),
      最近进展: clip(`${record.title} · 提出人已验收`, 500),
    };
    await updateRecord(current, record, fields);
    record.status = "已修复";
    record.updatedAt = now();
    scheduleSave();
    return record;
  }

  async function reject(
    recordId: string,
    operatorOpenId: string,
    note: string | null,
    values?: BotValues,
  ): Promise<IssueRecord | null> {
    const current = await valuesFor(values);
    const record = byRecord.get(recordId);
    if (!record || record.status !== "待验收") return null;
    const reason = clip(note ?? "提出人验收未通过", 400);
    await updateRecord(current, record, {
      状态: ["处理中"],
      最近进展: reason,
      最后活跃: formatIssueDateTime(now()),
      验收人: [],
      验收时间: null,
    });
    void operatorOpenId;
    record.status = "处理中";
    record.updatedAt = now();
    scheduleSave();
    return record;
  }

  async function release(recordId: string, operatorOpenId: string, values?: BotValues): Promise<IssueRecord | null> {
    const current = await valuesFor(values);
    const record = byRecord.get(recordId);
    if (!record) return null;
    if (record.status !== "待验收" && record.status !== "已修复") return null;
    void operatorOpenId;
    await updateRecord(current, record, {
      状态: ["已发布"],
      最近进展: clip("已发布上线，等待线上验证", 500),
      最后活跃: formatIssueDateTime(now()),
    });
    record.status = "已发布";
    record.updatedAt = now();
    scheduleSave();
    return record;
  }

  async function close(
    recordId: string,
    operatorOpenId: string,
    reason: string | null,
    values?: BotValues,
  ): Promise<IssueRecord | null> {
    const current = await valuesFor(values);
    const record = byRecord.get(recordId);
    if (!record) return null;
    void operatorOpenId;
    await updateRecord(current, record, {
      状态: ["已关闭"],
      最近进展: clip(reason ?? "已关闭", 500),
      最后活跃: formatIssueDateTime(now()),
    });
    record.status = "已关闭";
    record.updatedAt = now();
    scheduleSave();
    return record;
  }

  async function query(
    chatId: string,
    filter: "open" | "mine" | "pending" | "all",
    senderId: string,
    values?: BotValues,
  ): Promise<IssueQueryResult> {
    const current = await valuesFor(values);
    const config = await loadConfig(current, true);
    if (!config) return { items: [], total: 0, error: "问题跟踪表未配置" };
    const conditions: unknown[][] = [["群ID", "==", chatId]];
    if (filter === "pending") conditions.push(["状态", "intersects", ["待验收"]]);
    if (filter === "open") conditions.push(["状态", "intersects", OPEN_STATUSES]);
    if (filter === "mine") conditions.push(["提出人ID", "==", senderId]);
    try {
      const payload = await call(
        current,
        [
          "base",
          "+record-list",
          "--base-token",
          config.baseToken,
          "--table-id",
          config.tableId,
          "--as",
          "bot",
          "--format",
          "json",
          "--limit",
          "50",
          "--filter-json",
          JSON.stringify({ logic: "and", conditions }),
          "--sort-json",
          JSON.stringify([{ field: "最后活跃", desc: true }]),
          "--field-id",
          "标题",
          "--field-id",
          "状态",
          "--field-id",
          "类型",
          "--field-id",
          "最近进展",
          "--field-id",
          "最后活跃",
        ],
        "查询问题列表",
      );
      const { fields, rows, ids, hasMore } = parseRecordMatrix(payload);
      const items: IssueQueryItem[] = rows
        .map((row, index) => {
          const recordId = ids[index];
          if (!recordId) return null;
          return {
            recordId,
            title: cellText(cell(row, fields, "标题")),
            status: cellStatus(cell(row, fields, "状态")),
            type: cellText(cell(row, fields, "类型")),
            lastActive: cellText(cell(row, fields, "最后活跃")),
            progress: cellText(cell(row, fields, "最近进展")),
            url: issueRecordUrl(config, recordId),
          } satisfies IssueQueryItem;
        })
        .filter((item): item is IssueQueryItem => item !== null);
      return { items, total: hasMore ? items.length + 1 : items.length, error: null };
    } catch (error) {
      return { items: [], total: 0, error: errorDetail(error) };
    }
  }

  return {
    observe,
    markWorking,
    updateProgress,
    markDone,
    accept,
    reject,
    release,
    close,
    query,
    recordFor,
    recordForTopic,
    config: (values?: BotValues) => loadConfig(values),
    createBase,
    verifyBase,
    flush,
  };
}

/** Construct a clickable Base record URL from the configured coordinates. */
export function issueRecordUrl(config: IssueBaseConfig, recordId: string): string {
  const base = config.baseUrl.trim() || `https://feishu.cn/base/${config.baseToken}`;
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}table=${encodeURIComponent(config.tableId)}&record=${encodeURIComponent(recordId)}`;
}

/** Human-readable list for `/issues`; keeps the command layer thin. */
export function formatIssueList(result: IssueQueryResult, filter: string): string {
  if (result.error) return `查询问题失败：${result.error}`;
  if (result.items.length === 0) return "没有匹配的问题。";
  const label =
    filter === "mine" ? "我提的问题" : filter === "pending" ? "待验收" : filter === "all" ? "全部问题" : "未关闭";
  const lines = [`**${label}（${result.items.length}${result.total > result.items.length ? "+" : ""}）**`];
  for (const item of result.items.slice(0, 10)) {
    const meta = [item.status, item.type].filter(Boolean).join(" · ");
    lines.push(`- \`${meta}\` ${item.title || "未命名"}`);
    if (item.progress) lines.push(`  ${clip(item.progress, 80)}`);
    lines.push(`  ${item.url}`);
  }
  if (result.items.length > 10) lines.push(`…还有 ${result.items.length - 10} 条，打开跟踪表查看。`);
  return lines.join("\n");
}

// ── Helper installed into the agent's PATH ────────────────────────────────

const ISSUE_HELPER_SCRIPT = "lark-bot-issue.mjs";
const ISSUE_HELPER_WRAPPER = "lark-bot-issue";

function issueHelperSource(): string {
  return [
    "// Generated by paseo-lark-bot. Queues one issue-status update into the plugin outbox.",
    "import { mkdirSync, renameSync, writeFileSync } from 'node:fs';",
    "import { randomUUID } from 'node:crypto';",
    "import { dirname, join } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "const args = process.argv.slice(2);",
    "let summary = '';",
    "let chatId = process.env.LARK_BOT_CHAT_ID || '';",
    "let topicKey = process.env.LARK_BOT_TOPIC || '';",
    "let outbox = process.env.LARK_BOT_ISSUE_OUTBOX || '';",
    "let action = 'done';",
    "for (let i = 0; i < args.length; i += 1) {",
    "  const arg = args[i];",
    "  const value = args[i + 1];",
    "  if (arg === '--help' || arg === '-h') {",
    "    console.log('usage: lark-bot-issue [done] [--summary TEXT] [--chat CHAT_ID] [--topic TOPIC_KEY]');",
    "    process.exit(0);",
    "  }",
    "  if (arg === 'done') { action = 'done'; continue; }",
    "  if (value === undefined) { console.error('missing value for ' + arg); process.exit(2); }",
    "  if (arg === '--summary' || arg === '-s') { summary = value; i += 1; continue; }",
    "  if (arg === '--chat') { chatId = value; i += 1; continue; }",
    "  if (arg === '--topic') { topicKey = value; i += 1; continue; }",
    "  if (arg === '--outbox') { outbox = value; i += 1; continue; }",
    "  console.error('unknown option: ' + arg); process.exit(2);",
    "}",
    "if (!outbox) {",
    "  const root = dirname(dirname(fileURLToPath(import.meta.url)));",
    "  outbox = join(root, 'outbox', 'issues');",
    "}",
    "if (!chatId) { console.error('missing chat id (--chat or LARK_BOT_CHAT_ID)'); process.exit(2); }",
    "if (!topicKey) { console.error('missing topic key (--topic or LARK_BOT_TOPIC)'); process.exit(2); }",
    "mkdirSync(outbox, { recursive: true });",
    "const target = join(outbox, randomUUID() + '.json');",
    "const temporary = target + '.tmp';",
    "writeFileSync(temporary, JSON.stringify({ version: 1, action, chatId, topicKey, summary: summary.trim() || null }), { mode: 0o600 });",
    "renameSync(temporary, target);",
    "console.log('queued: ' + target);",
  ].join("\n") + "\n";
}

/** Install the small helper the agent calls when it believes the fix is done. */
export function installIssueHelper(root: string, execPath: string): string {
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const script = join(binDir, ISSUE_HELPER_SCRIPT);
  writeFileSync(script, issueHelperSource(), { mode: 0o644 });
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  const wrapper = join(binDir, ISSUE_HELPER_WRAPPER);
  writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  chmodSync(wrapper, 0o755);
  return wrapper;
}

export const issueHelperRequestSchema = z.object({
  version: z.number().default(1),
  action: z.enum(["done"]).default("done"),
  chatId: z.string().min(1),
  topicKey: z.string().min(1),
  summary: z.string().nullable().default(null),
});
export type IssueHelperRequest = z.output<typeof issueHelperRequestSchema>;

export interface IssueOutboxWatcher {
  tick(): Promise<void>;
  start(): void;
  stop(): void;
}

/** Poll the helper outbox; requests are tiny and idempotent at the topic level. */
export function createIssueOutboxWatcher(options: {
  dir: string;
  onRequest: (request: IssueHelperRequest) => Promise<void>;
  log?: (message: string, detail?: unknown) => void;
  intervalMs?: number;
}): IssueOutboxWatcher {
  const log = options.log ?? defaultLog;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let processing = false;

  async function processFile(file: string): Promise<void> {
    const path = join(options.dir, file);
    let request: IssueHelperRequest;
    try {
      const parsed = issueHelperRequestSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (!parsed.success) {
        log("忽略无效的问题状态请求", parsed.error.issues[0]?.message ?? file);
        renameSync(path, join(options.dir, file.replace(/\.json$/, ".failed")));
        return;
      }
      request = parsed.data;
    } catch (error) {
      log("读取问题状态请求失败", errorDetail(error));
      try {
        renameSync(path, join(options.dir, file.replace(/\.json$/, ".failed")));
      } catch {
        // Already gone.
      }
      return;
    }
    try {
      await options.onRequest(request);
      renameSync(path, join(options.dir, file.replace(/\.json$/, ".done")));
    } catch (error) {
      log("处理问题状态请求失败", errorDetail(error));
      try {
        renameSync(path, join(options.dir, file.replace(/\.json$/, ".failed")));
      } catch {
        // Already gone.
      }
    }
  }

  async function tick(): Promise<void> {
    if (stopped || processing) return;
    processing = true;
    try {
      const { readdirSync } = await import("node:fs");
      let files: string[];
      try {
        files = readdirSync(options.dir)
          .filter((name) => name.endsWith(".json"))
          .sort()
          .slice(0, 5);
      } catch {
        return;
      }
      for (const file of files) await processFile(file);
    } finally {
      processing = false;
    }
  }

  return {
    tick,
    start(): void {
      if (timer || stopped) return;
      void tick();
      timer = setInterval(() => void tick(), options.intervalMs ?? 2_000);
      timer.unref?.();
    },
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
