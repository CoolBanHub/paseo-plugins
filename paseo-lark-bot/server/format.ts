const DEFAULT_REPLY_LIMIT = 4000;

const CJK = /[\u4e00-\u9fff]/;

/**
 * DeepSeek-style providers sometimes fold English reasoning into the final
 * message. Keep the structured answer intact: only strip a leading English
 * prose paragraph when it is immediately followed by Chinese text. Never
 * collapse whitespace or truncate Chinese sentences — both destroy Markdown,
 * lists, code fences, and the actual answer.
 */
export function condenseReply(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || !CJK.test(trimmed)) return trimmed;
  // Code fences, lists and tables are user output, not reasoning.
  if (/```/.test(trimmed) || /^\s*(?:[-*+]|\d+\.)\s/m.test(trimmed) || /^\s*\|/m.test(trimmed)) {
    return trimmed;
  }
  const firstCjk = trimmed.search(CJK);
  if (firstCjk <= 0) return trimmed;
  const prefix = trimmed.slice(0, firstCjk);
  // A Markdown heading/link/quote at the start is part of the answer.
  if (/^\s*(?:#|>|!\[|\*\*|__|`)/.test(prefix)) return trimmed;
  const boundary = Math.max(
    prefix.lastIndexOf(". "),
    prefix.lastIndexOf(".\n"),
    prefix.lastIndexOf("! "),
    prefix.lastIndexOf("!\n"),
    prefix.lastIndexOf("? "),
    prefix.lastIndexOf("?\n"),
  );
  if (boundary < 0) return trimmed;
  const head = prefix.slice(0, boundary + 1).trim();
  // Only drop a prose-looking lead-in, and only if it is not itself a heading
  // or a list item.
  if (!head || /^[#>*\-|`]/.test(head)) return trimmed;
  const rest = trimmed.slice(boundary + 1).trimStart();
  return rest || trimmed;
}

/**
 * Feishu rejects overly long messages; clip the reply and point the user to
 * the full timeline in Paseo.
 */
export function clipReply(value: string, limit = DEFAULT_REPLY_LIMIT): { text: string; clipped: boolean } {
  const flat = value.trim();
  if (flat.length <= limit) return { text: flat, clipped: false };
  return { text: flat.slice(0, limit - 1) + "…", clipped: true };
}

export function appendFooter(text: string, clipped: boolean): string {
  if (!clipped) return text;
  return text + "\n\n（回复过长已截断，打开 Paseo 查看完整内容。）";
}

/**
 * Exact post payload for the `post` reply format: a single md element so
 * inline `<at user_id=...>` mentions stay intact for agent-to-agent handoffs
 * (plain markdown replies never trigger other agents).
 */
export function buildPostContent(text: string): string {
  return JSON.stringify({ zh_cn: { content: [[{ tag: "md", text }]] } });
}

/**
 * Short, actionable Chinese hints for upstream HTTP failures. Provider errors
 * often arrive as an HTML error page (Cloudflare/nginx 403/502…); forwarding
 * that page verbatim makes the Feishu reply unreadable.
 */
const HTTP_ERROR_HINTS: Record<number, string> = {
  400: "模型服务拒绝了请求参数（HTTP 400），请检查 provider 配置",
  401: "模型服务认证失败（HTTP 401），通常是 API Key 无效或已过期，请检查后重试",
  403: "模型服务拒绝访问（HTTP 403），通常是 API Key 无权限、账号受限或代理拦截，请检查后重试",
  404: "模型服务接口不存在（HTTP 404），请检查 provider 配置",
  408: "模型服务请求超时（HTTP 408），请稍后重试",
  409: "模型服务请求冲突（HTTP 409），请稍后重试",
  429: "模型服务限流（HTTP 429），请稍后重试",
  500: "模型服务内部错误（HTTP 500），请稍后重试",
  502: "模型服务网关错误（HTTP 502），请稍后重试",
  503: "模型服务暂时不可用（HTTP 503），请稍后重试",
  504: "模型服务网关超时（HTTP 504），请稍后重试",
};

const HTTP_STATUS_NAMES =
  "Forbidden|Unauthorized|Bad Request|Not Found|Request Timeout|Conflict|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout";

function detectHttpStatus(error: string): number | null {
  const patterns = [
    /\bHTTP\s*([45]\d{2})\b/i,
    /<title>\s*([45]\d{2})\b/i,
    /\bturn failed:\s*([45]\d{2})\b/i,
    new RegExp("\\b([45]\\d{2})\\s+(?:" + HTTP_STATUS_NAMES + ")\\b", "i"),
    /\b(?:status|status code|code|error)[:\s]+([45]\d{2})\b/i,
  ];
  for (const pattern of patterns) {
    const match = error.match(pattern);
    if (match?.[1]) return Number(match[1]);
  }
  return null;
}

/** Strip proxy HTML/ANSI noise; the raw page stays in the Paseo timeline. */
function plainError(value: string): string {
  return value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatTurnOutcome(outcome: "completed" | "failed" | "canceled" | null, lastError: string | null): string {
  if (outcome === "failed") {
    const raw = lastError?.trim() ?? "";
    if (!raw) return "处理失败";
    const status = detectHttpStatus(raw);
    if (status !== null) {
      const hint = HTTP_ERROR_HINTS[status] ?? `模型服务返回 HTTP ${status}，请稍后重试或检查 provider 配置`;
      return `处理失败：${hint}；完整错误见 Paseo 时间线。`;
    }
    const plain = plainError(raw);
    return plain ? "处理失败：" + clipText(plain) : "处理失败";
  }
  if (outcome === "canceled") return "本轮处理已取消。";
  return "";
}

function clipText(value: string, limit = 300): string {
  const flat = value.split(/\s+/).join(" ").trim();
  return flat.length > limit ? flat.slice(0, limit - 1) + "…" : flat;
}

/**
 * Permission requests are resolved in the Paseo client; the group message only
 * needs to make the pending request visible.
 */
export function formatPermissionNotice(detail: { heading: string; extra: string | null }): string {
  const lines = ["**🔐 智能体需要确认**", "", "**请求**：" + clipText(detail.heading, 160)];
  if (detail.extra) lines.push("**详情**：" + clipText(detail.extra, 200));
  lines.push("", "打开 Paseo 处理这条请求，处理完成后结果会回到本话题。");
  return lines.join("\n");
}
