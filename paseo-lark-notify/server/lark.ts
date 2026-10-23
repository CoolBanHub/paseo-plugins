import { execFile } from "node:child_process";
import { accessSync, constants, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SendDmOptions {
  cliPath: string;
  openId: string;
  identity: "bot" | "user";
  text: string;
}

interface LarkError {
  message?: string;
  hint?: string;
}

interface LarkPayload {
  ok?: boolean;
  data?: { message_id?: string };
  error?: LarkError;
}

interface WhoAmIPayload {
  onBehalfOf?: { openId?: string };
}

const SEND_TIMEOUT_MS = 25_000;

/**
 * lark-cli may print warnings before the JSON body; parse from the first
 * opening brace so a noisy login still yields a usable result.
 */
export function parseLarkJson(stdout: string): LarkPayload | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start)) as LarkPayload;
  } catch {
    return null;
  }
}

/**
 * The Paseo daemon is usually launched from Finder, so PATH lacks nvm's bin
 * directory. Walk explicit config, PATH, nvm versions, then common prefixes.
 */
export function resolveLarkCli(
  explicit = "",
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string | null {
  const candidates: string[] = [];
  const push = (value: string | undefined) => {
    if (value && value.trim()) candidates.push(value.trim());
  };

  push(explicit);
  push(env.LARK_CLI_PATH);
  for (const dir of (env.PATH || "").split(delimiter)) {
    if (dir) candidates.push(join(dir, "lark-cli"));
  }
  try {
    const versionsDir = join(home, ".nvm", "versions", "node");
    for (const version of readdirSync(versionsDir).sort().reverse()) {
      candidates.push(join(versionsDir, version, "bin", "lark-cli"));
    }
  } catch {
    // No nvm install on this machine.
  }
  candidates.push(
    join(home, ".local", "bin", "lark-cli"),
    "/opt/homebrew/bin/lark-cli",
    "/usr/local/bin/lark-cli",
  );

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

export async function readSelfOpenId(cliPath: string): Promise<string | null> {
  const { stdout } = await execFileAsync(cliPath, ["whoami"], {
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    const payload = JSON.parse(stdout.slice(start)) as WhoAmIPayload;
    return payload.onBehalfOf?.openId?.trim() || null;
  } catch {
    return null;
  }
}

export async function sendDm(options: SendDmOptions): Promise<string | null> {
  const { stdout, stderr } = await execFileAsync(
    options.cliPath,
    [
      "im",
      "+messages-send",
      "--as",
      options.identity,
      "--user-id",
      options.openId,
      "--markdown",
      options.text,
    ],
    { timeout: SEND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
  );

  const payload = parseLarkJson(stdout);
  if (payload?.ok === true) return payload.data?.message_id ?? null;

  const error = payload?.error;
  const detail = error?.message
    ? error.message + (error.hint ? " — " + error.hint : "")
    : stderr.trim() || stdout.trim();
  throw new Error(detail.slice(0, 400) || "lark-cli returned no result");
}
