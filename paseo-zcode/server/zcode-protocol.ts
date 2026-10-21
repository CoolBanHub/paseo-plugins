import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Client for the ZCode Protocol ("zcode app-server --stdio").
 *
 * Transport: newline-delimited JSON over stdio.
 *  - client request:  {id, method, params}          -> {id, result} | {id, error}
 *  - server push:     {method, params}              (session/event, process/*, ...)
 *  - server request:  {id, method, params}          -> client replies {id, result}
 */
export interface ZcodeRequestResult {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ZcodeSessionEvent {
  type: string;
  payload: Record<string, unknown> | undefined;
  sessionId: string;
  turnId?: string;
  seq: number;
  timestamp: number;
}

export interface ZcodeServerRequest {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
}

export interface ZcodeStateUpdate {
  sessionId: string;
  scope?: string;
  revision: number;
  reason?: string;
  patch?: Record<string, unknown>;
}

const ZCODE_CLI_CANDIDATES = [
  "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
  join(homedir(), "Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"),
];

export function resolveZcodeCliPath(): string | undefined {
  const fromEnv = process.env.ZCODE_CLI_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return ZCODE_CLI_CANDIDATES.find((p) => existsSync(p));
}

export function resolveNodePath(): string {
  return process.env.ZCODE_NODE_PATH || process.execPath;
}

/**
 * The CLI needs the ZCode built-in provider config. The desktop app caches it
 * under ~/.zcode/v2/runtime/provider/<platform>/<appVersion>/endpoint-<hash>
 * and normally passes its location via the environment; without it (for
 * example when spawned from Paseo's daemon) the CLI exits with a "无法定位
 * CLI ZCode Built-in Provider Config" error. Point
 * ZCODE_BUILTIN_PROVIDER_CONFIG_FILE at the newest cached copy so headless
 * runs work outside the desktop app.
 */
export function resolveBuiltinProviderConfig(): string | undefined {
  if (process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) return process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  const platform = process.platform === "darwin" && process.arch === "arm64" ? "darwin-aarch64" : undefined;
  if (!platform) return undefined;
  const root = join(homedir(), ".zcode", "v2", "runtime", "provider", platform);
  try {
    const versions = readdirSync(root).sort().reverse();
    for (const version of versions) {
      const versionDir = join(root, version);
      for (const endpoint of readdirSync(versionDir)) {
        const candidate = join(versionDir, endpoint, "zcode-builtin.json");
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

const RUNTIME_PREFERENCES = {
  nativeSearchEnhancementsEnabled: true,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: "preflight-v1",
};

export class ZcodeProtocolClient {
  private child: ChildProcess | undefined;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (r: ZcodeRequestResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private eventListeners = new Set<(event: ZcodeSessionEvent) => void>();
  private stateListeners = new Set<(update: ZcodeStateUpdate) => void>();
  private serverRequestListeners = new Set<(request: ZcodeServerRequest) => boolean>();
  private buffer = "";
  private closed = false;
  readonly exitPromise: Promise<void>;
  private exitResolve: () => void = () => {};

  constructor(
    private readonly options: {
      cliPath: string;
      nodePath: string;
      cwd: string;
      onLog?: (message: string, detail?: unknown) => void;
    },
  ) {
    this.exitPromise = new Promise((resolve) => {
      this.exitResolve = resolve;
    });
  }

  get log() {
    return (message: string, detail?: unknown) => this.options.onLog?.(message, detail);
  }

  get childPid(): number | undefined {
    return this.child?.pid;
  }

  start(): void {
    if (this.child) return;
    const builtinConfig = resolveBuiltinProviderConfig();
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1", NO_COLOR: "1" };
    if (builtinConfig && !env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) {
      env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtinConfig;
    }
    const child = spawn(this.options.nodePath, [this.options.cliPath, "app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.options.cwd,
      env,
    });
    this.child = child;
    this.log(`[zcode] spawning ${this.options.nodePath} ${this.options.cliPath} (builtinConfig=${builtinConfig ?? "none"})`);
    child.stdout?.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) this.log("[zcode] stderr: " + text.slice(0, 500));
    });
    child.on("exit", (code) => {
      this.log(`[zcode] app-server exited (code=${code})`);
      for (const [, entry] of this.pending) {
        entry.reject(new Error("zcode app-server exited"));
        clearTimeout(entry.timer);
      }
      this.pending.clear();
      if (!this.closed) {
        this.child = undefined;
      }
      this.exitResolve();
    });
  }

  private handleStdout(chunk: Buffer) {
    this.buffer += chunk.toString();
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line);
      } catch {
        this.log("[zcode] unparseable line: " + line.slice(0, 200));
        continue;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(message: Record<string, unknown>) {
    if (typeof message.method === "string" && message.id !== undefined) {
      this.handleServerRequest(message as unknown as ZcodeServerRequest);
      return;
    }
    if (typeof message.method === "string") {
      const params = (message.params ?? {}) as Record<string, unknown>;
      if (message.method === "session/event") {
        for (const listener of this.eventListeners) {
          listener(params as unknown as ZcodeSessionEvent);
        }
      } else if (message.method === "state.updated") {
        for (const listener of this.stateListeners) {
          listener(params as unknown as ZcodeStateUpdate);
        }
      } else if (message.method === "computer-use/operation-event" && params.kind === "turn-failed") {
        // Early turn failures (model/auth/quota) are reported only through
        // this channel, never as session/event — surface them to the provider.
        for (const listener of this.eventListeners) {
          listener({
            type: "zcode.turn_failed",
            sessionId: String(params.sessionId ?? ""),
            turnId: typeof params.turnId === "string" ? params.turnId : undefined,
            seq: 0,
            timestamp: Date.now(),
            payload: {},
          });
        }
      }
      return;
    }
    if (typeof message.id === "number") {
      const entry = this.pending.get(message.id);
      const error = message.error as { message?: string } | undefined;
      if (entry) {
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        this.log(`[zcode] <- response (id=${message.id})${error ? " ERROR: " + (error.message ?? "") : ""}`);
        entry.resolve(message as unknown as ZcodeRequestResult);
      } else {
        this.log(`[zcode] <- response for unknown id=${message.id}`);
      }
    }
  }

  private handleServerRequest(request: ZcodeServerRequest) {
    // Known server requests that can be answered deterministically.
    if (request.method === "session/requestRuntimePreferences") {
      this.replyServerRequest(request.id, RUNTIME_PREFERENCES);
      return;
    }
    if (request.method === "interaction/requestOfficialMcpAuthHeaders") {
      // No official plugin auth available outside the desktop app; decline so the
      // affected MCP servers are skipped rather than blocking the session.
      this.replyServerRequest(request.id, {});
      return;
    }
    for (const listener of this.serverRequestListeners) {
      if (listener(request)) return;
    }
    this.log(`[zcode] unhandled server request ${request.method}`, request.params);
    this.replyServerRequest(request.id, {});
  }

  replyServerRequest(id: string | number, result: unknown): void {
    this.child?.stdin?.write(JSON.stringify({ id, result }) + "\n");
  }

  onSessionEvent(listener: (event: ZcodeSessionEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStateUpdate(listener: (update: ZcodeStateUpdate) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Registers a handler; return true when the request was handled. */
  onServerRequest(listener: (request: ZcodeServerRequest) => boolean): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 120_000): Promise<ZcodeRequestResult> {
    this.start();
    const id = this.nextId++;
    this.log(`[zcode] -> ${method} (id=${id})`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.log(`[zcode] !! timeout ${method} (id=${id}) after ${timeoutMs}ms`);
        reject(new Error(`zcode request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin?.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  async requestOk(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    const response = await this.request(method, params, timeoutMs);
    if (response.error) {
      throw new Error(`zcode ${method} failed: ${response.error.message}`);
    }
    return (response.result ?? {}) as Record<string, unknown>;
  }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  }
}
