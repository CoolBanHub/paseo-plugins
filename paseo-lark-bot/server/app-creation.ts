import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { LarkBotAppCreation } from "../shared/contracts.ts";
import { readCurrentAppId } from "./lark.ts";

const execFileAsync = promisify(execFile);

/**
 * One-click Feishu app creation, driven through lark-cli's official device
 * flow (`config init --new`). The CLI prints a verification URL (and an ASCII
 * QR) to stderr, then blocks until the user confirms in Feishu and writes the
 * new App ID/Secret into its keychain. This module turns that into a small
 * state machine the settings screen can poll, and renders the URL as a PNG QR
 * data URL for the UI.
 *
 * Only one flow may run at a time: a second `start` while the CLI is waiting
 * returns the current state instead of spawning a second app registration.
 */

const TIMEOUT_MS = 11 * 60 * 1_000;
const STDERR_LIMIT = 96 * 1024;
const VERIFICATION_URL =
  /https:\/\/open\.(?:feishu\.cn|larksuite\.com)\/page\/(?:cli|launcher)\?[^\s"'<>]+/u;

export type AppCreationState = LarkBotAppCreation["state"];

export interface AppCreationHandle {
  start(cliPath: string): LarkBotAppCreation;
  status(): LarkBotAppCreation;
  cancel(): LarkBotAppCreation;
  dispose(): void;
}

export interface AppCreationDeps {
  /** Injectable for tests; defaults to node:child_process.spawn. */
  spawn?: (
    command: string,
    args: string[],
    options: {
      stdio: ["ignore", "pipe", "pipe"];
      env: NodeJS.ProcessEnv;
      detached: boolean;
    },
  ) => ChildProcess;
  /** Kills the CLI process tree; injectable for tests. */
  kill?: (proc: ChildProcess, signal: "SIGTERM" | "SIGKILL") => void;
  /** Renders the verification URL into a PNG data URL. */
  qrDataUrl?: (cliPath: string, url: string) => Promise<string | null>;
  /** Reads the App ID lark-cli saved after a successful creation. */
  readAppId?: (cliPath: string) => Promise<string | null>;
  /** Called after success so the plugin can switch consumers to the new app. */
  onSuccess?: (appId: string, cliPath: string) => Promise<void> | void;
  schedule?: (callback: () => void, delayMs: number) => { clear(): void };
  log?: (message: string) => void;
  timeoutMs?: number;
}

function idle(): LarkBotAppCreation {
  return { state: "idle", url: null, qrDataUrl: null, appId: null, error: null };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * lark-cli is an npm shim that runs the native binary as a child; killing the
 * shim alone can orphan the native process. Spawn it as a process-group leader
 * and signal the whole group (taskkill /T on Windows).
 */
function killProcessTree(proc: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform === "win32") {
    if (!proc.pid) return;
    try {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      proc.kill(signal);
    }
    return;
  }
  if (proc.pid) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // The group may already be gone; fall back to the direct child.
    }
  }
  proc.kill(signal);
}

/** Strip SGR/CSI sequences so URL and error parsing works on colored output. */
function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "");
}

/**
 * The verification link printed by `config init --new`. Supports both the
 * CLI landing page (`/page/cli`) and the SDK landing page (`/page/launcher`).
 */
export function extractVerificationUrl(text: string): string | null {
  const match = stripAnsi(text).match(VERIFICATION_URL);
  if (!match) return null;
  return match[0].replace(/[),.;]+$/u, "");
}

function jsonErrorMessage(line: string): string | null {
  if (!line.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(line) as {
      error?: { message?: unknown; hint?: unknown } | string;
      message?: unknown;
    };
    if (typeof parsed.error === "string" && parsed.error) return parsed.error;
    if (parsed.error && typeof parsed.error === "object") {
      const message = typeof parsed.error.message === "string" ? parsed.error.message : "";
      const hint = typeof parsed.error.hint === "string" ? parsed.error.hint : "";
      const combined = [message, hint].filter(Boolean).join(" — ");
      if (combined) return combined;
    }
    return typeof parsed.message === "string" && parsed.message ? parsed.message : null;
  } catch {
    return null;
  }
}

/**
 * Last human-readable line of stderr, skipping the ASCII QR block and the
 * verification URL itself. The CLI's final error is usually the last line.
 */
export function lastMeaningfulLine(text: string): string | null {
  const lines = stripAnsi(text)
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.length > 240) continue;
    // The ASCII QR uses block-drawing characters only.
    if (/^[\u2580-\u259f\s]+$/u.test(line)) continue;
    if (/https?:\/\//u.test(line)) continue;
    return jsonErrorMessage(line) ?? line;
  }
  return null;
}

/** Map the CLI's device-flow terminal errors to actionable Chinese hints. */
function friendlyError(line: string | null): string | null {
  if (!line) return null;
  const lower = line.toLowerCase();
  if (lower.includes("unknown flag") || lower.includes("unknown shorthand flag")) {
    return "当前 lark-cli 不支持一键创建，请升级到 1.0.98 或更新版本";
  }
  if (lower.includes("denied") || lower.includes("拒绝")) {
    return "你取消了授权，或当前账号没有创建应用的权限";
  }
  if (lower.includes("expired") || lower.includes("过期")) {
    return "二维码已过期，请重新生成";
  }
  if (lower.includes("timed out") || lower.includes("timeout") || lower.includes("超时")) {
    return "等待扫码超时，请重新生成";
  }
  return line;
}

/**
 * PNG data URL for the settings screen. lark-cli ships a local QR encoder, so
 * we do not add another dependency; the output path is relative to a temporary
 * cwd, which is one of the directories the CLI allows.
 */
export async function buildQrDataUrl(cliPath: string, url: string): Promise<string | null> {
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "paseo-lark-qr-"));
    await execFileAsync(
      cliPath,
      ["auth", "qrcode", url, "--output", "qr.png", "--size", "480"],
      { cwd: dir, timeout: 15_000, maxBuffer: 1024 * 1024 },
    );
    const png = await readFile(join(dir, "qr.png"));
    return "data:image/png;base64," + png.toString("base64");
  } catch {
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function createAppCreationController(deps: AppCreationDeps = {}): AppCreationHandle {
  let state: LarkBotAppCreation = idle();
  let child: ChildProcess | null = null;
  let timer: { clear(): void } | null = null;
  let stderr = "";
  /** Bumped on every start/cancel/failure so late process events are ignored. */
  let generation = 0;
  const spawnFn = deps.spawn ?? spawn;
  const killFn = deps.kill ?? killProcessTree;
  const qrFactory = deps.qrDataUrl ?? buildQrDataUrl;
  const readAppId = deps.readAppId ?? readCurrentAppId;
  const schedule =
    deps.schedule ??
    ((callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      return { clear: () => clearTimeout(handle) };
    });
  const log = deps.log ?? (() => {});

  function status(): LarkBotAppCreation {
    return { ...state };
  }

  function clearTimer(): void {
    timer?.clear();
    timer = null;
  }

  /**
   * lark-cli's device flow can ignore SIGTERM while it is polling. Send it
   * first for a clean shutdown, then force-kill after a short grace period.
   * `immediate` is used on plugin unload, where the daemon may exit before a
   * deferred timer gets a chance to run.
   */
  function terminate(proc: ChildProcess | null, immediate = false): void {
    if (!proc) return;
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    if (immediate) {
      killFn(proc, "SIGKILL");
      return;
    }
    killFn(proc, "SIGTERM");
    const force = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) killFn(proc, "SIGKILL");
    }, 2_000);
    force.unref?.();
    proc.once("exit", () => clearTimeout(force));
  }

  function fail(message: string): void {
    generation += 1;
    clearTimer();
    child = null;
    state = { state: "error", url: null, qrDataUrl: null, appId: null, error: message.slice(0, 400) };
  }

  async function finishSuccess(gen: number, cliPath: string): Promise<void> {
    let appId: string | null = null;
    try {
      appId = await readAppId(cliPath);
    } catch {
      appId = null;
    }
    if (gen !== generation) return;
    if (!appId) {
      fail("应用创建完成，但没有读取到 App ID");
      return;
    }
    state = { state: "success", url: null, qrDataUrl: null, appId, error: null };
    log("飞书应用创建成功 " + appId);
    try {
      await deps.onSuccess?.(appId, cliPath);
    } catch (error) {
      log("应用创建成功后的切换失败：" + errorMessage(error));
    }
  }

  function start(cliPath: string): LarkBotAppCreation {
    if (state.state === "starting" || state.state === "waiting") return status();

    generation += 1;
    const gen = generation;
    const previous = child;
    child = null;
    clearTimer();
    terminate(previous);
    stderr = "";
    state = { state: "starting", url: null, qrDataUrl: null, appId: null, error: null };

    let proc: ChildProcess;
    try {
      proc = spawnFn(cliPath, ["config", "init", "--new", "--brand", "feishu"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        detached: process.platform !== "win32",
      });
    } catch (error) {
      fail("启动 lark-cli 失败：" + errorMessage(error));
      return status();
    }
    child = proc;
    log("开始扫码创建飞书应用");

    proc.stderr?.on("data", (chunk: Buffer) => {
      if (gen !== generation) return;
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_LIMIT);
      if (state.state !== "starting") return;
      const url = extractVerificationUrl(stderr);
      if (!url) return;
      state = { state: "waiting", url, qrDataUrl: null, appId: null, error: null };
      log("二维码已生成，等待扫码");
      void (async () => {
        try {
          const qrDataUrl = await qrFactory(cliPath, url);
          if (gen !== generation || state.state !== "waiting") return;
          state = { ...state, qrDataUrl };
        } catch (error) {
          log("生成二维码失败：" + errorMessage(error));
        }
      })();
    });
    // Drain stdout (final JSON); the App ID is read back from config show.
    proc.stdout?.resume();

    proc.on("error", (error) => {
      if (gen !== generation) return;
      fail("启动 lark-cli 失败：" + errorMessage(error));
    });
    proc.on("exit", (code, signal) => {
      if (gen !== generation) return;
      child = null;
      clearTimer();
      if (code === 0) {
        void finishSuccess(gen, cliPath);
        return;
      }
      const detail =
        friendlyError(lastMeaningfulLine(stderr)) ??
        (signal ? `进程被 ${signal} 终止` : `lark-cli 退出码 ${code}`);
      fail(detail);
    });

    timer = schedule(
      () => {
        if (gen !== generation) return;
        const running = child;
        fail("二维码已过期，请重新生成");
        terminate(running);
      },
      deps.timeoutMs ?? TIMEOUT_MS,
    );
    return status();
  }

  function cancel(): LarkBotAppCreation {
    generation += 1;
    const running = child;
    child = null;
    clearTimer();
    terminate(running);
    state = idle();
    return status();
  }

  function dispose(): void {
    generation += 1;
    const running = child;
    child = null;
    clearTimer();
    terminate(running, true);
    state = idle();
  }

  return { start, status, cancel, dispose };
}
