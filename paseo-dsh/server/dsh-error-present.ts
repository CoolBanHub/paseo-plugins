/**
 * Presentation of dsh's stable LLM failure codes.
 *
 * dsh reports turn and retry failures as structured `LlmFailure` values whose
 * `code` is a stable machine-routable taxonomy (see `dsh-llm` error codes).
 * The codes travel on mirrored `turn/end` and `llm/retry` events; this table
 * maps them to short Chinese guidance so Paseo rows do not surface raw
 * provider stack text. Unknown codes fall back to the provider message.
 */

const CODE_TEXT: Record<string, string> = {
  RATE_LIMIT: "模型请求过于频繁，已被限流",
  QUOTA: "账号额度或余额已用尽",
  ACCOUNT_QUOTA: "账号额度已用尽，需要充值或更换账号",
  CONTEXT_WINDOW_EXCEEDED: "上下文窗口已超限，请压缩上下文或开启新会话",
  EMPTY_RESPONSE: "模型返回了空响应",
  INVALID_CREDENTIAL: "凭据不可用，请检查 API Key 或重新登录",
  MISSING_CREDENTIAL: "缺少凭据，请先在 dsh 中登录或配置 API Key",
  AUTH: "认证失败，请重新登录",
  IMAGE_OFFLOAD_REQUIRED: "图片占用过大，需要卸载部分图片后重试",
  NO_ADAPTER: "模型路由缺少适配器，请检查 dsh 配置",
};

export interface DshLlmFailure {
  code?: unknown;
  message?: unknown;
  status?: unknown;
}

/** One short Chinese sentence for a known failure code, else undefined. */
export function dshFailureText(failure: DshLlmFailure | undefined): string | undefined {
  const code = typeof failure?.code === "string" ? failure.code : undefined;
  if (!code) return undefined;
  return CODE_TEXT[code];
}

/**
 * The text a timeline error row or notice should show: the mapped sentence
 * when the code is known, otherwise the raw provider message, otherwise a
 * generic fallback.
 */
export function dshFailurePresentation(failure: DshLlmFailure | undefined): string {
  const mapped = dshFailureText(failure);
  if (mapped) {
    const status = typeof failure?.status === "number" ? `（HTTP ${failure.status}）` : "";
    return `${mapped}${status}`;
  }
  const message = typeof failure?.message === "string" && failure.message.trim()
    ? failure.message.trim().slice(0, 600)
    : undefined;
  return message ?? "dsh 回合未完成";
}
