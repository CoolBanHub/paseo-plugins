import { readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderInput, ProviderView } from "../shared/contracts.ts";
import { menuModelId, ownModelDescription } from "../shared/model-id.ts";

/**
 * Provider configuration and API keys, kept under the plugin's data
 * directory. Keys live in their own 0600 files and never enter Paseo config
 * or the renderer; providers.json is 0600 inside a 0700 directory.
 */

export type StoredModel = {
  id: string;
  label: string;
  description?: string;
  contextWindow?: number;
};

export type StoredProvider = {
  id: string;
  label: string;
  baseUrl: string;
  protocol: "anthropic" | "chat";
  authHeader: "bearer" | "x-api-key";
  enabled: boolean;
  models: StoredModel[];
  updatedAt: string;
};

/** A model as it appears in Paseo's Claude model picker. */
export type MenuModel = {
  id: string;
  label: string;
  description: string;
  contextWindow?: number;
  provider: StoredProvider;
};

const LOOPLBACK = /^(?:localhost|127\.0\.0\.1|\[::1\])$/i;

/** https-only except loopback (local vLLM/Ollama), no credentials/query/hash. */
export function normalizeBaseUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error("API 地址格式不正确");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("API 地址必须是 http(s)");
  if (parsed.protocol === "http:" && !LOOPLBACK.test(parsed.hostname)) throw new Error("仅本地回环地址允许 http，其他地址必须使用 https");
  if (parsed.username || parsed.password) throw new Error("API 地址不能携带账号密码");
  if (parsed.search || parsed.hash) throw new Error("API 地址不能携带查询参数");
  return parsed.toString().replace(/\/+$/, "");
}

export function normalizeApiKey(value: string): string {
  const key = value.trim();
  if (key.length < 8 || key.length > 512 || /[\s\u0000-\u001f\u007f]/.test(key)) throw new Error("API Key 格式不正确");
  return key;
}

const slugPattern = /^[a-z0-9][a-z0-9-]{0,31}$/;

function slugify(label: string): string {
  const slug = label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return slugPattern.test(slug) ? slug : "provider";
}

export function dataDirectory(explicit?: string): string {
  if (explicit) return explicit;
  const paseoHome = process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
  return join(paseoHome, "plugin-data", "custom-models");
}

type PersistedFile = { version: 1; providers: StoredProvider[] };

function parseProvidersFile(value: unknown): StoredProvider[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const providers = (value as Record<string, unknown>).providers;
  if (!Array.isArray(providers)) return [];
  const parsed: StoredProvider[] = [];
  for (const entry of providers) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.label !== "string" || typeof record.baseUrl !== "string"
      || (record.protocol !== "anthropic" && record.protocol !== "chat")
      || (record.authHeader !== "bearer" && record.authHeader !== "x-api-key")
      || typeof record.enabled !== "boolean" || typeof record.updatedAt !== "string" || !Array.isArray(record.models)) continue;
    const models: StoredModel[] = [];
    for (const model of record.models) {
      if (!model || typeof model !== "object" || Array.isArray(model)) continue;
      const m = model as Record<string, unknown>;
      if (typeof m.id !== "string" || typeof m.label !== "string") continue;
      models.push({
        id: m.id, label: m.label,
        ...(typeof m.description === "string" ? { description: m.description } : {}),
        ...(typeof m.contextWindow === "number" && Number.isInteger(m.contextWindow) && m.contextWindow > 0 ? { contextWindow: m.contextWindow } : {}),
      });
    }
    if (!models.length) continue;
    parsed.push({ id: record.id, label: record.label, baseUrl: record.baseUrl, protocol: record.protocol, authHeader: record.authHeader, enabled: record.enabled, models, updatedAt: record.updatedAt });
  }
  return parsed;
}

export type ModelRegistryOptions = {
  directory?: string;
  now?: () => string;
};

export type ModelRegistry = ReturnType<typeof createModelRegistry>;

export function createModelRegistry(options: ModelRegistryOptions = {}) {
  const root = dataDirectory(options.directory);
  const providersPath = join(root, "providers.json");
  const keysDirectory = join(root, "keys");
  const now = options.now ?? (() => new Date().toISOString());

  // Serialized writes keep providers.json consistent across concurrent saves.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const task = queue.then(work, work);
    queue = task.catch(() => undefined);
    return task;
  };

  async function atomicWrite(path: string, content: string, mode: 0o600 | 0o700): Promise<void> {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, content, { mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
  }

  function readProviders(): StoredProvider[] {
    try {
      return parseProvidersFile(JSON.parse(readFileSync(providersPath, "utf8")));
    } catch {
      return [];
    }
  }

  /** Enabled providers with a working key; only these join the menu. */
  const enabledProviders = (): StoredProvider[] =>
    readProviders().filter((provider) => provider.enabled && readKey(provider.id) !== null);

  function keyPath(id: string): string {
    return join(keysDirectory, `${id}.secret`);
  }

  function readKey(id: string): string | null {
    try {
      return normalizeApiKey(readFileSync(keyPath(id), "utf8"));
    } catch {
      return null;
    }
  }

  function uniqueId(existing: StoredProvider[], keepId: string | undefined, label: string): string {
    const taken = new Set(existing.filter((provider) => provider.id !== keepId).map((provider) => provider.id));
    const base = slugify(label);
    if (keepId && slugPattern.test(keepId) && !taken.has(keepId)) return keepId;
    if (!taken.has(base)) return base;
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${base}-${index}`;
      if (!taken.has(candidate)) return candidate;
    }
    throw new Error("Provider 数量过多");
  }

  async function persist(providers: StoredProvider[]): Promise<void> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const file: PersistedFile = { version: 1, providers };
    await atomicWrite(providersPath, `${JSON.stringify(file, null, 2)}\n`, 0o600);
  }

  return {
    root,
    /** All configured providers, enabled or not, in save order. */
    list: (): StoredProvider[] => readProviders(),
    /** Enabled providers with a working key; only these join the menu. */
    enabled: (): StoredProvider[] => enabledProviders(),
    providerById: (id: string): StoredProvider | undefined => readProviders().find((provider) => provider.id === id),
    apiKey: (id: string): string | null => readKey(id),

    async save(input: ProviderInput): Promise<StoredProvider> {
      const baseUrl = normalizeBaseUrl(input.baseUrl);
      const models = input.models.map((model) => ({
        id: model.id,
        label: model.label.trim() || model.id,
        ...(model.description ? { description: model.description } : {}),
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      }));
      return enqueue(async () => {
        const providers = readProviders();
        const id = uniqueId(providers, input.id, input.label);
        const suppliedKey = input.apiKey?.trim() ? normalizeApiKey(input.apiKey) : null;
        if (!suppliedKey && !readKey(id)) throw new Error("请先填写 API Key");
        if (suppliedKey) {
          await mkdir(keysDirectory, { recursive: true, mode: 0o700 });
          await atomicWrite(keyPath(id), `${suppliedKey}\n`, 0o600);
        }
        const stored: StoredProvider = {
          id, label: input.label, baseUrl, protocol: input.protocol, authHeader: input.authHeader,
          enabled: input.enabled, models, updatedAt: now(),
        };
        const index = providers.findIndex((provider) => provider.id === id);
        if (index >= 0) providers[index] = stored;
        else providers.push(stored);
        await persist(providers);
        return stored;
      });
    },

    async remove(id: string): Promise<boolean> {
      return enqueue(async () => {
        const providers = readProviders();
        const next = providers.filter((provider) => provider.id !== id);
        if (next.length === providers.length) return false;
        await persist(next);
        await rm(keyPath(id), { force: true }).catch(() => undefined);
        return true;
      });
    },

    /** The menu entries contributed to the Claude provider, in menu order. */
    menuModels(): MenuModel[] {
      const entries: MenuModel[] = [];
      const seen = new Set<string>();
      for (const provider of enabledProviders()) {
        for (const model of provider.models) {
          const id = menuModelId(model.id);
          // The first provider listing an id owns the menu entry.
          if (seen.has(id)) continue;
          seen.add(id);
          entries.push({
            id,
            label: model.label,
            description: ownModelDescription(provider.label),
            ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
            provider,
          });
        }
      }
      return entries;
    },

    /** Whether a model id is one of the enabled providers' menu ids. */
    isOwnMenuModel: (model: unknown): model is string =>
      typeof model === "string" && model.startsWith("cm:")
        && enabledProviders().some((provider) => provider.models.some((entry) => menuModelId(entry.id) === model)),

    /** The enabled provider a menu model id (or vendor id) belongs to. */
    providerForModel: (model: string): StoredProvider | null => {
      const wanted = model.startsWith("cm:") ? model.slice("cm:".length) : model;
      for (const provider of enabledProviders()) {
        if (provider.models.some((model) => model.id === wanted)) return provider;
      }
      return null;
    },

    /** Renderer-facing views: configuration without the key, only its hint. */
    views: (): ProviderView[] => readProviders().map((provider) => {
      const key = readKey(provider.id);
      return {
        id: provider.id,
        label: provider.label,
        baseUrl: provider.baseUrl,
        protocol: provider.protocol,
        authHeader: provider.authHeader,
        enabled: provider.enabled,
        models: provider.models,
        keyConfigured: key !== null,
        keyHint: key ? `••••${key.slice(-4)}` : null,
        updatedAt: provider.updatedAt,
      };
    }),
  };
}
