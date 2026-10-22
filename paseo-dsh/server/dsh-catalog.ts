import { createHash } from "node:crypto";
import type { Hash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseDocument, stringify } from "yaml";
import type { ProviderCatalogOptions } from "@getpaseo/plugin/server/provider";
import { dshCatalogShape } from "./dsh-labels.ts";

const PROFILE_FILES = ["cordis.yml", "cordis.patch.yml", "package.json", "pnpm-lock.yaml"];
const MODEL_PATCH_ID = "llm-pi-ai";
const PROVIDER_ID = "bai";

/**
 * Locate this plugin's source directory. Paseo evaluates the plugin server
 * as an esbuild CommonJS bundle inside eval(), where import.meta and
 * __dirname do not exist, so the module's own URL is unusable. The daemon's
 * config.json is the source of truth for directory plugins instead.
 * Resolution order: DSH_PLUGIN_ROOT, then plugins.dsh.path in
 * PASEO_HOME/config.json. Undefined means source hashing is skipped.
 */
export function resolvePluginSourceRoot(
  pluginId = "dsh",
  paseoHome = process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
): string | undefined {
  const fromEnv = process.env.DSH_PLUGIN_ROOT;
  if (fromEnv && readdirSyncSafe(fromEnv)) return fromEnv;
  try {
    const parsed = JSON.parse(readFileSync(join(paseoHome, "config.json"), "utf8")) as {
      plugins?: Record<string, { path?: unknown }>;
    };
    const path = parsed.plugins?.[pluginId]?.path;
    return typeof path === "string" && readdirSyncSafe(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

function readdirSyncSafe(path: string): boolean {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hash every plugin source that can shape discovery results: the server
 * entry, the server/ modules, and package.json (dependency bumps). Paseo
 * persists discovered settings per agent and only re-discovers when the
 * catalog cache key changes, so any plugin update must change the key —
 * otherwise stale labels and options keep serving after a reload. Source
 * bytes are the only marker that moves with every edit without a manual
 * version bump. A missing source root (bundled copy without a directory
 * entry) degrades to hashing only dshCatalogShape below.
 */
function hashPluginSources(hash: Hash, pluginRoot: string): void {
  const serverDir = join(pluginRoot, "server");
  const sources = [
    join(pluginRoot, "package.json"),
    join(pluginRoot, "index.server.ts"),
    ...readdirSync(serverDir)
      .filter((file) => file.endsWith(".ts"))
      .sort()
      .map((file) => join(serverDir, file)),
  ];
  for (const path of sources) {
    hash.update(path);
    try {
      hash.update(readFileSync(path));
    } catch {
      hash.update("<missing>");
    }
  }
}

/** Invalidate the catalog when either dsh profile or the execution environment changes. */
export function dshCatalogCacheKey(
  options: ProviderCatalogOptions,
  profileRoot = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "profiles"),
  pluginRoot: string | undefined = resolvePluginSourceRoot(),
): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    scope: options.scope,
    cwd: options.scope === "workspace" ? options.cwd : undefined,
    command: options.launch?.command,
    args: options.launch?.args,
    env: Object.entries(options.launch?.env ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  }));

  // Discovery surfaces this plugin's hardcoded labels (modes, permission
  // presets) too, and Paseo persists them per agent — without this
  // fingerprint a plugin-side label change would keep serving the cached
  // English strings until something else invalidates the key.
  hash.update(dshCatalogShape);
  if (pluginRoot) {
    try {
      hashPluginSources(hash, pluginRoot);
    } catch {
      // The configured root vanished or lost its server directory; the
      // shape fingerprint above still covers the label tables.
    }
  }

  for (const profile of ["acp", "web"]) {
    for (const file of PROFILE_FILES) {
      hash.update(`${profile}/${file}`);
      try {
        hash.update(readFileSync(join(profileRoot, profile, file)));
      } catch {
        hash.update("<missing>");
      }
    }
  }

  return hash.digest("hex");
}

function readPatchList(profileRoot: string): Array<{
  id?: unknown;
  config?: { providers?: Record<string, Record<string, unknown>> };
}> {
  const patchPath = join(profileRoot, "cordis.patch.yml");
  const document = parseDocument(readFileSync(patchPath, "utf8"), {
    customTags: [{
      tag: "tag:yaml.org,2002:js",
      resolve: (source: string) => source,
      identify: () => false,
    }],
  });
  if (document.errors.length) {
    throw new Error(`Could not parse dsh Web profile: ${document.errors[0].message}`);
  }

  return document.toJS() as Array<{
    id?: unknown;
    config?: { providers?: Record<string, Record<string, unknown>> };
  }>;
}

/** Build an ACP overlay from Web models and the ACP profile's non-secret route fields. */
export function writeWebModelOverlay(
  acpProfileRoot: string,
  webProfileRoot: string,
  outputPath: string,
): string[] {
  const acpPatch = readPatchList(acpProfileRoot).find((patch) => patch?.id === MODEL_PATCH_ID);
  const webPatch = readPatchList(webProfileRoot).find((patch) => patch?.id === MODEL_PATCH_ID);
  const acpProvider = acpPatch?.config?.providers?.[PROVIDER_ID];
  const models = webPatch?.config?.providers?.[PROVIDER_ID]?.models;
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error(`dsh Web profile does not define any ${PROVIDER_ID} models in ${join(webProfileRoot, "cordis.patch.yml")}`);
  }
  if (!acpProvider || typeof acpProvider.api !== "string" || typeof acpProvider.baseURL !== "string") {
    throw new Error(`dsh ACP profile must define ${PROVIDER_ID}.api and ${PROVIDER_ID}.baseURL`);
  }

  const ids = models.map((model) => {
    if (!model || typeof model !== "object" || typeof (model as { id?: unknown }).id !== "string") {
      throw new Error(`dsh Web profile contains a ${PROVIDER_ID} model without an id`);
    }
    return (model as { id: string }).id;
  });
  const route = {
    api: acpProvider.api,
    baseURL: acpProvider.baseURL,
    ...(typeof acpProvider.apiKeyEnv === "string" ? { apiKeyEnv: acpProvider.apiKeyEnv } : {}),
    models,
  };
  const overlay = [{
    id: MODEL_PATCH_ID,
    config: { providers: { [PROVIDER_ID]: route } },
  }];

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, stringify(overlay), { mode: 0o600 });
  return ids;
}
