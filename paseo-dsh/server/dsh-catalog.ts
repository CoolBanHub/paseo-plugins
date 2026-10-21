import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderCatalogOptions } from "@getpaseo/plugin/server/provider";

const PROFILE_FILES = ["cordis.yml", "cordis.patch.yml", "package.json", "pnpm-lock.yaml"];

/** Invalidate Paseo's workspace catalog when the dsh ACP profile changes. */
export function dshCatalogCacheKey(
  options: ProviderCatalogOptions,
  profileRoot = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "profiles", "acp"),
): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    scope: options.scope,
    cwd: options.scope === "workspace" ? options.cwd : undefined,
    command: options.launch?.command,
    args: options.launch?.args,
    env: Object.entries(options.launch?.env ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  }));

  for (const file of PROFILE_FILES) {
    hash.update(file);
    try {
      hash.update(readFileSync(join(profileRoot, file)));
    } catch {
      hash.update("<missing>");
    }
  }

  return hash.digest("hex");
}
