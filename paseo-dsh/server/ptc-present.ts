import type { AcpTransformer, AcpVendorUpdate } from "@getpaseo/plugin/server/acp";
import type { ProviderTimelineItem, ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";

/**
 * Presentation of dsh PTC (programmatic tool calling) sub-calls.
 *
 * In PTC agent presets the model drives every tool through one `run_code`
 * program, so the ACP wire only ever carries the aggregate `run_code` tool
 * call — Paseo's timeline would show an unexpanded "Run code" row per
 * program. dsh's own clients instead render the per-tool dispatches the
 * runtime records (`tool/ptc-dispatch-start` / `tool/ptc-dispatch`). Those
 * events never leave the dsh process: the bridge plugin appended to every
 * connector spawn mirrors them into a JSONL sidecar, the connector re-emits
 * each record here as a `dsh/ptc/call` / `dsh/ptc/result` notification, and
 * the transformer below turns them into native Paseo timeline rows
 * (Shell / Read / Edit / Search / Fetch, like the ZCode provider) instead of
 * opaque JSON blobs.
 */

export const DSH_PTC_CALL_METHOD = "dsh/ptc/call";
export const DSH_PTC_RESULT_METHOD = "dsh/ptc/result";

/** One mirrored dispatch record; field names follow dsh's durable events. */
export interface DshPtcRecordParams {
  subCallId: string;
  rootCallId?: string;
  name: string;
  arguments?: Record<string, unknown>;
  isError?: boolean;
  output?: string;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Map one dsh tool invocation to Paseo's structured tool-call detail, the
 * same mapping the ZCode provider uses so rows render identically across
 * providers. dsh tools take snake_case arguments.
 */
export function dshToolDetail(name: string, args: Record<string, unknown> | undefined): ProviderToolCallDetail {
  const input = args ?? {};
  switch (name) {
    case "bash":
    case "pwsh":
    case "shell":
      return { type: "shell", command: text(input.command) ?? "" };
    case "read":
    case "read_image":
      return { type: "read", filePath: text(input.file_path ?? input.path) ?? "" };
    case "edit":
      return {
        type: "edit",
        filePath: text(input.file_path ?? input.path) ?? "",
        oldString: text(input.old_string),
        newString: text(input.new_string),
      };
    case "write":
      return {
        type: "write",
        filePath: text(input.file_path ?? input.path) ?? "",
        content: text(input.content) ?? "",
      };
    case "glob":
    case "grep":
      return {
        type: "search",
        query: text(input.pattern ?? input.query) ?? "",
        toolName: name === "glob" ? "glob" : "grep",
      };
    case "web_search":
      return { type: "search", query: text(input.query ?? input.keywords) ?? "", toolName: "web_search" };
    case "web_fetch":
    case "web":
      return { type: "fetch", url: text(input.url) ?? "" };
    case "run_code":
      // Fallback row for a PTC program that dispatched no tools: the
      // description labels it and the code stands in for its activity.
      return {
        type: "plain_text",
        label: text(input.description) ?? "Run code",
        text: text(input.code)?.slice(0, 4000),
        icon: "square_terminal",
      };
    case "subagent":
      return {
        type: "sub_agent",
        subAgentType: text(input.type ?? input.subagent_type),
        description: text(input.description),
        log: "",
      };
    case "ask_user_question": {
      const first = Array.isArray(input.questions)
        ? input.questions.find((question): question is Record<string, unknown> =>
          !!question && typeof question === "object",
        )
        : undefined;
      return { type: "plain_text", label: text(first?.header) ?? text(input.description) ?? name };
    }
    default:
      return { type: "plain_text", label: text(input.description) ?? name };
  }
}

/** Attach a finished sub-call's output where Paseo's row detail expects it. */
function withOutput(detail: ProviderToolCallDetail, output: string): ProviderToolCallDetail {
  switch (detail.type) {
    case "shell":
      return { ...detail, output: output.slice(0, 8000) };
    case "read":
      return { ...detail, content: output.slice(0, 8000) };
    case "search":
      return { ...detail, content: output.slice(0, 4000) };
    case "fetch":
      return { ...detail, result: output.slice(0, 4000) };
    case "plain_text":
      // Keep a non-empty detail text (e.g. the run_code fallback's program)
      // unless the call produced output worth showing instead.
      return output ? { ...detail, text: output.slice(0, 4000) } : detail;
    default:
      return detail;
  }
}

/**
 * dsh's todo_write mirrors Paseo's native todo timeline item. The first
 * completed call renders the list; later calls update the same item id.
 */
function dshTodoItem(args: Record<string, unknown> | undefined, sessionId: string): ProviderTimelineItem | undefined {
  const todos = Array.isArray(args?.todos)
    ? args.todos.filter((todo): todo is Record<string, unknown> => !!todo && typeof todo === "object")
    : [];
  if (!todos.length) return undefined;
  return {
    type: "todo",
    id: `dsh:${sessionId}:todos`,
    items: todos.map((todo, index) => {
      const status = todo.status === "in_progress" || todo.status === "pending" || todo.status === "completed"
        ? todo.status
        : "pending";
      return {
        id: String(index),
        text: text(todo.content) ?? text(todo.subject) ?? "",
        status,
        completed: status === "completed",
      };
    }),
  };
}

/** Reject mirrored records that lack the fields the timeline rows need. */
function parsePtcParams(params: unknown): DshPtcRecordParams | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const record = params as Record<string, unknown>;
  if (typeof record.subCallId !== "string" || typeof record.name !== "string") return undefined;
  return {
    subCallId: record.subCallId,
    rootCallId: text(record.rootCallId),
    name: record.name,
    arguments: record.arguments && typeof record.arguments === "object" && !Array.isArray(record.arguments)
      ? record.arguments as Record<string, unknown>
      : undefined,
    isError: record.isError === true,
    output: text(record.output),
  };
}

/**
 * Build the timeline updates for one mirrored PTC record. `call` records
 * open a running row; `result` records settle it (and todo_write also
 * refreshes the native todo list).
 */
export function dshPtcTimelineUpdates(
  method: string,
  params: unknown,
  sessionId: string,
): AcpVendorUpdate[] | null {
  if (method !== DSH_PTC_CALL_METHOD && method !== DSH_PTC_RESULT_METHOD) return null;
  const record = parsePtcParams(params);
  if (!record) return null;
  const detail = dshToolDetail(record.name, record.arguments);
  if (method === DSH_PTC_CALL_METHOD) {
    return [{
      type: "timeline",
      item: {
        type: "tool_call",
        id: record.subCallId,
        callId: record.subCallId,
        name: record.name,
        status: "running",
        error: null,
        detail,
      },
    }];
  }
  const output = record.output ?? "";
  const settledItem = record.isError
    ? {
      type: "tool_call" as const,
      id: record.subCallId,
      callId: record.subCallId,
      name: record.name,
      status: "failed" as const,
      error: output || `${record.name} failed`,
      detail: withOutput(detail, output),
    }
    : {
      type: "tool_call" as const,
      id: record.subCallId,
      callId: record.subCallId,
      name: record.name,
      status: "completed" as const,
      error: null,
      detail: withOutput(detail, output),
    };
  const updates: AcpVendorUpdate[] = [{ type: "timeline", item: settledItem }];
  if (record.name === "todo_write") {
    const todo = dshTodoItem(record.arguments, sessionId);
    if (todo) updates.push({ type: "timeline", item: todo });
  }
  return updates;
}

/** ACP transformer registered by the provider; see runAcpProvider options. */
export const dshPtcTransformer: AcpTransformer = {
  notification(notification, context) {
    return dshPtcTimelineUpdates(notification.method, notification.params, context.sessionId);
  },
};
