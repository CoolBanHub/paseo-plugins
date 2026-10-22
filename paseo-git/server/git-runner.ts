import { execCommand } from "@getpaseo/plugin/server";

/**
 * Thin wrapper over the SDK process helper. `LC_ALL=C` keeps git's human
 * readable messages stable; `GIT_OPTIONAL_LOCKS=0` avoids touching the index
 * during read-only commands. `extraEnv` carries the proxy variables derived
 * from the plugin's proxy settings and wins over the daemon environment.
 */
export async function runGit(
  args: readonly string[],
  cwd: string,
  timeoutMs = 15_000,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<string> {
  const { stdout } = await execCommand("git", [...args], {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", ...extraEnv },
  });
  return stdout;
}
