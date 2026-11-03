import type { AcpTransformer, AcpVendorUpdate } from "@getpaseo/plugin/server/acp";
import type { ProviderTimelineItem, ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";

/**
 * Presentation of dsh tool calls on Paseo's timeline.
 *
 * dsh's ACP bridge reports every standard tool call with `kind: "other"`,
 * so Paseo's ACP adapter falls back to an opaque "unknown" row: the title
 * is the bare tool name and the model's output (sent as ACP `content`, not
 * `rawOutput`) never reaches the card. The connector re-emits the same
 * tool lifecycle as `dsh/tool/*` vendor notifications, and the transformer
 * below maps it onto the structured Shell / Read / Edit / Search / Fetch
 * rows the ZCode provider uses. The PTC path uses the same mapping for the
 * sub-calls it mirrors out of dsh (see ptc-present.ts).
 */

export const DSH_TOOL_CALL_METHOD = "dsh/tool/call";
export const DSH_TOOL_RESULT_METHOD = "dsh/tool/result";

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
export function dshToolDetailWithOutput(detail: ProviderToolCallDetail, output: string): ProviderToolCallDetail {
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
export function dshTodoItem(args: Record<string, unknown> | undefined, sessionId: string): ProviderTimelineItem | undefined {
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

function isTodoTool(name: string): boolean {
  return name.trim().replace(/[.\s-]+/g, "_").toLowerCase() === "todo_write";
}

export interface DshToolRecordParams {
  callId: string;
  name: string;
  arguments?: Record<string, unknown>;
  status?: string;
  isError?: boolean;
  output?: string;
}

/** Reject records that lack the fields the timeline rows need. */
function parseToolParams(params: unknown): DshToolRecordParams | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const record = params as Record<string, unknown>;
  if (typeof record.callId !== "string" || typeof record.name !== "string") return undefined;
  return {
    callId: record.callId,
    name: record.name,
    arguments: record.arguments && typeof record.arguments === "object" && !Array.isArray(record.arguments)
      ? record.arguments as Record<string, unknown>
      : undefined,
    status: text(record.status),
    isError: record.isError === true,
    output: text(record.output),
  };
}

/**
 * Build the timeline updates for one standard dsh tool lifecycle. Call
 * records open a running row; result records settle it and attach the
 * output. A successful todo_write renders only the native todo list (the
 * generic ACP row it replaces did the same); a failed one stays a tool row
 * so the error remains visible.
 */
export function dshToolTimelineUpdates(
  method: string,
  params: unknown,
  sessionId: string,
): AcpVendorUpdate[] | null {
  if (method !== DSH_TOOL_CALL_METHOD && method !== DSH_TOOL_RESULT_METHOD) return null;
  const record = parseToolParams(params);
  if (!record) return null;
  const detail = dshToolDetail(record.name, record.arguments);
  if (method === DSH_TOOL_CALL_METHOD) {
    if (isTodoTool(record.name)) return [];
    return [{
      type: "timeline",
      item: {
        type: "tool_call",
        id: record.callId,
        callId: record.callId,
        name: record.name,
        status: "running",
        error: null,
        detail,
      },
    }];
  }
  const output = record.output ?? "";
  const failed = record.isError || record.status === "failed";
  const completed = !failed && (record.status === undefined || record.status === "completed");
  if (!failed && isTodoTool(record.name)) {
    const todo = dshTodoItem(record.arguments, sessionId);
    return todo ? [{ type: "timeline", item: todo }] : [];
  }
  const finalDetail = output ? dshToolDetailWithOutput(detail, output) : detail;
  let settledItem: ProviderTimelineItem;
  if (failed) {
    settledItem = {
      type: "tool_call",
      id: record.callId,
      callId: record.callId,
      name: record.name,
      status: "failed",
      error: output || `${record.name} failed`,
      detail: finalDetail,
    };
  } else if (!completed) {
    settledItem = {
      type: "tool_call",
      id: record.callId,
      callId: record.callId,
      name: record.name,
      status: "running",
      error: null,
      detail: finalDetail,
    };
  } else {
    settledItem = {
      type: "tool_call",
      id: record.callId,
      callId: record.callId,
      name: record.name,
      status: "completed",
      error: null,
      detail: finalDetail,
    };
  }
  return [{ type: "timeline", item: settledItem }];
}

/** ACP transformer for the standard tool lifecycle emitted by the connector. */
export const dshToolTransformer: AcpTransformer = {
  notification(notification, context) {
    return dshToolTimelineUpdates(notification.method, notification.params, context.sessionId);
  },
};
