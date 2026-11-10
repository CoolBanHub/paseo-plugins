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
  thread_id?: string;
  reply_to?: string;
  event_id?: string;
  create_time?: string;
}

/** Flattened card.action.trigger payload as emitted by lark-cli. */
export interface LarkCardActionEvent {
  type?: string;
  chat_id: string;
  message_id: string;
  operator_id: string;
  action_tag?: string;
  action_name?: string;
  action_value?: string;
  form_value?: string;
  input_value?: string;
  option?: string;
  options?: string;
  checked?: boolean;
  token?: string;
  card_content?: string;
  event_id?: string;
  timestamp?: string;
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
 * Long-lived `lark-cli event consume <eventKey> --as bot` child process.
 * lark-cli bridges Feishu's WebSocket event subscription and streams NDJSON
 * events to stdout, so no public webhook endpoint is needed. The child treats
 * stdin EOF as an exit signal, so the pipe stays open for the whole lifetime
 * and stop() closes it / sends SIGTERM.
 */
export function createEventConsumer<T extends { chat_id?: string; message_id?: string } = LarkMessageEvent>(options: {
  cliPath: string;
  /** Defaults to im.message.receive_v1; card actions use card.action.trigger. */
  eventKey?: string;
  /**
   * Treat matching stdout/stderr output as a configuration error and stop
   * instead of retrying forever. Used for card.action.trigger, whose missing
   * console subscription is a stable "failed_precondition" response.
   */
  fatalErrorPattern?: RegExp;
  onEvent: (event: T) => void;
  deps?: SpawnDeps;
}): EventConsumer {
  const eventKey = options.eventKey ?? "im.message.receive_v1";
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
  /** Last few KB of child output, used to surface a fatal configuration error. */
  let outputTail = "";

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
    const proc = spawnFn(options.cliPath, ["event", "consume", eventKey, "--as", "bot"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = proc;
    outputTail = "";

    let stdoutRest = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      outputTail = (outputTail + text).slice(-4_096);
      stdoutRest += text;
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
      const text = chunk.toString("utf8");
      outputTail = (outputTail + text).slice(-4_096);
      stderrRest += text;
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

    // Both `error` (spawn ENOENT) and `close` can end the child without an
    // `exit` event. Route every termination through one guard so the consumer
    // always retries with backoff.
    const handleTermination = (detail: string): void => {
      if (proc !== child) return;
      child = null;
      if (stopped) return;
      if (options.fatalErrorPattern?.test(outputTail)) {
        stopped = true;
        state = "stopped";
        lastError = fatalOutputMessage(outputTail) ?? detail;
        log("event consumer stopped after a configuration error: " + lastError);
        return;
      }
      state = "retrying";
      if (!lastError) lastError = detail;
      scheduleRestart();
    };
    proc.on("error", (error) => {
      lastError = error.message;
      handleTermination(`lark-cli 事件进程启动失败（${error.message}）`);
    });
    proc.on("exit", (code, signal) => {
      handleTermination(`lark-cli 事件进程退出（code=${code} signal=${signal}）`);
    });
    proc.on("close", (code, signal) => {
      handleTermination(`lark-cli 事件进程关闭（code=${code} signal=${signal}）`);
    });
  }

  function emitEventLine(line: string): void {
    if (!line.startsWith("{")) return;
    try {
      const parsed = JSON.parse(line) as T;
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

/** Pull a readable message out of a lark-cli validation/error JSON blob. */
function fatalOutputMessage(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const match = [...lines]
    .reverse()
    .find((line) => /"message"|requires callbacks|failed_precondition/i.test(line));
  const text = (match ?? output).trim();
  return text ? text.slice(0, 400) : null;
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
