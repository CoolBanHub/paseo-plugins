/*
 * A local estimate of an Anthropic Messages request's input tokens, for
 * count_tokens toward a route that has no counting endpoint (OpenAI Chat
 * Completions). Adapted from the same estimation in paseo-team-work.
 */

type Json = Record<string, unknown>;

const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;
const IMAGE_TOKEN_ESTIMATE = 1600;

const isObj = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function estimateAnthropicInputTokens(body: Json): number {
  let chars = 0;
  let cjk = 0;
  let fixed = 0;
  const addText = (text: string) => {
    const matches = text.match(CJK_PATTERN);
    const cjkCount = matches ? matches.length : 0;
    cjk += cjkCount;
    chars += text.length - cjkCount;
  };
  const walk = (value: unknown): void => {
    if (typeof value === "string") return addText(value);
    if (Array.isArray(value)) return value.forEach(walk);
    if (!isObj(value)) return;
    if ((value.type === "image" || value.type === "document") && isObj(value.source)) {
      if (value.type === "image") fixed += IMAGE_TOKEN_ESTIMATE;
      else if (typeof value.source.data === "string") fixed += Math.ceil(value.source.data.length / 3);
      else if (typeof value.source.url === "string") fixed += IMAGE_TOKEN_ESTIMATE;
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "cache_control" || key === "signature" || key === "type" || key === "id" || key === "tool_use_id") continue;
      walk(child);
    }
  };
  const b = body as Record<string, unknown>;
  walk(b.system);
  walk(b.messages);
  if (Array.isArray(b.tools)) addText(JSON.stringify(b.tools));
  const messages = Array.isArray(b.messages) ? b.messages.length : 0;
  return Math.max(1, Math.ceil(chars / 4) + cjk + fixed + messages * 4);
}
