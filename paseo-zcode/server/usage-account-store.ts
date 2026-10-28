import { readFileSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Which usage accounts the plugin hides from Paseo's usage view, kept as one
 * JSON file under the plugin's data directory. Hidden keys (not a shown
 * allowlist) so accounts discovered later stay visible by default.
 */

type PersistedFile = { version: 1; hidden: string[] };

export function usageAccountDataDirectory(explicit?: string): string {
  if (explicit) return explicit;
  const paseoHome = process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
  return join(paseoHome, "plugin-data", "zcode");
}

function parseHiddenFile(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const hidden = (value as Record<string, unknown>).hidden;
  if (!Array.isArray(hidden)) return [];
  const seen = new Set<string>();
  for (const entry of hidden) {
    if (typeof entry !== "string" || !entry || entry.length > 128 || seen.has(entry)) continue;
    seen.add(entry);
  }
  return [...seen];
}

export function readHiddenUsageAccounts(directory?: string): string[] {
  try {
    return parseHiddenFile(JSON.parse(readFileSync(join(usageAccountDataDirectory(directory), "usage-accounts.json"), "utf8")));
  } catch {
    return [];
  }
}

export async function writeHiddenUsageAccounts(hidden: readonly string[], directory?: string): Promise<void> {
  const root = usageAccountDataDirectory(directory);
  const path = join(root, "usage-accounts.json");
  const file: PersistedFile = { version: 1, hidden: [...new Set(hidden)].slice(0, 200) };
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(temporary, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}
