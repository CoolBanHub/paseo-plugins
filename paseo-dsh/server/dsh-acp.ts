import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import type { AcpConnector, AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { DshSessionLaunchContext } from "./session-launch-context";
import { writeWebModelOverlay } from "./dsh-catalog.ts";

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

const AGENT_PRESET_BRIDGE_SOURCE = `import { readFileSync, writeFileSync } from "node:fs";

const PRESETS = new Set(["standard", "ptc", "minimal", "cordis"]);
const permissionAgents = new Map();
const appliedPermissions = new Map();
const controlFile = process.env.DSH_PERMISSION_CONTROL_FILE;
const catalogFile = process.env.DSH_PERMISSION_CATALOG_FILE;

export const name = "paseo-dsh-agent-preset-bridge";
export const inject = ["agentPresets", "sessionProjections", "permissionPresets"];

function selectedPermissions() {
  if (!controlFile) return {};
  try {
    return JSON.parse(readFileSync(controlFile, "utf8"));
  } catch {
    return {};
  }
}

async function writeCatalog(ctx) {
  if (!catalogFile) return;
  try {
    const catalog = await ctx.permissionPresets.catalog();
    const sessionPermissions = Object.fromEntries([...permissionAgents].map(([id, agent]) => [
      id,
      ctx.permissionPresets.current(agent.session),
    ]));
    writeFileSync(catalogFile, JSON.stringify({
      ...catalog,
      options: catalog.options.filter((option) => option.value !== "custom"),
      sessionPermissions,
    }));
  } catch (error) {
    ctx.logger.warn("paseo-dsh: permission catalog unavailable", error);
  }
}

async function applyPermission(ctx, agent, preset) {
  if (typeof preset !== "string" || appliedPermissions.get(agent.session.id) === preset) return;
  try {
    await ctx.permissionPresets.set(agent.session, preset);
    appliedPermissions.set(agent.session.id, preset);
    await writeCatalog(ctx);
  } catch (error) {
    ctx.logger.warn("paseo-dsh: permission preset could not be applied", { preset, error });
  }
}

export function apply(ctx) {
  const requested = process.env.DSH_AGENT_PRESET;
  const fallback = PRESETS.has(requested) ? requested : "standard";
  writeCatalog(ctx);
  ctx.on("agent/created", async ({ agent }) => {
    const recorded = ctx.sessionProjections.stateOf(agent.session, "agentPreset");
    const preset = typeof recorded === "string" ? recorded : fallback;
    if (!PRESETS.has(preset)) throw new Error("Unsupported dsh agent preset: " + preset);
    if (recorded === preset) await ctx.agentPresets.mount(agent.ctx, preset);
    else await ctx.agentPresets.select(agent, preset);
    permissionAgents.set(agent.session.id, agent);
    await applyPermission(ctx, agent, selectedPermissions()[agent.session.id]);
    await writeCatalog(ctx);
  });

  const poll = setInterval(() => {
    const selections = selectedPermissions();
    for (const [sessionId, agent] of permissionAgents) {
      void applyPermission(ctx, agent, selections[sessionId]);
    }
  }, 100);
  poll.unref?.();
}`;

const AGENT_PRESET_INTEGRATION_PATCH = `- insert:
    - id: paseo-agent-preset-registry
      name: "@deepseek-ai/dsh-agent-preset-registry"
      config:
        default: standard
    - id: paseo-subagent-model-selection-settings
      name: "@deepseek-ai/dsh-tool-subagent/model-selection-settings"
    - id: paseo-cordis-host-runner
      name: "@deepseek-ai/dsh-cordis-host-runner"
    - id: paseo-cordis-inspect-providers
      name: "@deepseek-ai/dsh-tool-cordis/host"
    - id: paseo-agent-preset-selection
      name: ./agent-preset-bridge.js
      inject: [agentPresets, sessionProjections, permissionPresets]
`;

const DSH_MODES = [
  { id: "standard", name: "标准模式", description: "日常编码任务的标准工具组合。" },
  { id: "ptc", name: "PTC 模式", description: "使用 dsh 的 PTC 工具呈现处理批量工具任务。" },
  { id: "minimal", name: "极简模式", description: "使用 dsh 的精简工具组合。" },
  { id: "cordis", name: "创造模式", description: "使用 dsh 的创造者工具组合。" },
] as const;

type DshModeId = (typeof DSH_MODES)[number]["id"];

function normalizeModeId(mode: string | undefined): DshModeId {
  if (mode === "ptc" || mode === "minimal" || mode === "cordis") return mode;
  return "standard";
}

function modeById(modeId: string) {
  return DSH_MODES.find((mode) => mode.id === modeId);
}

function presetPatchPaths(script: string, preset: DshModeId, dataDir: string): string[] {
  const dshPackageRoot = dirname(dirname(script));
  const webPresetRoot = process.env.DSH_WEB_PRESET_ROOT ?? join(dirname(dshPackageRoot), "dsh-web-app", "presets");
  const localPresetRoot = join(dataDir, "agent-presets");
  mkdirSync(localPresetRoot, { recursive: true });
  writeFileSync(join(localPresetRoot, "agent-preset-bridge.js"), AGENT_PRESET_BRIDGE_SOURCE);
  writeFileSync(join(localPresetRoot, "cordis.patch.yml"), AGENT_PRESET_INTEGRATION_PATCH);
  const paths = [
    join(localPresetRoot, "cordis.patch.yml"),
    join(webPresetRoot, `${preset}.patch.yml`),
  ];
  for (const path of paths) {
    if (!existsSync(path)) throw new Error(`dsh preset patch was not found: ${path}`);
  }
  return paths;
}

function dshProfileRoot(profile: string): string {
  const override = profile === "web"
    ? process.env.DSH_WEB_PROFILE_ROOT
    : profile === "acp"
      ? process.env.DSH_ACP_PROFILE_ROOT
      : undefined;
  if (override) return override;
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "profiles", profile);
}

function readPermissionCatalog(file: string): {
  options: Array<{ value: string; name: string }>;
  defaultPreset?: string;
  sessionPermissions?: Record<string, string>;
} {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      options?: unknown;
      defaultPreset?: unknown;
      sessionPermissions?: unknown;
    };
    const options = Array.isArray(parsed.options)
      ? parsed.options.filter((option): option is { value: string; name: string } =>
        !!option && typeof option === "object" &&
        typeof (option as { value?: unknown }).value === "string" &&
        typeof (option as { name?: unknown }).name === "string",
      ).map((option) => ({ ...option, name: PERMISSION_LABELS[option.value] ?? option.name }))
      : [];
    if (options.length) {
      return {
        options,
        defaultPreset: typeof parsed.defaultPreset === "string" ? parsed.defaultPreset : undefined,
        sessionPermissions: parsed.sessionPermissions && typeof parsed.sessionPermissions === "object"
          ? parsed.sessionPermissions as Record<string, string>
          : undefined,
      };
    }
  } catch {
    // Use the built-in preset list when a dsh profile has no catalog bridge yet.
  }
  return { options: DEFAULT_PERMISSION_OPTIONS };
}

function permissionConfigOption(
  options: Array<{ value: string; name: string }>,
  currentValue: string,
): ConfigOption {
  const selected = options.some((option) => option.value === currentValue)
    ? currentValue
    : options[0]?.value ?? "workspace-write";
  return {
    id: PERMISSION_SETTING_ID,
    name: "Permissions",
    description: "Choose the dsh permission preset for this project session.",
    category: "dsh_permission_preset",
    type: "select",
    currentValue: selected,
    options: options.map((option) => ({ value: option.value, name: option.name })),
  };
}

function decorateConfigOptions(
  source: unknown,
  permissionOptions: Array<{ value: string; name: string }>,
  currentPermission: string,
): ConfigOption[] {
  const options = Array.isArray(source) ? source as ConfigOption[] : [];
  const setting = permissionConfigOption(permissionOptions, currentPermission);
  const existing = options.findIndex((option) => option.id === PERMISSION_SETTING_ID);
  if (existing === -1) return [...options, setting];
  const next = [...options];
  next[existing] = setting;
  return next;
}

function writePermissionSelections(file: string, selections: Map<string, string>): void {
  const temporaryFile = `${file}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify(Object.fromEntries(selections)), { mode: 0o600 });
  renameSync(temporaryFile, file);
}

class ProjectPermissionStore {
  private values: Record<string, string> = {};
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.values = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] =>
          typeof entry[1] === "string",
        ));
      }
    } catch {
      // Start with defaults when no project preferences have been saved.
    }
  }

  get(cwd: string | undefined): string | undefined {
    return cwd ? this.values[projectKey(cwd)] : undefined;
  }

  set(cwd: string | undefined, preset: string): void {
    if (!cwd) return;
    this.values[projectKey(cwd)] = preset;
    mkdirSync(dirname(this.file), { recursive: true });
    const temporaryFile = `${this.file}.tmp`;
    writeFileSync(temporaryFile, `${JSON.stringify(this.values, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryFile, this.file);
  }
}

function projectKey(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

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
  /** A regular config-option response that must retain our synthetic setting. */
  config?: boolean;
  /** ACP session id for a request whose response needs synthetic settings. */
  sessionId?: string;
  /** Working directory associated with the native ACP session. */
  cwd?: string;
}

type SelectOption = { value?: unknown; name?: unknown };
type ConfigOption = {
  id?: unknown;
  category?: unknown;
  name?: unknown;
  description?: unknown;
  type?: unknown;
  currentValue?: unknown;
  options?: Array<SelectOption & Record<string, unknown>>;
};

const PERMISSION_SETTING_ID = "paseo_dsh_permission_preset";
const DEFAULT_PERMISSION_OPTIONS = [
  { value: "workspace-write", name: "Default permissions" },
  { value: "read-only", name: "Read only" },
  { value: "danger-full-access", name: "Full access" },
];
const PERMISSION_LABELS: Record<string, string> = {
  "workspace-write": "Default permissions",
  "read-only": "Read only",
  "danger-full-access": "Full access",
  auto: "Auto-review",
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
  getLaunchContext?: () => DshSessionLaunchContext | undefined,
): AcpConnector {
  const dataDir = join(
    process.env.PASEO_HOME ?? join(process.env.HOME ?? homedir(), ".paseo"),
    "plugin-data",
    "dsh",
  );
  const probes = new ProbeRegistry(join(dataDir, "probe-sessions.json"));
  const projectPermissions = new ProjectPermissionStore(join(dataDir, "project-permissions.json"));

  return async (): Promise<AcpStream> => {
    const script = resolveDshScript();
    if (!script) {
      throw new Error(
        "dsh was not found. Run `npx @deepseek-ai/dsh web` once so the npx cache exists, " +
          "install @deepseek-ai/dsh globally, or set DSH_BIN to the dsh bin script.",
      );
    }
    const node = resolveNodePath();
    const launchContext = getLaunchContext?.();
    const initialMode = normalizeModeId(launchContext?.mode);
    const presetPatches = presetPatchPaths(script, initialMode, dataDir);
    const modelOverlayPath = join(dataDir, "web-models.patch.yml");
    const modelIds = writeWebModelOverlay(dshProfileRoot("acp"), dshProfileRoot("web"), modelOverlayPath);
    const permissionControlFile = join(dataDir, `permission-control-${randomUUID()}.json`);
    const permissionCatalogFile = join(dataDir, `permission-catalog-${randomUUID()}.json`);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(permissionControlFile, "{}", { mode: 0o600 });
    const env = { ...process.env };
    env.DSH_AGENT_PRESET = initialMode;
    env.DSH_PERMISSION_CONTROL_FILE = permissionControlFile;
    env.DSH_PERMISSION_CATALOG_FILE = permissionCatalogFile;
    log("starting dsh acp", {
      node,
      script,
      cwd: launchContext?.cwd,
      agentPreset: initialMode,
      webModels: modelIds,
    });
    const patchArgs = [...presetPatches, modelOverlayPath].flatMap((path) => ["--patch", path]);
    const child = spawn(node, [script, "--profile", "acp", ...patchArgs], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: launchContext?.cwd ?? homedir(),
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) log(line.trim());
      }
    });
    child.once("exit", (code, signal) => {
      rmSync(permissionControlFile, { force: true });
      rmSync(permissionCatalogFile, { force: true });
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
    const sessionConfigOptions = new Map<string, ConfigOption[]>();
    const permissionSelections = new Map<string, string>();
    const sessionCwds = new Map<string, string>();
    const launchPermission = launchContext?.settings?.[PERMISSION_SETTING_ID];
    const configuredPermission = typeof launchPermission === "string" ? launchPermission : undefined;
    const currentPermissionFor = (sessionId: string, cwd?: string, catalog = readPermissionCatalog(permissionCatalogFile)) =>
      permissionSelections.get(sessionId) ?? catalog.sessionPermissions?.[sessionId] ?? configuredPermission ??
      projectPermissions.get(cwd) ?? catalog.defaultPreset ?? catalog.options[0]?.value ?? "workspace-write";
    let currentMode = initialMode;
    const processMode = initialMode;
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
            const params = message.params as { cwd?: unknown } | undefined;
            tracked.set(message.id, {
              session: true,
              probe: isProbeNewSession(message.params),
              cwd: typeof params?.cwd === "string" ? params.cwd : undefined,
            });
          } else if (message.method === "session/resume" || message.method === "session/load") {
            const params = message.params as { sessionId?: unknown; cwd?: unknown } | undefined;
            tracked.set(message.id, {
              session: true,
              sessionId: typeof params?.sessionId === "string" ? params.sessionId : undefined,
              cwd: typeof params?.cwd === "string" ? params.cwd : undefined,
            });
          } else if (message.method === "session/list") {
            tracked.set(message.id, { list: true });
          } else if (message.method === "session/set_config_option") {
            const params = message.params as {
              sessionId?: unknown;
              configId?: unknown;
            } | undefined;
            if (params?.configId !== PERMISSION_SETTING_ID) {
              tracked.set(message.id, {
                config: true,
                sessionId: typeof params?.sessionId === "string" ? params.sessionId : undefined,
              });
            }
          }

          if (message.method === "session/set_mode") {
            const modeId = (message.params as { modeId?: unknown } | undefined)?.modeId;
            if (typeof modeId === "string" && modeById(modeId)) {
              const requestedMode = normalizeModeId(modeId);
              if (requestedMode !== processMode) {
                fromAgentController?.enqueue({
                  jsonrpc: "2.0",
                  id: message.id,
                  error: {
                    code: -32602,
                    message: "dsh agent presets are composed when the session starts; create a new session to use another mode",
                  },
                });
                return;
              }
              currentMode = requestedMode;
              if (!fromAgentController) throw new Error("dsh ACP stream is not ready for mode changes");
              fromAgentController.enqueue({ jsonrpc: "2.0", id: message.id, result: {} });
              log("changed dsh mode", { mode: currentMode });
              return;
            }
          }

          if (message.method === "session/set_config_option") {
            const params = message.params as {
              sessionId?: unknown;
              configId?: unknown;
              value?: unknown;
            } | undefined;
            if (params?.configId === PERMISSION_SETTING_ID) {
              if (typeof params.sessionId !== "string" || typeof params.value !== "string") {
                fromAgentController?.enqueue({
                  jsonrpc: "2.0",
                  id: message.id,
                  error: { code: -32602, message: "Permission setting requires a session id and preset value" },
                });
                return;
              }
              const catalog = readPermissionCatalog(permissionCatalogFile);
              if (!catalog.options.some((option) => option.value === params.value)) {
                fromAgentController?.enqueue({
                  jsonrpc: "2.0",
                  id: message.id,
                  error: { code: -32602, message: `Unsupported dsh permission preset: ${params.value}` },
                });
                return;
              }
              permissionSelections.set(params.sessionId, params.value);
              projectPermissions.set(sessionCwds.get(params.sessionId) ?? launchContext?.cwd, params.value);
              writePermissionSelections(permissionControlFile, permissionSelections);
              const currentOptions = decorateConfigOptions(
                sessionConfigOptions.get(params.sessionId),
                catalog.options,
                params.value,
              );
              sessionConfigOptions.set(params.sessionId, currentOptions);
              fromAgentController?.enqueue({
                jsonrpc: "2.0",
                id: message.id,
                result: { configOptions: currentOptions },
              });
              log("changed dsh permission preset", { sessionId: params.sessionId, preset: params.value });
              return;
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
              const params = message.params as { update?: Record<string, unknown> } | undefined;
              const update = params?.update;
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
              } else if (update?.sessionUpdate === "config_option_update") {
                const sessionId = (message.params as { sessionId?: unknown }).sessionId;
                if (typeof sessionId === "string") {
                  const catalog = readPermissionCatalog(permissionCatalogFile);
                  const current = currentPermissionFor(sessionId, sessionCwds.get(sessionId), catalog);
                  const decorated = decorateConfigOptions(update.configOptions, catalog.options, current);
                  update.configOptions = decorated;
                  sessionConfigOptions.set(sessionId, decorated);
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
                  agentCapabilities?: Record<string, unknown>;
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
                const availableModes = DSH_MODES.map(({ id, name, description }) => ({
                  id,
                  name,
                  description,
                }));
                result.modes = {
                  ...modes,
                  availableModes,
                  currentModeId: currentMode,
                };
                const sessionId = typeof result.sessionId === "string"
                  ? result.sessionId
                  : request.sessionId;
                if (sessionId) {
                  const cwd = request.cwd ?? launchContext?.cwd;
                  if (cwd) sessionCwds.set(sessionId, cwd);
                  const catalog = readPermissionCatalog(permissionCatalogFile);
                  const currentPermission = currentPermissionFor(sessionId, cwd, catalog);
                  permissionSelections.set(sessionId, currentPermission);
                  const decorated = decorateConfigOptions(
                    result.configOptions,
                    catalog.options,
                    currentPermission,
                  );
                  result.configOptions = decorated;
                  sessionConfigOptions.set(sessionId, decorated);
                  log("exposed dsh permission setting", { sessionId, currentPermission });
                }
              }
              if (request?.config && request.sessionId) {
                const catalog = readPermissionCatalog(permissionCatalogFile);
                const currentPermission = currentPermissionFor(
                  request.sessionId,
                  sessionCwds.get(request.sessionId),
                  catalog,
                );
                const decorated = decorateConfigOptions(
                  result.configOptions,
                  catalog.options,
                  currentPermission,
                );
                result.configOptions = decorated;
                sessionConfigOptions.set(request.sessionId, decorated);
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
