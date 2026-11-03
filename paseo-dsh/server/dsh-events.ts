import type { AcpTransformer, AcpVendorUpdate } from "@getpaseo/plugin/server/acp";
import type { ProviderNotice, ProviderTimelineItem, ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";

/**
 * dsh events that the ACP bridge does not project onto its standard
 * surface. The in-dsh bridge plugin mirrors them into a JSONL sidecar; the
 * connector re-emits each record as a `dsh/event` vendor notification and
 * this transformer turns it into the closest Paseo timeline item, notice or
 * native card.
 */

export const DSH_EVENT_METHOD = "dsh/event";

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function notice(id: string, severity: ProviderNotice["severity"], title: string, description?: string): AcpVendorUpdate {
  return {
    type: "notice",
    notice: { id, severity, title, ...(description ? { description } : {}) },
  };
}

function toolItem(
  id: string,
  callId: string,
  name: string,
  status: "running" | "completed" | "failed" | "canceled",
  detail: ProviderToolCallDetail,
  error?: string | null,
): ProviderTimelineItem {
  if (status === "failed") {
    return {
      type: "tool_call",
      id,
      callId,
      name,
      status: "failed",
      error: error ?? { message: `${name} failed` },
      detail,
    };
  }
  return { type: "tool_call", id, callId, name, status, error: null, detail };
}

function retryUpdate(data: Record<string, unknown>): AcpVendorUpdate[] {
  const failure = object(data.failure);
  const message = text(failure?.message) ?? text(data.message) ?? "上游请求失败";
  const retry = typeof data.retry === "number" ? data.retry : undefined;
  const max = typeof data.maxRetries === "number" ? data.maxRetries : undefined;
  const delay = typeof data.delayMs === "number" ? data.delayMs : undefined;
  const attempt = retry === undefined ? "" : max === undefined ? `第 ${retry} 次` : `第 ${retry}/${max} 次`;
  const wait = delay === undefined ? "" : `，${Math.max(1, Math.round(delay / 1000))}s 后重试`;
  return [notice(
    `dsh:retry:${text(data.retryId) ?? String(retry ?? "?")}:${String(retry ?? "?")}`,
    "warning",
    "模型请求重试",
    `${attempt}${wait}${attempt || wait ? "：" : ""}${message}`,
  )];
}

function compactionUpdate(kind: string, data: Record<string, unknown>): AcpVendorUpdate[] {
  const compactionId = text(data.compactionId);
  if (!compactionId) return [];
  const id = `dsh:compaction:${compactionId}`;
  const trigger = data.sourceCommandId === undefined ? "auto" : "manual";
  if (kind === "compaction-start") {
    return [{
      type: "timeline",
      item: { type: "compaction", id, status: "loading", trigger },
    }];
  }
  if (kind === "compaction-summary") {
    const preTokens = typeof data.shadowedTokenCount === "number" ? data.shadowedTokenCount : undefined;
    return [{
      type: "timeline",
      item: { type: "compaction", id, status: "loading", trigger, ...(preTokens ? { preTokens } : {}) },
    }];
  }
  if (kind === "compaction-end") {
    const error = text(data.error);
    const updates: AcpVendorUpdate[] = [{
      type: "timeline",
      item: { type: "compaction", id, status: "completed", trigger },
    }];
    if (error) updates.push(notice(`dsh:compaction-error:${compactionId}`, "warning", "上下文压缩失败", error));
    return updates;
  }
  return [];
}

function jobDetail(data: Record<string, unknown>): ProviderToolCallDetail {
  const command = text(data.command);
  if (command) return { type: "shell", command };
  const label = text(data.label) ?? text(data.kind) ?? "后台任务";
  const jobId = text(data.jobId);
  return {
    type: "plain_text",
    label,
    text: jobId ? `任务 ${jobId}` : undefined,
    icon: "square_terminal",
  };
}

function jobUpdate(kind: string, data: Record<string, unknown>): AcpVendorUpdate[] {
  const jobId = text(data.jobId);
  if (!jobId) return [];
  const toolCall = object(data.toolCall);
  const callId = text(toolCall?.callId) ?? jobId;
  const name = text(data.label) ?? text(data.kind) ?? "后台任务";
  const id = `dsh:job:${jobId}`;
  if (kind === "job-registered") {
    return [{
      type: "timeline",
      item: toolItem(id, callId, name, "running", jobDetail(data)),
    }];
  }
  const status = text(data.status) ?? "completed";
  const failed = status === "failed";
  const canceled = status === "killed" || status === "canceled" || status === "cancelled";
  return [{
    type: "timeline",
    item: toolItem(
      id,
      callId,
      name,
      failed ? "failed" : canceled ? "canceled" : "completed",
      jobDetail(data),
      failed ? text(data.detail) ?? "后台任务失败" : null,
    ),
  }];
}

function subagentDetail(data: Record<string, unknown>): ProviderToolCallDetail {
  return {
    type: "sub_agent",
    subAgentType: text(data.provider),
    description: text(data.label),
    ...(text(data.childId) ? { childSessionId: text(data.childId) } : {}),
    log: text(data.output) ?? "",
  };
}

function subagentUpdate(kind: string, data: Record<string, unknown>): AcpVendorUpdate[] {
  const callId = text(data.callId);
  if (!callId) return [];
  const label = text(data.label) ?? "子代理";
  if (kind === "subagent-start") {
    return [{
      type: "timeline",
      item: toolItem(callId, callId, "subagent", "running", subagentDetail(data)),
    }];
  }
  const stopReason = text(data.stopReason);
  const failed = stopReason === "error" || stopReason === "failed";
  const canceled = stopReason === "cancelled" || stopReason === "canceled" || stopReason === "aborted";
  return [{
    type: "timeline",
    item: toolItem(
      callId,
      callId,
      "subagent",
      failed ? "failed" : canceled ? "canceled" : "completed",
      subagentDetail(data),
      failed ? text(data.output) ?? `${label} 失败` : null,
    ),
  }];
}

function goalUpdate(data: Record<string, unknown>): AcpVendorUpdate[] {
  const id = "dsh:goal";
  if (text(data.operation) === "clear") {
    return [{
      type: "timeline",
      item: toolItem(id, id, "Goal", "completed", {
        type: "plain_text",
        label: "目标",
        text: "目标已清除",
        icon: "sparkles",
      }),
    }];
  }
  const goal = object(data.goal);
  const phase = text(goal?.phase) ?? "active";
  const objective = text(goal?.objective) ?? "";
  if (!objective) return [];
  return [{
    type: "timeline",
    item: toolItem(
      id,
      id,
      "Goal",
      phase === "complete" ? "completed" : "running",
      { type: "plain_text", label: `目标 · ${phase}`, text: objective, icon: "sparkles" },
    ),
  }];
}

function questionCard(data: Record<string, unknown>): AcpVendorUpdate[] {
  const requestId = text(data.requestId);
  const index = typeof data.index === "number" ? data.index : undefined;
  if (!requestId || index === undefined) return [];
  const id = `dsh:question:${requestId}:${index}`;
  const header = text(data.header) ?? "问题";
  const question = text(data.question) ?? "";
  const detail = text(data.detail);
  const answer = text(data.answer);
  const status = text(data.status) ?? "running";
  const body = [question, detail].filter(Boolean).join("\n\n");
  return [{
    type: "timeline",
    item: toolItem(
      id,
      id,
      "Question",
      status === "completed" ? "completed" : "running",
      {
        type: "plain_text",
        label: header,
        text: answer ? `${body}\n\n回答：${answer}` : body,
        icon: "sparkles",
      },
    ),
  }];
}

/** Map one mirrored dsh event onto Paseo updates. */
export function dshEventUpdates(
  method: string,
  params: unknown,
  sessionId: string,
): AcpVendorUpdate[] | null {
  if (method !== DSH_EVENT_METHOD) return null;
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const record = params as Record<string, unknown>;
  const kind = text(record.kind);
  if (!kind) return null;
  const data = object(record.data) ?? {};
  switch (kind) {
    case "llm-retry":
      return retryUpdate(data);
    case "compaction-start":
    case "compaction-summary":
    case "compaction-end":
      return compactionUpdate(kind, data);
    case "job-registered":
    case "job-settled":
      return jobUpdate(kind, data);
    case "subagent-start":
    case "subagent-end":
      return subagentUpdate(kind, data);
    case "goal-change":
      return goalUpdate(data);
    case "working-directory": {
      const cwd = text(data.cwd);
      return cwd
        ? [notice(`dsh:cwd:${sessionId}:${cwd}`, "info", "工作目录已切换", cwd)]
        : [];
    }
    case "plan-mode": {
      const active = data.active === true;
      return [notice(
        `dsh:plan:${sessionId}`,
        "info",
        "Plan mode",
        active ? "已进入计划模式" : "已退出计划模式",
      )];
    }
    case "question-card":
      return questionCard(data);
    case "command-result": {
      const line = text(data.line) ?? "/command";
      const failed = text(data.kind) === "error";
      return [notice(
        `dsh:command:${text(data.requestId) ?? line}`,
        failed ? "error" : "info",
        line,
        text(data.text) || (failed ? "命令执行失败" : "命令已执行"),
      )];
    }
    default:
      return [];
  }
}

/** ACP transformer for mirrored dsh events; see DSH_EVENT_METHOD. */
export const dshEventTransformer: AcpTransformer = {
  notification(notification, context) {
    return dshEventUpdates(notification.method, notification.params, context.sessionId);
  },
};
