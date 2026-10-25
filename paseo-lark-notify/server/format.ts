import { homedir } from "node:os";
import { basename } from "node:path";

export interface AgentSummary {
  id: string;
  provider: string;
  cwd: string;
  title: string | null;
}

export interface ToolDetailLike {
  type?: string;
  command?: string;
  filePath?: string;
  url?: string;
  query?: string;
  text?: string;
  content?: string;
}

export interface PermissionSummary {
  name: string;
  kind: string;
  title?: string;
  description?: string;
  detail?: ToolDetailLike;
  input?: unknown;
  actions?: ReadonlyArray<{ label: string; behavior: string }>;
}

export interface TimelineLike {
  type?: string;
  text?: string;
  name?: string;
  detail?: ToolDetailLike;
}

export interface SessionSummary {
  outcome: "completed" | "failed" | "canceled" | null;
  turns: number;
  durationMs: number | null;
  lastText: string | null;
  lastAction: string | null;
  lastError: string | null;
}

const REPLY_LIMIT = 280;

/**
 * "CoolBanHub/paseo-plugins" reads better than a bare directory name; fall back
 * to the directory basename outside a known git host layout.
 */
export function projectName(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  const host = parts.findIndex(
    (part) => part.includes(".") && /git|github|gitlab|gitee|bitbucket/i.test(part),
  );
  if (host >= 0 && parts.length > host + 2) return parts.slice(host + 1, host + 3).join("/");
  return basename(cwd) || cwd;
}

export function displayPath(cwd: string): string {
  const home = homedir();
  return cwd.startsWith(home + "/") ? "~" + cwd.slice(home.length) : cwd;
}

export function clip(value: string, limit = 300): string {
  const flat = value.split(/\s+/).join(" ").trim();
  return flat.length > limit ? flat.slice(0, limit - 1) + "…" : flat;
}

function cjkRatio(value: string): number {
  const cjk = (value.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (value.match(/[A-Za-z]/g) || []).length;
  if (cjk + latin === 0) return 0;
  return cjk / (cjk + latin);
}

/**
 * DeepSeek-style providers sometimes fold English reasoning into the final
 * message. When a reply mixes scripts, keep the CJK sentences that carry the
 * actual answer instead of shipping the chain of thought to chat.
 */
export function condenseReply(value: string, limit = REPLY_LIMIT): string {
  const flat = value.split(/\s+/).join(" ").trim();
  if (!flat) return "";
  if (cjkRatio(flat) > 0) {
    const sentences = flat
      .split(/(?<=[。！？!?.])/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
    const answer = sentences.filter((sentence) => cjkRatio(sentence) >= 0.3);
    if (answer.length > 0) {
      const tail = answer.slice(-2).join("");
      return tail.length > limit ? "…" + tail.slice(-(limit - 1)) : tail;
    }
  }
  return flat.length > limit ? flat.slice(0, limit - 1) + "…" : flat;
}

export function describeTool(detail?: ToolDetailLike): string | null {
  if (!detail) return null;
  switch (detail.type) {
    case "shell":
      return detail.command ? "执行命令：" + clip(detail.command) : "执行命令";
    case "write": {
      const target = detail.filePath ? "写入文件：" + detail.filePath : "写入文件";
      return detail.content ? target + "（内容：" + clip(detail.content, 80) + "）" : target;
    }
    case "edit":
      return detail.filePath ? "修改文件：" + detail.filePath : "修改文件";
    case "read":
      return detail.filePath ? "读取文件：" + detail.filePath : "读取文件";
    case "search":
      return detail.query ? "搜索：" + clip(detail.query, 120) : "搜索";
    case "fetch":
      return detail.url ? "访问：" + clip(detail.url, 160) : "访问网页";
    case "plan":
      return detail.text ? "提交计划：" + clip(detail.text) : "提交计划";
    default:
      return null;
  }
}

function describeInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "filePath", "path", "url", "query", "pattern"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return clip(value);
  }
  try {
    const json = JSON.stringify(input);
    return json && json !== "{}" ? clip(json) : null;
  } catch {
    return null;
  }
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return hours + " 小时 " + minutes + " 分";
  if (minutes > 0) return minutes + " 分 " + seconds + " 秒";
  return seconds + " 秒";
}

function outcomeLabel(outcome: SessionSummary["outcome"], lastError: string | null): string {
  if (outcome === "completed") return "已完成";
  if (outcome === "canceled") return "已取消";
  if (outcome === "failed") return lastError ? "失败：" + clip(lastError, 160) : "失败";
  return "已关闭（这一轮没有留下结果）";
}

export function summarizeTimeline(items: readonly TimelineLike[]): {
  lastText: string | null;
  lastAction: string | null;
} {
  let lastText: string | null = null;
  let lastAction: string | null = null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) continue;
    if (!lastText && item.type === "assistant_message" && item.text && item.text.trim()) {
      lastText = item.text.trim();
    }
    if (!lastAction && item.type === "tool_call") {
      const detail = describeTool(item.detail);
      lastAction = detail ? (item.name ? item.name + " · " + detail : detail) : item.name || null;
    }
    if (lastText && lastAction) break;
  }
  return { lastText, lastAction };
}

export function formatPermissionMessage(agent: AgentSummary, request: PermissionSummary): string {
  const fallback =
    request.kind === "tool" ? "使用工具 " + request.name : request.name || "权限请求";
  const heading = (request.title || fallback).trim();
  const lines = [
    "**🔐 需要你确认**",
    "",
    "**项目**：" + projectName(agent.cwd),
    "**会话**：" + (agent.title || "未命名会话") + "（" + agent.provider + "）",
    "**请求**：" + clip(heading, 120),
  ];

  const detail = describeTool(request.detail) || describeInput(request.input);
  if (detail) lines.push("**详情**：" + detail);
  if (request.description && request.description.trim()) {
    lines.push("**说明**：" + clip(request.description, 200));
  }
  const actions = (request.actions || [])
    .map((action) => action.label)
    .filter((label) => label.trim().length > 0)
    .slice(0, 4);
  if (actions.length) lines.push("**可选**：" + actions.join(" / "));

  lines.push("", "打开 Paseo 处理这条请求。");
  return lines.join("\n");
}

export function formatTurnEndMessage(agent: AgentSummary, session: SessionSummary): string {
  const lines = [
    "**🏁 本轮任务完成**",
    "",
    "**项目**：" + projectName(agent.cwd),
    "**会话**：" + (agent.title || "未命名会话") + "（" + agent.provider + "，第 " + session.turns + " 轮）",
    "**结果**：" + outcomeLabel(session.outcome, session.lastError),
  ];

  if (session.lastText) lines.push("**最后回复**：" + condenseReply(session.lastText, REPLY_LIMIT));
  if (session.lastAction) lines.push("**最后动作**：" + clip(session.lastAction, REPLY_LIMIT));
  lines.push("**目录**：" + displayPath(agent.cwd), "", "打开 Paseo 查看完整时间线。");
  return lines.join("\n");
}
