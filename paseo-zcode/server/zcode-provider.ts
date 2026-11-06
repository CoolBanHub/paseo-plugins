import { mkdirSync } from "node:fs";
import { zcodeFailurePresentation } from "./zcode-error-present";
import { homedir, } from "node:os";
import { join } from "node:path";
import {
  PROVIDER_PROTOCOL_VERSION,
  negotiateProviderCapabilities,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderRegistration,
  type ProviderCatalog,
  type ProviderCommand,
  type ProviderContent,
  type ProviderModel,
  type ProviderMode,
  type ProviderSessionSummary,
  type ProviderThinkingOption,
  type ProviderToolCallDetail,
  type ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import {
  ZcodeProtocolClient,
  resolveNodePath,
  resolveZcodeCliPath,
  type ZcodeServerRequest,
  type ZcodeSessionEvent,
} from "./zcode-protocol";
import {
  readAccountProviders,
  readBuiltinRevision,
  readLastTurnFailure,
  readOAuthTokenSet,
  registerAccountProviders,
  resolveZcodeAppVersion,
  type AccountProvider,
} from "./zcode-account";
import { resolveAccountRequestAuth } from "./zcode-account-oauth";
import { ZcodeTaskIndex } from "./zcode-task-index";
import { zcodeCatalogCacheKey } from "./zcode-catalog-key";

const SUPPORTED_CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "session.list",
  "session.persistence",
  "session.configure",
  "session.archive",
  "session.unarchive",
  "permission",
  "session.subsession",
] as const;

/** Tools whose execution spawns a ZCode subagent child session. */
const AGENT_TOOL_NAMES = new Set(["Agent", "Task"]);

/**
 * Delays for the `session/subagents` reconciliation passes. A subagent child
 * session only exists shortly after the Agent tool call starts executing, so
 * discovery is scheduled after the tool call streams in and revisited once the
 * call settles. The app-server does not push child session events to
 * subscribers, so adopted children are polled at `subagentPollMs`. Exposed for
 * tests.
 */
export const subagentSyncTiming = {
  spawnMs: 1200,
  spawnFollowUpMs: 6000,
  settledMs: 400,
  subagentPollMs: 2000,
  /** Delay before re-reading a just-ended child to catch late-persisted rows. */
  backfillMs: 2500,
};

// Labels and descriptions mirror the ZCode desktop app's zh-CN strings
// (mode.label.glm.* / mode.description.glm.*); ids stay protocol-level.
const ZCODE_MODES: ProviderMode[] = [
  { id: "plan", label: "计划模式", description: "编辑前先出计划。" },
  { id: "build", label: "变更前确认", description: "改文件前先问我。" },
  { id: "edit", label: "自动编辑", description: "自动编辑文件。" },
  { id: "guarded", label: "自主模式", description: "在有风险时询问" },
  { id: "yolo", label: "完全访问", description: "减少确认次数。", isUnattended: true },
];

const ZCODE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

interface ZcodeImageAttachment {
  kind: "image";
  filename: string;
  mimeType: string;
  sizeBytes: number;
  dataBase64: string;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function imageMimeType(mimeType: string, data: string): string {
  if (mimeType !== "image/*") return mimeType;
  const bytes = Buffer.from(data.slice(0, 64), "base64");
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "image/jpeg";
}

function toZcodeImageAttachment(part: Extract<ProviderContent, { type: "image" }>, index: number): ZcodeImageAttachment {
  let mimeType = part.mimeType.trim().toLowerCase().split(";", 1)[0];
  let data = part.data.trim();
  const dataUrl = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/iu.exec(data);
  if (dataUrl) {
    data = dataUrl[2];
    if (mimeType === "image/*") mimeType = dataUrl[1].toLowerCase();
  } else if (data.startsWith("data:")) {
    throw new Error("ZCode image attachments must use a base64 data URL");
  }
  mimeType = imageMimeType(mimeType, data);
  if (!/^image\/[a-z0-9.+-]+$/u.test(mimeType)) {
    throw new Error("Unsupported ZCode image MIME type: " + part.mimeType);
  }

  const compact = data.replace(/\s+/gu, "");
  const unpadded = compact.replace(/=+$/u, "");
  if (!unpadded || !/^[A-Za-z0-9+/]+$/u.test(unpadded) || unpadded.length % 4 === 1) {
    throw new Error("ZCode image data is not valid base64");
  }
  const dataBase64 = unpadded + "=".repeat((4 - unpadded.length % 4) % 4);
  const bytes = Buffer.from(dataBase64, "base64");
  if (bytes.length === 0) throw new Error("ZCode image data is empty");
  if (bytes.length > ZCODE_IMAGE_MAX_BYTES) {
    throw new Error("ZCode images must be 20 MiB or smaller (received " + (bytes.length / 1024 / 1024).toFixed(1) + " MiB)");
  }
  return {
    kind: "image",
    filename: "image-" + (index + 1) + "." + (IMAGE_EXTENSIONS[mimeType] ?? "img"),
    mimeType,
    sizeBytes: bytes.length,
    dataBase64: bytes.toString("base64"),
  };
}

export function prepareZcodePrompt(content: ProviderContent[]): {
  text: string;
  attachments?: ZcodeImageAttachment[];
} {
  const text: string[] = [];
  const attachments: ZcodeImageAttachment[] = [];
  for (const part of content) {
    if (part.type === "text") {
      text.push(part.text);
    } else if (part.type === "image") {
      attachments.push(toZcodeImageAttachment(part, attachments.length));
    } else if (part.type === "uploaded_file" && part.mimeType.toLowerCase().startsWith("image/")) {
      throw new Error("This image was uploaded as a file without readable image data; attach it as an image instead");
    }
  }
  return {
    text: text.join("").trim(),
    ...(attachments.length ? { attachments } : {}),
  };
}

interface ZcodeModelSelection {
  providerId: string;
  modelId: string;
  options?: { reasoningLevel: string };
}

interface ZcodeTarget {
  targetID?: string;
  objective?: string;
  summaryTitle?: string | null;
  status?: "active" | "paused" | "budget_limited" | "complete";
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
}

interface ZcodeSlashCommand {
  name: string;
  description: string;
  inputHint?: string;
  source?: "builtin" | "custom";
}

interface CreateOrResumeResult {
  session: {
    sessionId: string;
    sessionKind?: string;
    status?: string;
    mode?: string;
    title?: string;
    model?: ZcodeModelSelection | null;
    target?: ZcodeTarget | null;
    workspace?: { workspacePath?: string; workspaceKey?: string };
  };
  settings?: {
    mode?: { current?: string };
    model?: {
      current?: ZcodeModelSelection | null;
      available?: Array<{
        ref: { providerId: string; modelId: string };
        label: string;
        providerLabel?: string;
        contextWindow?: number;
        reasoning?: { levels?: Array<{ value: string; label?: string }>; defaultLevel?: string };
      }>;
    };
    thoughtLevel?: { current?: string };
  };
  runtime?: {
    stateRevision?: number;
    eventSeq?: number;
    activeTurnKind?: "regular" | "compact" | "rewind";
    contextUsage?: { used?: number; size?: number };
  };
  projection?: {
    contextWindow?: number;
    contextUsed?: number;
    status?: string;
    mode?: string;
    target?: ZcodeTarget | null;
    backgroundJobs?: Array<Record<string, unknown>>;
  };
  slashCommands?: ZcodeSlashCommand[];
  todos?: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
    priority?: "high" | "medium" | "low";
  }>;
  messages?: unknown[];
}

interface PendingPermission {
  request: ZcodeServerRequest;
  logicalId?: string;
  kind: "permission" | "user_input" | "question";
  answer?: string;
  /** Original question batch for mapping Paseo's form answers back. */
  questions?: Array<Record<string, unknown>>;
}

/** One entry of the ZCode `session/subagents` listing. */
interface SubagentRef {
  childSessionId?: string;
  agentId?: string;
  toolCallId?: string;
  subagentType?: string;
  title?: string;
  status?: string;
  summary?: string;
  ended?: boolean;
}

interface SessionSubagentsResult {
  childSessionIds?: string[];
  running?: SubagentRef[];
  ended?: { total?: number; items?: SubagentRef[] };
}

/** A ZCode subagent child session attached to a parent Paseo session. */
interface SubagentChildRecord {
  paseoSessionId: string;
  childSessionId: string;
  toolCallId?: string;
  title?: string;
  adopted: boolean;
  /** Signatures of timeline rows already forwarded for this child. */
  emittedRows?: Set<string>;
  /** Set once the child's final turn state has been reported. */
  terminalEmitted?: boolean;
  pollTimer?: ReturnType<typeof setTimeout>;
  pollGeneration?: number;
}

function endedSubagentTurnState(status: string | undefined): "completed" | "failed" | "canceled" {
  if (status === "cancelled" || status === "canceled") return "canceled";
  if (status === "failed" || status === "timed_out" || status === "spawn_error" || status === "lost") return "failed";
  return "completed";
}

interface TurnState {
  turnId: string;
  started: boolean;
  text: string;
  reasoning: string;
  assistantMessageId?: string;
  emittedAssistant: Set<string>;
  /** First generated content (text, reasoning or tool input) of the open decode window. */
  firstContentAt?: number;
  /** Summed generated-content time across this turn's model requests. */
  decodeMs: number;
  tools: Map<string, {
    name: string;
    input?: Record<string, unknown>;
    outcome?: "completed" | "failed";
    error?: string;
    log?: string;
  }>;
}

interface SessionState {
  /** Session ID assigned by Paseo; all ProviderEvents must use this. */
  paseoSessionId: string;
  /** Session ID from the ZCode CLI; used for app-server calls. */
  zcodeSessionId: string;
  turns: Map<string, TurnState>;
  contextWindow?: number;
  contextUsed?: number;
  pendingClientMessageId?: string;
  modelSelection?: ZcodeModelSelection;
  mode?: string;
  ready: boolean;
  /** Set once Paseo closed the session; late async work must not emit events. */
  closed?: boolean;
  revision?: number;
  modeEventSeq?: number;
  catalog?: ProviderCatalog;
  /** True when this state represents a subagent child session. */
  child?: boolean;
  cwd?: string;
  /** Subagent children keyed by ZCode child session id; parents only. */
  subagents?: Map<string, SubagentChildRecord>;
  subagentSyncTimers?: Set<ReturnType<typeof setTimeout>>;
  subagentSyncRunning?: boolean;
  subagentSyncQueued?: boolean;
  /** Last emitted command catalog / goal / usage signatures. */
  commandsSignature?: string;
  goalSignature?: string;
  goalActive?: boolean;
  usageSignature?: string;
  compactionId?: string;
  compactionTrigger?: "manual" | "auto";
  goalRefreshTimer?: ReturnType<typeof setTimeout>;
}

function modelId(ref: { providerId: string; modelId: string }): string {
  return `${ref.providerId}::${ref.modelId}`;
}

function parseModelId(id: string): { providerId: string; modelId: string } | undefined {
  const parts = id.split("::");
  if (parts.length === 2 && parts[0] && parts[1]) return { providerId: parts[0], modelId: parts[1] };
  return undefined;
}

function resolveModelSelection(
  catalog: ProviderCatalog,
  id: string | undefined,
  thinkingOption?: string | null,
  previousThinkingOption?: string,
): ZcodeModelSelection {
  const ref = id ? parseModelId(id) : undefined;
  const model = catalog.models.find((entry) => entry.id === id);
  if (!ref || !model) throw new Error(`ZCode model is unavailable: ${id ?? "none"}`);
  const levels = model.thinkingOptions ?? [];
  if (thinkingOption && !levels.some((level) => level.id === thinkingOption)) {
    throw new Error(`Reasoning effort "${thinkingOption}" is not supported by ${id}`);
  }
  const preferred = thinkingOption === null ? undefined : thinkingOption ?? previousThinkingOption;
  const reasoningLevel = levels.find((level) => level.id === preferred)?.id
    ?? levels.find((level) => level.id === model.defaultThinkingOptionId)?.id
    ?? levels.at(-1)?.id;
  return reasoningLevel ? { ...ref, options: { reasoningLevel } } : ref;
}

function buildCatalog(result: CreateOrResumeResult): ProviderCatalog {
  const available = result.settings?.model?.available ?? [];
  const models: ProviderModel[] = available.map((entry) => {
    const thinkingOptions: ProviderThinkingOption[] | undefined = entry.reasoning?.levels?.map((level) => ({
      id: level.value,
      label: level.label ?? level.value,
    }));
    const model: ProviderModel = {
      id: modelId(entry.ref),
      label: `${entry.providerLabel ?? entry.ref.providerId}/${entry.label}`,
      description: entry.providerLabel,
      contextWindowMaxTokens: entry.contextWindow,
    };
    if (thinkingOptions?.length) {
      model.thinkingOptions = thinkingOptions;
      model.defaultThinkingOptionId = entry.reasoning?.defaultLevel;
    }
    return model;
  });
  const selection = result.settings?.model?.current ?? result.session.model;
  const current = selection ? modelId(selection) : undefined;
  const catalog: ProviderCatalog = {
    models,
    modes: ZCODE_MODES,
    defaultModel: models.find((m) => m.id === current)?.id ?? models[0]?.id,
    defaultMode: result.settings?.mode?.current ?? result.projection?.mode ?? result.session.mode ?? "build",
  };
  return catalog;
}

/** Tool input can arrive as an object or as a JSON-encoded string. */
function readToolInput(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Tool input that is not JSON stays opaque; the row falls back to its name.
    }
  }
  return undefined;
}

/** ZCode persists some tool parts with the original call under `state.raw`. */
function readRawToolInput(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return readToolInput((parsed as Record<string, unknown>).input);
  } catch {
    return undefined;
  }
}

/**
 * Timeline rows need a visible summary. When the tool input never reached the
 * stream (for example a tool scheduled without a preceding model streaming
 * event), structured details such as shell/read would render as a bare label,
 * so fall back to a plain text row until input arrives.
 */
function buildTimelineToolDetail(
  name: string,
  input: Record<string, unknown> | undefined,
): ProviderToolCallDetail {
  const detail = buildToolDetail(name, input);
  switch (detail.type) {
    case "shell":
      return detail.command.trim() ? detail : { type: "plain_text", label: name };
    case "read":
      return detail.filePath.trim() ? detail : { type: "plain_text", label: name };
    case "edit":
    case "write":
      return detail.filePath.trim() ? detail : { type: "plain_text", label: name };
    case "search":
      return detail.query.trim() ? detail : { type: "plain_text", label: name };
    case "fetch":
      return detail.url.trim() ? detail : { type: "plain_text", label: name };
    default:
      return detail;
  }
}

function buildToolDetail(name: string, input: Record<string, unknown> | undefined): ProviderToolCallDetail {
  const i = input ?? {};
  switch (name) {
    case "Bash":
      return { type: "shell", command: String(i.command ?? "") };
    case "Read":
      return { type: "read", filePath: String(i.file_path ?? i.filePath ?? "") };
    case "Edit":
    case "MultiEdit":
      return {
        type: "edit",
        filePath: String(i.file_path ?? i.filePath ?? ""),
        oldString: typeof i.old_string === "string" ? i.old_string : undefined,
        newString: typeof i.new_string === "string" ? i.new_string : undefined,
      };
    case "Write":
      return { type: "write", filePath: String(i.file_path ?? i.filePath ?? ""), content: String(i.content ?? "") };
    case "Grep":
    case "Glob":
      return { type: "search", query: String(i.query ?? i.pattern ?? ""), toolName: name === "Grep" ? "grep" : "glob" };
    case "WebSearch":
      return { type: "search", query: String(i.query ?? ""), toolName: "web_search" };
    case "WebFetch":
      return { type: "fetch", url: String(i.url ?? "") };
    case "Agent":
    case "Task":
      return {
        type: "sub_agent",
        subAgentType: typeof i.subagent_type === "string" ? i.subagent_type : undefined,
        description: typeof i.description === "string" ? i.description : undefined,
        log: "",
      };
    default:
      return { type: "plain_text", label: name };
  }
}

function withOutput(detail: ProviderToolCallDetail, output: unknown): ProviderToolCallDetail {
  const text = typeof output === "string" ? output : output === undefined ? "" : JSON.stringify(output);
  switch (detail.type) {
    case "shell":
      return { ...detail, output: text.slice(0, 8000) };
    case "read":
      return { ...detail, content: text.slice(0, 8000) };
    case "search":
      return { ...detail, content: text.slice(0, 4000) };
    case "fetch":
      return { ...detail, result: text.slice(0, 4000) };
    case "sub_agent":
      return { ...detail, log: text.slice(0, 8000) };
    default:
      return detail;
  }
}

function emitTodos(
  emit: (event: ProviderEvent) => void,
  state: SessionState,
  todos: CreateOrResumeResult["todos"],
): void {
  if (!todos) return;
  emit({
    type: "timeline.item",
    sessionId: state.paseoSessionId,
    item: {
      type: "todo",
      id: `zcode:${state.zcodeSessionId}:todos`,
      items: todos.map((todo, index) => ({
        id: `zcode:${state.zcodeSessionId}:todo:${index}`,
        text: todo.content,
        completed: todo.status === "completed",
        status: todo.status,
      })),
    },
  });
}

function emitBackgroundJob(
  emit: (event: ProviderEvent) => void,
  state: SessionState,
  job: Record<string, unknown>,
): void {
  if (typeof job.taskId !== "string" || !job.taskId) return;
  const rawStatus = String(job.status ?? "running").toLowerCase();
  const status = rawStatus === "failed" || rawStatus === "error"
    ? "failed"
    : rawStatus === "cancelled" || rawStatus === "canceled"
      ? "canceled"
      : rawStatus === "completed" || rawStatus === "success" || rawStatus === "done"
        ? "completed"
        : "running";
  const command = typeof job.command === "string" ? job.command : "";
  const output = typeof job.outputTail === "string"
    ? job.outputTail
    : [job.stdoutTail, job.stderrTail].filter((value): value is string => typeof value === "string").join("\n");
  const detail = withOutput({ type: "shell", command }, output);
  const identity = `zcode:background:${job.taskId}`;
  emit({
    type: "timeline.item",
    sessionId: state.paseoSessionId,
    item: status === "failed"
      ? {
          type: "tool_call",
          id: identity,
          callId: String(job.toolCallId ?? job.taskId),
          name: String(job.toolName ?? "Background task"),
          status,
          error: String(job.error ?? job.blockedReason ?? output ?? "Background task failed"),
          detail,
        }
      : {
          type: "tool_call",
          id: identity,
          callId: String(job.toolCallId ?? job.taskId),
          name: String(job.toolName ?? "Background task"),
          status,
          error: null,
          detail,
        },
  });
}

/** ZCode slash commands the plugin can execute through this provider. */
const SUPPORTED_BUILTIN_COMMANDS = new Set(["compact", "goal", "fork"]);

/** Builtins the plugin can run even when an older snapshot omits them. */
const FALLBACK_BUILTIN_COMMANDS: ProviderCommand[] = [
  { name: "compact", description: "压缩当前会话，可附加摘要说明", argumentHint: "[instructions]" },
  { name: "goal", description: "查看或设置当前会话目标", argumentHint: "[pause|resume|clear|replace <objective>|<objective>]" },
  { name: "fork", description: "从检查点创建分支会话", argumentHint: "[latest|checkpointId]" },
];

/** Provider-local commands for ZCode background tasks and session usage. */
const SYNTHETIC_COMMANDS: ProviderCommand[] = [
  { name: "tasks", description: "列出 ZCode 后台任务" },
  { name: "stop-task", description: "停止一个 ZCode 后台任务", argumentHint: "<taskId>" },
  { name: "usage", description: "查看当前 ZCode 会话的 token 用量" },
];

let commandNoticeSeq = 0;

function emitCommands(
  emit: (event: ProviderEvent) => void,
  state: SessionState,
  slashCommands: ZcodeSlashCommand[] | undefined,
): void {
  if (state.child) return;
  const byName = new Map<string, ProviderCommand>();
  for (const command of slashCommands ?? []) {
    if (!command || typeof command.name !== "string" || !command.name.trim()) continue;
    const name = command.name.trim().toLowerCase();
    if (command.source !== "custom" && !SUPPORTED_BUILTIN_COMMANDS.has(name)) continue;
    if (byName.has(name)) continue;
    byName.set(name, {
      name,
      description: typeof command.description === "string" ? command.description : name,
      ...(typeof command.inputHint === "string" && command.inputHint
        ? { argumentHint: command.inputHint }
        : {}),
    });
  }
  for (const command of FALLBACK_BUILTIN_COMMANDS) {
    if (!byName.has(command.name)) byName.set(command.name, command);
  }
  for (const command of SYNTHETIC_COMMANDS) {
    if (!byName.has(command.name)) byName.set(command.name, command);
  }
  const commands = [...byName.values()];
  const signature = JSON.stringify(commands);
  if (signature === state.commandsSignature) return;
  state.commandsSignature = signature;
  emit({ type: "session.commands", sessionId: state.paseoSessionId, commands });
}

function goalStatus(target: ZcodeTarget): { status: "running" | "completed"; label: string } {
  if (target.status === "complete") return { status: "completed", label: "Goal · complete" };
  if (target.status === "paused") return { status: "running", label: "Goal · paused" };
  if (target.status === "budget_limited") return { status: "running", label: "Goal · budget limited" };
  return { status: "running", label: "Goal · active" };
}

function emitGoal(
  emit: (event: ProviderEvent) => void,
  state: SessionState,
  target: ZcodeTarget | null | undefined,
): void {
  if (!target || typeof target.objective !== "string" || !target.objective.trim()) {
    if (!state.goalActive) return;
    state.goalActive = false;
    state.goalSignature = undefined;
    emit({
      type: "timeline.item",
      sessionId: state.paseoSessionId,
      item: {
        type: "tool_call",
        id: `zcode:${state.paseoSessionId}:goal`,
        callId: `zcode:${state.paseoSessionId}:goal`,
        name: "Goal",
        status: "completed",
        error: null,
        detail: { type: "plain_text", label: "Goal", text: "目标已清除", icon: "sparkles" },
      },
    });
    return;
  }
  const signature = JSON.stringify({
    objective: target.objective,
    status: target.status,
    tokensUsed: target.tokensUsed,
    tokenBudget: target.tokenBudget,
    timeUsedSeconds: target.timeUsedSeconds,
  });
  if (signature === state.goalSignature) return;
  state.goalSignature = signature;
  state.goalActive = true;
  const { status, label } = goalStatus(target);
  const lines = [target.objective];
  if (typeof target.tokensUsed === "number") {
    lines.push(
      "Tokens: " + target.tokensUsed +
      (typeof target.tokenBudget === "number" ? " / " + target.tokenBudget : ""),
    );
  }
  if (typeof target.timeUsedSeconds === "number") lines.push("Time: " + target.timeUsedSeconds + "s");
  emit({
    type: "timeline.item",
    sessionId: state.paseoSessionId,
    item: {
      type: "tool_call",
      id: `zcode:${state.paseoSessionId}:goal`,
      callId: `zcode:${state.paseoSessionId}:goal`,
      name: "Goal",
      status,
      error: null,
      detail: {
        type: "plain_text",
        label,
        text: lines.join("\n"),
        icon: "sparkles",
      },
    },
  });
}

function emitUsageContext(
  emit: (event: ProviderEvent) => void,
  state: SessionState,
  used: number | undefined,
  size: number | undefined,
): void {
  const usedTokens = typeof used === "number" ? used : state.contextUsed;
  const maxTokens = typeof size === "number" ? size : state.contextWindow;
  if (usedTokens === undefined && maxTokens === undefined) return;
  if (usedTokens !== undefined) state.contextUsed = usedTokens;
  const signature = String(usedTokens) + "/" + String(maxTokens);
  if (signature === state.usageSignature) return;
  state.usageSignature = signature;
  emit({
    type: "session.usage",
    sessionId: state.paseoSessionId,
    usage: {
      ...(maxTokens !== undefined ? { contextWindowMaxTokens: maxTokens } : {}),
      ...(usedTokens !== undefined ? { contextWindowUsedTokens: usedTokens } : {}),
    },
  });
}

function emitCompaction(
  emit: (event: ProviderEvent) => void,
  state: SessionState,
  status: "loading" | "completed",
  trigger: "manual" | "auto",
  preTokens?: number,
): void {
  if (!state.compactionId) {
    state.compactionId = `zcode:${state.paseoSessionId}:compact:${Date.now()}`;
    state.compactionTrigger = trigger;
  }
  emit({
    type: "timeline.item",
    sessionId: state.paseoSessionId,
    item: {
      type: "compaction",
      id: state.compactionId,
      status,
      trigger: state.compactionTrigger ?? trigger,
      ...(typeof preTokens === "number" ? { preTokens } : {}),
    },
  });
  if (status === "completed") {
    state.compactionId = undefined;
    state.compactionTrigger = undefined;
  }
}

function emitCommandNotice(
  emit: (event: ProviderEvent) => void,
  state: SessionState,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  const text = message.trim();
  if (!text) return;
  commandNoticeSeq += 1;
  emit({
    type: "timeline.item",
    sessionId: state.paseoSessionId,
    item: {
      type: "notification",
      id: `zcode:${state.paseoSessionId}:command:${Date.now()}:${commandNoticeSeq}`,
      level,
      message: text,
    },
  });
}

function parseGoalCommand(args: string): { action: "show" | "set" | "replace" | "pause" | "resume" | "clear"; objective?: string } {
  const trimmed = args.trim();
  if (!trimmed) return { action: "show" };
  const [head, ...rest] = trimmed.split(/\s+/u);
  if (head === "pause" || head === "resume" || head === "clear") {
    return { action: head };
  }
  if (head === "replace") {
    const objective = rest.join(" ").trim();
    return objective ? { action: "replace", objective } : { action: "show" };
  }
  return { action: "set", objective: trimmed };
}

function parseForkTarget(args: string): Record<string, unknown> {
  const trimmed = args.trim();
  if (!trimmed || trimmed === "latest") return { kind: "latestCheckpoint" };
  return { kind: "checkpoint", checkpointId: trimmed };
}

function formatUsage(result: Record<string, unknown>): string {
  const entries: Array<[string, unknown]> = [
    ["total", result.totalTokens],
    ["input", result.inputTokens],
    ["output", result.outputTokens],
    ["reasoning", result.reasoningTokens],
    ["cache read", result.cacheReadTokens],
    ["cache write", result.cacheCreationTokens],
    ["requests", result.modelRequestCount],
    ["errors", result.modelErrorCount],
  ];
  return entries
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([label, value]) => label + ": " + value)
    .join("\n");
}

function formatTokenCount(value: number): string {
  if (value < 1000) return String(value);
  const scaled = value / 1000;
  return `${scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10}k`;
}

/**
 * Generation throughput for one turn: ZCode reports aggregate output tokens in
 * `turn.completed`, while the plugin accumulates each generated segment's
 * first-content → boundary time. This is the same decode-only definition
 * ZCode's own `tokensPerSecond` debug figure uses (`durationMs -
 * timeToFirstContentMs`); because the app-server forwards only delta frames,
 * a tool call or the turn completion closes the segment.
 */
function formatGenerationSpeed(outputTokens: number | undefined, decodeMs: number): string | undefined {
  if (outputTokens === undefined || outputTokens <= 0 || decodeMs <= 0) return undefined;
  const tps = outputTokens / (decodeMs / 1000);
  if (!Number.isFinite(tps) || tps <= 0) return undefined;
  return `${tps >= 10 ? Math.round(tps) : Math.round(tps * 10) / 10} tok/s`;
}

function openDecodeWindow(turn: TurnState, at: number): void {
  if (turn.firstContentAt === undefined) turn.firstContentAt = at;
}

function closeDecodeWindow(turn: TurnState, at: number): void {
  if (turn.firstContentAt === undefined) return;
  turn.decodeMs += Math.max(0, at - turn.firstContentAt);
  turn.firstContentAt = undefined;
}

/** One compact per-turn token accounting row, including the decode speed. */
function emitTurnUsage(
  emit: (event: ProviderEvent) => void,
  state: SessionState,
  turn: TurnState,
  usage: Record<string, unknown>,
): void {
  const output = typeof usage.outputTokens === "number" ? usage.outputTokens : undefined;
  const speed = formatGenerationSpeed(output, turn.decodeMs);
  if (!speed) return;
  const parts: string[] = [];
  if (typeof usage.inputTokens === "number") parts.push(`输入 ${formatTokenCount(usage.inputTokens)}`);
  if (typeof usage.cacheReadTokens === "number") parts.push(`缓存读 ${formatTokenCount(usage.cacheReadTokens)}`);
  if (typeof usage.cacheWriteTokens === "number" && usage.cacheWriteTokens > 0) {
    parts.push(`缓存写 ${formatTokenCount(usage.cacheWriteTokens)}`);
  }
  if (output !== undefined) parts.push(`输出 ${formatTokenCount(output)}`);
  parts.push(`速度 ${speed}`);
  emit({
    type: "timeline.item",
    sessionId: state.paseoSessionId,
    item: {
      type: "notification",
      id: `zcode:${state.paseoSessionId}:usage:${turn.turnId}`,
      level: "info",
      message: `Token 用量：${parts.join(" · ")}`,
    },
  });
}

function historyOutput(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value === undefined ? undefined : JSON.stringify(value);
  const chunks = value
    .filter((part): part is Record<string, unknown> => !!part && typeof part === "object")
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter(Boolean);
  return chunks.length ? chunks.join("\n") : undefined;
}

/** Convert the native ZCode snapshot returned by session/read into Paseo timeline rows. */
export function zcodeHistoryTimelineItems(
  messages: unknown,
  sessionId: string,
  childSessionIds?: Map<string, string>,
): ProviderTimelineItem[] {
  if (!Array.isArray(messages)) return [];
  const items: ProviderTimelineItem[] = [];
  for (const [messageIndex, raw] of messages.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as Record<string, unknown>;
    const info = message.info && typeof message.info === "object"
      ? message.info as Record<string, unknown>
      : undefined;
    // Only replay transcript rows ZCode explicitly marked user-visible. Older
    // or incomplete snapshots without visibility metadata must not leak the
    // injected runtime context that shares the same message store.
    const semantics = info?.semantics && typeof info.semantics === "object"
      ? info.semantics as Record<string, unknown>
      : undefined;
    if (semantics?.transcriptVisibility !== "visible") continue;
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const role = info?.role;
    const messageId = typeof info?.messageId === "string" ? info.messageId : `zcode:history:${sessionId}:${messageIndex}`;
    // Persisted compaction/fork/verification markers are message parts, not
    // model text. Surface them before the role-specific replay below.
    for (const [partIndex, rawPart] of parts.entries()) {
      if (!rawPart || typeof rawPart !== "object") continue;
      const part = rawPart as Record<string, unknown>;
      const partId = typeof part.partId === "string" ? part.partId : `${messageId}:part:${partIndex}`;
      if (part.type === "compaction") {
        items.push({
          type: "compaction",
          id: partId,
          status: "completed",
          trigger: part.auto === true ? "auto" : "manual",
        });
        continue;
      }
      if (part.type !== "timeline") continue;
      if (part.timelineType === "context_compaction") {
        const failed = part.status === "failed" || part.status === "error";
        items.push({
          type: "compaction",
          id: partId,
          status: "completed",
          trigger: part.trigger === "manual" ? "manual" : "auto",
          ...(typeof part.preCompactTokenCount === "number" ? { preTokens: part.preCompactTokenCount } : {}),
        });
        if (failed) {
          items.push({
            type: "notification",
            id: `${partId}:failed`,
            level: "warning",
            message: "上下文压缩失败" + (typeof part.reason === "string" && part.reason ? "：" + part.reason : ""),
          });
        }
      } else if (part.timelineType === "goal_verification") {
        const verification = part.verification && typeof part.verification === "object"
          ? part.verification as Record<string, unknown>
          : {};
        const passed = verification.passed === true;
        items.push({
          type: "notification",
          id: partId,
          level: passed ? "info" : "warning",
          message: "Goal verification " + (passed ? "passed" : "not satisfied") +
            (typeof verification.reason === "string" && verification.reason ? "：" + verification.reason : ""),
        });
      } else if (part.timelineType === "session_fork") {
        items.push({
          type: "notification",
          id: partId,
          level: "info",
          message: "会话已从此处创建分支" +
            (typeof part.targetCheckpointId === "string" && part.targetCheckpointId
              ? "（" + part.targetCheckpointId + "）"
              : ""),
        });
      }
    }
    if (role === "user") {
      const text = parts
        .filter((part): part is Record<string, unknown> => !!part && typeof part === "object")
        .map((part) => part.type === "text" && typeof part.text === "string" ? part.text
          : part.type === "image" ? "[图片]" : part.type === "file" ? "[文件]" : "")
        .filter(Boolean)
        .join("");
      if (text) items.push({ type: "user_message", id: messageId, messageId, text });
      continue;
    }
    if (role !== "assistant") continue;
    let pendingText = "";
    let textIndex = 0;
    const flushText = () => {
      if (!pendingText) return;
      const id = `${messageId}:text:${textIndex++}`;
      items.push({ type: "assistant_message", id, messageId: id, text: pendingText });
      pendingText = "";
    };
    for (const [partIndex, rawPart] of parts.entries()) {
      if (!rawPart || typeof rawPart !== "object") continue;
      const part = rawPart as Record<string, unknown>;
      const partId = typeof part.partId === "string" ? part.partId : `${messageId}:part:${partIndex}`;
      if (part.type === "text" && typeof part.text === "string") {
        pendingText += part.text;
      } else if (part.type === "reasoning" && typeof part.text === "string" && part.text) {
        flushText();
        items.push({ type: "reasoning", id: partId, text: part.text });
      } else if (part.type === "tool") {
        flushText();
        const name = typeof part.tool === "string" ? part.tool : typeof part.name === "string" ? part.name : "tool";
        const callId = typeof part.callId === "string" ? part.callId : `${messageId}:tool:${partIndex}`;
        const snapshot = part.state && typeof part.state === "object" ? part.state as Record<string, unknown> : {};
        const rawStatus = String(snapshot.status ?? part.status ?? "completed");
        const status = rawStatus === "error" || rawStatus === "failed" ? "failed"
          : rawStatus === "running" || rawStatus === "pending" ? "running" : "completed";
        const input = readToolInput(snapshot.input)
          ?? readToolInput(part.input)
          ?? readToolInput(part.arguments)
          ?? readRawToolInput(snapshot.raw);
        const output = historyOutput(snapshot.output);
        let detail = output === undefined
          ? buildTimelineToolDetail(name, input)
          : withOutput(buildTimelineToolDetail(name, input), output);
        const childSessionId = childSessionIds?.get(callId);
        if (childSessionId && detail.type === "sub_agent") {
          detail = { ...detail, childSessionId };
        }
        items.push(status === "failed"
          ? { type: "tool_call", id: callId, callId, name, status, error: String(snapshot.error ?? output ?? `${name} failed`), detail }
          : { type: "tool_call", id: callId, callId, name, status, error: null, detail });
      }
    }
    flushText();
  }
  return items;
}

interface CatalogCache {
  at: number;
  catalog: ProviderCatalog;
}
const CATALOG_TTL_MS = 60_000;

export function createZcodeProvider(): ProviderRegistration {
  return {
    id: "zcode",
    label: "ZCode",
    description: "ZCode (GLM) coding agent running locally through the ZCode app-server protocol.",
    icon: "zcode.svg",
    getCatalogCacheKey: async () => zcodeCatalogCacheKey({ cliPath: resolveZcodeCliPath() }),
    connect: async (request) => {
      const cliPath = resolveZcodeCliPath();
      const log = (message: string, detail?: unknown) =>
        console.log(`[zcode-provider] ${message}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600));

      log("connect requested", { offered: request.capabilities });
      if (!cliPath) {
        throw new Error(
          "ZCode CLI not found. Install the ZCode desktop app or set ZCODE_CLI_PATH to zcode.cjs.",
        );
      }

      const dataDir = join(process.env.PASEO_HOME ?? join(process.env.HOME ?? "~", ".paseo"), "plugin-data", "zcode");
      const bridgeDir = join(dataDir, "bridge");
      mkdirSync(bridgeDir, { recursive: true });

      const client = new ZcodeProtocolClient({ cliPath, nodePath: resolveNodePath(), cwd: bridgeDir, onLog: log });
      // An app-server crash used to leave subscribed sessions "ready" with a
      // dead event stream: turns never ended and Paseo hung. Fail loudly
      // instead — the session closes in Paseo and reopening resumes it.
      client.onProcessExit((info) => {
        const spawnError = info.spawnError ? `（${info.spawnError.message}）` : "";
        for (const state of sessions.values()) {
          if (!state.ready || state.closed || state.child) continue;
          state.ready = false;
          state.pendingClientMessageId = undefined;
          for (const [turnId, turn] of state.turns) {
            if (!turn.started) continue;
            emit({
              type: "session.turn",
              sessionId: state.paseoSessionId,
              turnId,
              state: "failed",
              error: { message: `zcode app-server 意外退出${spawnError}，本轮已中止` },
            });
          }
          emit({
            type: "session.runtime_failed",
            sessionId: state.paseoSessionId,
            error: { message: `zcode app-server 意外退出${spawnError}；重新打开会话可继续` },
          });
        }
      });
      const taskIndex = new ZcodeTaskIndex(cliPath);
      let catalogCache: CatalogCache | undefined;
      // Keyed by zcode session id for event lookup.
      const sessions = new Map<string, SessionState>();
      // Paseo session id -> zcode session id for input handling.
      const zcodeIdFor = new Map<string, string>();
      const permissions = new Map<string, PendingPermission>();
      // Permissions that are never answered must not accumulate forever; at
      // capacity the oldest entries (and their pending-id index rows) go.
      const rememberPermission = (permissionId: string, entry: PendingPermission) => {
        permissions.set(permissionId, entry);
        if (permissions.size > 256) {
          const oldest = permissions.keys().next().value;
          if (oldest !== undefined) {
            const dropped = permissions.get(oldest);
            permissions.delete(oldest);
            if (dropped?.logicalId && pendingPermissionIds.get(dropped.logicalId) === oldest) {
              pendingPermissionIds.delete(dropped.logicalId);
            }
          }
        }
      };
      const pendingPermissionIds = new Map<string, string>();
      const accountProviders: AccountProvider[] = readAccountProviders({
        onSkip: (providerId, reason) => log("account provider skipped", { providerId, reason }),
      });
      const zcodeAppVersion = resolveZcodeAppVersion(cliPath);
      let accountProvidersRegistered = false;

      // Account providers must be registered before they can be used.
      const ensureAccountProviders = async () => {
        if (accountProvidersRegistered || !accountProviders.length) return;
        // Force the CLI to start, then wait for its registry-ready log line.
        const spawnedAt = Date.now();
        await client.request("session/list", {}).catch(() => undefined);
        let revision: string | undefined;
        for (let i = 0; i < 30 && !revision; i++) {
          revision = readBuiltinRevision(spawnedAt);
          if (!revision) await new Promise((r) => setTimeout(r, 300));
        }
        if (!revision) {
          log("account providers not registered: builtin revision not found");
          return;
        }
        try {
          await registerAccountProviders(
            (method, params) => client.request(method, params),
            accountProviders,
            revision,
          );
          accountProvidersRegistered = true;
          log("account providers registered", accountProviders.map((p) => p.providerId));
        } catch (error) {
          log("account provider registration failed", String(error));
        }
      };

      let listener: ((event: ProviderEvent) => void) | undefined;
      let queued: ProviderEvent[] = [];
      const emit = (event: ProviderEvent) => {
        if (listener) listener(event);
        else {
          queued.push(event);
          // A listener that never attaches must not grow the queue forever.
          if (queued.length > 2_000) queued.splice(0, queued.length - 2_000);
        }
      };

      const stateFor = (paseoSessionId: string, zcodeSessionId: string): SessionState => {
        let state = sessions.get(zcodeSessionId);
        if (!state) {
          state = {
            paseoSessionId,
            zcodeSessionId,
            turns: new Map(),
            ready: false,
            subagents: new Map(),
          };
          sessions.set(zcodeSessionId, state);
          zcodeIdFor.set(paseoSessionId, zcodeSessionId);
        }
        return state;
      };

      const applyOfficialState = (state: SessionState, snapshot: Partial<CreateOrResumeResult>): void => {
        if (snapshot.session?.sessionId && snapshot.session.sessionId !== state.zcodeSessionId) {
          throw new Error("ZCode returned a snapshot for a different session");
        }
        const revision = snapshot.runtime?.stateRevision;
        if (revision !== undefined && state.revision !== undefined && revision < state.revision) return;
        if (revision !== undefined) state.revision = revision;
        const settings = snapshot.settings;
        const selection = settings?.model?.current ?? snapshot.session?.model;
        if (selection) {
          const reasoningLevel = selection.options?.reasoningLevel ?? settings?.thoughtLevel?.current;
          state.modelSelection = {
            providerId: selection.providerId,
            modelId: selection.modelId,
            ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
          };
        } else if (settings?.thoughtLevel && state.modelSelection) {
          const reasoningLevel = settings.thoughtLevel.current;
          state.modelSelection = {
            providerId: state.modelSelection.providerId,
            modelId: state.modelSelection.modelId,
            ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
          };
        }
        // The session projection can retain the mode from its last message;
        // settings.mode.current is the live selection confirmed by ZCode.
        const snapshotMode = settings?.mode?.current ?? snapshot.projection?.mode ?? snapshot.session?.mode;
        if (snapshotMode && !(state.mode === "plan" && snapshotMode === "build")) {
          state.mode = snapshotMode;
        }
        if (settings?.model?.available) {
          const incoming = buildCatalog({ session: { sessionId: state.zcodeSessionId }, settings }).models;
          const models = new Map((state.catalog?.models ?? []).map((model) => [model.id, model]));
          for (const model of incoming) models.set(model.id, model);
          state.catalog = { ...state.catalog, models: [...models.values()], modes: state.catalog?.modes ?? ZCODE_MODES };
        }
        const selected = state.catalog?.models.find((model) => model.id === (state.modelSelection && modelId(state.modelSelection)));
        state.contextWindow = snapshot.projection?.contextWindow ?? selected?.contextWindowMaxTokens ?? state.contextWindow;
        if (typeof snapshot.projection?.contextUsed === "number") {
          state.contextUsed = snapshot.projection.contextUsed;
        }
      };

      client.onStateUpdate((update) => {
        const state = sessions.get(update.sessionId);
        if (!state || (update.scope && update.scope !== "session")
          || (state.revision !== undefined && update.revision < state.revision)) return;
        const patch = update.patch && typeof update.patch === "object" && !Array.isArray(update.patch)
          ? update.patch as Record<string, unknown>
          : {};
        applyOfficialState(state, {
          settings: update.patch as CreateOrResumeResult["settings"],
          runtime: { stateRevision: update.revision },
        });
        if (state.ready && state.catalog) emitSessionConfig(state, state.catalog);
        const reason = typeof update.reason === "string" ? update.reason : "";
        if (reason === "compact_started") {
          emitCompaction(emit, state, "loading", state.compactionTrigger ?? "auto");
        } else if (reason === "session_compacted") {
          emitCompaction(emit, state, "completed", state.compactionTrigger ?? "auto");
          scheduleGoalRefresh(state);
        } else if (reason === "session_compact_failed" || reason === "session_compact_cancelled") {
          emitCompaction(emit, state, "completed", state.compactionTrigger ?? "auto");
          emitCommandNotice(
            emit,
            state,
            reason === "session_compact_cancelled" ? "上下文压缩已取消" : "上下文压缩失败",
            "warning",
          );
          scheduleGoalRefresh(state);
        } else if (reason.includes("goal")) {
          scheduleGoalRefresh(state);
        }
        if (patch.target !== undefined) emitGoal(emit, state, patch.target as ZcodeTarget | null);
      });

      const turnFor = (state: SessionState, turnId: string): TurnState => {
        let turn = state.turns.get(turnId);
        if (!turn) {
          turn = {
            turnId,
            started: false,
            text: "",
            reasoning: "",
            emittedAssistant: new Set(),
            decodeMs: 0,
            tools: new Map(),
          };
          state.turns.set(turnId, turn);
        }
        return turn;
      };

      const emitAssistantOnce = (state: SessionState, turn: TurnState, text: string) => {
        const hash = text.trim();
        if (!hash || turn.emittedAssistant.has(hash)) return;
        turn.emittedAssistant.add(hash);
        emit({
          type: "timeline.item",
          sessionId: state.paseoSessionId,
          item: { type: "assistant_message", id: turn.assistantMessageId ?? turn.turnId, text },
        });
      };

      const flushReasoning = (state: SessionState, turn: TurnState) => {
        if (!turn.reasoning.trim()) return;
        const text = turn.reasoning;
        turn.reasoning = "";
        emit({
          type: "timeline.item",
          sessionId: state.paseoSessionId,
          item: {
            type: "reasoning",
            id: `${turn.assistantMessageId ?? turn.turnId}:reasoning:${turn.emittedAssistant.size}`,
            text,
          },
        });
      };

      client.onServerRequest((request) => {
        if (request.method === "interaction/requestProviderRuntimeHeaders") {
          const providerId = String(request.params?.providerId ?? "");
          const account = accountProviders.find((p) => p.providerId === providerId);
          if (!account) {
            client.replyServerRequest(request.id, { headersApplied: false });
            return true;
          }
          if (!account.oauth) {
            if (account.apiKey) {
              client.replyServerRequest(request.id, { headersApplied: true, requestAuth: { apiKey: account.apiKey } });
            } else {
              client.replyServerRequest(request.id, { headersApplied: false, errorMessage: "账号凭据不可用" });
            }
            return true;
          }

          // The desktop may refresh the OAuth token between turns; pick up the
          // newest file contents before computing the account scope.
          const fresh = readOAuthTokenSet(account.family);
          if (fresh) {
            account.oauth = {
              ...account.oauth,
              accessToken: fresh.accessToken,
              zcodeJwtToken: fresh.zcodeJwtToken,
            };
          }

          void resolveAccountRequestAuth(account.oauth, request.params ?? {}, { clientVersion: zcodeAppVersion })
            .then((result) => {
              try {
                client.replyServerRequest(request.id, result);
              } catch {
                // The app-server may have exited while the token exchange was in flight.
              }
            })
            .catch((error) => {
              log("account request auth failed", {
                providerId,
                error: error instanceof Error ? error.message : String(error),
              });
              try {
                client.replyServerRequest(request.id, { headersApplied: false, errorMessage: "账号凭据解析失败" });
              } catch {
                // Ignore a reply to a process that is already gone.
              }
            });
          return true;
        }
        if (request.method === "interaction/requestPermission") {
          const params = request.params ?? {};
          const zcodeSessionId = String(params.sessionId ?? "");
          const toolName = String(params.toolName ?? params.tool ?? "permission");
          const logicalId = typeof params.requestId === "string" && params.requestId
            ? `${zcodeSessionId}:${params.requestId}`
            : undefined;
          log("permission request", { sessionId: zcodeSessionId, toolName, requestId: params.requestId });
          const state = sessions.get(zcodeSessionId);
          if (!state) {
            log("permission for unknown session, denying", zcodeSessionId);
            client.replyServerRequest(request.id, { approved: false });
            return true;
          }
          if (logicalId && pendingPermissionIds.has(logicalId)) {
            log("permission reannouncement coalesced", { sessionId: zcodeSessionId, toolName });
            return true;
          }
          const permissionId = String(request.id);
          rememberPermission(permissionId, { request, logicalId, kind: "permission" });
          if (logicalId) pendingPermissionIds.set(logicalId, permissionId);
          const options = Array.isArray(params.options) ? (params.options as Array<Record<string, unknown>>) : [];
          const toolInput = params.input && typeof params.input === "object" && !Array.isArray(params.input)
            ? params.input as Record<string, unknown>
            : undefined;
          const command = typeof toolInput?.command === "string" ? toolInput.command : undefined;
          emit({
            type: "session.permission",
            sessionId: state.paseoSessionId,
            request: {
              id: permissionId,
              name: toolName,
              kind: "tool",
              title: String(params.title ?? params.prompt ?? toolName),
              description: typeof params.description === "string"
                ? params.description
                : typeof params.reason === "string" ? params.reason : command,
              detail: toolInput ? buildToolDetail(toolName, toolInput) : undefined,
              actions: options.slice(0, 4).map((option) => {
                const raw = String(option.id ?? option.value ?? option.kind ?? "approve");
                const isDeny = /deny|reject|cancel/i.test(raw);
                return {
                  id: raw,
                  label: String(option.label ?? option.name ?? (isDeny ? "Deny" : "Allow")),
                  behavior: isDeny ? ("deny" as const) : ("allow" as const),
                };
              }),
            },
          });
          return true;
        }
        if (request.method === "interaction/requestUserInput") {
          const params = request.params ?? {};
          const zcodeSessionId = String(params.sessionId ?? "");
          const state = sessions.get(zcodeSessionId);
          const schema = params.schema && typeof params.schema === "object" && !Array.isArray(params.schema)
            ? params.schema as Record<string, unknown>
            : undefined;
          const input = params.input && typeof params.input === "object" && !Array.isArray(params.input)
            ? params.input as Record<string, unknown>
            : undefined;
          const toolName = String(params.toolName ?? schema?.toolName ?? "user_input");
          const logicalId = typeof params.requestId === "string" && params.requestId
            ? `${zcodeSessionId}:${params.requestId}`
            : undefined;
          const questions = Array.isArray(params.questions) ? params.questions as Array<Record<string, unknown>> : [];
          if (!state) {
            log("user input for unknown session, declining", zcodeSessionId);
            client.replyServerRequest(request.id, { action: "decline" });
            return true;
          }
          if (logicalId && pendingPermissionIds.has(logicalId)) {
            log("user input reannouncement coalesced", { sessionId: zcodeSessionId, toolName });
            return true;
          }

          const isPlanApproval = schema?.interaction === "plan_approval"
            || toolName === "ExitPlanMode";
          if (!isPlanApproval) {
            const headers = new Set<string>();
            const entries: Array<Record<string, unknown>> = [];
            const formQuestions = questions.map((question, index) => {
              const questionText = typeof question.question === "string" ? question.question : "";
              const base = (typeof question.header === "string" && question.header.trim())
                ? question.header.trim()
                : questionText.trim().slice(0, 40) || `Question ${index + 1}`;
              let header = base;
              let suffix = 2;
              while (headers.has(header)) header = `${base} (${suffix++})`;
              headers.add(header);
              const options = Array.isArray(question.options)
                ? question.options
                  .filter((option): option is Record<string, unknown> => !!option && typeof option === "object")
                  .map((option) => {
                    const label = String(option.label ?? option.value ?? "").trim() || "Option";
                    const description = typeof option.description === "string"
                      ? option.description
                      : typeof option.preview === "string" ? option.preview : undefined;
                    return { label, ...(description ? { description } : {}) };
                  })
                : [];
              entries.push({ header, question: questionText, options });
              return {
                header,
                question: questionText,
                options,
                multiSelect: question.multiSelect === true,
                allowOther: true,
                allowEmpty: options.length === 0,
              };
            });
            if (!formQuestions.length) {
              log("user input request without questions, declining", { sessionId: zcodeSessionId, toolName });
              client.replyServerRequest(request.id, { action: "decline" });
              return true;
            }
            const permissionId = String(request.id);
            rememberPermission(permissionId, {
              request,
              logicalId,
              kind: "question",
              questions: entries,
            });
            if (logicalId) pendingPermissionIds.set(logicalId, permissionId);
            emit({
              type: "session.permission",
              sessionId: state.paseoSessionId,
              request: {
                id: permissionId,
                name: toolName,
                kind: "question",
                title: String(formQuestions[0]?.header ?? "Question"),
                description: typeof questions[0]?.question === "string" ? questions[0].question as string : undefined,
                input: { questions: formQuestions },
                actions: [],
              },
            });
            return true;
          }

          log("user input request", {
            sessionId: zcodeSessionId,
            toolName,
            requestId: params.requestId,
            kind: "plan",
          });
          const permissionId = String(request.id);
          const firstQuestion = questions[0];
          const options = firstQuestion && Array.isArray(firstQuestion.options)
            ? firstQuestion.options as Array<Record<string, unknown>>
            : [];
          const actions = options.slice(0, 3).map((option) => {
            const raw = String(option.value ?? option.id ?? option.optionId ?? option.label ?? "answer");
            return {
              id: raw,
              label: raw === "approve" ? "批准并开始实施" : String(option.label ?? option.name ?? raw),
              behavior: "allow" as const,
              intent: "implement_resume" as const,
            };
          });
          const fallbackAnswer = "approve";
          const plan = typeof input?.plan === "string" ? input.plan : undefined;
          permissions.set(permissionId, {
            request,
            logicalId,
            kind: "user_input",
            answer: fallbackAnswer,
          });
          if (logicalId) pendingPermissionIds.set(logicalId, permissionId);
          emit({
            type: "session.permission",
            sessionId: state.paseoSessionId,
            request: {
              id: permissionId,
              name: toolName,
              kind: "plan",
              title: "请求批准实施计划",
              description: firstQuestion && typeof firstQuestion.question === "string"
                ? firstQuestion.question
                : "批准后退出计划模式并开始实施。",
              detail: plan ? { type: "plan", text: plan } : undefined,
              // Paseo's plan card renders the body from metadata.planText
              // (falling back to input.plan); detail is not displayed here.
              metadata: plan ? { planText: plan } : undefined,
              actions: [
                ...(actions.length ? actions : [{
                  id: fallbackAnswer,
                  label: "批准并开始实施",
                  behavior: "allow" as const,
                  intent: "implement_resume" as const,
                }]),
                { id: "decline", label: "拒绝计划", behavior: "deny" as const, intent: "dismiss" as const },
              ],
            },
          });
          return true;
        }
        return false;
      });

      client.onSessionEvent((event: ZcodeSessionEvent) => {
        const state = sessions.get(event.sessionId);
        if (!state) return;
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        const turn = event.turnId ? turnFor(state, event.turnId) : undefined;

        if (event.type === "zcode.turn_failed") {
          // Early failure (model/auth/quota) reported outside the session/event
          // stream; recover the reason from the CLI log when possible.
          const rawReason = readLastTurnFailure(event.sessionId) ?? "Turn failed before producing output";
          const reason = zcodeFailurePresentation({ message: rawReason }) || rawReason;
          const clientMessageId = state.pendingClientMessageId;
          state.pendingClientMessageId = undefined;
          emit({
            type: "timeline.item",
            sessionId: state.paseoSessionId,
            item: { type: "error", id: `error:${event.turnId ?? Date.now()}`, message: reason },
          });
          if (event.turnId && turn?.started) {
            emit({
              type: "session.turn",
              sessionId: state.paseoSessionId,
              turnId: event.turnId,
              state: "failed",
              error: { message: reason },
            });
          }
          if (clientMessageId) {
            emit({
              type: "session.prompt_result",
              sessionId: state.paseoSessionId,
              clientMessageId,
              result: { type: "failed", error: { message: reason } },
            });
          }
          return;
        }

        switch (event.type) {
          case "turn.started": {
            // The user message is already recorded by Paseo itself; emitting a
            // duplicate user_message here would show the prompt twice.
            if (event.turnId) {
              turn!.started = true;
              emit({ type: "session.turn", sessionId: state.paseoSessionId, turnId: event.turnId, state: "started" });
              const clientMessageId = state.pendingClientMessageId;
              if (clientMessageId) {
                state.pendingClientMessageId = undefined;
                emit({
                  type: "session.prompt_result",
                  sessionId: state.paseoSessionId,
                  clientMessageId,
                  result: { type: "turn", turnId: event.turnId },
                });
              }
            }
            break;
          }
          case "model.streaming": {
            if (!turn) break;
            const kind = payload.kind;
            if (typeof payload.assistantMessageId === "string") turn.assistantMessageId = payload.assistantMessageId;
            if (kind === "start") {
              // A new request; the previous window should already have been
              // closed by a finish/tool call, so drop only an incomplete one.
              turn.firstContentAt = undefined;
            } else if (kind === "finish" || kind === "error") {
              closeDecodeWindow(turn, event.timestamp);
            } else if (kind === "text_start" || kind === "reasoning_start" || kind === "tool_input_start"
              || kind === "text_delta" || kind === "reasoning_delta" || kind === "tool_input_delta") {
              openDecodeWindow(turn, event.timestamp);
            }
            if (kind === "reasoning_delta" && typeof payload.delta === "string") {
              turn.reasoning += payload.delta;
            } else if (kind === "text_delta" && typeof payload.delta === "string") {
              turn.text += payload.delta;
            } else if (kind === "tool_call") {
              closeDecodeWindow(turn, event.timestamp);
              flushReasoning(state, turn);
              const toolCallId = String(payload.toolCallId ?? "");
              const toolName = String(payload.toolName ?? "tool");
              const input = readToolInput(payload.input);
              if (toolCallId) {
                const existing = turn.tools.get(toolCallId);
                turn.tools.set(toolCallId, {
                  ...existing,
                  name: toolName,
                  input: input ?? existing?.input,
                });
                emit({
                  type: "timeline.item",
                  sessionId: state.paseoSessionId,
                  item: {
                    type: "tool_call",
                    id: toolCallId,
                    callId: toolCallId,
                    name: toolName,
                    status: "running",
                    error: null,
                    detail: buildTimelineToolDetail(toolName, input ?? existing?.input),
                  },
                });
                if (AGENT_TOOL_NAMES.has(toolName)) {
                  scheduleSubagentSync(state, subagentSyncTiming.spawnMs);
                  scheduleSubagentSync(state, subagentSyncTiming.spawnFollowUpMs);
                }
              }
            }
            break;
          }
          case "session.updated": {
            if (typeof payload.mode === "string"
              && (state.modeEventSeq === undefined || event.seq > state.modeEventSeq)) {
              const mode = payload.planEnabled === true ? "plan" : payload.mode;
              if (ZCODE_MODES.some((candidate) => candidate.id === mode)) {
                state.mode = mode;
                state.modeEventSeq = event.seq;
                if (state.ready && state.catalog) emitSessionConfig(state, state.catalog);
              }
            }
            if (typeof payload.taskId === "string") {
              if (backgroundJobVisible(payload)) emitBackgroundJob(emit, state, payload);
              if (String(payload.taskKind ?? "") === "subagent") scheduleSubagentSync(state, 0);
            } else if (Array.isArray(payload.backgroundJobs)) {
              const jobs = payload.backgroundJobs as Array<Record<string, unknown>>;
              emitVisibleBackgroundJobs(state, jobs);
              if (jobs.some((job) => String(job?.taskKind ?? "") === "subagent")) {
                scheduleSubagentSync(state, 0);
              }
            }
            if (!turn) break;
            if (typeof payload.contextWindow === "number") state.contextWindow = payload.contextWindow;
            if (typeof payload.content === "string" && payload.content.trim()) {
              flushReasoning(state, turn);
              emitAssistantOnce(state, turn, payload.content);
            }
            break;
          }
          case "tool.updated": {
            const toolCallId = String(payload.toolCallId ?? "");
            if (!toolCallId || !turn) break;
            const payloadName = typeof payload.toolName === "string" && payload.toolName ? payload.toolName : undefined;
            const incomingInput = readToolInput(payload.input) ?? readToolInput(payload.arguments);
            if (payload.kind === "scheduled") {
              // ZCode reports the complete tool arguments here. Some tools
              // (notably subagent children) never get a model.streaming
              // tool_call event, so without this branch their rows only know
              // the tool name and render as bare "Shell"/"Read" entries.
              const existing = turn.tools.get(toolCallId);
              const toolName = payloadName ?? existing?.name ?? "tool";
              const input = incomingInput ?? existing?.input;
              turn.tools.set(toolCallId, { ...existing, name: toolName, input });
              emit({
                type: "timeline.item",
                sessionId: state.paseoSessionId,
                item: {
                  type: "tool_call",
                  id: toolCallId,
                  callId: toolCallId,
                  name: toolName,
                  status: "running",
                  error: null,
                  detail: buildTimelineToolDetail(toolName, input),
                },
              });
              if (AGENT_TOOL_NAMES.has(toolName)) {
                scheduleSubagentSync(state, subagentSyncTiming.spawnMs);
                scheduleSubagentSync(state, subagentSyncTiming.spawnFollowUpMs);
              }
            } else if (payload.kind === "started") {
              const existing = turn.tools.get(toolCallId);
              const toolName = payloadName ?? existing?.name ?? "tool";
              const input = incomingInput ?? existing?.input;
              turn.tools.set(toolCallId, { ...existing, name: toolName, input });
              // A scheduled event already published this row with arguments.
              if (existing && existing.name === toolName && existing.input !== undefined && input !== undefined) break;
              emit({
                type: "timeline.item",
                sessionId: state.paseoSessionId,
                item: {
                  type: "tool_call",
                  id: toolCallId,
                  callId: toolCallId,
                  name: toolName,
                  status: "running",
                  error: null,
                  detail: buildTimelineToolDetail(toolName, input),
                },
              });
              if (AGENT_TOOL_NAMES.has(toolName)) {
                scheduleSubagentSync(state, subagentSyncTiming.spawnMs);
                scheduleSubagentSync(state, subagentSyncTiming.spawnFollowUpMs);
              }
            } else if (payload.kind === "result") {
              const existing = turn.tools.get(toolCallId);
              const toolName = payloadName ?? existing?.name ?? "tool";
              const input = incomingInput ?? existing?.input;
              const tool = existing ?? { name: toolName, input };
              tool.name = toolName;
              tool.input = input;
              turn.tools.set(toolCallId, tool);
              const result = (payload.result ?? {}) as Record<string, unknown>;
              const success = result.success !== false;
              const outputText = typeof result.content === "string"
                ? result.content
                : result.content === undefined ? "" : JSON.stringify(result.content);
              tool.outcome = success ? "completed" : "failed";
              tool.log = outputText.slice(0, 8000);
              if (!success) tool.error = String(result.content ?? "tool failed");
              const detail = withOutput(
                buildTimelineToolDetail(tool.name, tool.input),
                result.content,
              );
              const linkedChild = [...(state.subagents?.values() ?? [])].find((entry) => entry.toolCallId === toolCallId);
              if (linkedChild && detail.type === "sub_agent") {
                detail.childSessionId = linkedChild.childSessionId;
              }
              const failureMessage = String(result.content ?? "tool failed");
              emit({
                type: "timeline.item",
                sessionId: state.paseoSessionId,
                item: success
                  ? {
                      type: "tool_call",
                      id: toolCallId,
                      callId: toolCallId,
                      name: tool.name,
                      status: "completed",
                      error: null,
                      detail,
                    }
                  : {
                      type: "tool_call",
                      id: toolCallId,
                      callId: toolCallId,
                      name: tool.name,
                      status: "failed",
                      error: failureMessage,
                      detail,
                    },
              });
              if (tool.name === "TodoWrite") {
                void refreshSession(state).catch((error) => log("todo refresh failed", String(error)));
              }
              if (AGENT_TOOL_NAMES.has(tool.name)) {
                scheduleSubagentSync(state, 0);
              }
            }
            break;
          }
          case "turn.completed": {
            if (!turn || !event.turnId) break;
            flushReasoning(state, turn);
            const response = typeof payload.response === "string" ? payload.response : turn.text;
            emitAssistantOnce(state, turn, response);
            const usage = (payload.usage ?? {}) as Record<string, unknown>;
            const resultType = String(payload.resultType ?? "success");
            // A user pause ends the turn with resultType "cancelled"; report it as
            // a canceled turn so Paseo settles quietly instead of surfacing a
            // system error and rolling the prompt back as a failed run.
            const turnState = resultType === "success"
              ? "completed"
              : resultType === "cancelled" ? "canceled" : "failed";
            emit({
              type: "session.turn",
              sessionId: state.paseoSessionId,
              turnId: event.turnId,
              state: turnState,
              error:
                turnState === "failed"
                  ? { message: String(payload.response || payload.resultType || "turn failed") }
                  : undefined,
            });
            emit({
              type: "session.usage",
              sessionId: state.paseoSessionId,
              turnId: event.turnId,
              usage: {
                inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : undefined,
                outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : undefined,
                cachedInputTokens: typeof usage.cacheReadTokens === "number" ? usage.cacheReadTokens : undefined,
                contextWindowMaxTokens: state.contextWindow,
                contextWindowUsedTokens: state.contextUsed,
              },
            });
            // The app-server does not project a finish frame for every
            // request, so the completed turn is the final segment boundary.
            closeDecodeWindow(turn, event.timestamp);
            emitTurnUsage(emit, state, turn, usage);
            state.turns.delete(event.turnId);
            if (state.goalActive) scheduleGoalRefresh(state);
            scheduleSubagentSync(state, subagentSyncTiming.settledMs);
            break;
          }
          default:
            break;
        }
      });

      const ensureCatalog = async (): Promise<ProviderCatalog> => {
        if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.catalog;
        await ensureAccountProviders();
        // Create a short-lived throwaway session to read the model catalog.
        // Resuming an arbitrary session from session/list is unsafe: sessions
        // owned by the running desktop app can block on resume.
        const created = (await client.requestOk(
          "session/create",
          { workspace: { workspacePath: bridgeDir, workspaceKey: bridgeDir }, persistence: "deferred" },
          60_000,
        )) as unknown as CreateOrResumeResult;
        if (created.session?.sessionId) {
          await client.request("session/close", { sessionId: created.session.sessionId }).catch(() => undefined);
        }
        const catalog = buildCatalog(created);
        catalogCache = { at: Date.now(), catalog };
        return catalog;
      };

      const failRequest = (requestId: string, message: string) =>
        emit({ type: "request.failed", requestId, error: { message } });

      const emitSessionConfig = (state: SessionState, catalog: ProviderCatalog) => {
        const current = state.modelSelection ? modelId(state.modelSelection) : undefined;
        emit({
          type: "session.config",
          sessionId: state.paseoSessionId,
          config: {
            model: current,
            mode: state.mode,
            thinkingOption: state.modelSelection?.options?.reasoningLevel,
            models: catalog.models,
            modes: catalog.modes,
            thinkingOptions: catalog.models.find((model) => model.id === current)?.thinkingOptions ?? [],
            settings: [],
          },
        });
      };

      const applyModel = async (state: SessionState, selection: ZcodeModelSelection) => {
        const result = (await client.requestOk("session/setModel", {
          sessionId: state.zcodeSessionId,
          model: selection,
          expectedRevision: state.revision,
        })) as unknown as CreateOrResumeResult;
        applyOfficialState(state, result);
        const applied = state.modelSelection;
        if (!applied || modelId(applied) !== modelId(selection)
          || applied.options?.reasoningLevel !== selection.options?.reasoningLevel) {
          throw new Error(`ZCode did not apply model selection: ${modelId(selection)}`);
        }
        log("model selected", { sessionId: state.paseoSessionId, ...applied });
      };

      const refreshSession = async (state: SessionState) => {
        const snapshot = (await client.requestOk("session/read", {
          sessionId: state.zcodeSessionId,
          messageLimit: 1,
        })) as unknown as CreateOrResumeResult;
        applyOfficialState(state, snapshot);
        emitTodos(emit, state, snapshot.todos);
        emitCommands(emit, state, snapshot.slashCommands);
        emitGoal(emit, state, snapshot.session.target ?? snapshot.projection?.target);
        emitUsageContext(emit, state, snapshot.projection?.contextUsed, snapshot.projection?.contextWindow);
        if (snapshot.runtime?.activeTurnKind === "compact") {
          emitCompaction(emit, state, "loading", state.compactionTrigger ?? "auto", snapshot.projection?.contextUsed);
        }
        emitVisibleBackgroundJobs(state, snapshot.projection?.backgroundJobs);
        if (state.ready && state.catalog) emitSessionConfig(state, state.catalog);
        return snapshot;
      };

      /** Coalesce goal/compaction refreshes into one snapshot read. */
      function scheduleGoalRefresh(state: SessionState): void {
        if (state.closed) return;
        if (state.goalRefreshTimer) clearTimeout(state.goalRefreshTimer);
        state.goalRefreshTimer = setTimeout(() => {
          state.goalRefreshTimer = undefined;
          if (state.closed) return;
          void refreshSession(state).catch((error) => log("session refresh failed", String(error)));
        }, 300);
        state.goalRefreshTimer.unref?.();
      }

      const applyMode = async (state: SessionState, mode: string) => {
        const snapshot = await client.requestOk("session/setMode", {
          sessionId: state.zcodeSessionId, mode, expectedRevision: state.revision,
        });
        applyOfficialState(state, snapshot as unknown as CreateOrResumeResult);
        if (state.mode !== mode) throw new Error(`ZCode did not apply mode "${mode}"; current mode is "${state.mode}"`);
      };

      const completePrompt = (
        state: SessionState,
        clientMessageId: string,
        result: { type: "completed" } | { type: "failed"; error: { message: string } } = { type: "completed" },
      ): void => {
        emit({
          type: "session.prompt_result",
          sessionId: state.paseoSessionId,
          clientMessageId,
          result,
        });
      };

      /** Execute one Paseo command prompt against the ZCode app-server. */
      const handleCommandPrompt = async (
        state: SessionState,
        input: { name: string; arguments: string },
        clientMessageId: string,
      ): Promise<void> => {
        const name = input.name.trim().toLowerCase();
        const args = input.arguments.trim();
        try {
          switch (name) {
            case "compact": {
              state.compactionTrigger = "manual";
              const response = await client.requestOk("session/compact", {
                sessionId: state.zcodeSessionId,
                expectedRevision: state.revision,
                ...(args ? { instructions: args } : {}),
              });
              const snapshot = response.snapshot as CreateOrResumeResult | undefined;
              if (snapshot) applyOfficialState(state, snapshot);
              emitCompaction(emit, state, "loading", "manual", snapshot?.projection?.contextUsed);
              emitCommandNotice(emit, state, args ? "已开始压缩会话：" + args : "已开始压缩会话");
              completePrompt(state, clientMessageId);
              return;
            }
            case "goal": {
              const parsed = parseGoalCommand(args);
              const response = await client.requestOk("session/goal", {
                sessionId: state.zcodeSessionId,
                action: parsed.action,
                ...(parsed.objective ? { objective: parsed.objective } : {}),
                expectedRevision: state.revision,
              });
              const snapshot = response.snapshot as CreateOrResumeResult | undefined;
              if (snapshot) {
                applyOfficialState(state, snapshot);
                emitGoal(emit, state, snapshot.session.target ?? snapshot.projection?.target);
              }
              emitCommandNotice(
                emit,
                state,
                typeof response.response === "string" && response.response.trim()
                  ? response.response
                  : "Goal updated",
              );
              completePrompt(state, clientMessageId);
              scheduleGoalRefresh(state);
              return;
            }
            case "tasks": {
              const snapshot = await refreshSession(state);
              const jobs = (snapshot.projection?.backgroundJobs ?? [])
                .filter((job): job is Record<string, unknown> => !!job && typeof job === "object");
              const lines = jobs.map((job) => {
                const id = String(job.taskId ?? "?");
                const status = String(job.status ?? "running");
                const label = String(job.toolName ?? job.taskKind ?? job.command ?? "task");
                return id + " · " + status + " · " + label;
              });
              emitCommandNotice(emit, state, lines.length ? lines.join("\n") : "没有后台任务");
              completePrompt(state, clientMessageId);
              return;
            }
            case "stop-task": {
              const taskId = args.split(/\s+/u)[0] ?? "";
              if (!taskId) {
                emitCommandNotice(emit, state, "用法：/stop-task <taskId>", "warning");
                completePrompt(state, clientMessageId);
                return;
              }
              await client.requestOk("session/cancelBackgroundTask", {
                sessionId: state.zcodeSessionId,
                taskId,
              });
              emitCommandNotice(emit, state, "已请求停止后台任务 " + taskId);
              completePrompt(state, clientMessageId);
              scheduleGoalRefresh(state);
              return;
            }
            case "usage": {
              const usage = await client.requestOk("session/usage", { sessionId: state.zcodeSessionId });
              emitCommandNotice(emit, state, formatUsage(usage) || "暂无用量数据");
              completePrompt(state, clientMessageId);
              return;
            }
            case "fork": {
              const response = await client.requestOk("session/fork", {
                sessionId: state.zcodeSessionId,
                expectedRevision: state.revision,
                target: parseForkTarget(args),
              });
              // The response snapshot belongs to the forked session, not this
              // one; applying it to the parent state would fail the identity
              // check and mix revisions.
              const forkedSessionId = typeof response.forkedSessionId === "string" ? response.forkedSessionId : "";
              emitCommandNotice(
                emit,
                state,
                forkedSessionId
                  ? "已创建分支会话 " + forkedSessionId + "，可在 Paseo 会话导入中打开"
                  : "ZCode 已创建分支会话",
              );
              completePrompt(state, clientMessageId);
              return;
            }
            default: {
              // Custom/prompt commands are expanded by ZCode's prompt path.
              const line = "/" + name + (args ? " " + args : "");
              await client.requestOk("session/send", {
                sessionId: state.zcodeSessionId,
                content: line,
                ...(state.modelSelection ? { modelSelection: state.modelSelection } : {}),
                expectedRevision: state.revision,
              });
              completePrompt(state, clientMessageId);
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log("command failed", { sessionId: state.paseoSessionId, command: name, error: message });
          emitCommandNotice(emit, state, "命令 /" + name + " 失败：" + message, "error");
          completePrompt(state, clientMessageId, { type: "failed", error: { message } });
        }
      };

      const subsessionsNegotiated = () => connection.capabilities.includes("session.subsession");

      const backgroundJobVisible = (job: Record<string, unknown>): boolean =>
        !(subsessionsNegotiated() && String(job.taskKind ?? "") === "subagent");

      const emitVisibleBackgroundJobs = (
        state: SessionState,
        jobs: NonNullable<CreateOrResumeResult["projection"]>["backgroundJobs"],
      ): void => {
        if (!jobs) return;
        for (const job of jobs) {
          if (backgroundJobVisible(job as Record<string, unknown>)) {
            emitBackgroundJob(emit, state, job as Record<string, unknown>);
          }
        }
      };

      /** Re-emit the parent's Agent tool card so it links to the child session. */
      const refreshAgentToolCard = (parent: SessionState, record: SubagentChildRecord): void => {
        if (!record.toolCallId) return;
        for (const turn of parent.turns.values()) {
          const tool = turn.tools.get(record.toolCallId);
          if (!tool) continue;
          const base = buildTimelineToolDetail(tool.name, tool.input);
          const detail = base.type === "sub_agent"
            ? { ...base, childSessionId: record.childSessionId, ...(tool.log ? { log: tool.log } : {}) }
            : base;
          emit({
            type: "timeline.item",
            sessionId: parent.paseoSessionId,
            item: tool.outcome === "failed"
              ? {
                  type: "tool_call",
                  id: record.toolCallId,
                  callId: record.toolCallId,
                  name: tool.name,
                  status: "failed",
                  error: tool.error ?? `${tool.name} failed`,
                  detail,
                }
              : {
                  type: "tool_call",
                  id: record.toolCallId,
                  callId: record.toolCallId,
                  name: tool.name,
                  status: tool.outcome ?? "running",
                  error: null,
                  detail,
                },
          });
          return;
        }
      };

      /**
       * Paseo rejects a child session.opened unless the parent session has
       * already announced the session.subsession capability. The open
       * handshake is asynchronous, so events replayed by the app-server may
       * request a reconciliation pass before the parent is announced.
       */
      const canAttachSubagents = (parent: SessionState): boolean =>
        !parent.child && parent.ready && !parent.closed;

      /**
       * Register a ZCode subagent child session as a Paseo subsession nested
       * under the parent's Agent tool call, backfill its transcript so far and
       * poll it while it runs.
       */
      const adoptSubagent = async (parent: SessionState, ref: SubagentRef): Promise<void> => {
        const childSessionId = String(ref.childSessionId ?? "");
        if (!childSessionId || !parent.subagents || !canAttachSubagents(parent)) return;
        let record = parent.subagents.get(childSessionId);
        if (!record) {
          record = {
            paseoSessionId: childSessionId,
            childSessionId,
            toolCallId: typeof ref.toolCallId === "string" ? ref.toolCallId : undefined,
            title: typeof ref.title === "string" ? ref.title : undefined,
            adopted: false,
            emittedRows: new Set(),
          };
          parent.subagents.set(childSessionId, record);
          const childState = stateFor(childSessionId, childSessionId);
          childState.child = true;
          childState.cwd = parent.cwd;
          emit({
            type: "session.opened",
            sessionId: record.paseoSessionId,
            parentSessionId: parent.paseoSessionId,
            ...(record.toolCallId ? { toolCallId: record.toolCallId } : {}),
            capabilities: [],
            restoration: "parent" as const,
            cwd: parent.cwd ?? bridgeDir,
            ...(record.title ? { title: record.title } : {}),
          });
          refreshAgentToolCard(parent, record);
        }
        if (record.adopted) {
          if (ref.ended && !record.terminalEmitted) {
            // The listing carries the accurate outcome; a running poll only
            // reports coarse completion, so prefer this whenever it arrives.
            record.terminalEmitted = true;
            scheduleSubagentBackfill(record);
            emit({
              type: "session.turn",
              sessionId: record.paseoSessionId,
              turnId: `zcode:subagent:${childSessionId}`,
              state: endedSubagentTurnState(ref.status),
            });
          }
          return;
        }
        record.adopted = true;
        // Resume is idempotent for active sessions and activates ended ones.
        await client.requestOk("session/resume", { sessionId: childSessionId }).catch(() => undefined);
        try {
          const snapshot = await client.requestOk("session/read", {
            sessionId: childSessionId,
            messageLimit: 1000,
          }) as unknown as CreateOrResumeResult;
          // The parent may have closed while the child transcript was loading.
          if (!canAttachSubagents(parent)) return;
          emitSubagentSnapshot(record, snapshot.messages);
          if (!record.terminalEmitted) {
            record.terminalEmitted = true;
            if (!ref.ended && subagentSnapshotRunning(snapshot)) {
              startSubagentPolling(parent, record);
            } else {
              scheduleSubagentBackfill(record);
              emit({
                type: "session.turn",
                sessionId: record.paseoSessionId,
                turnId: `zcode:subagent:${childSessionId}`,
                state: ref.ended
                  ? endedSubagentTurnState(ref.status)
                  : String(snapshot.session?.status ?? "") === "error" ? "failed" : "completed",
              });
            }
          }
        } catch (error) {
          log("subagent transcript unavailable", {
            sessionId: childSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          record.adopted = false;
        }
      };

      const subagentSnapshotRunning = (snapshot: CreateOrResumeResult): boolean => {
        const status = String(snapshot.session?.status ?? "running");
        return status === "running" || status === "waiting" || status === "paused";
      };

      const rowSignature = (item: ProviderTimelineItem): string => `${item.id}:${item.type}:${JSON.stringify(item).length}`;

      const emitSubagentSnapshot = (record: SubagentChildRecord, messages: unknown): void => {
        if (!record.emittedRows) record.emittedRows = new Set();
        for (const item of zcodeHistoryTimelineItems(messages, record.childSessionId)) {
          const signature = rowSignature(item);
          if (record.emittedRows.has(signature)) continue;
          record.emittedRows.add(signature);
          emit({ type: "timeline.item", sessionId: record.paseoSessionId, item });
        }
      };

      const stopSubagentPolling = (record: SubagentChildRecord): void => {
        record.pollGeneration = (record.pollGeneration ?? 0) + 1;
        if (record.pollTimer) {
          clearTimeout(record.pollTimer);
          record.pollTimer = undefined;
        }
      };

      /**
       * A child that just ended can report an inactive status before its last
       * rows are persisted, so re-read it briefly and forward anything new.
       */
      const scheduleSubagentBackfill = (record: SubagentChildRecord): void => {
        stopSubagentPolling(record);
        const generation = record.pollGeneration ?? 0;
        let growing = true;
        const tick = async (): Promise<void> => {
          if (record.pollGeneration !== generation || !growing) return;
          try {
            const snapshot = await client.requestOk("session/read", {
              sessionId: record.childSessionId,
              messageLimit: 1000,
            }) as unknown as CreateOrResumeResult;
            if (record.pollGeneration !== generation) return;
            const before = record.emittedRows?.size ?? 0;
            emitSubagentSnapshot(record, snapshot.messages);
            growing = (record.emittedRows?.size ?? 0) > before;
          } catch (error) {
            log("subagent backfill failed", {
              sessionId: record.childSessionId,
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          if (growing && record.pollGeneration === generation) {
            record.pollTimer = setTimeout(() => void tick().catch(() => undefined), subagentSyncTiming.backfillMs);
            record.pollTimer.unref?.();
          }
        };
        record.pollTimer = setTimeout(() => void tick().catch(() => undefined), subagentSyncTiming.backfillMs);
        record.pollTimer.unref?.();
      };

      /**
       * The app-server pushes session events only for sessions subscribed at
       * the protocol level and keeps subagent child sessions out of that
       * stream, so a running child is followed by polling its snapshot until
       * its own status leaves the active set.
       */
      const startSubagentPolling = (parent: SessionState, record: SubagentChildRecord): void => {
        stopSubagentPolling(record);
        const generation = record.pollGeneration ?? 0;
        const tick = async (): Promise<void> => {
          if (record.pollGeneration !== generation) return;
          try {
            const snapshot = await client.requestOk("session/read", {
              sessionId: record.childSessionId,
              messageLimit: 1000,
            }) as unknown as CreateOrResumeResult;
            if (record.pollGeneration !== generation) return;
            emitSubagentSnapshot(record, snapshot.messages);
            if (subagentSnapshotRunning(snapshot)) {
              record.pollTimer = setTimeout(() => void tick().catch(() => undefined), subagentSyncTiming.subagentPollMs);
              record.pollTimer.unref?.();
              return;
            }
            record.terminalEmitted = true;
            emit({
              type: "session.turn",
              sessionId: record.paseoSessionId,
              turnId: `zcode:subagent:${record.childSessionId}`,
              state: String(snapshot.session?.status ?? "") === "error" ? "failed" : "completed",
            });
            scheduleSubagentBackfill(record);
          } catch (error) {
            log("subagent poll failed", {
              sessionId: record.childSessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        };
        record.pollTimer = setTimeout(() => void tick().catch(() => undefined), subagentSyncTiming.subagentPollMs);
        record.pollTimer.unref?.();
      };

      const syncSubagents = async (parent: SessionState): Promise<void> => {
        if (!canAttachSubagents(parent)) return;
        if (parent.subagentSyncRunning) {
          parent.subagentSyncQueued = true;
          return;
        }
        parent.subagentSyncRunning = true;
        try {
          if (!parent.subagents || !subsessionsNegotiated()) return;
          let result: SessionSubagentsResult;
          try {
            result = await client.requestOk("session/subagents", {
              sessionId: parent.zcodeSessionId,
              endedLimit: 50,
            }) as unknown as SessionSubagentsResult;
          } catch {
            // Deferred or forgotten parent sessions have no subagent listing.
            return;
          }
          const refs = [
            ...(result.running ?? []).map((ref) => ({ ...ref, ended: false })),
            ...(result.ended?.items ?? []).map((ref) => ({ ...ref, ended: true })),
          ];
          for (const ref of refs) {
            // Adoption can take a while; stop if the parent closed meanwhile.
            if (!canAttachSubagents(parent)) return;
            try {
              await adoptSubagent(parent, ref);
            } catch (error) {
              log("subagent adoption failed", {
                childSessionId: ref.childSessionId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        } finally {
          parent.subagentSyncRunning = false;
          if (parent.subagentSyncQueued) {
            parent.subagentSyncQueued = false;
            scheduleSubagentSync(parent, 0);
          }
        }
      };

      const scheduleSubagentSync = (parent: SessionState, delay: number): void => {
        if (!canAttachSubagents(parent)) return;
        const timers = parent.subagentSyncTimers ??= new Set();
        const timer = setTimeout(() => {
          timers.delete(timer);
          void syncSubagents(parent).catch((error) => log("subagent sync failed", String(error)));
        }, delay);
        timer.unref?.();
        timers.add(timer);
      };

      const closeSubagents = (parent: SessionState): void => {
        for (const timer of parent.subagentSyncTimers ?? []) clearTimeout(timer);
        parent.subagentSyncTimers?.clear();
        if (!parent.subagents?.size) return;
        for (const record of parent.subagents.values()) {
          stopSubagentPolling(record);
          emit({ type: "session.closed", sessionId: record.paseoSessionId });
          sessions.delete(record.childSessionId);
          zcodeIdFor.delete(record.paseoSessionId);
        }
        parent.subagents.clear();
      };

      const sessionInputs = new Map<string, Promise<void>>();
      const connection: ProviderConnection = {
        get version() {
          return PROVIDER_PROTOCOL_VERSION;
        },
        get capabilities() {
          return negotiateProviderCapabilities(
            request.capabilities,
            SUPPORTED_CAPABILITIES.filter((capability) => taskIndex.available || !["session.archive", "session.unarchive"].includes(capability)),
          ) as readonly string[];
        },
        send: async (input: ProviderInput) => {
          const archivedId = (input.type === "session.archive" || input.type === "session.unarchive")
            ? (input.persistence.data as { zcodeSessionId?: string })?.zcodeSessionId : undefined;
          const sessionId = "sessionId" in input ? input.sessionId
            : archivedId ? sessions.get(archivedId)?.paseoSessionId ?? archivedId : undefined;
          const pending = sessionId ? sessionInputs.get(sessionId) : undefined;
          const handled = (pending ?? Promise.resolve()).then(() => handleInput(input)).catch((error) => {
            const message = error instanceof Error
              ? (zcodeFailurePresentation(error as Error & { code?: number }) || error.message)
              : String(error);
            if (input.type === "session.prompt") {
              const state = sessions.get(zcodeIdFor.get(input.sessionId) ?? input.sessionId);
              if (state) state.pendingClientMessageId = undefined;
              emit({
                type: "session.prompt_result",
                sessionId: input.sessionId,
                clientMessageId: input.prompt.clientMessageId,
                result: { type: "failed", error: { message } },
              });
            } else {
              const requestId = (input as { requestId?: string }).requestId;
              if (requestId) failRequest(requestId, message);
              else log("input failed", message);
            }
          });
          if (sessionId) sessionInputs.set(sessionId, handled);
          await handled;
          if (sessionId && sessionInputs.get(sessionId) === handled) {
            sessionInputs.delete(sessionId);
          }
        },
        onEvent: (next) => {
          listener = next;
          const backlog = queued;
          queued = [];
          for (const event of backlog) next(event);
          return () => {
            listener = undefined;
          };
        },
        close: async () => {
          for (const state of sessions.values()) {
            if (!state.child) {
              state.closed = true;
              closeSubagents(state);
            }
          }
          await client.close();
        },
      };

      const handleInput = async (input: ProviderInput) => {
        log(`input: ${input.type}`);
        switch (input.type) {
          case "catalog": {
            const catalog = await ensureCatalog();
            emit({ type: "catalog", requestId: input.requestId, catalog });
            emit({ type: "request.completed", requestId: input.requestId });
            return;
          }
          case "sessions": {
            const list = (await client.requestOk("session/list", {})) as {
              sessions?: Array<Record<string, unknown>>;
            };
            const hidden = taskIndex.available ? await taskIndex.hiddenSessionIds() : new Set<string>();
            // Forked sessions are user-facing conversations too; auxiliary
            // side chats and workflow/subagent children stay out of the picker.
            const importableKinds = new Set(["interactive", "fork"]);
            const summaries: ProviderSessionSummary[] = (list.sessions ?? [])
              .filter((s) => s.sessionKind === undefined || importableKinds.has(String(s.sessionKind)))
              .filter((s) => !hidden.has(String(s.sessionId)))
              .map((s) => ({
                persistence: { version: 1, data: { zcodeSessionId: String(s.sessionId) } },
                cwd: ((s.workspace as Record<string, unknown> | undefined)?.workspacePath as string) ?? bridgeDir,
                title: (s.title as string) || undefined,
                updatedAt: typeof s.updatedAt === "number" ? new Date(s.updatedAt).toISOString() : undefined,
              }));
            emit({ type: "sessions", requestId: input.requestId, sessions: summaries });
            emit({ type: "request.completed", requestId: input.requestId });
            return;
          }
          case "session.open": {
            await ensureAccountProviders();
            const persisted = input.persistence?.data as { zcodeSessionId?: string } | undefined;
            const existingId = persisted?.zcodeSessionId;
            let result: CreateOrResumeResult;
            let resuming = false;
            if (existingId && existingId.startsWith("sess_")) {
              resuming = true;
              result = (await client.requestOk("session/resume", { sessionId: existingId }, 60_000)) as unknown as CreateOrResumeResult;
            } else {
              const cwd = input.config.cwd || bridgeDir;
              result = (await client.requestOk(
                "session/create",
                {
                  workspace: { workspacePath: cwd, workspaceKey: cwd },
                  persistence: input.config.persist ? "immediate" : "deferred",
                },
                60_000,
              )) as unknown as CreateOrResumeResult;
            }
            const zcodeSessionId = result.session.sessionId;
            const state = stateFor(input.sessionId, zcodeSessionId);
            state.ready = false;
            state.closed = false;
            state.revision = undefined;
            state.modeEventSeq = undefined;
            state.cwd = input.config.cwd || bridgeDir;
            const catalog = await ensureCatalog();
            state.catalog = catalog;
            applyOfficialState(state, result);
            // Subscribe before mutations: Plan mode is confirmed only by
            // session.updated { mode, planEnabled }, not by the snapshot.
            await client.requestOk("session/subscribe", { sessionId: zcodeSessionId, deliveryKind: "desktop-continuous" });
            let historyMessages = result.messages;
            let childSessionIds: Map<string, string> | undefined;
            if (resuming && input.history === "replay") {
              try {
                const snapshot = await client.requestOk("session/read", {
                  sessionId: zcodeSessionId,
                  messageLimit: 1000,
                }) as unknown as CreateOrResumeResult;
                historyMessages = snapshot.messages ?? historyMessages;
              } catch (error) {
                log("history replay unavailable; keeping the resumed session open", {
                  sessionId: zcodeSessionId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
              if (subsessionsNegotiated()) {
                // Map Agent tool calls to their child sessions so replayed
                // cards link to the subsessions attached below.
                try {
                  const listing = await client.requestOk("session/subagents", {
                    sessionId: zcodeSessionId,
                    endedLimit: 50,
                  }) as unknown as SessionSubagentsResult;
                  childSessionIds = new Map();
                  for (const ref of [...(listing.running ?? []), ...(listing.ended?.items ?? [])]) {
                    if (ref.childSessionId && ref.toolCallId) {
                      childSessionIds.set(ref.toolCallId, ref.childSessionId);
                    }
                  }
                } catch (error) {
                  log("subagent listing unavailable for replay", {
                    sessionId: zcodeSessionId,
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              }
            }
            const current = result.settings?.model?.current ?? result.session.model;
            const selection = resolveModelSelection(
              catalog,
              input.config.model ?? (current ? modelId(current) : catalog.defaultModel),
              input.config.thinkingOption,
              current?.options?.reasoningLevel ?? result.settings?.thoughtLevel?.current,
            );
            await applyModel(state, selection);
            if (input.config.mode && input.config.mode !== state.mode) {
              await applyMode(state, input.config.mode);
            }
            state.ready = true;
            const persistence = { version: 1, data: { zcodeSessionId } };
            emit({
              type: "session.opened",
              requestId: input.requestId,
              sessionId: input.sessionId,
              capabilities: connection.capabilities,
              restoration: "core",
              persistence,
              title: result.session.title || input.config.title || undefined,
              cwd: input.config.cwd,
            });
            emit({ type: "session.persistence", sessionId: input.sessionId, persistence });
            emitSessionConfig(state, state.catalog ?? catalog);
            if (resuming && input.history === "replay") {
              for (const item of zcodeHistoryTimelineItems(historyMessages, zcodeSessionId, childSessionIds)) {
                emit({ type: "timeline.item", sessionId: input.sessionId, item });
              }
            }
            emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
            emit({ type: "request.completed", requestId: input.requestId });
            emitTodos(emit, state, result.todos);
            emitCommands(emit, state, result.slashCommands);
            emitGoal(emit, state, result.session.target ?? result.projection?.target);
            emitUsageContext(emit, state, result.projection?.contextUsed, result.projection?.contextWindow);
            if (result.runtime?.activeTurnKind === "compact") {
              emitCompaction(emit, state, "loading", "auto", result.projection?.contextUsed);
            }
            emitVisibleBackgroundJobs(state, result.projection?.backgroundJobs);
            if (resuming) {
              // Attach (or refresh) subagent child subsessions without
              // blocking the open handshake.
              scheduleSubagentSync(state, 0);
            }
            return;
          }
          case "session.prompt": {
            const zcodeSessionId = zcodeIdFor.get(input.sessionId) ?? input.sessionId;
            const state = sessions.get(zcodeSessionId);
            if (!state?.ready || !state.modelSelection) throw new Error("ZCode session is not ready; reopen it before sending");
            await refreshSession(state);
            if (input.prompt.input.type === "command") {
              await handleCommandPrompt(state, input.prompt.input, input.prompt.clientMessageId);
              return;
            }
            const prepared = prepareZcodePrompt(input.prompt.input.content);
            state.pendingClientMessageId = input.prompt.clientMessageId;
            log("sending with model", { sessionId: input.sessionId, ...state.modelSelection });
            await client.requestOk("session/send", {
              sessionId: zcodeSessionId,
              content: prepared.text,
              ...prepared.attachments ? { attachments: prepared.attachments } : {},
              modelSelection: state.modelSelection,
              expectedRevision: state.revision,
            });
            return;
          }
          case "session.interrupt": {
            const zcodeSessionId = zcodeIdFor.get(input.sessionId) ?? input.sessionId;
            await client.requestOk("session/stop", { sessionId: zcodeSessionId });
            emit({ type: "request.completed", requestId: input.requestId });
            return;
          }
          case "session.configure": {
            const zcodeSessionId = zcodeIdFor.get(input.sessionId) ?? input.sessionId;
            const state = sessions.get(zcodeSessionId);
            if (!state?.ready || !state.modelSelection) throw new Error("ZCode session is not ready; reopen it before configuring");
            const changes = input.changes;
            await refreshSession(state);
            const catalog = state.catalog ?? await ensureCatalog();
            try {
              if (changes.model !== undefined || changes.thinkingOption !== undefined) {
                const selection = resolveModelSelection(
                  catalog,
                  changes.model === null ? catalog.defaultModel : changes.model ?? modelId(state.modelSelection),
                  changes.thinkingOption,
                  state.modelSelection.options?.reasoningLevel,
                );
                await applyModel(state, selection);
              }
              if (changes.mode !== undefined) {
                const mode = changes.mode ?? catalog.defaultMode;
                if (mode) {
                  await applyMode(state, mode);
                }
              }
            } catch (error) {
              await refreshSession(state).catch((refreshError) => log("refresh after configure failed", String(refreshError)));
              emitSessionConfig(state, state.catalog ?? catalog);
              throw error;
            }
            emitSessionConfig(state, state.catalog ?? catalog);
            emit({ type: "request.completed", requestId: input.requestId });
            return;
          }
          case "session.permission": {
            const pending = permissions.get(input.permissionId);
            if (!pending) return;
            permissions.delete(input.permissionId);
            if (pending.logicalId && pendingPermissionIds.get(pending.logicalId) === input.permissionId) {
              pendingPermissionIds.delete(pending.logicalId);
            }
            if (pending.kind === "question") {
              if (input.response.behavior !== "allow") {
                client.replyServerRequest(pending.request.id, { action: "decline" });
              } else {
                const updated = input.response.updatedInput as Record<string, unknown> | undefined;
                const rawAnswers = updated && typeof updated.answers === "object" && !Array.isArray(updated.answers)
                  ? updated.answers as Record<string, unknown>
                  : {};
                const answers: Record<string, string> = {};
                for (const question of pending.questions ?? []) {
                  const header = typeof question.header === "string" ? question.header : "";
                  const text = typeof question.question === "string" && question.question
                    ? question.question
                    : header;
                  if (!text) continue;
                  const value = (header ? rawAnswers[header] : undefined) ?? rawAnswers[text];
                  const answer = Array.isArray(value)
                    ? value.filter((entry) => typeof entry === "string").join(", ")
                    : typeof value === "string" ? value.trim() : "";
                  if (answer) answers[text] = answer;
                }
                client.replyServerRequest(pending.request.id, {
                  action: "accept",
                  content: { answers },
                });
              }
            } else if (pending.kind === "user_input") {
              if (input.response.behavior === "allow") {
                const answer = input.response.selectedActionId ?? pending.answer ?? "approve";
                client.replyServerRequest(pending.request.id, { action: "accept", content: { answer } });
              } else {
                client.replyServerRequest(pending.request.id, { action: "decline" });
              }
            } else {
              client.replyServerRequest(pending.request.id, { approved: input.response.behavior === "allow" });
            }
            emit({ type: "session.permission_resolved", sessionId: input.sessionId, permissionId: input.permissionId });
            return;
          }
          case "session.close": {
            const zcodeSessionId = zcodeIdFor.get(input.sessionId) ?? input.sessionId;
            const state = sessions.get(zcodeSessionId);
            if (state) {
              state.closed = true;
              closeSubagents(state);
            }
            await client.request("session/close", { sessionId: zcodeSessionId }).catch(() => undefined);
            sessions.delete(zcodeSessionId);
            zcodeIdFor.delete(input.sessionId);
            emit({ type: "session.closed", sessionId: input.sessionId });
            emit({ type: "request.completed", requestId: input.requestId });
            return;
          }
          case "session.archive":
          case "session.unarchive": {
            const persisted = input.persistence.data as { zcodeSessionId?: string } | undefined;
            const zcodeSessionId = persisted?.zcodeSessionId;
            if (!zcodeSessionId) throw new Error("ZCode session persistence is missing its session ID");
            const state = sessions.get(zcodeSessionId);
            if (state?.ready) {
              const snapshot = await refreshSession(state);
              if (snapshot.projection?.status === "running" || snapshot.session.status === "running") {
                throw new Error("Stop the active ZCode turn before archiving this session");
              }
            }
            await taskIndex.setArchived(zcodeSessionId, input.type === "session.archive");
            emit({ type: "request.completed", requestId: input.requestId });
            return;
          }
          default:
            return;
        }
      };

      return connection;
    },
  };
}
