import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseDocument, stringify } from "yaml";
import type { ProviderCatalogOptions } from "@getpaseo/plugin/server/provider";

const PROFILE_FILES = ["cordis.yml", "cordis.patch.yml", "package.json", "pnpm-lock.yaml"];
const MODEL_PATCH_ID = "llm-pi-ai";
const PROVIDER_ID = "bai";

/** Invalidate the catalog when either dsh profile or the execution environment changes. */
export function dshCatalogCacheKey(
  options: ProviderCatalogOptions,
  profileRoot = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "profiles"),
): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    scope: options.scope,
    cwd: options.scope === "workspace" ? options.cwd : undefined,
    command: options.launch?.command,
    args: options.launch?.args,
    env: Object.entries(options.launch?.env ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  }));

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
