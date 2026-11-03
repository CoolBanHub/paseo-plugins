import type { AcpTransformer, AcpVendorUpdate } from "@getpaseo/plugin/server/acp";
import { dshTodoItem, dshToolDetail, dshToolDetailWithOutput } from "./tool-present.ts";

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
      detail: dshToolDetailWithOutput(detail, output),
    }
    : {
      type: "tool_call" as const,
      id: record.subCallId,
      callId: record.subCallId,
      name: record.name,
      status: "completed" as const,
      error: null,
      detail: dshToolDetailWithOutput(detail, output),
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
