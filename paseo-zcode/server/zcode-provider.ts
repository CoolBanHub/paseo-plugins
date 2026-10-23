import { mkdirSync } from "node:fs";
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
  registerAccountProviders,
  type AccountProvider,
} from "./zcode-account";
import { ZcodeTaskIndex } from "./zcode-task-index";
import { zcodeCatalogCacheKey } from "./zcode-catalog-key";

const SUPPORTED_CAPABILITIES = [
  "prompt.message",
  "prompt.image",
  "session.list",
  "session.persistence",
  "session.configure",
  "session.archive",
  "session.unarchive",
  "permission",
] as const;

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

interface CreateOrResumeResult {
  session: {
    sessionId: string;
    sessionKind?: string;
    status?: string;
    mode?: string;
    title?: string;
    model?: ZcodeModelSelection | null;
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
  runtime?: { stateRevision?: number; eventSeq?: number };
  projection?: {
    contextWindow?: number;
    status?: string;
    mode?: string;
    backgroundJobs?: Array<Record<string, unknown>>;
  };
  todos?: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
    priority?: "high" | "medium" | "low";
  }>;
}

interface PendingPermission {
  request: ZcodeServerRequest;
  logicalId?: string;
  kind: "permission" | "user_input";
  answer?: string;
}

interface TurnState {
  turnId: string;
  started: boolean;
  text: string;
  reasoning: string;
  assistantMessageId?: string;
  emittedAssistant: Set<string>;
  tools: Map<string, { name: string; input?: Record<string, unknown> }>;
}

interface SessionState {
  /** Session ID assigned by Paseo; all ProviderEvents must use this. */
  paseoSessionId: string;
  /** Session ID from the ZCode CLI; used for app-server calls. */
  zcodeSessionId: string;
  turns: Map<string, TurnState>;
  contextWindow?: number;
  pendingClientMessageId?: string;
  modelSelection?: ZcodeModelSelection;
  mode?: string;
  ready: boolean;
  revision?: number;
  modeEventSeq?: number;
  catalog?: ProviderCatalog;
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
      return { type: "sub_agent", subAgentType: typeof i.subagent_type === "string" ? i.subagent_type : undefined, log: "" };
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

function emitBackgroundJobs(
  emit: (event: ProviderEvent) => void,
  state: SessionState,
  jobs: NonNullable<CreateOrResumeResult["projection"]>["backgroundJobs"],
): void {
  if (!jobs) return;
  for (const job of jobs) emitBackgroundJob(emit, state, job);
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
      const taskIndex = new ZcodeTaskIndex(cliPath);
      let catalogCache: CatalogCache | undefined;
      // Keyed by zcode session id for event lookup.
      const sessions = new Map<string, SessionState>();
      // Paseo session id -> zcode session id for input handling.
      const zcodeIdFor = new Map<string, string>();
      const permissions = new Map<string, PendingPermission>();
      const pendingPermissionIds = new Map<string, string>();
      const accountProviders: AccountProvider[] = readAccountProviders();
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
        else queued.push(event);
      };

      const stateFor = (paseoSessionId: string, zcodeSessionId: string): SessionState => {
        let state = sessions.get(zcodeSessionId);
        if (!state) {
          state = { paseoSessionId, zcodeSessionId, turns: new Map(), ready: false };
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
      };

      client.onStateUpdate((update) => {
        const state = sessions.get(update.sessionId);
        if (!state || (update.scope && update.scope !== "session")
          || (state.revision !== undefined && update.revision < state.revision)) return;
        applyOfficialState(state, {
          settings: update.patch as CreateOrResumeResult["settings"],
          runtime: { stateRevision: update.revision },
        });
        if (state.ready && state.catalog) emitSessionConfig(state, state.catalog);
      });

      const turnFor = (state: SessionState, turnId: string): TurnState => {
        let turn = state.turns.get(turnId);
        if (!turn) {
          turn = { turnId, started: false, text: "", reasoning: "", emittedAssistant: new Set(), tools: new Map() };
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
          if (account) {
            client.replyServerRequest(request.id, { headersApplied: true, requestAuth: { apiKey: account.apiKey } });
          } else {
            client.replyServerRequest(request.id, { headersApplied: false });
          }
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
          permissions.set(permissionId, { request, logicalId, kind: "permission" });
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
          const isPlanApproval = schema?.interaction === "plan_approval"
            || toolName === "ExitPlanMode";
          if (!isPlanApproval) {
            log("unsupported user input request, declining", { sessionId: zcodeSessionId, toolName });
            client.replyServerRequest(request.id, { action: "decline" });
            return true;
          }
          log("user input request", {
            sessionId: zcodeSessionId,
            toolName,
            requestId: params.requestId,
            kind: "plan",
          });
          if (!state) {
            log("user input for unknown session, declining", zcodeSessionId);
            client.replyServerRequest(request.id, { action: "decline" });
            return true;
          }
          if (logicalId && pendingPermissionIds.has(logicalId)) {
            log("user input reannouncement coalesced", { sessionId: zcodeSessionId, toolName });
            return true;
          }

          const permissionId = String(request.id);
          const questions = Array.isArray(params.questions) ? params.questions as Array<Record<string, unknown>> : [];
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
          const reason = readLastTurnFailure(event.sessionId) ?? "Turn failed before producing output";
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
            if (kind === "reasoning_delta" && typeof payload.delta === "string") {
              turn.reasoning += payload.delta;
            } else if (kind === "text_delta" && typeof payload.delta === "string") {
              turn.text += payload.delta;
            } else if (kind === "tool_call") {
              flushReasoning(state, turn);
              const toolCallId = String(payload.toolCallId ?? "");
              const toolName = String(payload.toolName ?? "tool");
              const input = (payload.input ?? undefined) as Record<string, unknown> | undefined;
              if (toolCallId) {
                turn.tools.set(toolCallId, { name: toolName, input });
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
                    detail: buildToolDetail(toolName, input),
                  },
                });
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
              emitBackgroundJob(emit, state, payload);
            } else if (Array.isArray(payload.backgroundJobs)) {
              emitBackgroundJobs(emit, state, payload.backgroundJobs as Array<Record<string, unknown>>);
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
            if (payload.kind === "started" && !turn.tools.has(toolCallId)) {
              const toolName = String(payload.toolName ?? "tool");
              turn.tools.set(toolCallId, { name: toolName });
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
                  detail: { type: "plain_text", label: toolName },
                },
              });
            } else if (payload.kind === "result") {
              const tool = turn.tools.get(toolCallId);
              const result = (payload.result ?? {}) as Record<string, unknown>;
              const success = result.success !== false;
              const detail = withOutput(
                tool ? buildToolDetail(tool.name, tool.input) : { type: "plain_text" as const, label: "tool" },
                result.content,
              );
              const failureMessage = String(result.content ?? "tool failed");
              emit({
                type: "timeline.item",
                sessionId: state.paseoSessionId,
                item: success
                  ? {
                      type: "tool_call",
                      id: toolCallId,
                      callId: toolCallId,
                      name: tool?.name ?? "tool",
                      status: "completed",
                      error: null,
                      detail,
                    }
                  : {
                      type: "tool_call",
                      id: toolCallId,
                      callId: toolCallId,
                      name: tool?.name ?? "tool",
                      status: "failed",
                      error: failureMessage,
                      detail,
                    },
              });
              if (tool?.name === "TodoWrite") {
                void refreshSession(state).catch((error) => log("todo refresh failed", String(error)));
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
            emit({
              type: "session.turn",
              sessionId: state.paseoSessionId,
              turnId: event.turnId,
              state: resultType === "success" ? "completed" : "failed",
              error:
                resultType === "success"
                  ? undefined
                  : { message: String(payload.response ?? payload.resultType ?? "turn failed") },
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
              },
            });
            state.turns.delete(event.turnId);
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
        emitBackgroundJobs(emit, state, snapshot.projection?.backgroundJobs);
        if (state.ready && state.catalog) emitSessionConfig(state, state.catalog);
        return snapshot;
      };

      const applyMode = async (state: SessionState, mode: string) => {
        const snapshot = await client.requestOk("session/setMode", {
          sessionId: state.zcodeSessionId, mode, expectedRevision: state.revision,
        });
        applyOfficialState(state, snapshot as unknown as CreateOrResumeResult);
        if (state.mode !== mode) throw new Error(`ZCode did not apply mode "${mode}"; current mode is "${state.mode}"`);
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
            const message = error instanceof Error ? error.message : String(error);
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
            const summaries: ProviderSessionSummary[] = (list.sessions ?? [])
              .filter((s) => s.sessionKind === undefined || s.sessionKind === "interactive")
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
            if (existingId && existingId.startsWith("sess_")) {
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
            state.revision = undefined;
            state.modeEventSeq = undefined;
            const catalog = await ensureCatalog();
            state.catalog = catalog;
            applyOfficialState(state, result);
            // Subscribe before mutations: Plan mode is confirmed only by
            // session.updated { mode, planEnabled }, not by the snapshot.
            await client.requestOk("session/subscribe", { sessionId: zcodeSessionId, deliveryKind: "desktop-continuous" });
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
            emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
            emit({ type: "request.completed", requestId: input.requestId });
            emitTodos(emit, state, result.todos);
            emitBackgroundJobs(emit, state, result.projection?.backgroundJobs);
            return;
          }
          case "session.prompt": {
            const zcodeSessionId = zcodeIdFor.get(input.sessionId) ?? input.sessionId;
            const state = sessions.get(zcodeSessionId);
            if (!state?.ready || !state.modelSelection) throw new Error("ZCode session is not ready; reopen it before sending");
            await refreshSession(state);
            const prepared = input.prompt.input.type === "message"
              ? prepareZcodePrompt(input.prompt.input.content)
              : { text: "" };
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
            if (pending.kind === "user_input") {
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
