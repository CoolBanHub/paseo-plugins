import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import type { AcpConnector, AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { DshSessionLaunchContext } from "./session-launch-context";
import { resolveModelOverlay } from "./dsh-catalog.ts";
import { DSH_PTC_CALL_METHOD, DSH_PTC_RESULT_METHOD } from "./ptc-present.ts";
import { DSH_TOOL_CALL_METHOD, DSH_TOOL_RESULT_METHOD } from "./tool-present.ts";
import { DSH_EVENT_METHOD } from "./dsh-events.ts";
import { dshSessionLastActivity, dshSessionPlanActive, dshSessionTitle } from "./dsh-projections.ts";
import { cancelAllDshQuestions, cancelDshQuestion, registerDshQuestion } from "./dsh-questions.ts";
import { SidecarTail, type SidecarTailRecord } from "./sidecar-tail.ts";
import { registerDshRevertHandler, unregisterDshRevertHandler } from "./dsh-revert.ts";
import {
  DEFAULT_PERMISSION_OPTIONS,
  DSH_MODES,
  PERMISSION_LABELS,
  PERMISSION_SETTING_DESCRIPTION,
  PERMISSION_SETTING_ID,
  PERMISSION_SETTING_NAME,
  PLAN_SETTING_DESCRIPTION,
  PLAN_SETTING_ID,
  PLAN_SETTING_NAME,
} from "./dsh-labels.ts";
import type { DshModeId } from "./dsh-labels.ts";
import {
  loadProtectedSessionIds,
  removeEmptyProbeSession,
  sweepEmptyProbeSessions,
} from "./probe-cleanup.ts";

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

const AGENT_PRESET_BRIDGE_SOURCE = `import { appendFileSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const NL = String.fromCharCode(10);
const PRESETS = new Set(["standard", "ptc", "minimal", "cordis"]);
const SIDECAR_CAP_BYTES = 8 * 1024 * 1024;
const SIDECAR_KEEP_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_MAX_BYTES = 256 * 1024;
// The reveal knobs are env-overridable so tests can exercise the gating
// without waiting real seconds; production uses the defaults below.
const streamKnob = (name, fallback) => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};
const STREAM_REVEAL_MS = streamKnob("DSH_STREAM_REVEAL_MS", 1500);
const STREAM_INTERVAL_MS = streamKnob("DSH_STREAM_INTERVAL_MS", 500);
const REWIND_PLAIN = new Set(["session/start","session/create","session/end-seed","turn/start","turn/end","step/start","step/end",
  "agent/inbox/spliced","user/message","assistant/message","assistant/attempt","system/message","request/header","request/context","session/title","tool/call","tool/result",
  // Durable-delivery bookkeeping the session log writer appends per flush; it
  // carries no surface or state projection, so rewinding past it is safe.
  "session-log-deepseek/delivery-accepted"]);
const permissionAgents = new Map();
const appliedPermissions = new Map();
const appliedPlanRequests = new Map();
const toolCalls = new Map();
const subagentRuns = new Map();
const startedRuns = new Set();
const pendingWrites = new Map();
const controlFile = process.env.DSH_PERMISSION_CONTROL_FILE;
const catalogFile = process.env.DSH_PERMISSION_CATALOG_FILE;
const ptcEventFile = process.env.DSH_PTC_EVENT_FILE;
const eventFile = process.env.DSH_EVENT_FILE;
const requestDir = process.env.DSH_BRIDGE_REQUEST_DIR;
const responseDir = process.env.DSH_BRIDGE_RESPONSE_DIR;
const commandCatalogFile = process.env.DSH_COMMAND_CATALOG_FILE;
const planControlFile = process.env.DSH_PLAN_CONTROL_FILE;
const receiptFile = process.env.DSH_RECEIPT_FILE;
let questionSeq = 0;
let pollTick = 0;
let processingRequests = false;
let eventSeq = 0;
let ptcSeq = 0;
let receiptSeq = 0;
let rewindSeq = 0;

export const name = "paseo-dsh-agent-preset-bridge";
export const inject = ["agentPresets", "sessionProjections", "permissionPresets", "sessions"];

function cap(value) {
  if (typeof value === "string") return value.length > 20000 ? value.slice(0, 20000) : value;
  if (Array.isArray(value)) return value.map(cap);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map((entry) => [entry[0], cap(entry[1])]));
  }
  return value;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJson(file, value) {
  try {
    writeFileSync(file, JSON.stringify(value));
  } catch {
    // The connector may have torn down its directories on close.
  }
}

// The connector tails each sidecar by byte offset and dedups re-read records
// by their monotonic record counter, so compaction only drops old lines.
function compactSidecar(file) {
  if (!file) return;
  try {
    if (statSync(file).size <= SIDECAR_CAP_BYTES) return;
    const text = readFileSync(file, "utf8");
    const keep = text.slice(Math.max(0, text.length - SIDECAR_KEEP_BYTES));
    const start = keep.indexOf(NL);
    writeFileSync(file, start === -1 ? "" : keep.slice(start + 1), { mode: 0o600 });
  } catch {
    // Compaction is best-effort; growth alone is not fatal.
  }
}

function appendEvent(kind, sessionId, data) {
  if (!eventFile) return;
  try {
    appendFileSync(eventFile, JSON.stringify({ n: ++eventSeq, kind, sessionId, data: cap(data) }) + NL);
    compactSidecar(eventFile);
  } catch {
    // Event mirroring is best-effort; the agent must keep running.
  }
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(NL);
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.message === "string") return value.message;
  }
  return "";
}

function parseArgs(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function selectedPermissions() {
  if (!controlFile) return {};
  const parsed = readJson(controlFile);
  return parsed && typeof parsed === "object" ? parsed : {};
}

function planSelections() {
  if (!planControlFile) return {};
  const parsed = readJson(planControlFile);
  return parsed && typeof parsed === "object" ? parsed : {};
}

async function writeCatalog(ctx) {
  if (!catalogFile) return;
  try {
    const catalog = await ctx.permissionPresets.catalog();
    const sessionPermissions = Object.fromEntries([...permissionAgents].map((entry) => [
      entry[0],
      ctx.permissionPresets.current(entry[1].session),
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

async function applyPlanRequest(ctx, agent, entry) {
  if (!entry || typeof entry !== "object") return;
  const active = entry.active;
  const requestId = entry.requestId;
  // A request id makes a repeated user toggle apply even when its value
  // equals the previous one; entries without one are only UI state.
  if (typeof active !== "boolean" || typeof requestId !== "string") return;
  const sessionId = agent.session.id;
  if (appliedPlanRequests.get(sessionId) === requestId) return;
  const planMode = ctx.get("planMode");
  if (!planMode || typeof planMode.set !== "function") return;
  try {
    planMode.set(agent, active);
    appliedPlanRequests.set(sessionId, requestId);
  } catch (error) {
    ctx.logger.warn("paseo-dsh: plan mode could not be applied", { active, error });
  }
}

function writeCommandCatalog(ctx) {
  if (!commandCatalogFile) return;
  const commands = ctx.get("commands");
  if (!commands || typeof commands.list !== "function") return;
  const result = {};
  for (const entry of permissionAgents) {
    try {
      result[entry[0]] = commands.list(entry[1]).map((command) => ({
        name: command.name,
        description: command.description,
        ...(command.input && command.input.hint ? { argumentHint: command.input.hint } : {}),
      }));
    } catch {
      // A closing agent can fail discovery; the next tick retries.
    }
  }
  writeJson(commandCatalogFile, result);
}

function emitSubagentStart(sessionId, callId, childId, provider, label) {
  if (startedRuns.has(childId)) return;
  startedRuns.add(childId);
  appendEvent("subagent-start", sessionId, { callId, childId, provider, label });
}

// Mirror dsh's internal PTC sub-call events into a JSONL sidecar the Paseo
// connector tails (see ptc-present.ts). dsh's own ACP bridge only projects
// the aggregate run_code tool call; the per-tool dispatches recorded here
// are what dsh's clients render as detailed rows.
function ptcMirror(ctx) {
  if (!ptcEventFile) return;
  ctx.on("session/event", (session, event) => {
    if (event.type !== "tool/ptc-dispatch-start" && event.type !== "tool/ptc-dispatch") return;
    try {
      appendFileSync(ptcEventFile, JSON.stringify({
        n: ++ptcSeq,
        kind: event.type === "tool/ptc-dispatch-start" ? "call" : "result",
        sessionId: session.header.id,
        data: cap({
          rootCallId: event.data.rootCallId,
          parentCallId: event.data.parentCallId,
          subCallId: event.data.subCallId,
          name: event.data.name,
          arguments: event.data.arguments,
          isError: event.data.isError,
          content: event.data.content,
        }),
      }) + NL);
      compactSidecar(ptcEventFile);
    } catch (error) {
      ctx.logger.warn("paseo-dsh: ptc event mirror failed", error);
    }
  });
}

function recordSubagent(sessionId, callId, call, content) {
  if (!call || (call.name !== "subagent" && call.name !== "subagent_fork")) return;
  const output = textOf(content);
  const match = /started subagent ([A-Za-z0-9_-]+)/.exec(output);
  if (!match) return;
  const args = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
  subagentRuns.set(match[1], {
    sessionId,
    callId,
    label: typeof args.description === "string" ? args.description : undefined,
  });
  emitSubagentStart(
    sessionId,
    callId,
    match[1],
    typeof args.type === "string" ? args.type : "subagent",
    typeof args.description === "string" ? args.description : undefined,
  );
}

// Mirror the events Paseo has no ACP projection for: retries, compaction,
// background jobs, subagents, goals, working-directory changes and plan mode.
// The connector maps them onto timeline rows and notices.
function eventMirror(ctx) {
  if (!eventFile) return;
  ctx.on("session/event", (session, event) => {
    const sessionId = session.header.id;
    const data = event.data || {};
    try {
      if (event.type === "tool/call") {
        toolCalls.set(data.callId, {
          sessionId,
          name: data.name,
          arguments: parseArgs(data.arguments),
        });
        if (toolCalls.size > 1000) {
          const oldest = toolCalls.keys().next().value;
          if (oldest !== undefined) toolCalls.delete(oldest);
        }
        return;
      }
      if (event.type === "tool/ptc-dispatch-start") {
        toolCalls.set(data.subCallId, {
          sessionId,
          name: data.name,
          arguments: data.arguments,
        });
        return;
      }
      if (event.type === "tool/result") {
        const message = data.message || {};
        recordSubagent(sessionId, message.toolCallId, toolCalls.get(message.toolCallId), message.content);
        return;
      }
      if (event.type === "tool/ptc-dispatch") {
        recordSubagent(sessionId, data.subCallId, toolCalls.get(data.subCallId), data.content);
        return;
      }
      if (event.type === "llm/retry") {
        appendEvent("llm-retry", sessionId, data);
        return;
      }
      if (event.type === "user/message") {
        const source = data.source || {};
        if (source.kind === "user" && typeof data.id === "string") {
          appendEvent("revert-point", sessionId, {
            messageId: data.id,
            seq: typeof event.seq === "number" ? event.seq : undefined,
            text: textOf(data.content).slice(0, 120),
          });
        }
        return;
      }
      if (event.type === "assistant/message") {
        if (data.usage && typeof data.usage === "object") {
          appendEvent("usage", sessionId, {
            turn: data.turn,
            step: data.step,
            usage: data.usage,
          });
        }
        return;
      }
      if (event.type === "turn/end") {
        appendEvent("turn-end", sessionId, { turn: data.turn, reason: data.reason });
        return;
      }
      if (event.type === "compaction/start") {
        appendEvent("compaction-start", sessionId, data);
        return;
      }
      if (event.type === "compaction/summary") {
        appendEvent("compaction-summary", sessionId, data);
        return;
      }
      if (event.type === "compaction/end") {
        appendEvent("compaction-end", sessionId, data);
        return;
      }
      if (event.type === "job/registered" || event.type === "job/settled") {
        const toolCall = data.toolCall && typeof data.toolCall === "object" ? data.toolCall : undefined;
        const call = toolCall && toolCall.callId ? toolCalls.get(toolCall.callId) : undefined;
        const args = call && call.arguments && typeof call.arguments === "object" ? call.arguments : {};
        const command = call && (call.name === "bash" || call.name === "shell" || call.name === "pwsh")
          ? args.command
          : undefined;
        appendEvent(event.type === "job/registered" ? "job-registered" : "job-settled", sessionId, {
          ...data,
          command: typeof command === "string" ? command : undefined,
        });
        return;
      }
      if (event.type === "goal/change") {
        appendEvent("goal-change", sessionId, data);
        return;
      }
      if (event.type === "working-directory/change") {
        appendEvent("working-directory", sessionId, data);
        return;
      }
      if (event.type === "plan/mode") {
        appendEvent("plan-mode", sessionId, data);
      }
    } catch (error) {
      ctx.logger.warn("paseo-dsh: event mirror failed", { type: event.type, error });
    }
  });

  ctx.on("subagent/start", (info) => {
    const run = subagentRuns.get(info.id);
    if (!run) return;
    emitSubagentStart(run.sessionId, run.callId, info.id, info.provider, run.label);
  });

  ctx.on("subagent/end", (info) => {
    const run = subagentRuns.get(info.id);
    if (!run) return;
    appendEvent("subagent-end", run.sessionId, {
      callId: run.callId,
      childId: info.id,
      provider: info.provider,
      label: run.label,
      stopReason: info.stopReason,
      output: textOf(info.lastAssistantMessage),
    });
    subagentRuns.delete(info.id);
    startedRuns.delete(info.id);
  });
}

// Live assistant streaming preview. dsh's ACP bridge only projects the
// settled assistant message, so the first visible token would otherwise wait
// for the whole turn. Frames are transient; accumulate text deltas and mirror
// a throttled preview that the connector renders as one updating row. Quick
// attempts (under STREAM_REVEAL_MS) never surface a row at all.
function streamMirror(ctx) {
  if (!eventFile) return;
  const attempts = new Map();
  ctx.on("agent/assistant-stream", (payload) => {
    const agent = payload && payload.agent;
    const frame = payload && payload.frame;
    if (!agent || !agent.session || !frame || typeof frame.attemptId !== "string") return;
    const sessionId = agent.session.header && agent.session.header.id;
    if (typeof sessionId !== "string") return;
    if (frame.type === "start") {
      attempts.set(frame.attemptId, { lastSent: 0, text: "", chars: 0, started: Date.now(), shown: false });
      return;
    }
    if (frame.type === "chunk") {
      const state = attempts.get(frame.attemptId);
      if (!state) return;
      const chunk = frame.chunk;
      if (chunk && chunk.type === "text-delta" && typeof chunk.text === "string") {
        state.text = (state.text + chunk.text).slice(-2000);
        state.chars += chunk.text.length;
      }
      const now = Date.now();
      if (now - state.started >= STREAM_REVEAL_MS && now - state.lastSent >= STREAM_INTERVAL_MS && state.chars > 0) {
        state.lastSent = now;
        state.shown = true;
        appendEvent("stream-row", sessionId, {
          attemptId: frame.attemptId,
          phase: "running",
          text: state.text,
          chars: state.chars,
        });
      }
      return;
    }
    if (frame.type === "end") {
      const state = attempts.get(frame.attemptId);
      attempts.delete(frame.attemptId);
      if (!state || !state.shown) return;
      const abandoned = !frame.outcome || frame.outcome.kind !== "committed";
      appendEvent("stream-row", sessionId, {
        attemptId: frame.attemptId,
        phase: abandoned ? "failed" : "completed",
        text: state.text,
        chars: state.chars,
      });
    }
  });
}

// Byte-level before-snapshots of the model's write/edit tool calls, appended
// to a sidecar the connector persists per dsh session. bash and other tools
// are deliberately not checkpointed: their file effects cannot be captured
// reliably, and revert fails closed for them instead of guessing.
function fileCheckpoints(ctx) {
  if (!receiptFile) return;
  const snapshotBefore = (callId, path) => {
    try {
      const before = statSync(path);
      if (!before.isFile() || before.size > SNAPSHOT_MAX_BYTES) {
        pendingWrites.set(callId, { path, absent: false, bytes: null });
        return;
      }
      const content = readFileSync(path);
      const after = statSync(path);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        pendingWrites.set(callId, { path, absent: false, bytes: null });
        return;
      }
      pendingWrites.set(callId, { path, absent: false, bytes: content });
    } catch {
      // ENOENT: the file did not exist before this call created it.
      pendingWrites.set(callId, { path, absent: true, bytes: null });
    }
  };
  ctx.on("tools/pre-execute", async (call, next) => {
    try {
      if (call && (call.name === "write" || call.name === "edit")) {
        const args = parseArgs(call.arguments);
        const path = args && typeof args === "object" ? (args.file_path || args.path) : undefined;
        if (typeof path === "string" && path && typeof call.callId === "string") {
          snapshotBefore(call.callId, path);
        }
      }
    } catch {
      // A failed snapshot only means this call is not revertible.
    }
    return next();
  });
  ctx.on("tools/result", (call, result) => {
    try {
      if (!call || typeof call.callId !== "string") return;
      const snapshot = pendingWrites.get(call.callId);
      if (!snapshot) return;
      pendingWrites.delete(call.callId);
      if (!result || result.isError === true) return;
      const agent = call.agent;
      const sessionId = agent && agent.session && agent.session.header ? agent.session.header.id : undefined;
      if (typeof sessionId !== "string" || !sessionId) return;
      let afterDigest;
      try {
        afterDigest = createHash("sha256").update(readFileSync(snapshot.path)).digest("hex");
      } catch {
        afterDigest = undefined;
      }
      let seq;
      try {
        const events = agent.session.snapshotEvents();
        if (Array.isArray(events)) seq = events.length;
      } catch {
        seq = undefined;
      }
      appendFileSync(receiptFile, JSON.stringify({
        n: ++receiptSeq,
        sessionId,
        callId: call.callId,
        tool: call.name,
        path: snapshot.path,
        absentBefore: snapshot.absent === true,
        beforeB64: snapshot.bytes ? snapshot.bytes.toString("base64") : undefined,
        afterDigest,
        seq,
        time: Date.now(),
      }) + NL);
      compactSidecar(receiptFile);
    } catch (error) {
      ctx.logger.warn("paseo-dsh: file receipt failed", error);
    }
  });
}

// Conversation rewind appends one marker user message whose native surfaceOp
// replace shadows everything after the chosen cut, using dsh's own log
// semantics. Planning is deliberately conservative: only plain exchanges and
// fully settled read/write/edit calls are rewound; jobs, goals, PTC programs
// and anything stateful fail closed.
function planRewind(events, messageId, back) {
  if (!Array.isArray(events) || events.length === 0 || events.length > 100000) return null;
  const hidden = [];
  for (const event of events) {
    if (
      event && event.type === "user/message" && typeof event.seq === "number" &&
      event.data && event.data.source && event.data.source.kind === "paseo-rewind" &&
      event.surfaceOp && event.surfaceOp.op === "replace" &&
      typeof event.surfaceOp.startSeq === "number"
    ) {
      hidden.push([event.surfaceOp.startSeq - 1, event.seq]);
    }
  }
  const isHidden = (seq) => hidden.some((range) => seq > range[0] && seq <= range[1]);
  const userMessages = [];
  for (const event of events) {
    if (event.type !== "user/message" || typeof event.seq !== "number" || isHidden(event.seq)) continue;
    const data = event.data || {};
    if (data.source && data.source.kind === "user" && typeof data.id === "string") {
      userMessages.push({ seq: event.seq, id: data.id, text: textOf(data.content) });
    }
  }
  if (userMessages.length === 0) return null;
  let target = null;
  if (typeof messageId === "string" && messageId) {
    target = userMessages.find((entry) => entry.id === messageId) || null;
  } else {
    const backIndex = typeof back === "number" && back >= 1 ? Math.floor(back) : 1;
    target = userMessages[Math.max(0, userMessages.length - backIndex)] || null;
  }
  if (!target) return null;
  const summary = target.text && target.text.trim() ? target.text.trim().slice(0, 60) : "更早的消息";
  const cut = target.seq;
  const sources = [];
  const openCalls = new Set();
  const toolNames = new Set(["read", "write", "edit"]);
  const declared = new Map();
  for (const event of events) {
    if (typeof event.seq !== "number" || event.seq <= cut || isHidden(event.seq)) continue;
    if (!REWIND_PLAIN.has(event.type)) return null;
    if (event.surfaceOp !== undefined) {
      if (event.surfaceOp !== "append" && event.surfaceOp.op !== "append") return null;
      if (event.surfaceOp === "append" || event.surfaceOp.op === "append") sources.push(event.seq);
    }
    const data = event.data || {};
    if (event.type === "assistant/message") {
      const content = data.message && Array.isArray(data.message.content) ? data.message.content : [];
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        if (part.type === "text" || part.type === "reasoning") continue;
        if (
          part.type !== "tool-call" || typeof part.id !== "string" || !part.id ||
          !toolNames.has(part.name) || typeof part.arguments !== "string" ||
          !Number.isSafeInteger(data.turn) || !Number.isSafeInteger(data.step)
        ) return null;
        declared.set(part.id, { name: part.name, arguments: part.arguments, turn: data.turn, step: data.step });
      }
    } else if (event.type === "tool/call") {
      const spec = declared.get(data.callId);
      if (
        !spec || spec.name !== data.name || spec.arguments !== data.arguments ||
        spec.turn !== data.turn || spec.step !== data.step || !toolNames.has(data.name)
      ) return null;
      openCalls.add(data.callId);
    } else if (event.type === "tool/result") {
      const message = data.message || {};
      if (!openCalls.delete(message.toolCallId)) return null;
    } else if (event.type === "step/end" || event.type === "turn/end") {
      if (openCalls.size) return null;
    }
  }
  if (openCalls.size || sources.length === 0) return null;
  return { cut, messageId: target.id, summary, first: sources[0], last: sources[sources.length - 1], sources };
}

async function performRewind(ctx, agent, request) {
  if (!agent || agent.status !== "idle" || typeof agent.runMaintenance !== "function" || !agent.session) {
    throw new Error("会话忙碌或未就绪，暂时无法回退");
  }
  const inbox = agent.inbox;
  if (
    inbox && ((Array.isArray(inbox.nextTurn) && inbox.nextTurn.length) ||
      (Array.isArray(inbox.nextStep) && inbox.nextStep.length))
  ) {
    throw new Error("会话还有排队中的消息，请等本轮结束后再回退");
  }
  let plan;
  let appended = false;
  await agent.runMaintenance(async () => {
    const events = agent.session.snapshotEvents();
    if (!Array.isArray(events)) throw new Error("无法读取会话事件");
    plan = planRewind(events, request.messageId, request.back);
    if (!plan) throw new Error("当前会话内容不支持在此处回退（例如包含 bash、后台任务或未完成的调用）");
    const message = {
      role: "user",
      id: "paseo-rewind-" + Date.now().toString(36) + "-" + (++rewindSeq),
      content: [{ type: "text", text: "Paseo：以上为保留的会话上下文。" }],
      source: { kind: "paseo-rewind" },
    };
    agent.session.append("user/message", message, {
      surfaceOp: { op: "replace", startSeq: plan.first, endSeq: plan.last },
      sourceEventSeqs: plan.sources,
    });
    appended = true;
    if (!ctx.sessions || typeof ctx.sessions.flush !== "function") {
      throw new Error("回退已写入但无法确认持久化");
    }
    const flushed = await ctx.sessions.flush(agent.session);
    if (!flushed) throw new Error("回退已写入但未能确认持久化，请重新打开会话核对");
  });
  return plan;
}

// The ACP app has no answerer for ctx.userQuestions. Relay each request to
// Paseo's native question form and return the selected labels / custom text.
function questionBridge(ctx) {
  if (!eventFile || !responseDir) return;
  ctx.on("user-questions/request", async (request, next) => {
    const agent = request.agent;
    if (!agent || !agent.session) return next();
    const requestId = "q-" + Date.now().toString(36) + "-" + (++questionSeq);
    appendEvent("question", agent.session.id, {
      requestId,
      questions: request.questions,
      wait: request.wait,
    });
    const answerFile = join(responseDir, requestId + ".json");
    while (true) {
      const answer = readJson(answerFile);
      if (answer && Array.isArray(answer.answers)) {
        rmSync(answerFile, { force: true });
        return { answers: answer.answers };
      }
      if (request.signal && request.signal.aborted) {
        // dsh gave up waiting (timed ask_user_question): let the connector
        // dismiss the Paseo form so it does not keep waiting for a dead answer.
        appendEvent("question-cancelled", agent.session.id, { requestId });
        throw new Error("user question cancelled");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
}

// Commands and plan-mode changes arrive as request files from the connector.
async function processRequests(ctx) {
  if (processingRequests || !requestDir || !responseDir) return;
  processingRequests = true;
  try {
    let names;
    try {
      names = readdirSync(requestDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const path = join(requestDir, name);
      const request = readJson(path);
      rmSync(path, { force: true });
      if (!request || typeof request !== "object") continue;
      const requestId = typeof request.requestId === "string" ? request.requestId : name.slice(0, -5);
      const responseFile = join(responseDir, requestId + ".json");
      try {
        if (request.kind === "plan") {
          const agent = permissionAgents.get(request.sessionId);
          const planMode = ctx.get("planMode");
          if (!agent || !planMode || typeof planMode.set !== "function") throw new Error("plan mode is not available in this preset");
          planMode.set(agent, request.active === true);
          writeJson(responseFile, { ok: true });
        } else if (request.kind === "command") {
          const agent = permissionAgents.get(request.sessionId);
          const commands = ctx.get("commands");
          if (!agent || !commands || typeof commands.execute !== "function") throw new Error("commands are not available in this preset");
          const controller = new AbortController();
          // The connector's own deadline (130s) fires first and reports a
          // clean failure; this backstop only guards a stuck native command.
          const timer = setTimeout(() => controller.abort(), 150000);
          try {
            const execution = await commands.execute(agent, String(request.line || ""), [], controller.signal);
            writeJson(responseFile, execution
              ? { ok: true, result: execution.result }
              : { ok: false, error: "unknown command" });
          } finally {
            clearTimeout(timer);
          }
        } else if (request.kind === "rewind") {
          const agent = permissionAgents.get(request.sessionId);
          const plan = await performRewind(ctx, agent, request);
          writeJson(responseFile, {
            ok: true,
            result: {
              messageId: plan.messageId,
              cut: plan.cut,
              summary: plan.summary,
              first: plan.first,
              last: plan.last,
            },
          });
        } else {
          writeJson(responseFile, { ok: false, error: "unknown bridge request" });
        }
      } catch (error) {
        writeJson(responseFile, { ok: false, error: error && error.message ? error.message : String(error) });
      }
    }
  } finally {
    processingRequests = false;
  }
}

export function apply(ctx) {
  const requested = process.env.DSH_AGENT_PRESET;
  const fallback = PRESETS.has(requested) ? requested : "standard";
  writeCatalog(ctx);
  ptcMirror(ctx);
  eventMirror(ctx);
  streamMirror(ctx);
  fileCheckpoints(ctx);
  questionBridge(ctx);
  ctx.on("agent/created", async ({ agent }) => {
    const recorded = ctx.sessionProjections.stateOf(agent.session, "agentPreset");
    const preset = typeof recorded === "string" ? recorded : fallback;
    if (!PRESETS.has(preset)) throw new Error("Unsupported dsh agent preset: " + preset);
    if (recorded === preset) await ctx.agentPresets.mount(agent.ctx, preset);
    else await ctx.agentPresets.select(agent, preset);
    permissionAgents.set(agent.session.id, agent);
    await applyPermission(ctx, agent, selectedPermissions()[agent.session.id]);
    await applyPlanRequest(ctx, agent, planSelections()[agent.session.id]);
    await writeCatalog(ctx);
    writeCommandCatalog(ctx);
  });

  const poll = setInterval(() => {
    pollTick += 1;
    const selections = selectedPermissions();
    for (const entry of permissionAgents) {
      void applyPermission(ctx, entry[1], selections[entry[0]]);
    }
    // Each Paseo toggle carries a fresh request id, so dsh's own /plan
    // changes are never overwritten by a stale control value.
    const plans = planSelections();
    for (const entry of permissionAgents) {
      void applyPlanRequest(ctx, entry[1], plans[entry[0]]);
    }
    void processRequests(ctx);
    if (pollTick % 10 === 0) writeCommandCatalog(ctx);
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
      inject: [agentPresets, sessionProjections, permissionPresets, sessions]
`;

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
    // dsh composes sessions under workspace-write by default, which the
    // option list alone (ordered read-only first, like dsh's catalog) cannot
    // express.
  }
  return { options: DEFAULT_PERMISSION_OPTIONS, defaultPreset: "workspace-write" };
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
    name: PERMISSION_SETTING_NAME,
    description: PERMISSION_SETTING_DESCRIPTION,
    category: "dsh_permission_preset",
    type: "select",
    currentValue: selected,
    options: options.map((option) => ({ value: option.value, name: option.name })),
  };
}

function planConfigOption(active: boolean): ConfigOption {
  return {
    id: PLAN_SETTING_ID,
    name: PLAN_SETTING_NAME,
    description: PLAN_SETTING_DESCRIPTION,
    type: "boolean",
    currentValue: active,
  };
}

function decorateConfigOptions(
  source: unknown,
  permissionOptions: Array<{ value: string; name: string }>,
  currentPermission: string,
  planActive: boolean,
): ConfigOption[] {
  const options = Array.isArray(source) ? source as ConfigOption[] : [];
  const insert = (next: ConfigOption[], setting: ConfigOption): ConfigOption[] => {
    const existing = next.findIndex((option) => option.id === setting.id);
    if (existing === -1) return [...next, setting];
    next[existing] = setting;
    return next;
  };
  return insert(
    insert([...options], permissionConfigOption(permissionOptions, currentPermission)),
    planConfigOption(planActive),
  );
}

function writePermissionSelections(file: string, selections: Map<string, string>): void {
  const temporaryFile = `${file}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify(Object.fromEntries(selections)), { mode: 0o600 });
  renameSync(temporaryFile, file);
}

function writePlanSelections(
  file: string,
  selections: Map<string, { active: boolean; requestId?: string }>,
): void {
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

  sessionIds(): string[] {
    return [...this.ids];
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
 * ACP dsh reports failed tool calls without `rawOutput`. Paseo's timeline
 * schema requires a JSON error for failed tool items, so supply a stable
 * diagnostic before the ACP adapter snapshots the update.
 */
function normalizeFailedToolUpdate(message: AcpStreamMessage): void {
  if (!("method" in message) || message.method !== "session/update" || !("params" in message)) return;
  const params = message.params as { update?: Record<string, unknown> } | undefined;
  const update = params?.update;
  if (
    update?.sessionUpdate === "tool_call_update" &&
    update.status === "failed" &&
    (update.rawOutput === undefined || update.rawOutput === null)
  ) {
    update.rawOutput = { message: "dsh tool call failed without an error payload" };
  }
}

/**
 * Join the text blocks of a dsh content array into the single output string
 * the PTC timeline rows display.
 */
function ptcResultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Record<string, unknown> => !!block && typeof block === "object")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Extract the printed output of an aggregate run_code tool_call_update. dsh
 * nests the text one level deeper than the dispatch records
 * (`[{type:"content", content:{type:"text", text}}]`) and failed updates may
 * carry a plain object instead.
 */
function aggregateOutputText(content: unknown): string {
  const blocks = Array.isArray(content)
    ? content.filter((block): block is Record<string, unknown> => !!block && typeof block === "object")
    : content && typeof content === "object"
      ? [content as Record<string, unknown>]
      : [];
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    const inner = block.content;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      const text = (inner as Record<string, unknown>).text;
      if (typeof text === "string") parts.push(text);
    }
    // normalizeFailedToolUpdate supplies {message} for failed calls that
    // carried no content; surface it as the row's error text.
    if (typeof block.message === "string") parts.push(block.message);
  }
  return parts.filter(Boolean).join("\n");
}

/** Parse a dsh rawInput value, which is an object or a JSON string. */
function parseToolInput(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Re-emit one standard dsh tool update as a `dsh/tool/*` vendor
 * notification. dsh reports `kind: "other"` and delivers output in ACP
 * `content` blocks, both of which Paseo's generic adapter cannot turn into
 * a useful row; the transformer rebuilds the structured detail instead.
 */
function standardToolNotification(
  update: Record<string, unknown>,
  snapshot: { title?: unknown; rawInput?: unknown } | undefined,
): AcpStreamMessage | undefined {
  const callId = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
  if (!callId) return undefined;
  const title = typeof update.title === "string" && update.title
    ? update.title
    : typeof snapshot?.title === "string" ? snapshot.title : undefined;
  const name = title ?? "tool";
  if (update.sessionUpdate === "tool_call") {
    return {
      jsonrpc: "2.0",
      method: DSH_TOOL_CALL_METHOD,
      params: { callId, name, arguments: parseToolInput(update.rawInput) ?? {} },
    };
  }
  const status = typeof update.status === "string" ? update.status : undefined;
  return {
    jsonrpc: "2.0",
    method: DSH_TOOL_RESULT_METHOD,
    params: {
      callId,
      name,
      arguments: parseToolInput(snapshot?.rawInput) ?? {},
      status,
      isError: status === "failed",
      output: aggregateOutputText(update.content) || aggregateOutputText(update.rawOutput),
    },
  };
}

/** A PTC program's aggregate `run_code` call, kept for the fallback row. */
interface RunCodeProgram {
  description?: string;
  code?: string;
  output?: string;
  failed?: boolean;
}

/** JSONL record the bridge plugin inside dsh appends per PTC dispatch. */
interface PtcMirrorRecord {
  kind?: unknown;
  sessionId?: unknown;
  data?: Record<string, unknown>;
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

  // Recover probes left behind by a crash or plugin reload. A minute is
  // enough for an in-flight catalog probe to finish; archived Sessions and
  // Workspace members are protected by the cleanup helper.
  try {
    const removed = sweepEmptyProbeSessions(probes.sessionIds(), {
      protectedIds: loadProtectedSessionIds(),
      minAgeMs: 60_000,
    });
    for (const sessionId of removed) log("removed stale catalog probe session", { sessionId });
  } catch (error) {
    log("catalog probe sweep failed", { error: String(error) });
  }

  // Sidecars and control files from crashed or reloaded connectors. Live ones
  // are owned by a running child; anything an hour old is a leftover. The
  // sweep covers every per-connection artifact this plugin creates; before it
  // only matched PTC mirrors, so a daemon crash leaked the rest forever.
  const leftoverPrefixes = [
    "ptc-events-",
    "dsh-events-",
    "permission-control-",
    "permission-catalog-",
    "command-catalog-",
    "plan-control-",
    "file-receipts-conn-",
    "bridge-requests-",
    "bridge-responses-",
  ];
  try {
    for (const file of readdirSync(dataDir)) {
      if (!leftoverPrefixes.some((prefix) => file.startsWith(prefix))) continue;
      const path = join(dataDir, file);
      try {
        const stats = statSync(path);
        if (Date.now() - stats.mtimeMs > 60 * 60_000) {
          rmSync(path, { recursive: true, force: true });
        }
      } catch {
        // Unreadable leftovers are harmless; leave them for the next sweep.
      }
    }
  } catch {
    // dataDir may not exist yet on a fresh install.
  }

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
    const modelOverlay = resolveModelOverlay(dshProfileRoot("acp"), dshProfileRoot("web"), modelOverlayPath);
    if (modelOverlay.degradedReason) {
      log("web model overlay degraded; spawning with the fallback route", {
        reason: modelOverlay.degradedReason,
        reusedLastGood: modelOverlay.path !== undefined,
      });
    }
    const permissionControlFile = join(dataDir, `permission-control-${randomUUID()}.json`);
    const permissionCatalogFile = join(dataDir, `permission-catalog-${randomUUID()}.json`);
    const ptcEventFile = join(dataDir, `ptc-events-${randomUUID()}.jsonl`);
    const eventFile = join(dataDir, `dsh-events-${randomUUID()}.jsonl`);
    const bridgeId = randomUUID();
    const bridgeRequestDir = join(dataDir, `bridge-requests-${bridgeId}`);
    const bridgeResponseDir = join(dataDir, `bridge-responses-${bridgeId}`);
    const commandCatalogFile = join(dataDir, `command-catalog-${randomUUID()}.json`);
    const planControlFile = join(dataDir, `plan-control-${randomUUID()}.json`);
    const receiptFile = join(dataDir, `file-receipts-conn-${bridgeId}.jsonl`);
    const persistentReceiptDir = join(dataDir, "file-receipts");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(bridgeRequestDir, { recursive: true });
    mkdirSync(bridgeResponseDir, { recursive: true });
    writeFileSync(permissionControlFile, "{}", { mode: 0o600 });
    writeFileSync(planControlFile, "{}", { mode: 0o600 });
    writeFileSync(commandCatalogFile, "{}", { mode: 0o600 });
    writeFileSync(ptcEventFile, "", { mode: 0o600 });
    writeFileSync(eventFile, "", { mode: 0o600 });
    writeFileSync(receiptFile, "", { mode: 0o600 });
    const env = { ...process.env };
    env.DSH_AGENT_PRESET = initialMode;
    env.DSH_PERMISSION_CONTROL_FILE = permissionControlFile;
    env.DSH_PERMISSION_CATALOG_FILE = permissionCatalogFile;
    env.DSH_PTC_EVENT_FILE = ptcEventFile;
    env.DSH_EVENT_FILE = eventFile;
    env.DSH_BRIDGE_REQUEST_DIR = bridgeRequestDir;
    env.DSH_BRIDGE_RESPONSE_DIR = bridgeResponseDir;
    env.DSH_COMMAND_CATALOG_FILE = commandCatalogFile;
    env.DSH_PLAN_CONTROL_FILE = planControlFile;
    env.DSH_RECEIPT_FILE = receiptFile;
    log("starting dsh acp", {
      node,
      script,
      cwd: launchContext?.cwd,
      agentPreset: initialMode,
      webModels: modelOverlay.ids,
    });
    const patchArgs = [...presetPatches, ...(modelOverlay.path ? [modelOverlay.path] : [])]
      .flatMap((path) => ["--patch", path]);
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

    // Catalog discovery opens throwaway sessions through this process. Once
    // it is done, remove their session logs so dsh Web does not accumulate
    // untitled "Ungrouped" rows. The timer covers a long-lived ACP process
    // that never exits after a probe.
    const probeCleanupIds = new Set<string>();
    const cleanupProbe = (sessionId: string): void => {
      if (!probeCleanupIds.has(sessionId)) return;
      try {
        if (removeEmptyProbeSession(sessionId)) {
          probeCleanupIds.delete(sessionId);
          log("cleaned catalog probe session", { sessionId });
        }
      } catch (error) {
        log("catalog probe cleanup failed", { sessionId, error: String(error) });
      }
    };

    const scheduleProbeCleanup = (delayMs: number): void => {
      if (probeCleanupIds.size === 0) return;
      // Give dsh a moment to flush the probe log before unlinking it.
      const timer = setTimeout(() => {
        for (const sessionId of [...probeCleanupIds]) cleanupProbe(sessionId);
      }, delayMs);
      timer.unref();
    };

    child.once("exit", (code, signal) => {
      rmSync(permissionControlFile, { force: true });
      rmSync(permissionCatalogFile, { force: true });
      rmSync(planControlFile, { force: true });
      rmSync(commandCatalogFile, { force: true });
      rmSync(receiptFile, { force: true });
      rmSync(bridgeRequestDir, { recursive: true, force: true });
      rmSync(bridgeResponseDir, { recursive: true, force: true });
      for (const sessionId of liveSessions) unregisterDshRevertHandler(sessionId);
      stopPtcMirror();
      stopEventMirror();
      if (child.exitCode !== null || child.signalCode !== null) {
        log("dsh acp exited", { code, signal: signal ?? undefined });
      }
      scheduleProbeCleanup(250);
    });

    const base = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream,
      Readable.toWeb(child.stdout) as ReadableStream,
    ) as unknown as AcpStream;

    const initializeIds = new Set<string | number>();
    const tracked = new Map<string | number, TrackedRequest>();
    const sessionConfigOptions = new Map<string, ConfigOption[]>();
    const permissionSelections = new Map<string, string>();
    // `requestId` is present only on a user toggle, so the bridge can tell a
    // fresh request from the cached UI state.
    const planSelections = new Map<string, { active: boolean; requestId?: string }>();
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
    // ACP sessions opened through this connection that are not catalog
    // probes; only their PTC mirror records become timeline rows.
    const liveSessions = new Set<string>();
    // PTC aggregates by toolCallId. The aggregate `run_code` rows are dropped
    // from the wire (their mirrored sub-call rows already cover the program),
    // but a dispatch-free program still needs one fallback row.
    const runCodePrograms = new Map<string, RunCodeProgram>();
    // rootCallIds of aggregates whose sub-call rows were already mirrored.
    const mirroredRootCallIds = new Set<string>();
    let mirroredCallsUnrooted = false;
    let stopPtcMirror: () => void = () => {};
    let stopEventMirror: () => void = () => {};
    // Commands the bridge advertised for each dsh session.
    const sessionCommands = new Map<string, Set<string>>();
    const FALLBACK_COMMANDS = new Set(["plan", "compact", "goal", "permission", "permissions", "model", "feedback", "rewind", "revert-files"]);
    // Mirror requestId -> synthetic tool-call id of the live question form, so
    // a dsh-side wait timeout can dismiss the form Paseo is still showing.
    const questionForms = new Map<string, string>();

    const writer = base.writable.getWriter();
    let writerClosed = false;
    const debugWire = process.env.DSH_DEBUG_WIRE === "1";

    const wireLog = (direction: string, message: AcpStreamMessage) => {
      if (debugWire) console.log(`[dsh-wire ${direction}]`, describeWireMessage(message));
    };

    const toAgent = new WritableStream<AcpStreamMessage>({
      async write(message) {
        wireLog("->agent", message);
        // The ACP adapter settles a question permission as cancelled when its
        // session closes; that response belongs to the plugin, not to dsh.
        if (
          ("result" in message || "error" in message) &&
          typeof message.id === "string" &&
          message.id.startsWith("paseo-question:")
        ) {
          return;
        }
        if ("method" in message && message.method && "id" in message && message.id !== null) {
          if (message.method === "session/prompt") {
            const params = message.params as { sessionId?: unknown; prompt?: Array<{ text?: unknown }> } | undefined;
            const promptText = Array.isArray(params?.prompt)
              ? params.prompt.map((part) => typeof part?.text === "string" ? part.text : "").join("")
              : "";
            const line = promptText.trim();
            const match = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(line);
            const name = match?.[1]?.toLowerCase();
            const argumentText = match?.[2] ?? "";
            if (
              match && name && typeof params?.sessionId === "string" &&
              (sessionCommands.get(params.sessionId)?.has(name) === true || FALLBACK_COMMANDS.has(name))
            ) {
              if (name === "rewind") {
                void runRewindSlash(params.sessionId, argumentText, message.id);
                return;
              }
              if (name === "revert-files") {
                runRevertFilesSlash(params.sessionId, argumentText, message.id);
                return;
              }
              void runBridgeCommand(params.sessionId, line, message.id);
              return;
            }
          }
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
                planSelections.get(params.sessionId)?.active ?? false,
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
            if (params?.configId === PLAN_SETTING_ID) {
              if (typeof params.sessionId !== "string" || typeof params.value !== "boolean") {
                fromAgentController?.enqueue({
                  jsonrpc: "2.0",
                  id: message.id,
                  error: { code: -32602, message: "Plan mode requires a session id and boolean value" },
                });
                return;
              }
              planSelections.set(params.sessionId, { active: params.value, requestId: randomUUID() });
              writePlanSelections(planControlFile, planSelections);
              const catalog = readPermissionCatalog(permissionCatalogFile);
              const currentOptions = decorateConfigOptions(
                sessionConfigOptions.get(params.sessionId),
                catalog.options,
                currentPermissionFor(params.sessionId, sessionCwds.get(params.sessionId), catalog),
                params.value,
              );
              sessionConfigOptions.set(params.sessionId, currentOptions);
              fromAgentController?.enqueue({
                jsonrpc: "2.0",
                id: message.id,
                result: { configOptions: currentOptions },
              });
              log("changed dsh plan mode", { sessionId: params.sessionId, active: params.value });
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
        // Paseo may keep the ACP process alive after discovery; closing the
        // client stream is the definitive end of the catalog probe.
        scheduleProbeCleanup(250);
        if (writerClosed) return;
        writerClosed = true;
        try {
          await writer.close();
        } catch {
          // The child may already be gone; nothing left to drain.
        }
        // stdin EOF makes dsh drain and exit; enforce a deadline. The sidecar
        // is removed after the deadline too, so a child that never exits
        // cannot leak it (the exit handler normally gets there first).
        const timer = setTimeout(() => child.kill("SIGTERM"), 5_000);
        const sidecarTimer = setTimeout(() => {
          stopPtcMirror();
          stopEventMirror();
          rmSync(bridgeRequestDir, { recursive: true, force: true });
          rmSync(bridgeResponseDir, { recursive: true, force: true });
        }, 5_500);
        sidecarTimer.unref();
        child.once("exit", () => {
          clearTimeout(timer);
          clearTimeout(sidecarTimer);
        });
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

    /**
     * In PTC mode dsh reports one aggregate `run_code` tool call per program
     * (title "run_code", kind "other"), while the per-tool dispatches only
     * reach the PTC sidecar. Recognize the aggregate's tool_call and any
     * follow-up tool_call_update for a tracked aggregate.
     */
    const isRunCodeAggregate = (update: Record<string, unknown> | undefined): boolean => {
      if (!update) return false;
      if (update.sessionUpdate === "tool_call") {
        const name = update.title ?? update.name;
        return typeof name === "string" && name.toLowerCase() === "run_code";
      }
      return update.sessionUpdate === "tool_call_update" &&
        typeof update.toolCallId === "string" &&
        runCodePrograms.has(update.toolCallId);
    };

    const handleRunCodeAggregate = (sessionId: unknown, update: Record<string, unknown>): void => {
      const toolCallId = update.toolCallId as string;
      if (update.sessionUpdate === "tool_call") {
        const raw = update.rawInput;
        let input: Record<string, unknown> = {};
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          input = raw as Record<string, unknown>;
        } else if (typeof raw === "string") {
          try {
            input = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            // A non-JSON payload leaves the fallback row unlabeled.
          }
        }
        runCodePrograms.set(toolCallId, {
          description: typeof input.description === "string" ? input.description : undefined,
          code: typeof input.code === "string" ? input.code : undefined,
        });
        return;
      }
      const program = runCodePrograms.get(toolCallId);
      if (!program) return;
      const output = aggregateOutputText(update.content) || aggregateOutputText(update.rawOutput);
      if (output) program.output = output;
      if (update.status === "failed") program.failed = true;
      if (update.status !== "completed" && update.status !== "failed") return;
      runCodePrograms.delete(toolCallId);
      // The bridge writes every dispatch record before the program settles;
      // one synchronous drain closes the watcher-latency window so the
      // fallback cannot duplicate already-mirrored rows.
      drainPtcEvents();
      if (mirroredCallsUnrooted || mirroredRootCallIds.has(toolCallId)) return;
      if (typeof sessionId !== "string" || !liveSessions.has(sessionId)) return;
      try {
        fromAgentController?.enqueue({
          jsonrpc: "2.0",
          method: DSH_PTC_RESULT_METHOD,
          params: {
            subCallId: `${toolCallId}:program`,
            rootCallId: toolCallId,
            name: "run_code",
            arguments: { description: program.description, code: program.code },
            isError: program.failed === true,
            output: program.output ?? "",
          },
        });
      } catch {
        // The consumer tore the stream down; the row is dropped with it.
        return;
      }
      log("surfaced ptc program without dispatched tools", {
        toolCallId,
        description: program.description,
      });
    };

    const fromAgent = base.readable.pipeThrough(
      new TransformStream<AcpStreamMessage, AcpStreamMessage>({
        start(controller) {
          fromAgentController = controller;
        },
        transform(message, controller) {
          wireLog("agent->", message);
          normalizeFailedToolUpdate(message);
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
              }
              if (processMode === "ptc" && isRunCodeAggregate(update)) {
                handleRunCodeAggregate(
                  (message.params as { sessionId?: unknown }).sessionId,
                  update as Record<string, unknown>,
                );
                // Paseo would render the aggregate as an opaque "Run code"
                // JSON row; the mirrored sub-call rows replace it.
                return;
              }
              if (
                processMode !== "ptc" &&
                typeof update?.toolCallId === "string" &&
                (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")
              ) {
                const sessionId = (message.params as { sessionId?: unknown }).sessionId;
                if (typeof sessionId === "string" && liveSessions.has(sessionId) && fromAgentController) {
                  const notification = standardToolNotification(update, toolSnapshots.get(update.toolCallId));
                  if (notification) {
                    try {
                      fromAgentController.enqueue(notification);
                    } catch {
                      // The consumer tore the stream down; nothing left to render.
                    }
                    // Paseo's ACP adapter would show the bare tool name and
                    // drop the ACP content output; the vendor row replaces it.
                    return;
                  }
                }
              }
              if (update?.sessionUpdate === "config_option_update") {
                const sessionId = (message.params as { sessionId?: unknown }).sessionId;
                if (typeof sessionId === "string") {
                  const catalog = readPermissionCatalog(permissionCatalogFile);
                  const current = currentPermissionFor(sessionId, sessionCwds.get(sessionId), catalog);
                  const decorated = decorateConfigOptions(
                    update.configOptions,
                    catalog.options,
                    current,
                    planSelections.get(sessionId)?.active ?? false,
                  );
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
                if (sessionId && !request.probe) {
                  liveSessions.add(sessionId);
                  registerDshRevertHandler(sessionId, ({ token, scope }) =>
                    runNativeRevert(sessionId, token, scope));
                  // Commands may already be in the bridge's catalog by the
                  // time the ACP session/new or resume response arrives. Send
                  // once now and once after Paseo has emitted session.ready.
                  setTimeout(() => refreshCommandCatalog(sessionId), 0);
                  setTimeout(() => refreshCommandCatalog(sessionId), 750);
                }
                if (sessionId) {
                  const cwd = request.cwd ?? launchContext?.cwd;
                  if (cwd) sessionCwds.set(sessionId, cwd);
                  const catalog = readPermissionCatalog(permissionCatalogFile);
                  const currentPermission = currentPermissionFor(sessionId, cwd, catalog);
                  permissionSelections.set(sessionId, currentPermission);
                  const planActive = dshSessionPlanActive(sessionId) ?? planSelections.get(sessionId)?.active ?? false;
                  planSelections.set(sessionId, { active: planActive });
                  const decorated = decorateConfigOptions(
                    result.configOptions,
                    catalog.options,
                    currentPermission,
                    planActive,
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
                const planActive = dshSessionPlanActive(request.sessionId) ?? planSelections.get(request.sessionId)?.active ?? false;
                planSelections.set(request.sessionId, { active: planActive });
                const decorated = decorateConfigOptions(
                  result.configOptions,
                  catalog.options,
                  currentPermission,
                  planActive,
                );
                result.configOptions = decorated;
                sessionConfigOptions.set(request.sessionId, decorated);
              }
              if (request?.probe && typeof result.sessionId === "string") {
                const probeSessionId = result.sessionId;
                probes.add(probeSessionId);
                probeCleanupIds.add(probeSessionId);
                const timer = setTimeout(() => cleanupProbe(probeSessionId), 60_000);
                timer.unref();
                log("hid catalog probe session", { sessionId: probeSessionId });
              }
              if (request?.list && Array.isArray(result.sessions)) {
                const visible = result.sessions
                  .filter((session) => typeof session.sessionId !== "string" || !probes.has(session.sessionId))
                  .map((session) => {
                    const sessionId = session.sessionId;
                    if (typeof sessionId !== "string") return session;
                    // dsh's ACP list carries no title; its projection cache
                    // does, and is far cheaper than replaying each session log.
                    const title = dshSessionTitle(sessionId);
                    const updatedAt = dshSessionLastActivity(sessionId);
                    return {
                      ...session,
                      ...(title ? { title } : {}),
                      ...(updatedAt ? { updatedAt } : {}),
                    };
                  });
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

    /**
     * Tail the PTC mirror sidecar the bridge plugin inside dsh appends to,
     * and re-emit each record of a live session as a vendor notification.
     * Paseo's ACP adapter routes non-ACP notification methods to the plugin
     * transformer (see ptc-present.ts), which renders one detailed timeline
     * row per sub-call instead of a bare "Run code" aggregate.
     */
    const ptcTail = new SidecarTail(ptcEventFile);
    const emitPtcRecord = (record: PtcMirrorRecord): boolean => {
      if (!fromAgentController) return false;
      if (typeof record.sessionId !== "string" || !liveSessions.has(record.sessionId)) return true;
      const data = record.data;
      if (!data || typeof data.subCallId !== "string" || typeof data.name !== "string") return true;
      try {
        fromAgentController.enqueue({
          jsonrpc: "2.0",
          method: record.kind === "call" ? DSH_PTC_CALL_METHOD : DSH_PTC_RESULT_METHOD,
          params: {
            subCallId: data.subCallId,
            rootCallId: typeof data.rootCallId === "string" ? data.rootCallId : undefined,
            name: data.name,
            arguments: data.arguments && typeof data.arguments === "object" && !Array.isArray(data.arguments)
              ? data.arguments
              : {},
            isError: data.isError === true,
            output: ptcResultText(data.content),
          },
        });
      } catch {
        // The consumer tore the stream down; nothing left to mirror for.
        return false;
      }
      if (record.kind === "call") {
        if (typeof data.rootCallId === "string") mirroredRootCallIds.add(data.rootCallId);
        else mirroredCallsUnrooted = true;
      }
      return true;
    };
    const drainPtcEvents = (): void => {
      ptcTail.drain((record) => emitPtcRecord(record as PtcMirrorRecord));
    };
    const ptcWatcher: FSWatcher = watch(ptcEventFile, () => drainPtcEvents());
    // A vanished sidecar (crash cleanup) must not crash the daemon.
    ptcWatcher.on("error", () => {});
    const ptcPoll = setInterval(drainPtcEvents, 250);
    ptcPoll.unref?.();
    let ptcMirrorStopped = false;
    stopPtcMirror = () => {
      if (ptcMirrorStopped) return;
      ptcMirrorStopped = true;
      ptcWatcher.close();
      clearInterval(ptcPoll);
      drainPtcEvents();
      rmSync(ptcEventFile, { force: true });
    };

    // Mirrored dsh events (retries, compaction, jobs, subagents, goals,
    // questions, commands) are re-emitted as one vendor notification kind;
    // dsh-events.ts maps them onto Paseo timeline items and notices.
    const eventTail = new SidecarTail(eventFile);
    const emitEventRecord = (record: SidecarTailRecord): boolean => {
      if (!fromAgentController) return false;
      if (typeof record.sessionId !== "string" || !liveSessions.has(record.sessionId)) return true;
      if (typeof record.kind !== "string") return true;
      const sessionId = record.sessionId;
      const data = record.data && typeof record.data === "object" && !Array.isArray(record.data)
        ? record.data as Record<string, unknown>
        : {};
      // Questions carry a request/answer round trip, so they never become a
      // plain timeline event; the handler emits question cards itself.
      if (record.kind === "question") {
        void handleQuestionEvent(sessionId, data);
        return true;
      }
      if (record.kind === "question-cancelled") {
        const toolCallId = questionForms.get(typeof data.requestId === "string" ? data.requestId : "");
        if (toolCallId) {
          questionForms.delete(typeof data.requestId === "string" ? data.requestId : "");
          cancelDshQuestion(toolCallId);
        }
        // Fall through: the transformer also renders a timeout notice.
      }
      if (record.kind === "plan-mode") syncPlanSetting(sessionId, data);
      try {
        fromAgentController.enqueue({
          jsonrpc: "2.0",
          method: DSH_EVENT_METHOD,
          params: { kind: record.kind, sessionId, data },
        });
      } catch {
        return false;
      }
      return true;
    };
    const drainDshEvents = (): void => {
      eventTail.drain((record) => emitEventRecord(record));
      drainReceipts();
    };
    const eventWatcher: FSWatcher = watch(eventFile, () => drainDshEvents());
    eventWatcher.on("error", () => {});
    const eventPoll = setInterval(drainDshEvents, 250);
    eventPoll.unref?.();
    let eventMirrorStopped = false;
    let bridgeDisposed = false;
    stopEventMirror = () => {
      if (eventMirrorStopped) return;
      eventMirrorStopped = true;
      bridgeDisposed = true;
      eventWatcher.close();
      clearInterval(eventPoll);
      clearInterval(commandPoll);
      drainDshEvents();
      // Unblock questions owned by this connector that are still waiting on
      // a client which just went away.
      cancelAllDshQuestions(bridgeId);
      rmSync(eventFile, { force: true });
    };

    function emitDshEvent(sessionId: string, kind: string, data: Record<string, unknown>): void {
      if (!fromAgentController) return;
      try {
        fromAgentController.enqueue({
          jsonrpc: "2.0",
          method: DSH_EVENT_METHOD,
          params: { kind, sessionId, data },
        });
      } catch {
        // The stream is gone; nothing left to render.
      }
    }

    /** Keep the Plan mode toggle in sync when dsh changes it itself (/plan). */
    function syncPlanSetting(sessionId: string, data: Record<string, unknown>): void {
      const active = data.active;
      if (typeof active !== "boolean" || planSelections.get(sessionId)?.active === active) return;
      // Keep a pending request id so a user toggle still reaches the bridge.
      planSelections.set(sessionId, { ...planSelections.get(sessionId), active });
      const catalog = readPermissionCatalog(permissionCatalogFile);
      const options = decorateConfigOptions(
        sessionConfigOptions.get(sessionId),
        catalog.options,
        currentPermissionFor(sessionId, sessionCwds.get(sessionId), catalog),
        active,
      );
      sessionConfigOptions.set(sessionId, options);
      if (!fromAgentController) return;
      try {
        fromAgentController.enqueue({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "config_option_update", configOptions: options },
          },
        });
      } catch {
        // The stream is gone; the next session open decorates from disk.
      }
    }

    let commandCatalogSignature = "";
    /** Publish the bridge's command catalog as ACP available_commands. */
    function refreshCommandCatalog(forceSessionId?: string): void {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(readFileSync(commandCatalogFile, "utf8")) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const signature = JSON.stringify(parsed);
      if (signature === commandCatalogSignature && forceSessionId === undefined) return;
      commandCatalogSignature = signature;
      for (const [sessionId, value] of Object.entries(parsed)) {
        if (forceSessionId !== undefined && sessionId !== forceSessionId) continue;
        if (!Array.isArray(value)) continue;
        const commands = value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object");
        sessionCommands.set(
          sessionId,
          new Set(commands.map((entry) => typeof entry.name === "string" ? entry.name.toLowerCase() : "").filter(Boolean)),
        );
        if (!liveSessions.has(sessionId) || !fromAgentController) continue;
        const availableCommands = commands
          .filter((entry) => typeof entry.name === "string" && entry.name.length > 0)
          .map((entry) => ({
            name: entry.name as string,
            description: typeof entry.description === "string" ? entry.description : "",
            ...(typeof entry.argumentHint === "string" && entry.argumentHint
              ? { input: { hint: entry.argumentHint } }
              : {}),
          }));
        try {
          fromAgentController.enqueue({
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId, update: { sessionUpdate: "available_commands_update", availableCommands } },
          });
        } catch {
          // The stream is gone; the next pump retries.
        }
      }
    }
    const commandPoll = setInterval(refreshCommandCatalog, 1000);
    commandPoll.unref?.();

    function emitQuestionCard(sessionId: string, data: Record<string, unknown>): void {
      emitDshEvent(sessionId, "question-card", data);
    }

    /** One question becomes one native Paseo permission card. */
    function questionHeader(question: Record<string, unknown>, index: number, used: Set<string>): string {
      const base = (typeof question.header === "string" && question.header.trim())
        ? question.header.trim()
        : (typeof question.question === "string" && question.question.trim())
          ? question.question.trim().slice(0, 40)
          : `问题 ${index + 1}`;
      let header = base;
      let suffix = 2;
      while (used.has(header)) header = `${base} (${suffix++})`;
      used.add(header);
      return header;
    }

    /** Paseo joins selected labels and custom text with ", ". */
    function mapQuestionAnswer(raw: string, labels: string[]): { selected: string[]; custom?: string } {
      if (!raw) return { selected: [] };
      if (labels.includes(raw)) return { selected: [raw] };
      const selected: string[] = [];
      const custom: string[] = [];
      for (const token of raw.split(/,\s+/).map((part) => part.trim()).filter(Boolean)) {
        if (labels.includes(token)) selected.push(token);
        else custom.push(token);
      }
      return { selected, ...(custom.length ? { custom: custom.join(", ") } : {}) };
    }

    async function handleQuestionEvent(sessionId: string, data: Record<string, unknown>): Promise<void> {
      const requestId = typeof data.requestId === "string" ? data.requestId : `q-${randomUUID()}`;
      const questions = Array.isArray(data.questions)
        ? data.questions.filter((question): question is Record<string, unknown> =>
          !!question && typeof question === "object",
        )
        : [];
      if (questions.length === 0) {
        try {
          writeFileSync(join(bridgeResponseDir, `${requestId}.json`), JSON.stringify({ answers: [] }), { mode: 0o600 });
        } catch {
          // The bridge is gone; its question wait will abort with the process.
        }
        return;
      }
      const used = new Set<string>();
      const headers: string[] = [];
      const forms = questions.map((question, index) => {
        const options = Array.isArray(question.options)
          ? question.options
            .filter((option): option is Record<string, unknown> => !!option && typeof option === "object")
            .map((option) => ({
              label: typeof option.label === "string" ? option.label : `选项 ${index + 1}`,
              ...(typeof option.description === "string" ? { description: option.description } : {}),
            }))
          : [];
        const header = questionHeader(question, index, used);
        headers.push(header);
        return {
          header,
          question: typeof question.question === "string" ? question.question : "",
          options,
          multiSelect: question.multiSelect === true,
          allowOther: true,
          allowEmpty: options.length === 0,
        };
      });
      const toolCallId = `paseo-question-${requestId}`;
      questionForms.set(requestId, toolCallId);
      const answersPromise = new Promise<Record<string, string> | undefined>((resolve) => {
        registerDshQuestion(toolCallId, { requestId, scope: bridgeId, resolve });
      });
      for (let index = 0; index < questions.length; index += 1) {
        emitQuestionCard(sessionId, {
          requestId,
          index,
          header: headers[index],
          question: questions[index]!.question,
          detail: questions[index]!.detail,
          status: "running",
        });
      }
      try {
        fromAgentController?.enqueue({
          jsonrpc: "2.0",
          id: `paseo-question:${requestId}`,
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: {
              toolCallId,
              title: headers[0] ?? "问题",
              name: "ask_user_question",
              kind: "other",
              status: "pending",
              rawInput: { questions: forms },
            },
            // A dummy allow option lets the wrapper settle the ACP adapter's
            // pending permission after Paseo's question form answers.
            options: [{ optionId: "answer", name: "Answer", kind: "allow_once" }],
          },
        });
      } catch {
        cancelDshQuestion(toolCallId);
      }
      const answerMap = await answersPromise;
      questionForms.delete(requestId);
      const answers = questions.map((question, index) => {
        const header = headers[index]!;
        const raw = answerMap?.[header] ?? "";
        const labels = forms[index]?.options.map((option) => option.label) ?? [];
        return {
          id: typeof question.id === "string" ? question.id : String(index),
          ...mapQuestionAnswer(raw, labels),
        };
      });
      for (let index = 0; index < questions.length; index += 1) {
        const header = headers[index]!;
        emitQuestionCard(sessionId, {
          requestId,
          index,
          header,
          question: questions[index]!.question,
          detail: questions[index]!.detail,
          status: "completed",
          answer: answerMap?.[header] || "跳过",
        });
      }
      try {
        writeFileSync(
          join(bridgeResponseDir, `${requestId}.json`),
          JSON.stringify({ answers }),
          { mode: 0o600 },
        );
      } catch {
        // The bridge is gone; its question wait will abort with the process.
      }
    }

    /** Execute one slash command inside dsh and resolve the ACP prompt. */
    async function runBridgeCommand(sessionId: string, line: string, promptId: string | number): Promise<void> {
      const requestId = `cmd-${randomUUID()}`;
      const requestFile = join(bridgeRequestDir, `${requestId}.json`);
      const responseFile = join(bridgeResponseDir, `${requestId}.json`);
      try {
        writeFileSync(requestFile, JSON.stringify({ kind: "command", requestId, sessionId, line }), { mode: 0o600 });
      } catch (error) {
        log("command request could not be queued", { sessionId, error: String(error) });
        return;
      }
      const deadline = Date.now() + 130_000;
      let response: Record<string, unknown> | undefined;
      while (!bridgeDisposed && Date.now() < deadline) {
        try {
          response = JSON.parse(readFileSync(responseFile, "utf8")) as Record<string, unknown>;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      rmSync(responseFile, { force: true });
      const result = response && typeof response.result === "object" && !Array.isArray(response.result)
        ? response.result as Record<string, unknown>
        : undefined;
      const failed = !response || response.ok !== true || result?.kind === "error";
      const output = typeof result?.text === "string"
        ? result.text
        : failed
          ? typeof response?.error === "string" ? response.error : "命令执行失败或超时"
          : "";
      emitDshEvent(sessionId, "command-result", {
        requestId,
        line,
        kind: failed ? "error" : "success",
        text: output,
      });
      if (!fromAgentController) return;
      try {
        fromAgentController.enqueue({
          jsonrpc: "2.0",
          id: promptId,
          result: { stopReason: "end_turn" },
        });
      } catch {
        // The prompt is already gone with the stream.
      }
    }

    // ---- Native session revert ------------------------------------------
    // Conversation rewind appends dsh's own replace marker through the
    // bridge; file revert restores byte snapshots the bridge checkpointed.
    // Both are reachable from Paseo's revert affordances (revert tokens on
    // timeline rows) and the /rewind, /revert-files slash commands.

    interface FileReceipt {
      sessionId?: string;
      path?: string;
      absentBefore?: boolean;
      beforeB64?: string;
      afterDigest?: string;
      seq?: number;
      time?: number;
    }

    const receiptTail = new SidecarTail(receiptFile);
    const receiptLogPath = (sessionId: string): string => join(persistentReceiptDir, `${sessionId}.jsonl`);

    /** Mirror bridge checkpoints into the per-dsh-session receipt log. */
    const drainReceipts = (): void => {
      receiptTail.drain((record) => {
        const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
        const path = typeof record.path === "string" ? record.path : undefined;
        if (!sessionId || !path) return true;
        try {
          mkdirSync(persistentReceiptDir, { recursive: true });
          appendFileSync(receiptLogPath(sessionId), `${JSON.stringify(record)}\n`);
        } catch (error) {
          log("file receipt could not be persisted", { sessionId, error: String(error) });
        }
        return true;
      });
    };

    function loadReceipts(sessionId: string): FileReceipt[] {
      const receipts: FileReceipt[] = [];
      try {
        const text = readFileSync(receiptLogPath(sessionId), "utf8");
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as FileReceipt;
            if (parsed && typeof parsed === "object") receipts.push(parsed);
          } catch {
            // A partially written trailing line is ignored.
          }
        }
      } catch {
        // No receipts yet for this session.
      }
      return receipts;
    }

    /**
     * Undo checkpointed write/edit calls newest-first. A digest mismatch
     * stops the chain: reverting below an externally edited file could
     * clobber user work, so the remaining receipts are reported skipped.
     */
    function revertFilesFor(
      sessionId: string,
      afterSeq: number | undefined,
      count: number | undefined,
    ): { undone: string[]; skipped: string[] } {
      const eligible = loadReceipts(sessionId).filter((receipt) =>
        typeof receipt.path === "string" &&
        receipt.path.startsWith("/") &&
        (afterSeq === undefined || typeof receipt.seq !== "number" || receipt.seq > afterSeq));
      const targets = count !== undefined ? eligible.slice(-Math.max(1, count)) : eligible;
      const undone: string[] = [];
      const skipped: string[] = [];
      let chainBroken = false;
      for (const receipt of [...targets].reverse()) {
        const path = receipt.path as string;
        if (chainBroken) {
          skipped.push(`${path}（前置文件已变化，链条中断）`);
          continue;
        }
        try {
          const current = existsSync(path)
            ? createHash("sha256").update(readFileSync(path)).digest("hex")
            : undefined;
          if (receipt.afterDigest !== undefined && current !== receipt.afterDigest) {
            chainBroken = true;
            skipped.push(`${path}（内容已变化，未回滚）`);
            continue;
          }
          if (receipt.absentBefore === true) {
            if (current === undefined) {
              skipped.push(`${path}（已不存在）`);
              continue;
            }
            const backup = `${path}.dsh-backup-${Date.now().toString(36)}`;
            renameSync(path, backup);
            undone.push(`${path}（移至 ${backup}）`);
            continue;
          }
          if (typeof receipt.beforeB64 !== "string") {
            skipped.push(`${path}（无快照）`);
            continue;
          }
          const staged = `${path}.dsh-restore-${randomUUID()}`;
          writeFileSync(staged, Buffer.from(receipt.beforeB64, "base64"), { mode: 0o600 });
          let backup: string | undefined;
          if (current !== undefined) {
            backup = `${path}.dsh-backup-${Date.now().toString(36)}`;
            renameSync(path, backup);
          }
          try {
            renameSync(staged, path);
          } catch (error) {
            if (backup) renameSync(backup, path);
            throw error;
          }
          undone.push(path);
        } catch (error) {
          skipped.push(`${path}（${error instanceof Error ? error.message : String(error)}）`);
        }
      }
      return { undone, skipped };
    }

    /** Ask the in-dsh bridge to append one rewind marker; see performRewind. */
    async function requestBridgeRewind(
      sessionId: string,
      messageId: string | undefined,
      back: number | undefined,
    ): Promise<{ cut: number; summary: string }> {
      const requestId = `rewind-${randomUUID()}`;
      const requestFile = join(bridgeRequestDir, `${requestId}.json`);
      const responseFile = join(bridgeResponseDir, `${requestId}.json`);
      try {
        writeFileSync(
          requestFile,
          JSON.stringify({ kind: "rewind", requestId, sessionId, messageId, back }),
          { mode: 0o600 },
        );
      } catch (error) {
        throw new Error(`回退请求无法排队：${error instanceof Error ? error.message : String(error)}`);
      }
      const deadline = Date.now() + 60_000;
      let response: Record<string, unknown> | undefined;
      while (!bridgeDisposed && Date.now() < deadline) {
        try {
          response = JSON.parse(readFileSync(responseFile, "utf8")) as Record<string, unknown>;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      rmSync(responseFile, { force: true });
      if (!response) throw new Error("回退请求超时，会话未改动");
      if (response.ok !== true) {
        const message = typeof response.error === "string" ? response.error : "回退失败，会话未改动";
        log("rewind rejected", { sessionId, error: message });
        throw new Error(message);
      }
      const result = response.result as { cut?: unknown; summary?: unknown } | undefined;
      const summary = typeof result?.summary === "string" ? result.summary : "更早的消息";
      log("rewind committed", { sessionId, cut: result?.cut, summary });
      return {
        cut: typeof result?.cut === "number" ? result.cut : -1,
        summary,
      };
    }

    /**
     * Paseo cannot retract already-rendered rows, so after a successful
     * conversation rewind the connector closes this connection; reopening
     * replays the rewound log through history-replay's surface filtering.
     */
    function closeAfterRewind(sessionId: string, summary: string): void {
      emitDshEvent(sessionId, "rewind-applied", { summary });
      const timer = setTimeout(() => {
        void toAgent.close();
      }, 1_500);
      timer.unref();
    }

    async function runNativeRevert(
      sessionId: string,
      token: { messageId?: string; seq?: number } | undefined,
      scope: "conversation" | "files" | "both",
    ): Promise<{ description: string }> {
      const parts: string[] = [];
      if (scope !== "files") {
        const rewind = await requestBridgeRewind(sessionId, token?.messageId, token ? undefined : 1);
        parts.push(`对话已回退到「${rewind.summary}」`);
      }
      if (scope !== "conversation") {
        const files = revertFilesFor(sessionId, token?.seq, undefined);
        if (files.undone.length) parts.push(`已还原 ${files.undone.length} 个文件`);
        if (files.skipped.length) parts.push(`跳过 ${files.skipped.length} 个：${files.skipped.join("；")}`);
        if (!files.undone.length && !files.skipped.length) parts.push("没有可回滚的文件改动");
      }
      if (scope !== "files") closeAfterRewind(sessionId, parts[0] ?? "");
      return { description: parts.join("；") };
    }

    /** /rewind [n] — rewind the conversation to the n-th previous user message. */
    async function runRewindSlash(sessionId: string, argumentText: string, promptId: string | number): Promise<void> {
      const back = Number.parseInt(argumentText.trim(), 10);
      try {
        const rewind = await requestBridgeRewind(sessionId, undefined, Number.isFinite(back) && back >= 1 ? back : 1);
        closeAfterRewind(sessionId, rewind.summary);
      } catch (error) {
        emitDshEvent(sessionId, "command-result", {
          requestId: `rewind-${Date.now()}`,
          line: "/rewind",
          kind: "error",
          text: error instanceof Error ? error.message : String(error),
        });
      }
      if (!fromAgentController) return;
      try {
        fromAgentController.enqueue({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
      } catch {
        // The prompt is already gone with the stream.
      }
    }

    /** /revert-files [n] — undo the last n checkpointed write/edit calls. */
    function runRevertFilesSlash(sessionId: string, argumentText: string, promptId: string | number): void {
      const count = Number.parseInt(argumentText.trim(), 10);
      const files = revertFilesFor(sessionId, undefined, Number.isFinite(count) && count >= 1 ? count : 1);
      const text = [
        files.undone.length ? `已还原：${files.undone.join("；")}` : "",
        files.skipped.length ? `跳过：${files.skipped.join("；")}` : "",
      ].filter(Boolean).join("\n") || "没有可回滚的文件改动";
      emitDshEvent(sessionId, "command-result", {
        requestId: `revert-files-${Date.now()}`,
        line: "/revert-files",
        kind: files.undone.length ? "success" : "error",
        text,
      });
      if (!fromAgentController) return;
      try {
        fromAgentController.enqueue({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
      } catch {
        // The prompt is already gone with the stream.
      }
    }

    return { writable: toAgent, readable: fromAgent };
  };
}
