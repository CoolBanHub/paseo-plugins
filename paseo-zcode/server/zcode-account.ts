import { createDecipheriv, createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";

/**
 * Account providers (BigModel / Z.ai coding plans) are not in the CLI's
 * provider registry by default: the desktop app registers them at runtime via
 * provider/updateAccountConfig and supplies their credentials through
 * interaction/requestProviderRuntimeHeaders. This module replicates that for
 * headless use: it reads the account provider instances from
 * ~/.zcode/v2/provider_config.json and decrypts their API keys from
 * ~/.zcode/v2/credentials.json (enc:v1 AES-256-GCM with the local fallback
 * secret).
 */
export interface AccountProvider {
  providerId: string;
  family: "bigmodel" | "zai";
  apiKey: string;
  models: string[];
}

const ENC_PREFIX = "enc:v1:";

export function decryptCredential(value: string): string | undefined {
  if (!value.startsWith(ENC_PREFIX)) return value;
  const secret =
    process.env.ZCODE_CREDENTIAL_SECRET?.trim() ||
    `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
  const key = createHash("sha256").update(secret).digest();
  const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const parts = value.slice(ENC_PREFIX.length).split(".").map(b64url);
  if (parts.length !== 3) return undefined;
  try {
    const [iv, tag, ciphertext] = parts;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString();
  } catch {
    return undefined;
  }
}

export function readAccountProviders(): AccountProvider[] {
  try {
    const v2 = join(homedir(), ".zcode", "v2");
    const creds = JSON.parse(readFileSync(join(v2, "credentials.json"), "utf8")) as Record<string, unknown>;
    const cfg = JSON.parse(readFileSync(join(v2, "provider_config.json"), "utf8")) as {
      config?: {
        providerConfigRules?: { providerRules?: Array<Record<string, unknown>> };
        modelConfigRules?: { providerModelRules?: Array<Record<string, unknown>> };
      };
    };
    const rules = cfg.config?.providerConfigRules?.providerRules ?? [];
    const modelRules = cfg.config?.modelConfigRules?.providerModelRules ?? [];
    const providers: AccountProvider[] = [];
    for (const rule of rules) {
      const providerId = String(rule?.providerId ?? "");
      if (!providerId.startsWith("account:")) continue;
      const family: AccountProvider["family"] | undefined = providerId.includes("bigmodel")
        ? "bigmodel"
        : providerId.includes("zai")
          ? "zai"
          : undefined;
      if (!family) continue;
      const oauth = creds[family === "bigmodel" ? "oauth:bigmodel:access_token" : "oauth:zai:access_token"];
      if (typeof oauth !== "string" || !oauth.trim()) continue;

      const prefix = `account-provider:coding-plan:${providerId}:account:`;
      const apiKeyEntry = Object.keys(creds).find(
        (k) => k.startsWith(prefix) && k.endsWith(":api-key") && k.length > prefix.length + ":api-key".length,
      );
      const apiKey = apiKeyEntry ? decryptCredential(String(creds[apiKeyEntry])) : undefined;
      if (!apiKey) continue;

      const config = (rule?.config ?? {}) as Record<string, unknown>;
      const order = Array.isArray(config.modelOrder) ? config.modelOrder.map(String) : [];
      const models = order.filter((modelId) => {
        const disabled = modelRules.some(
          (mr) =>
            String(mr?.providerId ?? "") === providerId &&
            String(mr?.modelId ?? "") === modelId &&
            ((mr?.config as Record<string, unknown> | undefined)?.enabled === false),
        );
        return !disabled;
      });
      if (!models.length) continue;
      providers.push({ providerId, family, apiKey, models });
    }
    return providers;
  } catch {
    return [];
  }
}

/**
 * The builtin revision is a digest the CLI computes over the builtin provider
 * config; updateAccountConfig rejects mismatched values. The CLI logs the
 * exact value (configRevision[0], JSON-encoded) in provider_registry.ready
 * lines right after startup, so find the newest line written after the child
 * process spawned.
 */
export function readBuiltinRevision(spawnedAtMs: number): string | undefined {
  try {
    const dir = join(homedir(), ".zcode", "cli", "log");
    const today = new Date().toISOString().slice(0, 10);
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().reverse();
    const ordered = [
      ...files.filter((f) => f === `zcode-${today}.jsonl`),
      ...files.filter((f) => f !== `zcode-${today}.jsonl`),
    ];
    for (const file of ordered.slice(0, 2)) {
      const lines = readFileSync(join(dir, file), "utf8").split("\n").reverse();
      for (const line of lines) {
        if (!line.includes("provider_registry.ready")) continue;
        try {
          const entry = JSON.parse(line);
          const at = Date.parse(entry.timestamp ?? "");
          if (!Number.isFinite(at) || at < spawnedAtMs) continue;
          const raw = entry?.context?.configRevision;
          const revisionArray = typeof raw === "string" ? JSON.parse(raw) : raw;
          const rev = Array.isArray(revisionArray) ? revisionArray[0] : undefined;
          if (typeof rev === "string" && rev.startsWith("zcode-builtin:")) return rev;
        } catch {
          continue;
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Reads the newest turn.failed log entry for a session and returns the deepest error message. */
export function readLastTurnFailure(sessionId: string): string | undefined {
  try {
    const dir = join(homedir(), ".zcode", "cli", "log");
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().reverse().slice(0, 2);
    for (const file of files) {
      const lines = readFileSync(join(dir, file), "utf8").split("\n").reverse();
      for (const line of lines) {
        if (!line.includes('"turn.failed"')) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.sessionId !== sessionId) continue;
          let deepest: string | undefined;
          let node: unknown = entry.error;
          for (let depth = 0; depth < 6 && node && typeof node === "object"; depth++) {
            const current = node as Record<string, unknown>;
            if (typeof current.message === "string" && current.message.trim()) deepest = current.message.trim();
            node = current.cause;
          }
          if (deepest) return deepest;
        } catch {
          continue;
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Registers account providers into the CLI's runtime provider registry. */
export async function registerAccountProviders(
  request: (method: string, params: Record<string, unknown>) => Promise<{ error?: unknown }>,
  providers: AccountProvider[],
  builtinRevision: string,
): Promise<void> {
  if (!providers.length) return;
  const providerMap: Record<string, unknown> = {};
  const states: Record<string, unknown> = {};
  for (const p of providers) {
    providerMap[p.providerId] = {
      builtinModelIds: p.models,
      access: { type: "zhipu-account", entitled: true },
    };
    states[p.providerId] = { availability: "available", entitled: true, current: true };
  }
  const response = await request("provider/updateAccountConfig", {
    revision: `paseo-zcode-${Date.now()}`,
    basedOnZCodeBuiltinRevision: builtinRevision,
    providers: providerMap,
    states,
  });
  if (response.error) {
    throw new Error(`updateAccountConfig failed: ${JSON.stringify(response.error).slice(0, 200)}`);
  }
}
