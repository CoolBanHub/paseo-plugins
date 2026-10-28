import { vendorModelId } from "../shared/model-id.ts";
import { normalizeBaseUrl } from "./store.ts";

/**
 * A live round-trip against one model: the smallest real request the
 * protocol allows, so key, endpoint and model id are all verified the way a
 * session would exercise them.
 */

export type ModelTestResult = { ok: true; latencyMs: number; reply: string } | { ok: false; error: string };

function extractReply(body: unknown, protocol: "anthropic" | "chat"): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  if (protocol === "anthropic") {
    const content = record.content;
    if (!Array.isArray(content)) return "";
    for (const block of content) {
      if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") return text;
      }
    }
    return "";
  }
  const choices = record.choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return "";
  const message = (choices[0] as Record<string, unknown>).message;
  if (message && typeof message === "object" && typeof (message as Record<string, unknown>).content === "string") {
    return (message as Record<string, unknown>).content as string;
  }
  return "";
}

function extractError(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const error = (body as Record<string, unknown>).error;
  if (error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string") {
    return (error as Record<string, unknown>).message as string;
  }
  if (typeof error === "string") return error;
  return null;
}

export async function testVendorModel(options: {
  baseUrl: string;
  protocol: "anthropic" | "chat";
  authHeader: "bearer" | "x-api-key";
  key: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ModelTestResult> {
  let base: string;
  try {
    base = normalizeBaseUrl(options.baseUrl);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const model = vendorModelId(options.model.trim());
  if (!model) return { ok: false, error: "请先填写模型 ID" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
  timer.unref();
  const started = Date.now();
  try {
    const anthropic = options.protocol === "anthropic";
    const response = await (options.fetchImpl ?? fetch)(`${base}${anthropic ? "/v1/messages" : "/v1/chat/completions"}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(options.authHeader === "x-api-key"
          ? { "x-api-key": options.key }
          : { authorization: `Bearer ${options.key}` }),
        ...(anthropic ? { "anthropic-version": "2023-06-01" } : {}),
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        stream: false,
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
      }),
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = extractError(body);
      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: `API Key 无效或无权限${detail ? `：${detail}` : ""}` };
      }
      return { ok: false, error: `端点返回 ${response.status}${detail ? `：${detail}` : ""}` };
    }
    const reply = extractReply(body, options.protocol).trim().slice(0, 80);
    return { ok: true, latencyMs: Date.now() - started, reply };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, error: "测试请求超时（模型可能在思考，也可稍后重试）" };
    return { ok: false, error: `无法访问端点：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}
