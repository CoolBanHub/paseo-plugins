/**
 * Presentation of ZCode request failures.
 *
 * `ZcodeProtocolClient.requestOk` keeps the structured numeric error code on
 * the thrown Error; early turn failures are recovered from the CLI log. This
 * table maps the well-known classes (quota, auth, rate limit, context) to
 * short Chinese guidance so Paseo rows do not surface raw provider text.
 * Unknown failures fall back to the original message unchanged.
 */

export interface ZcodeFailureLike {
  code?: unknown;
  message?: unknown;
}

const CODE_TEXT: Record<number, string> = {
  401: "认证失败（401），请在 ZCode 客户端重新登录",
  402: "额度或配额不足（402），请检查 ZCode 套餐额度",
  403: "没有权限执行该操作（403），请检查账号或套餐",
  404: "资源不存在（404），会话可能已失效，请重新打开",
  429: "请求过于频繁（429），请稍后重试",
};

const MESSAGE_PATTERNS: Array<[RegExp, string]> = [
  [/quota|配额|额度|insufficient[_ ]balance|balance[_ ]is[_ ]not[_ ]enough|欠费/i, "额度或配额不足，请检查 ZCode 套餐额度"],
  [/rate[_ ]?limit|too[_ ]many[_ ]requests|请求过于频繁|频繁/i, "请求过于频繁（限流），请稍后重试"],
  [/unauthorized|invalid[_ ]token|token[_ ]expired|登录|auth.*fail|认证失败/i, "认证失败，请在 ZCode 客户端重新登录"],
  [/context[_ ]?(window|length)|上下文.*(超|过长)|prompt is too long/i, "上下文窗口已超限，请压缩上下文或开启新会话"],
];

/** One short Chinese sentence for a known failure class, else the original text. */
export function zcodeFailureText(failure: ZcodeFailureLike | undefined): string | undefined {
  if (!failure) return undefined;
  if (typeof failure.code === "number" && CODE_TEXT[failure.code]) return CODE_TEXT[failure.code];
  const message = typeof failure.message === "string" ? failure.message : "";
  if (message) {
    for (const [pattern, text] of MESSAGE_PATTERNS) {
      if (pattern.test(message)) return text;
    }
  }
  return undefined;
}

/** The text a timeline error row should show: mapped class, else the message. */
export function zcodeFailurePresentation(failure: ZcodeFailureLike | undefined): string {
  const mapped = zcodeFailureText(failure);
  if (mapped) return mapped;
  const message = typeof failure?.message === "string" && failure.message.trim()
    ? failure.message.trim().slice(0, 600)
    : "";
  return message || "ZCode 请求失败";
}
