import { PROVIDER_PRESETS, type PresetModel } from "../shared/presets.ts";
import type { FetchedModel } from "../shared/contracts.ts";
import { modelIdPattern } from "../shared/model-id.ts";
import { normalizeBaseUrl } from "./store.ts";

/**
 * Vendor model discovery: GET <base>/v1/models over the person's key (the
 * OpenAI and Anthropic list endpoints share the {data:[{id}]} shape), then
 * the raw ids gain the presets' knowledge — display label, context window,
 * and a "[1m]" variant whenever a preset knows one — so a fetched model
 * needs no manual configuration.
 */

function presetIndex(): Map<string, PresetModel> {
  const map = new Map<string, PresetModel>();
  for (const preset of PROVIDER_PRESETS) {
    for (const model of preset.models) map.set(model.id, model);
  }
  return map;
}

/** Fetched ids with the presets' label/window attached, 1M variants offered. */
export function expandFetchedModels(ids: readonly unknown[]): FetchedModel[] {
  const presets = presetIndex();
  const models: FetchedModel[] = [];
  const seen = new Set<string>();
  const push = (id: string, label?: string, contextWindow?: number) => {
    if (seen.has(id) || !modelIdPattern.test(id)) return;
    seen.add(id);
    models.push({ id, ...(label ? { label } : {}), ...(contextWindow ? { contextWindow } : {}) });
  };
  for (const raw of ids) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id) continue;
    const preset = presets.get(id);
    push(id, preset?.label, preset?.contextWindow);
    // "[1m]" is never a vendor id — only a preset knowing the variant offers it.
    const variant = presets.get(`${id}[1m]`);
    if (variant) push(`${id}[1m]`, variant.label, variant.contextWindow);
  }
  return models;
}

export type VendorModelsResult = { ok: true; models: FetchedModel[] } | { ok: false; error: string };

/** Context-window field names gateways actually use on /v1/models entries. */
const WINDOW_FIELDS = ["context_length", "context_window", "max_context_length", "max_model_len"];

export async function fetchVendorModels(options: {
  baseUrl: string;
  authHeader: "bearer" | "x-api-key";
  key: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<VendorModelsResult> {
  let base: string;
  try {
    base = normalizeBaseUrl(options.baseUrl);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  timer.unref();
  try {
    const response = await (options.fetchImpl ?? fetch)(`${base}/v1/models`, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(options.authHeader === "x-api-key"
          ? { "x-api-key": options.key }
          : { authorization: `Bearer ${options.key}` }),
      },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) return { ok: false, error: "API Key 无效或无权限" };
    if (response.status === 404 || response.status === 405) return { ok: false, error: "该端点不提供模型列表，请手动添加模型" };
    if (!response.ok) return { ok: false, error: `端点返回 ${response.status}` };
    const body: unknown = await response.json().catch(() => null);
    const data = body && typeof body === "object" && !Array.isArray(body)
      ? (body as { data?: unknown }).data : null;
    if (!Array.isArray(data)) return { ok: false, error: "端点返回的模型列表格式无法识别" };
    const ids: string[] = [];
    const windows = new Map<string, number>();
    for (const entry of data) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.id !== "string") continue;
      ids.push(record.id);
      for (const field of WINDOW_FIELDS) {
        const value = record[field];
        if (typeof value === "number" && Number.isInteger(value) && value >= 4_096 && value <= 10_000_000) {
          windows.set(record.id, value);
        }
      }
    }
    const models = expandFetchedModels(ids).map((model) =>
      model.contextWindow ? model : windows.has(model.id) ? { ...model, contextWindow: windows.get(model.id)! } : model);
    if (!models.length) return { ok: false, error: "端点未返回可用模型" };
    return { ok: true, models };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, error: "获取模型列表超时" };
    return { ok: false, error: `无法访问端点：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}
