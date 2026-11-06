import { execFile, spawn } from "node:child_process";
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
  /** Stable per logical notification; lets a retry never duplicate a send. */
  idempotencyKey?: string;
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

/** Run lark-cli with the body on stdin; a timeout kills the child hard. */
function runWithStdin(cliPath: string, args: string[], stdin: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), SEND_TIMEOUT_MS);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      if (size + chunk.length <= 4 * 1024 * 1024) {
        stdout.push(chunk);
        size += chunk.length;
      }
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.reduce((total, part) => total + part.length, 0) + chunk.length <= 64 * 1024) stderr.push(chunk);
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) {
        reject(new Error("lark-cli 执行超时"));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    child.stdin.on("error", () => { /* the child may exit before reading all input */ });
    child.stdin.end(stdin);
  });
}

export async function sendDm(options: SendDmOptions): Promise<string | null> {
  // "-" reads the markdown from stdin so the notification body (project
  // paths, session titles, reply excerpts) never appears in `ps` output.
  const args = [
    "im",
    "+messages-send",
    "--as",
    options.identity,
    "--user-id",
    options.openId,
    "--markdown",
    "-",
  ];
  if (options.idempotencyKey) {
    args.push("--idempotency-key", options.idempotencyKey.slice(0, 50));
  }
  const { stdout, stderr } = await runWithStdin(options.cliPath, args, options.text);

  const payload = parseLarkJson(stdout);
  if (payload?.ok === true) return payload.data?.message_id ?? null;

  const error = payload?.error;
  const detail = error?.message
    ? error.message + (error.hint ? " — " + error.hint : "")
    : stderr.trim() || stdout.trim();
  throw new Error(detail.slice(0, 400) || "lark-cli returned no result");
}
