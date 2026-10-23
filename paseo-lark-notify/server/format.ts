import { basename } from "node:path";

export interface AgentSummary {
  provider: string;
  cwd: string;
  title: string | null;
}

export interface PermissionSummary {
  name: string;
  kind: string;
  title?: string;
  description?: string;
  input?: unknown;
}

const DETAIL_LIMIT = 600;

export function projectLabel(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  return basename(trimmed) || trimmed;
}

export function clip(value: string, limit = DETAIL_LIMIT): string {
  const flat = value.split(/\s+/).join(" ").trim();
  return flat.length > limit ? flat.slice(0, limit - 1) + "…" : flat;
}

export function agentLine(agent: AgentSummary): string {
  const parts = ["**" + projectLabel(agent.cwd) + "**", agent.provider];
  if (agent.title) parts.push(agent.title);
  return parts.join(" · ");
}

export function formatPermissionMessage(agent: AgentSummary, request: PermissionSummary): string {
  const heading = (request.title || request.name || "权限请求").trim();
  const lines = ["**🔐 需要你确认**", "", agentLine(agent), "", "**" + clip(heading, 120) + "**"];
  if (request.description && request.description.trim()) {
    lines.push("", clip(request.description));
  } else if (request.input && typeof request.input === "object") {
    let json = "";
    try {
      json = JSON.stringify(request.input);
    } catch {
      json = "";
    }
    if (json && json !== "{}") lines.push("", clip(json, 900));
  }
  lines.push("", "类型：" + request.kind + "，打开 Paseo 处理。");
  return lines.join("\n");
}

export function formatSessionEndMessage(agent: AgentSummary): string {
  return ["**🏁 会话结束**", "", agentLine(agent), "", "打开 Paseo 查看结果。"].join("\n");
}
