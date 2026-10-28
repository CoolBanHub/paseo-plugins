import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  hashAccountKey,
  toneFromUsedPct,
  windowFromUsedPct,
  type UsageSourceRegistration,
  type UsageReport,
  type UsageWindow,
  type UsageBalance,
} from "@getpaseo/plugin/server/usage";
import { decryptCredential, readAccountProviders } from "./zcode-account";

const QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";

interface QuotaLimit {
  type?: string;
  unit?: number;
  number?: number;
  percentage?: number;
  nextResetTime?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  usageDetails?: Array<{ modelCode?: string; usage?: number }>;
}

interface QuotaResponse {
  code?: number;
  msg?: string;
  data?: { limits?: QuotaLimit[]; level?: string };
}

/** Zhipu coding plans identify their windows by type + unit + number. */
function findLimit(limits: QuotaLimit[], unit: number, number?: number): QuotaLimit | undefined {
  return limits.find(
    (l) => (l.type === "TOKENS_LIMIT" || l.type === "CREDIT_LIMIT") && l.unit === unit && (number === undefined || l.number === number),
  );
}

function iso(ms: number | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function buildReport(payload: QuotaResponse, planPrefix: string): UsageReport {
  const limits = payload.data?.limits ?? [];
  const fiveHour = findLimit(limits, 3, 5);
  const week = findLimit(limits, 6);
  const mcp = limits.find((l) => l.type === "TIME_LIMIT" && l.unit === 5);
  const level = payload.data?.level?.trim();

  const windows: UsageWindow[] = [];
  if (fiveHour) {
    windows.push(
      windowFromUsedPct({
        id: "five-hour",
        label: "5 小时额度",
        shortLabel: "5h",
        summary: true,
        utilizationPct: fiveHour.percentage ?? null,
        resetsAt: iso(fiveHour.nextResetTime),
      }),
    );
  }
  if (week) {
    windows.push(
      windowFromUsedPct({
        id: "week",
        label: "每周额度",
        shortLabel: "wk",
        summary: true,
        utilizationPct: week.percentage ?? null,
        resetsAt: iso(week.nextResetTime),
      }),
    );
  }

  // Credit-based plans report concrete counts; expose them as balances.
  const balances: UsageBalance[] = [];
  if (fiveHour?.type === "CREDIT_LIMIT" && typeof fiveHour.usage === "number") {
    balances.push({
      id: "five-hour-credits",
      label: "5 小时剩余额度（credits）",
      used: fiveHour.currentValue ?? null,
      remaining: fiveHour.remaining ?? null,
      limit: fiveHour.usage ?? null,
      unit: "credits",
      resetsAt: iso(fiveHour.nextResetTime),
      tone: toneFromUsedPct(fiveHour.percentage ?? null),
    });
  }
  if (week?.type === "CREDIT_LIMIT" && typeof week.usage === "number") {
    balances.push({
      id: "week-credits",
      label: "每周剩余额度（credits）",
      used: week.currentValue ?? null,
      remaining: week.remaining ?? null,
      limit: week.usage ?? null,
      unit: "credits",
      resetsAt: iso(week.nextResetTime),
      tone: toneFromUsedPct(week.percentage ?? null),
    });
  }
  if (mcp && typeof mcp.usage === "number") {
    balances.push({
      id: "mcp-monthly",
      label: "MCP 工具月额度",
      used: mcp.currentValue ?? null,
      remaining: mcp.remaining ?? null,
      limit: mcp.usage ?? null,
      unit: "requests",
      resetsAt: iso(mcp.nextResetTime),
      tone: toneFromUsedPct(mcp.percentage ?? null),
    });
  }

  const details = [];
  if (level) details.push({ id: "plan", label: "套餐", value: level === "max" ? "GLM Coding Max" : level });
  if (mcp?.usageDetails?.length) {
    const parts = mcp.usageDetails
      .filter((d) => (d.usage ?? 0) > 0)
      .map((d) => `${d.modelCode}: ${d.usage}`)
      .join("，");
    if (parts) details.push({ id: "mcp-detail", label: "本月 MCP 工具用量", value: parts });
  }

  return {
    status: "available",
    planLabel: `${planPrefix}${level === "max" ? "GLM Coding Max" : level ? level : "Coding Plan"}`,
    windows,
    ...(balances.length ? { balances } : {}),
    details,
  };
}

type QuotaFetch = { kind: "payload"; payload: QuotaResponse } | { kind: "report"; report: UsageReport };

async function fetchQuota(authorization: string): Promise<QuotaFetch> {
  // AbortSignal.timeout's global type resolves against react-native's bundled
  // DOM lib in the plugin-wide tsc program; an AbortController timer keeps
  // the same timeout without that clash.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(QUOTA_URL, {
      headers: { Authorization: authorization, "x-request-id": crypto.randomUUID() },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return {
        kind: "report",
        report: {
          status: "unavailable",
          problem: { kind: "rejected", status: response.status, refreshedBy: "检查 API key 或重新登录 ZCode" },
        },
      };
    }
    if (!response.ok) return { kind: "report", report: { status: "error", error: `quota endpoint returned ${response.status}` } };
    const payload = (await response.json()) as QuotaResponse;
    if (payload.code !== 200 || !payload.data?.limits) {
      return { kind: "report", report: { status: "error", error: payload.msg || "quota endpoint returned no limits" } };
    }
    return { kind: "payload", payload };
  } finally {
    clearTimeout(timer);
  }
}

interface ApiKeyPlanProvider {
  providerId: string;
  providerName: string;
}

/** Personal providers backed by a Zhipu coding-plan API key (e.g. binglm). */
function readApiKeyPlanProviders(): ApiKeyPlanProvider[] {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".zcode", "v2", "provider_config.json"), "utf8")) as {
      config?: {
        providerConfigRules?: {
          providerRules?: Array<{
            providerId?: string;
            providerName?: string;
            config?: { access?: { type?: string; apiKey?: string } };
          }>;
        };
      };
    };
    return (cfg.config?.providerConfigRules?.providerRules ?? [])
      .filter((r) => r.config?.access?.type === "zhipu-coding-plan-api-key" && r.config?.access?.apiKey?.trim())
      .map((r) => ({ providerId: String(r.providerId ?? ""), providerName: String(r.providerName ?? r.providerId ?? "") }));
  } catch {
    return [];
  }
}

function readApiKey(providerId: string): string | undefined {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".zcode", "v2", "provider_config.json"), "utf8")) as {
      config?: {
        providerConfigRules?: {
          providerRules?: Array<{ providerId?: string; config?: { access?: { apiKey?: string } } }>;
        };
      };
    };
    const rule = (cfg.config?.providerConfigRules?.providerRules ?? []).find((r) => r.providerId === providerId);
    const key = rule?.config?.access?.apiKey;
    return typeof key === "string" && key.trim() ? key : undefined;
  } catch {
    return undefined;
  }
}

function readBigModelAccountToken(): string | undefined {
  try {
    const creds = JSON.parse(readFileSync(join(homedir(), ".zcode", "v2", "credentials.json"), "utf8")) as Record<string, unknown>;
    const encrypted = creds["oauth:bigmodel:access_token"];
    return typeof encrypted === "string" && encrypted ? encrypted : undefined;
  } catch {
    return undefined;
  }
}

/** One coding-plan account discoverable on this machine. */
export interface DiscoveredUsageAccount {
  key: string;
  label: string;
  kind: "account" | "apikey";
  input: { kind: "account" | "apikey"; providerId: string };
}

/** BigModel login plus every personal provider backed by a coding-plan key. */
export function discoverUsageAccounts(): DiscoveredUsageAccount[] {
  const accounts: DiscoveredUsageAccount[] = [];
  const bigmodel = readAccountProviders().find((p) => p.family === "bigmodel");
  if (bigmodel && readBigModelAccountToken()) {
    accounts.push({
      key: hashAccountKey(bigmodel.providerId),
      label: "智谱 BigModel 账号套餐",
      kind: "account",
      input: { kind: "account", providerId: bigmodel.providerId },
    });
  }
  for (const p of readApiKeyPlanProviders()) {
    if (!p.providerId) continue;
    accounts.push({
      key: hashAccountKey(`${p.providerId}:${p.providerName}`),
      label: `${p.providerName}（智谱 API key 套餐）`,
      kind: "apikey",
      input: { kind: "apikey", providerId: p.providerId },
    });
  }
  return accounts;
}

/** Accounts the usage view shows: everything except the hidden keys. */
export function reportedUsageAccounts(
  accounts: readonly DiscoveredUsageAccount[],
  hidden: readonly string[],
): DiscoveredUsageAccount[] {
  const hiddenKeys = new Set(hidden);
  return accounts.filter((account) => !hiddenKeys.has(account.key));
}

export type ZcodeUsageSourceOptions = {
  /** Read per discover() call, so the settings screen takes effect without a reload. */
  hiddenAccounts?: () => readonly string[];
};

export function createZcodeUsageSource(options: ZcodeUsageSourceOptions = {}): UsageSourceRegistration {
  const hiddenAccounts = options.hiddenAccounts ?? (() => []);
  return {
    id: "zcode-coding-plan",
    label: "ZCode Coding Plan",
    input: z.object({ kind: z.enum(["account", "apikey"]), providerId: z.string() }),
    discover: async () =>
      reportedUsageAccounts(discoverUsageAccounts(), hiddenAccounts()).map((account) => ({
        key: account.key,
        label: account.label,
        harness: "ZCode",
        input: account.input,
      })),
    fetch: async (rawInput) => {
      const input = rawInput as { kind: "account" | "apikey"; providerId: string };
      if (input?.kind === "apikey") {
        const apiKey = readApiKey(input.providerId);
        if (!apiKey) {
          return { status: "unavailable", problem: { kind: "no_quota", detail: "未找到该供应商的 API key" } };
        }
        const result = await fetchQuota("Bearer " + apiKey);
        return result.kind === "payload" ? buildReport(result.payload, `${input.providerId} · `) : result.report;
      }
      const encrypted = readBigModelAccountToken();
      if (!encrypted) {
        return {
          status: "unavailable",
          problem: { kind: "no_quota", detail: "未找到 BigModel 账号凭证，请先在 ZCode 桌面版登录" },
        };
      }
      const jwt = decryptCredential(encrypted);
      if (!jwt) {
        return { status: "unavailable", problem: { kind: "no_quota", detail: "BigModel 凭证解密失败" } };
      }
      const result = await fetchQuota(jwt);
      return result.kind === "payload" ? buildReport(result.payload, "BigModel · ") : result.report;
    },
  };
}
