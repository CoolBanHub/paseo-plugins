// Live acceptance script (not part of `npm test`): drives one real dsh
// session through the provider this plugin registers — ACP adapter,
// connector, the bridge inside dsh and every wrapper — against a host that
// enforces Paseo's own rules for provider child sessions, and checks that a
// subagent dsh spawns shows up as a nested child with its own transcript,
// live and again after the parent is reopened.
//
//   node --experimental-strip-types tests/dsh-subagents-live.mts
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import {
  PROVIDER_CAPABILITIES,
  PROVIDER_PROTOCOL_VERSION,
  ProviderEventSchema,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderPersistence,
  type ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { createDshConnector } from "../server/dsh-acp.ts";
import { dshEventTransformer } from "../server/dsh-events.ts";
import { withDshHistoryReplay } from "../server/history-replay.ts";
import { dshPtcTransformer } from "../server/ptc-present.ts";
import { withDshQuestions } from "../server/dsh-questions.ts";
import { currentDshSessionLaunchContext, withDshSessionLaunchContext } from "../server/session-launch-context.ts";
import { dshSubagentTransformer, withDshSubagents } from "../server/dsh-subagents.ts";
import { dshSessionLogPath } from "../server/probe-cleanup.ts";
import { dshToolTransformer } from "../server/tool-present.ts";

const workdir = mkdtempSync(join(tmpdir(), "dsh-subagents-live-"));
const paseoHome = mkdtempSync(join(tmpdir(), "paseo-dsh-subagents-live-"));
process.env.PASEO_HOME = paseoHome;
process.env.DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");

const log = (message: string, detail?: unknown) =>
  console.log("[live]", message, detail === undefined ? "" : JSON.stringify(detail).slice(0, 500));

// The stack index.server.ts registers.
const acpProvider = runAcpProvider({
  id: "dsh",
  label: "dsh",
  acpOptions: { startupTimeoutMs: 60_000 },
  transformers: [dshPtcTransformer, dshToolTransformer, dshEventTransformer, dshSubagentTransformer],
  connector: createDshConnector(log, currentDshSessionLaunchContext),
});
const provider = withDshQuestions(withDshSubagents(
  withDshHistoryReplay(withDshSessionLaunchContext(acpProvider)),
  { log, pollMs: 500 },
));

// Paseo's rules for a plugin's provider sessions, as its plugin host and
// session adapter apply them. A real host fails the whole provider
// connection on the first violation, so any entry here is a release blocker.
const violations: string[] = [];
const sessions = new Map<string, readonly string[]>();
interface ChildView {
  parent: string;
  toolCallId?: string;
  title?: string;
  status: string;
  outcome?: string;
  rows: ProviderTimelineItem[];
}
const children = new Map<string, ChildView>();
const announcedChildren = new Set<string>();
const dropped: string[] = [];
const events: ProviderEvent[] = [];
let connection: ProviderConnection | undefined;

const accept = (event: ProviderEvent): void => {
  const parsed = ProviderEventSchema.safeParse(event);
  if (!parsed.success) violations.push(`${event.type}: ${parsed.error.issues[0]?.message}`);
  if (event.type === "session.opened") {
    const unoffered = event.capabilities.find((capability) =>
      (PROVIDER_CAPABILITIES as readonly string[]).includes(capability) && !connection?.capabilities.includes(capability));
    if (unoffered) violations.push(`session ${event.sessionId} selected the unoffered capability ${unoffered}`);
    if (sessions.has(event.sessionId)) violations.push(`session ${event.sessionId} was opened twice`);
    if (event.parentSessionId !== undefined) {
      if (!sessions.get(event.parentSessionId)?.includes("session.subsession")) {
        violations.push(`parent session did not negotiate session.subsession`);
      }
      announcedChildren.add(event.sessionId);
      children.set(event.sessionId, {
        parent: event.parentSessionId,
        toolCallId: event.toolCallId,
        title: event.title,
        status: "running",
        rows: [],
      });
    }
    sessions.set(event.sessionId, [...event.capabilities]);
    return;
  }
  if (!("sessionId" in event)) return;
  const child = children.get(event.sessionId);
  if (child) {
    if (event.type === "timeline.item") child.rows.push(event.item);
    if (event.type === "session.turn") {
      child.status = event.state === "started" ? "running" : event.state;
      child.outcome = event.state;
    }
    if (event.type === "session.closed" || event.type === "session.runtime_failed") {
      child.status = event.error ? "failed" : child.outcome === "started" ? "canceled" : child.outcome ?? "completed";
    }
  }
  if (!sessions.has(event.sessionId)) {
    // The real host drops an event for a session it does not know. It is
    // expected once: the connector refreshes slash commands as soon as dsh
    // answers the open, which can precede the adapter's `session.opened`.
    // Nothing may ever target a child that is not open, though.
    if (announcedChildren.has(event.sessionId)) violations.push(`${event.type} arrived for the closed child ${event.sessionId}`);
    else dropped.push(`${event.type} ${event.sessionId}`);
    return;
  }
  // The task needs nothing outside its own temporary directory.
  if (event.type === "session.permission") {
    void connection?.send({
      type: "session.permission",
      sessionId: event.sessionId,
      permissionId: event.request.id,
      response: { behavior: "deny", message: "live acceptance: no escalation is needed" },
    });
  }
  if (event.type === "session.closed") sessions.delete(event.sessionId);
};

async function until(label: string, condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const rowSummary = (rows: readonly ProviderTimelineItem[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = row.type === "tool_call" ? `tool_call:${row.name}` : row.type;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

let parentDshId: string | undefined;
let failure: unknown;
try {
  connection = await provider.connect({ versions: [PROVIDER_PROTOCOL_VERSION], capabilities: [...PROVIDER_CAPABILITIES] });
  connection.onEvent((event) => {
    events.push(event);
    accept(event);
  });
  if (!connection.capabilities.includes("session.subsession")) {
    throw new Error("the connection did not negotiate session.subsession");
  }

  const open = (sessionId: string, persistence?: ProviderPersistence): Promise<void> => connection!.send({
    type: "session.open",
    requestId: `open-${sessionId}`,
    sessionId,
    persistence,
    history: persistence ? "replay" : "skip",
    config: { cwd: workdir, env: {}, mcpServers: {}, settings: {}, persist: true },
  });
  const opened = (sessionId: string) => events.find((event) => event.type === "session.opened" && event.sessionId === sessionId);

  await open("root-1");
  await until("the session to become ready", () => events.some((event) => event.type === "session.ready" && event.sessionId === "root-1"), 180_000);
  const rootOpened = opened("root-1");
  if (rootOpened?.type !== "session.opened" || !rootOpened.capabilities.includes("session.subsession")) {
    throw new Error("the root session was announced without session.subsession");
  }
  parentDshId = (rootOpened.persistence?.data as { sessionId?: string } | undefined)?.sessionId;
  log("session ready", { parentDshId, mode: rootOpened.title });

  const prompt = "Start exactly one subagent with the subagent tool (description: \"write pong\"). Its prompt must tell it to "
    + "use the write tool to create a file named pong.txt in the current directory containing the single line PONG, and then "
    + "reply with just: OK. Do not write the file yourself, do not use any other tool, and do not start more than one subagent. "
    + "Once the subagent has finished, reply with just: DONE.";
  await connection.send({
    type: "session.prompt",
    sessionId: "root-1",
    prompt: { clientMessageId: "prompt-1", delivery: "auto", input: { type: "message", content: [{ type: "text", text: prompt }] } },
  });

  await until("dsh to start the subagent", () => children.size > 0, 300_000);
  const childId = [...children.keys()][0]!;
  log("child opened", { childId, ...children.get(childId), rows: undefined });
  const sawRunningRows = () => children.get(childId)!.rows.length > 0 && children.get(childId)!.status === "running";
  await until("the working child to stream its transcript", sawRunningRows, 120_000);
  log("transcript streaming while the child works", rowSummary(children.get(childId)!.rows));

  await until("the child to settle", () => children.get(childId)!.status !== "running", 300_000);
  await until("the parent turn to end", () => events.some((event) =>
    (event.type === "session.prompt_result" && event.sessionId === "root-1" && event.result.type !== "turn")
    || (event.type === "session.turn" && event.sessionId === "root-1" && event.state !== "started")), 300_000);

  const child = children.get(childId)!;
  const parentRows = events.flatMap((event) => event.type === "timeline.item" && event.sessionId === "root-1" ? [event.item] : []);
  const card = parentRows.filter((item) => item.type === "tool_call" && item.detail.type === "sub_agent").at(-1);
  log("live result", {
    children: children.size,
    status: child.status,
    title: child.title,
    rows: rowSummary(child.rows),
    pong: existsSync(join(workdir, "pong.txt")) ? readFileSync(join(workdir, "pong.txt"), "utf8").trim() : null,
    card: card?.type === "tool_call" && card.detail.type === "sub_agent"
      ? { status: card.status, childSessionId: card.detail.childSessionId }
      : null,
  });
  if (children.size !== 1) throw new Error(`expected one child session, got ${children.size}`);
  if (child.parent !== "root-1") throw new Error(`the child nests under ${child.parent}`);
  if (child.status !== "completed") throw new Error(`the child settled as ${child.status}`);
  if (!child.rows.some((row) => row.type === "user_message")) throw new Error("the child transcript has no task message");
  if (!child.rows.some((row) => row.type === "tool_call" && row.name === "write" && row.status === "completed")) {
    throw new Error("the child transcript does not show the completed write");
  }
  if (readFileSync(join(workdir, "pong.txt"), "utf8").trim() !== "PONG") throw new Error("pong.txt was not written");
  if (card?.type !== "tool_call" || card.detail.type !== "sub_agent" || card.detail.childSessionId !== childId || card.callId !== child.toolCallId) {
    throw new Error("the parent's tool card is not linked to the child session");
  }
  if (violations.length) throw new Error(`host violations: ${violations.join("; ")}`);

  // Paseo closes the runtime of an idle agent and opens it again later.
  const before = events.length;
  await connection.send({ type: "session.close", requestId: "close-1", sessionId: "root-1" });
  await until("the child to close with its parent", () =>
    events.slice(before).some((event) => event.type === "session.closed" && event.sessionId === childId), 60_000);

  const reopened = events.length;
  await open("root-2", rootOpened.persistence);
  await until("the reopened parent to adopt its child", () =>
    events.slice(reopened).some((event) => event.type === "session.opened" && event.sessionId === childId), 180_000);
  await until("the adopted child to settle", () => children.get(childId)!.status !== "running", 60_000);
  const adopted = children.get(childId)!;
  log("reopened result", { parent: adopted.parent, status: adopted.status, rows: rowSummary(adopted.rows) });
  if (adopted.parent !== "root-2") throw new Error(`the adopted child nests under ${adopted.parent}`);
  if (adopted.status !== "completed") throw new Error(`the adopted child settled as ${adopted.status}`);
  if (!adopted.rows.some((row) => row.type === "tool_call" && row.name === "write")) {
    throw new Error("the adopted child lost its transcript");
  }
  if (violations.length) throw new Error(`host violations: ${violations.join("; ")}`);

  await connection.close();
  connection = undefined;
  log("events the host dropped as unknown sessions", dropped);
  console.log("LIVE SUBAGENT ACCEPTANCE: PASS");
} catch (error) {
  failure = error;
  log("FAILED", { error: error instanceof Error ? error.message : String(error), violations });
} finally {
  await connection?.close().catch(() => undefined);
  // The test's own dsh sessions live in one bucket keyed by its temporary
  // working directory; nothing else is filed there.
  const logPath = parentDshId ? dshSessionLogPath(parentDshId, { home: process.env.DSH_HOME! }) : undefined;
  if (logPath) {
    const bucket = dirname(dirname(logPath));
    if (basename(bucket).includes("dsh-subagents-live-")) {
      const ids = readdirSync(bucket);
      rmSync(bucket, { recursive: true, force: true });
      const cache = join(process.env.DSH_HOME!, "storages", "session_projcache", "sessions");
      for (const id of ids) {
        for (const name of [`${id}.json`, `session-${id}.json`]) rmSync(join(cache, name), { force: true });
      }
      log("removed the test's dsh sessions", { bucket: basename(bucket), sessions: ids.length });
    } else {
      log("left the dsh session bucket in place", { bucket });
    }
  }
  rmSync(workdir, { recursive: true, force: true });
  rmSync(paseoHome, { recursive: true, force: true });
}
process.exit(failure === undefined ? 0 : 1);
