import { type ChildProcess, spawn } from "node:child_process";

/** Flattened im.message.receive_v1 payload as pre-rendered by lark-cli. */
export interface LarkMessageEvent {
  chat_id: string;
  chat_type: "p2p" | "group";
  /** Pre-rendered human-readable text for most message types. */
  content: string;
  message_id: string;
  message_type: string;
  sender_id: string;
  sender_type: "user" | "bot";
  mentions?: ReadonlyArray<{ id: string; key: string; name: string }>;
  root_id?: string;
  create_time?: string;
}

export type ConsumerState = "stopped" | "starting" | "ready" | "retrying";

export interface EventConsumerStatus {
  state: ConsumerState;
  lastError: string | null;
  /** Restart attempt since the last successful ready; 0 while healthy. */
  attempt: number;
}

export interface SpawnDeps {
  /** Injectable for tests; defaults to node:child_process spawn. */
  spawn?: (command: string, args: string[], options: { stdio: "pipe"[] }) => ChildProcess;
  /** Injectable timer creator for tests. */
  schedule?: (callback: () => void, delayMs: number) => { clear: () => void };
  log?: (message: string) => void;
}

export interface EventConsumer {
  start(): void;
  stop(): Promise<void>;
  status(): EventConsumerStatus;
}

const READY_MARKER = "[event] ready event_key=";
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;

/**
 * Long-lived `lark-cli event consume im.message.receive_v1 --as bot` child
 * process. lark-cli bridges Feishu's WebSocket event subscription and streams
 * NDJSON events to stdout, so no public webhook endpoint is needed. The child
 * treats stdin EOF as an exit signal, so the pipe stays open for the whole
 * lifetime and stop() closes it / sends SIGTERM.
 */
export function createEventConsumer(options: {
  cliPath: string;
  onEvent: (event: LarkMessageEvent) => void;
  deps?: SpawnDeps;
}): EventConsumer {
  const spawnFn = options.deps?.spawn ?? spawn;
  const schedule = options.deps?.schedule ?? ((callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return { clear: () => clearTimeout(timer) };
  });
  const log = options.deps?.log ?? (() => {});

  let state: ConsumerState = "stopped";
  let lastError: string | null = null;
  let attempt = 0;
  let child: ChildProcess | null = null;
  let retryTimer: { clear: () => void } | null = null;
  let stopped = true;

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      state = "starting";
      spawnChild();
    },
    async stop() {
      stopped = true;
      state = "stopped";
      retryTimer?.clear();
      retryTimer = null;
      await terminate(child);
      child = null;
    },
    status() {
      return { state, lastError, attempt };
    },
  };

  function spawnChild(): void {
    if (stopped) return;
    // stdio pipe keeps stdin open; the consumer exits when stdin closes.
    const proc = spawnFn(options.cliPath, ["event", "consume", "im.message.receive_v1", "--as", "bot"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = proc;

    let stdoutRest = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutRest += chunk.toString("utf8");
      let newline = stdoutRest.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutRest.slice(0, newline).trim();
        stdoutRest = stdoutRest.slice(newline + 1);
        emitEventLine(line);
        newline = stdoutRest.indexOf("\n");
      }
    });

    let stderrRest = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrRest += chunk.toString("utf8");
      let newline = stderrRest.indexOf("\n");
      while (newline >= 0) {
        const line = stderrRest.slice(0, newline).trim();
        stderrRest = stderrRest.slice(newline + 1);
        if (line.startsWith(READY_MARKER)) {
          attempt = 0;
          state = "ready";
          lastError = null;
          log("event consumer ready");
        }
        newline = stderrRest.indexOf("\n");
      }
    });

    proc.on("error", (error) => {
      lastError = error.message;
    });
    proc.on("exit", (code, signal) => {
      if (proc !== child) return;
      child = null;
      if (stopped) return;
      state = "retrying";
      if (!lastError) lastError = `lark-cli 事件进程退出（code=${code} signal=${signal}）`;
      scheduleRestart();
    });
  }

  function emitEventLine(line: string): void {
    if (!line.startsWith("{")) return;
    try {
      const parsed = JSON.parse(line) as LarkMessageEvent;
      if (parsed && typeof parsed.chat_id === "string" && typeof parsed.message_id === "string") {
        options.onEvent(parsed);
      }
    } catch {
      // Skip malformed lines; the stream stays usable.
    }
  }

  function scheduleRestart(): void {
    const delay = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
    attempt += 1;
    log(`event consumer exited; restart #${attempt} in ${delay}ms`);
    retryTimer?.clear();
    retryTimer = schedule(() => {
      retryTimer = null;
      if (stopped) return;
      state = "starting";
      spawnChild();
    }, delay);
  }
}

async function terminate(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  // Closing stdin is the documented graceful stop; SIGTERM is equivalent.
  child.stdin?.end();
  child.kill("SIGTERM");
  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), STOP_TIMEOUT_MS).unref?.();
  });
  if ((await Promise.race([exited.then(() => "exit" as const), timeout])) === "timeout") {
    child.kill("SIGKILL");
    await exited.catch(() => undefined);
  }
}
