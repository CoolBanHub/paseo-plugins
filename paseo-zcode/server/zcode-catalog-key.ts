import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Build the zcode provider's catalog cache key.
 *
 * Paseo persists discovery results per agent and only re-discovers when the
 * key changes, so the key must move with everything that shapes the catalog:
 * the zcode CLI (the model list is queried live from it), the plugin's own
 * sources (mode labels and catalog assembly), and package.json (dependency
 * bumps). A constant key keeps serving stale labels and models across plugin
 * updates — exactly the bug this replaces.
 *
 * The plugin server runs as an esbuild CommonJS bundle inside eval(), where
 * import.meta and __dirname do not exist, so the source root is resolved
 * from the daemon's config instead: ZCODE_PLUGIN_ROOT, then
 * plugins.zcode.path in PASEO_HOME/config.json. Missing inputs degrade to
 * hashing only the marker and CLI identity, never to a constant key.
 */
export function zcodeCatalogCacheKey(
  options: { cliPath?: string; pluginRoot?: string } = {},
): Promise<string> {
  const hash = createHash("sha256");
  hash.update("zcode-local");

  const cliPath = options.cliPath;
  hash.update("cli");
  if (cliPath) {
    try {
      const stats = statSync(cliPath);
      hash.update(`${cliPath}:${stats.mtimeMs}:${stats.size}`);
    } catch {
      hash.update("<missing>");
    }
  } else {
    hash.update("<unresolved>");
  }

  const pluginRoot = options.pluginRoot ?? resolvePluginSourceRoot();
  if (pluginRoot) {
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

  return Promise.resolve(hash.digest("hex"));
}

/**
 * Locate this plugin's source directory from the daemon's config.json (the
 * source of truth for directory plugins; the bundled runtime exposes no
 * module path). Resolution order: ZCODE_PLUGIN_ROOT, then plugins.zcode.path.
 */
export function resolvePluginSourceRoot(
  pluginId = "zcode",
  paseoHome = process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
): string | undefined {
  const fromEnv = process.env.ZCODE_PLUGIN_ROOT;
  if (fromEnv && isReadableDir(fromEnv)) return fromEnv;
  try {
    const parsed = JSON.parse(readFileSync(join(paseoHome, "config.json"), "utf8")) as {
      plugins?: Record<string, { path?: unknown }>;
    };
    const path = parsed.plugins?.[pluginId]?.path;
    return typeof path === "string" && isReadableDir(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

function isReadableDir(path: string): boolean {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}
