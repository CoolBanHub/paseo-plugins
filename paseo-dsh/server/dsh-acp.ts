import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import type { AcpConnector, AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";

/**
 * Locate the dsh bin script (a Node JS file). The daemon's PATH may not
 * include nvm's node, so the plugin always spawns the script through an
 * explicit node executable instead of relying on its shebang.
 *
 * Resolution order: DSH_BIN, `dsh` on PATH, then the newest copy in the
 * npx cache (left behind by `npx @deepseek-ai/dsh web`).
 */
export function resolveDshScript(): string | undefined {
  const fromEnv = process.env.DSH_BIN;
  if (fromEnv && existsSync(fromEnv)) {
    try {
      return realpathSync(fromEnv);
    } catch {
      return fromEnv;
    }
  }
  const pathDirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, "dsh");
    if (!existsSync(candidate)) continue;
    try {
      return realpathSync(candidate);
    } catch {
      continue;
    }
  }
  const npxRoot = join(homedir(), ".npm", "_npx");
  try {
    const hits: Array<{ path: string; mtime: number }> = [];
    for (const entry of readdirSync(npxRoot)) {
      const script = join(npxRoot, entry, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
      try {
        const stats = statSync(script);
        if (stats.isFile()) hits.push({ path: script, mtime: stats.mtimeMs });
      } catch {
        // Different package in this cache slot; skip it.
      }
    }
    hits.sort((left, right) => right.mtime - left.mtime);
    return hits[0]?.path;
  } catch {
    return undefined;
  }
}

/**
 * Locate a real Node executable for spawning dsh. The Paseo daemon runs on
 * Electron, whose binary dsh's launcher rejects by runtime fingerprint, so
 * `process.execPath` is only a last resort.
 *
 * Resolution order: DSH_NODE_PATH, `node` on PATH, the newest nvm-managed
 * node, Homebrew nodes, then the daemon's own executable.
 */
export function resolveNodePath(): string {
  const fromEnv = process.env.DSH_NODE_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const candidates: Array<{ path: string; version: number[] }> = [];
  const addCandidate = (path: string) => {
    const version = versionTupleOf(path);
    if (version) candidates.push({ path, version });
  };
  for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    addCandidate(join(dir, "node"));
  }
  const nvmRoot = join(homedir(), ".nvm", "versions", "node");
  try {
    for (const entry of readdirSync(nvmRoot)) addCandidate(join(nvmRoot, entry, "bin", "node"));
  } catch {
    // nvm not installed.
  }
  addCandidate("/opt/homebrew/bin/node");
  addCandidate("/usr/local/bin/node");
  if (candidates.length) {
    candidates.sort((left, right) => compareVersions(right.version, left.version));
    return candidates[0].path;
  }
  return process.execPath;
}

function versionTupleOf(nodePath: string): number[] | undefined {
  const cached = nodeVersionCache.get(nodePath);
  if (cached) return cached;
  try {
    const output = spawnSync(nodePath, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = /^v(\d+(?:\.\d+)*)/.exec((output.stdout ?? "").trim());
    if (!match) return undefined;
    const tuple = match[1].split(".").map((part) => Number.parseInt(part, 10));
    nodeVersionCache.set(nodePath, tuple);
    return tuple;
  } catch {
    return undefined;
  }
}

const nodeVersionCache = new Map<string, number[]>();

const DSH_MODES = [
  {
    id: "standard",
    name: "标准模式",
    description: "按常规方式处理请求。",
  },
  {
    id: "plan",
    name: "计划模式",
    description: "先分析并给出计划，不要直接修改项目。",
  },
] as const;

const PLAN_MODE_INSTRUCTION = [
  "[Paseo plan mode] Do not create, edit, delete, or execute commands that modify project state.",
  "Inspect the project using read-only operations, then return a concise implementation plan and wait for approval.",
].join(" ");

function compareVersions(left: number[], right: number[]): number {
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta) return delta;
  }
  return 0;
}

/**
 * Session ids created by Paseo's catalog probes. dsh persists every
 * ACP-created session, so each probe would otherwise linger in the
 * session list (and the dsh web UI). Probes are identified on the wire:
 * Paseo's adapter only sends `_meta._paseo` on real session opens, never
 * on discovery's throwaway `session/new`. The registry is persisted so
 * filters survive plugin reloads.
 */
class ProbeRegistry {
  private readonly ids = new Set<string>();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { ids?: unknown };
      if (Array.isArray(parsed.ids)) {
        for (const id of parsed.ids) {
          if (typeof id === "string") this.ids.add(id);
        }
      }
    } catch {
      // Absent or unreadable registry; start empty.
    }
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    if (this.ids.has(id)) return;
    this.ids.add(id);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, `${JSON.stringify({ ids: [...this.ids] }, null, 2)}\n`);
    } catch {
      // Best effort; filtering only degrades after a plugin restart.
    }
  }
}

interface TrackedRequest {
  /** A throwaway session/new from catalog discovery. */
  probe?: boolean;
  /** A session/list response to filter probe sessions out of. */
  list?: boolean;
  /** A session/new or session/resume response whose modes need adapting. */
  session?: boolean;
}

type SelectOption = { value?: unknown; name?: unknown };
type ConfigOption = {
  category?: unknown;
  currentValue?: unknown;
  options?: Array<SelectOption & Record<string, unknown>>;
};

/**
 * dsh's reasoning-effort option includes a "Provider default" entry whose
 * value is the empty string, which Paseo's thinking-option schema rejects
 * (ids must be non-empty). Drop empty-valued entries and re-point an empty
 * current value at "off" (which dsh maps to "send no effort parameter",
 * the same wire behavior as the provider default).
 */
function sanitizeConfigOptions(options: unknown): void {
  if (!Array.isArray(options)) return;
  for (const option of options) {
    const entry = option as ConfigOption;
    if (entry?.category !== "thought_level" || !Array.isArray(entry.options)) continue;
    entry.options = entry.options.filter(
      (candidate) => candidate.value !== "" && candidate.value !== null && candidate.value !== undefined,
    );
    if (entry.currentValue === "" || entry.currentValue === null || entry.currentValue === undefined) {
      const fallback = entry.options.find((candidate) => candidate.value === "off") ?? entry.options[0];
      entry.currentValue = typeof fallback?.value === "string" ? fallback.value : undefined;
    }
  }
}

function describeWireMessage(message: AcpStreamMessage): string {
  if ("method" in message) {
    const id = "id" in message ? ` id=${String(message.id)}` : "";
    const params = "params" in message && message.params !== undefined
      ? ` params=${JSON.stringify(message.params).slice(0, 400)}`
      : " params=<absent>";
    return `${message.method}${id}${params}`;
  }
  if ("error" in message) {
    return `error id=${String(message.id)} ${JSON.stringify(message.error)}`;
  }
  return `result id=${String(message.id)} ${JSON.stringify(message.result).slice(0, 120)}`;
}

/**
 * Spawn `dsh --profile acp` and expose its stdio as an AcpStream.
 *
 * dsh implements ACP v1 with `session/resume` for reattaching persisted
 * sessions, while Paseo's ACP adapter resumes through `session/load` and
 * only enables session persistence when the agent advertises the
 * `loadSession` capability. The stream returned here translates between
 * the two in flight:
 *
 * - initialize responses gain `agentCapabilities.loadSession = true`;
 * - `session/load` requests are rewritten to `session/resume`;
 * - probe sessions from catalog discovery are hidden from `session/list`.
 */
export function createDshConnector(
  log: (message: string, detail?: unknown) => void,
  getPermissionMode?: () => string | undefined,
): AcpConnector {
  const dataDir = join(
    process.env.PASEO_HOME ?? join(process.env.HOME ?? homedir(), ".paseo"),
    "plugin-data",
    "dsh",
  );
  const probes = new ProbeRegistry(join(dataDir, "probe-sessions.json"));

  return async (): Promise<AcpStream> => {
    const script = resolveDshScript();
    if (!script) {
      throw new Error(
        "dsh was not found. Run `npx @deepseek-ai/dsh web` once so the npx cache exists, " +
          "install @deepseek-ai/dsh globally, or set DSH_BIN to the dsh bin script.",
      );
    }
    const node = resolveNodePath();
    // dsh's permission preset (read-only / workspace-write / danger-full-access)
    // is fixed per process; because Paseo spawns a fresh dsh process per
    // session, a plugin setting here applies to every NEW session.
    const permissionMode = getPermissionMode?.();
    const env = { ...process.env };
    if (permissionMode && permissionMode !== "default") env.DSH_PERMISSION_MODE = permissionMode;
    log("starting dsh acp", { node, script, permissionMode: permissionMode ?? "inherited" });
    const child = spawn(node, [script, "--profile", "acp"], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: homedir(),
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) log(line.trim());
      }
    });
    child.once("exit", (code, signal) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        log("dsh acp exited", { code, signal: signal ?? undefined });
      }
    });

    const base = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream,
      Readable.toWeb(child.stdout) as ReadableStream,
    ) as unknown as AcpStream;

    const initializeIds = new Set<string | number>();
    const tracked = new Map<string | number, TrackedRequest>();
    let currentMode = "standard";
    let fromAgentController: { enqueue(chunk: AcpStreamMessage): void } | undefined;
    // toolCallId -> latest tool_call snapshot, used to enrich dsh's minimal
    // session/request_permission requests (see enrichPermissionRequest).
    const toolSnapshots = new Map<string, { title?: unknown; kind?: unknown; rawInput?: unknown }>();
    const isProbeNewSession = (params: unknown): boolean => {
      const meta = (params as { _meta?: { _paseo?: unknown } } | undefined)?._meta;
      return !(meta && "_paseo" in meta);
    };

    const writer = base.writable.getWriter();
    let writerClosed = false;
    const debugWire = process.env.DSH_DEBUG_WIRE === "1";

    const wireLog = (direction: string, message: AcpStreamMessage) => {
      if (debugWire) console.log(`[dsh-wire ${direction}]`, describeWireMessage(message));
    };

    const toAgent = new WritableStream<AcpStreamMessage>({
      async write(message) {
        wireLog("->agent", message);
        if ("method" in message && message.method && "id" in message && message.id !== null) {
          if (message.method === "initialize") {
            initializeIds.add(message.id);
          } else if (message.method === "session/new") {
            tracked.set(message.id, {
              session: true,
              probe: isProbeNewSession(message.params),
            });
          } else if (message.method === "session/resume" || message.method === "session/load") {
            tracked.set(message.id, { session: true });
          } else if (message.method === "session/list") {
            tracked.set(message.id, { list: true });
          }

          if (message.method === "session/set_mode") {
            const modeId = (message.params as { modeId?: unknown } | undefined)?.modeId;
            if (modeId === "standard" || modeId === "plan") {
              currentMode = modeId;
              if (!fromAgentController) throw new Error("dsh ACP stream is not ready for mode changes");
              fromAgentController.enqueue({ jsonrpc: "2.0", id: message.id, result: {} });
              log("changed dsh mode", { mode: currentMode });
              return;
            }
          }

          if (message.method === "session/prompt" && currentMode === "plan") {
            const params = message.params as { prompt?: unknown } | undefined;
            if (params && Array.isArray(params.prompt)) {
              params.prompt.unshift({ type: "text", text: PLAN_MODE_INSTRUCTION });
            }
          }
          if (message.method === "session/load") {
            log("translated session/load to session/resume");
            message = { ...message, method: "session/resume" };
          }
        }
        if (writerClosed) return;
        await writer.write(message as never);
      },
      async close() {
        if (writerClosed) return;
        writerClosed = true;
        try {
          await writer.close();
        } catch {
          // The child may already be gone; nothing left to drain.
        }
        // stdin EOF makes dsh drain and exit; enforce a deadline.
        const timer = setTimeout(() => child.kill("SIGTERM"), 5_000);
        child.once("exit", () => clearTimeout(timer));
      },
      async abort(reason) {
        if (!writerClosed) {
          writerClosed = true;
          try {
            await writer.abort(reason);
          } catch {
            // Ignore; the child is being torn down anyway.
          }
        }
        child.kill("SIGTERM");
      },
    });

    /**
     * Paseo's ACP adapter builds its permission event with
     * `jsonRecord(toolCall.rawInput)`, and its jsonValue helper runs
     * `z.json().parse(value)` — which throws on undefined. dsh sends minimal
     * permission requests carrying only `{toolCallId}`, so the request would
     * fail with "no approval channel is available" before reaching Paseo's
     * UI. Fill in title/kind/rawInput from the observed tool_call update so
     * the prompt both survives and shows the tool's input.
     */
    const enrichPermissionRequest = (message: AcpStreamMessage): void => {
      if (!("method" in message) || message.method !== "session/request_permission") return;
      const params = message.params as
        | { toolCall?: { toolCallId?: unknown; title?: unknown; rawInput?: unknown } }
        | undefined;
      const call = params?.toolCall;
      if (!call || typeof call.toolCallId !== "string") return;
      const snapshot = toolSnapshots.get(call.toolCallId);
      call.rawInput = call.rawInput !== undefined
        ? call.rawInput
        : snapshot?.rawInput !== undefined
          ? snapshot.rawInput
          : {};
      if (call.title === undefined || call.title === null) {
        call.title = snapshot?.title;
      }
      log("enriched permission request", { toolCallId: call.toolCallId, title: snapshot?.title });
    };

    const fromAgent = base.readable.pipeThrough(
      new TransformStream<AcpStreamMessage, AcpStreamMessage>({
        start(controller) {
          fromAgentController = controller;
        },
        transform(message, controller) {
          wireLog("agent->", message);
          if ("method" in message && !("result" in message)) {
            if (message.method === "session/update" && !("id" in message)) {
              const update = (message.params as { update?: Record<string, unknown> } | undefined)?.update;
              if (update?.sessionUpdate === "tool_call" && typeof update.toolCallId === "string") {
                toolSnapshots.set(update.toolCallId, {
                  title: update.title,
                  kind: update.kind,
                  rawInput: update.rawInput,
                });
                if (toolSnapshots.size > 500) {
                  const oldest = toolSnapshots.keys().next().value;
                  if (oldest !== undefined) toolSnapshots.delete(oldest);
                }
              }
            } else {
              enrichPermissionRequest(message);
            }
          }
          if ("result" in message && "id" in message && message.id !== null) {
            const result = message.result as
              | {
                  sessionId?: unknown;
                  sessions?: Array<{ sessionId?: unknown }>;
                  configOptions?: unknown;
                  modes?: { availableModes?: Array<Record<string, unknown>>; currentModeId?: string };
                }
              | undefined;
            if (result && typeof result === "object") {
              sanitizeConfigOptions((result as { configOptions?: unknown }).configOptions);
            }
            if (initializeIds.delete(message.id) && result && typeof result === "object") {
              const capabilities = (result as { agentCapabilities?: Record<string, unknown> })
                .agentCapabilities;
              (result as { agentCapabilities?: Record<string, unknown> }).agentCapabilities = {
                ...capabilities,
                loadSession: true,
              };
            } else if (tracked.has(message.id) && result && typeof result === "object") {
              const request = tracked.get(message.id);
              tracked.delete(message.id);
              if (request?.session) {
                const modes = result.modes ?? {};
                const availableModes = Array.isArray(modes.availableModes)
                  ? [...modes.availableModes]
                  : [];
                for (const mode of DSH_MODES) {
                  if (!availableModes.some((candidate) => candidate.id === mode.id)) {
                    availableModes.push(mode as unknown as Record<string, unknown>);
                  }
                }
                result.modes = {
                  ...modes,
                  availableModes,
                  currentModeId: modes.currentModeId ?? currentMode,
                };
              }
              if (request?.probe && typeof result.sessionId === "string") {
                probes.add(result.sessionId);
                log("hid catalog probe session", { sessionId: result.sessionId });
              }
              if (request?.list && Array.isArray(result.sessions)) {
                const visible = result.sessions.filter(
                  (session) => typeof session.sessionId !== "string" || !probes.has(session.sessionId),
                );
                if (visible.length !== result.sessions.length) {
                  log("filtered probe sessions from list", {
                    hidden: result.sessions.length - visible.length,
                  });
                }
                result.sessions = visible;
              }
            }
          }
          controller.enqueue(message);
        },
      }),
    );

    return { writable: toAgent, readable: fromAgent };
  };
}
