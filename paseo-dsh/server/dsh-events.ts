import type { AcpTransformer, AcpVendorUpdate } from "@getpaseo/plugin/server/acp";
import type { ProviderNotice, ProviderTimelineItem, ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";
import { dshFailurePresentation } from "./dsh-error-present.ts";

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
  const mapped = dshFailurePresentation(failure);
  const providerMessage = text(failure?.message) ?? text(data.message) ?? "";
  const message = mapped !== providerMessage && providerMessage ? `${mapped}：${providerMessage}` : mapped;
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

/**
 * dsh's ACP bridge maps every failed turn to `end_turn`, so Paseo currently
 * learns nothing when a turn dies on quota, credentials or the context
 * window. The mirrored `turn/end` reason carries the structured failure;
 * render its stable code as a Chinese row instead.
 */
function turnEndUpdate(sessionId: string, data: Record<string, unknown>): AcpVendorUpdate[] {
  const reason = object(data.reason);
  const turn = typeof data.turn === "number" ? data.turn : undefined;
  if (!reason) return [];
  if (text(reason.kind) === "error") {
    const presentation = dshFailurePresentation(object(reason.error));
    return [{
      type: "timeline",
      item: {
        type: "error",
        id: `dsh:turn-error:${sessionId}:${turn ?? "?"}`,
        message: presentation,
      },
    }];
  }
  if (text(reason.kind) === "max-tokens") {
    return [notice(`dsh:turn-max-tokens:${sessionId}:${turn ?? "?"}`, "warning", "达到输出上限", "本轮已按 max tokens 截断，可继续提问让它接着写")];
  }
  if (text(reason.kind) === "blocked") {
    return [notice(`dsh:turn-blocked:${sessionId}:${turn ?? "?"}`, "warning", "本轮被阻塞", "回合未产生输出，请检查权限设置或重试")];
  }
  return [];
}

function formatCount(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k` : String(value);
}

/**
 * Decode throughput for one step: reported output tokens over the time from
 * the first streamed token to the committed assistant message. This mirrors
 * dsh's sessionStats decode figure, so a step that only reports usage without
 * a stream timing simply omits the speed.
 */
function formatDecodeSpeed(outputTokens: number | undefined, decodeMs: number | undefined): string | undefined {
  if (outputTokens === undefined || outputTokens <= 0 || decodeMs === undefined || decodeMs <= 0) return undefined;
  const tps = outputTokens / (decodeMs / 1000);
  if (!Number.isFinite(tps) || tps <= 0) return undefined;
  return `${tps >= 10 ? Math.round(tps) : Math.round(tps * 10) / 10} tok/s`;
}

/** Per-step token accounting from `assistant/message` usage snapshots. */
function usageUpdate(sessionId: string, data: Record<string, unknown>): AcpVendorUpdate[] {
  const usage = object(data.usage);
  if (!usage) return [];
  const input = typeof usage.inputTokens === "number" ? usage.inputTokens : undefined;
  const output = typeof usage.outputTokens === "number" ? usage.outputTokens : undefined;
  const cacheRead = typeof usage.cacheReadTokens === "number" ? usage.cacheReadTokens : undefined;
  const cacheWrite = typeof usage.cacheWriteTokens === "number" ? usage.cacheWriteTokens : undefined;
  const decodeMs = typeof data.decodeMs === "number" ? data.decodeMs : undefined;
  const parts: string[] = [];
  if (input !== undefined) parts.push(`输入 ${formatCount(input)}`);
  if (cacheRead !== undefined) parts.push(`缓存读 ${formatCount(cacheRead)}`);
  if (cacheWrite !== undefined) parts.push(`缓存写 ${formatCount(cacheWrite)}`);
  if (output !== undefined) parts.push(`输出 ${formatCount(output)}`);
  const speed = formatDecodeSpeed(output, decodeMs);
  if (speed) parts.push(`速度 ${speed}`);
  if (!parts.length) return [];
  const turn = typeof data.turn === "number" ? data.turn : undefined;
  const step = typeof data.step === "number" ? data.step : undefined;
  return [notice(
    `dsh:usage:${sessionId}:${turn ?? "?"}:${step ?? "?"}`,
    "info",
    "Token 用量",
    parts.join(" · "),
  )];
}

/**
 * Live assistant streaming preview. The connector accumulates mirrored
 * `agent/assistant-stream` chunks and only emits rows for attempts that run
 * longer than a moment, so quick replies do not grow extra rows; the settled
 * row is a compact marker because the real assistant message follows it.
 */
function streamRowUpdate(sessionId: string, data: Record<string, unknown>): AcpVendorUpdate[] {
  const attemptId = text(data.attemptId);
  if (!attemptId) return [];
  const id = `dsh:stream:${sessionId}:${attemptId}`;
  const phase = text(data.phase) === "completed" ? "completed" : "running";
  const chars = typeof data.chars === "number" ? data.chars : undefined;
  const preview = (text(data.text) ?? "").slice(-600);
  return [{
    type: "timeline",
    item: toolItem(
      id,
      id,
      "stream",
      phase,
      {
        type: "plain_text",
        label: phase === "completed" ? `已生成${chars !== undefined ? ` ${formatCount(chars)} 字` : ""}` : "正在生成…",
        text: preview,
        icon: "brain",
      },
    ),
  }];
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
    case "turn-end":
      return turnEndUpdate(sessionId, data);
    case "usage":
      return usageUpdate(sessionId, data);
    case "stream-row":
      return streamRowUpdate(sessionId, data);
    case "question-cancelled": {
      const requestId = text(data.requestId) ?? "?";
      return [notice(`dsh:question-cancelled:${sessionId}:${requestId}`, "info", "提问已取消", "dsh 等待回答超时，该问题已跳过")];
    }
    case "rewind-applied": {
      const summary = text(data.summary);
      return [notice(
        `dsh:rewind:${sessionId}:${Date.now()}`,
        "info",
        "会话已回退",
        `${summary ? `回退到「${summary}」。` : ""}正在结束本次连接，重新打开会话即可看到回退后的时间线`,
      )];
    }
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
