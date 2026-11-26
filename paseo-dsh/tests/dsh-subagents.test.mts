import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { DSH_EVENT_METHOD, dshSubagentTurnState } from "../server/dsh-events.ts";
import { withDshHistoryReplay } from "../server/history-replay.ts";
import {
  dshSubagentLogState,
  dshSubagentNotification,
  dshSubagentRuns,
  DSH_SUBSESSION_CAPABILITY,
  withDshSubagents,
} from "../server/dsh-subagents.ts";
import type { DshSessionEvent } from "../server/probe-cleanup.ts";

// Paseo lists a provider's subagents only for child sessions the provider
// announces under a `session.subsession` parent. The fake provider below
// plays the ACP adapter; the assertions mirror the host's own rules.

const ROOT_CAPABILITIES = ["prompt.message", "permission"];
const HOST_CAPABILITIES = [...ROOT_CAPABILITIES, DSH_SUBSESSION_CAPABILITY];
const TIMINGS = { pollMs: 10, idlePollMs: 20 };

function temporaryHome(t: { after: (fn: () => void) => void }): string {
  const home = mkdtempSync(join(tmpdir(), "dsh-subagents-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

function sessionDir(home: string, sessionId: string): string {
  return join(home, "sessions", "--tmp--", sessionId);
}

function writeSessionLog(home: string, sessionId: string, events: readonly DshSessionEvent[]): void {
  mkdirSync(sessionDir(home, sessionId), { recursive: true });
  const header = JSON.stringify({ type: "session", version: 4, id: sessionId, cwd: "/tmp" });
  writeFileSync(
    join(sessionDir(home, sessionId), "session.v4.jsonl"),
    `${[header, ...events.map((event) => JSON.stringify(event))].join("\n")}\n`,
  );
}

function appendSessionLog(home: string, sessionId: string, events: readonly DshSessionEvent[]): void {
  appendFileSync(
    join(sessionDir(home, sessionId), "session.v4.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
}

const userMessage = (seq: number, id: string, text: string): DshSessionEvent => ({
  type: "user/message",
  seq,
  data: { id, role: "user", source: { kind: "user" }, content: [{ type: "text", text }] },
});
const assistantMessage = (seq: number, text: string): DshSessionEvent => ({
  type: "assistant/message",
  seq,
  data: { message: { id: `a-${seq}`, role: "assistant", content: [{ type: "text", text }] } },
});
const toolCall = (seq: number, callId: string, name: string, args: Record<string, unknown>): DshSessionEvent => ({
  type: "tool/call",
  seq,
  data: { callId, name, arguments: JSON.stringify(args) },
});
const toolResult = (seq: number, callId: string, text: string): DshSessionEvent => ({
  type: "tool/result",
  seq,
  data: { message: { toolCallId: callId, isError: false, content: [{ type: "text", text }] } },
});
const delegation = (seq: number, callId: string, description: string): DshSessionEvent =>
  toolCall(seq, callId, "subagent", { description, prompt: `Do the ${description}` });
const started = (seq: number, callId: string, childId: string): DshSessionEvent =>
  toolResult(seq, callId, `started subagent ${childId}`);
const turnStart = (seq: number, turn: number): DshSessionEvent => ({ type: "turn/start", seq, data: { turn } });
const turnEnd = (seq: number, turn: number, kind: string): DshSessionEvent => ({
  type: "turn/end",
  seq,
  data: { turn, reason: { kind } },
});

/** A child that received its task and is working through a shell call. */
function runningChildEvents(): DshSessionEvent[] {
  return [
    { type: "subagent/descriptor", seq: 0, data: { version: 3, mode: "continuable", provider: "spawn" } },
    turnStart(1, 1),
    userMessage(2, "task-1", "Review the memory layer"),
    toolCall(3, "call-a", "bash", { command: "ls" }),
  ];
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the provider");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The ACP adapter as the host sees it: one root session per open, nothing else. */
function fakeProvider() {
  let listener: ((event: ProviderEvent) => void) | undefined;
  const inputs: ProviderInput[] = [];
  const base: ProviderRegistration = {
    id: "mock",
    label: "mock",
    async connect() {
      const connection: ProviderConnection = {
        version: 1,
        capabilities: ROOT_CAPABILITIES,
        onEvent(next) {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        async send(input) {
          inputs.push(input);
          if (input.type !== "session.open" || !listener) return;
          listener({
            type: "session.opened",
            requestId: input.requestId,
            sessionId: input.sessionId,
            capabilities: ROOT_CAPABILITIES,
            restoration: "core",
            persistence: input.persistence,
            cwd: input.config.cwd,
          });
          listener({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
        },
        async close() {},
      };
      return connection;
    },
  };
  return {
    base,
    inputs,
    emit: (event: ProviderEvent) => listener?.(event),
  };
}

async function openRoot(
  connection: ProviderConnection,
  sessionId: string,
  options: { dshId?: string; history?: "replay" | "skip" } = {},
): Promise<void> {
  await connection.send({
    type: "session.open",
    requestId: `open-${sessionId}`,
    sessionId,
    ...(options.dshId ? { persistence: { version: 1, data: { sessionId: options.dshId } } } : {}),
    history: options.history ?? "skip",
    config: { cwd: "/tmp", env: {}, mcpServers: {}, settings: {}, persist: true },
  });
}

/** The connector re-emits each mirrored bridge event for the transformer. */
function bridge(rootId: string, kind: string, data: Record<string, unknown>, method = DSH_EVENT_METHOD): unknown {
  return dshSubagentNotification(method, { kind, sessionId: "parent", data }, rootId);
}

/** Events of one kind, narrowed to that kind's payload. */
function typed<T extends ProviderEvent["type"]>(events: readonly ProviderEvent[], type: T): Extract<ProviderEvent, { type: T }>[] {
  return events.filter((event): event is Extract<ProviderEvent, { type: T }> => event.type === type);
}

/** Timeline rows announced for one child session, in announcement order. */
function childRows(events: readonly ProviderEvent[], childId: string): ProviderTimelineItem[] {
  return typed(events, "timeline.item")
    .filter((event) => event.sessionId === childId)
    .map((event) => event.item);
}

const turnStates = (events: readonly ProviderEvent[], sessionId: string): string[] =>
  typed(events, "session.turn")
    .filter((event) => event.sessionId === sessionId)
    .map((event) => event.state);

test("delegations are read from standard and PTC tool calls, honoring rewinds", () => {
  const standard = [
    userMessage(1, "u1", "Audit the pool"),
    toolCall(2, "call-1", "bash", { command: "ls" }),
    toolResult(3, "call-1", "started subagent not-a-child"),
    delegation(4, "call-2", "Review memory"),
    started(5, "call-2", "child-1"),
    toolCall(6, "call-3", "subagent_fork", { description: "Fork the audit" }),
    started(7, "call-3", "child-2"),
  ];
  assert.deepEqual(dshSubagentRuns(standard), [
    { childId: "child-1", callId: "call-2", label: "Review memory" },
    { childId: "child-2", callId: "call-3", label: "Fork the audit" },
  ]);

  const ptc: DshSessionEvent[] = [
    { type: "tool/ptc-dispatch-start", seq: 1, data: { rootCallId: "run-1", subCallId: "sub-1", name: "subagent", arguments: { description: "Design tests" } } },
    { type: "tool/ptc-dispatch", seq: 2, data: { rootCallId: "run-1", subCallId: "sub-1", name: "subagent", content: [{ type: "text", text: "started subagent child-3" }] } },
  ];
  assert.deepEqual(dshSubagentRuns(ptc), [{ childId: "child-3", callId: "sub-1", label: "Design tests" }]);

  // A rewound delegation no longer has a tool card to nest under.
  const rewound: DshSessionEvent[] = [
    ...standard,
    { type: "user/message", seq: 8, data: { id: "rewind", source: { kind: "paseo-rewind" }, content: [] }, surfaceOp: { op: "replace", startSeq: 4, endSeq: 5 } },
  ];
  assert.deepEqual(dshSubagentRuns(rewound), [{ childId: "child-2", callId: "call-3", label: "Fork the audit" }]);

  // A read that delivers a frame twice yields one delegation.
  assert.equal(dshSubagentRuns([...standard, ...standard]).length, 2);
});

test("a child's log state and stop reasons map to Paseo turn states", () => {
  assert.deepEqual(dshSubagentLogState([]), { kind: "empty" });
  assert.deepEqual(dshSubagentLogState([turnStart(5, 1)]), { kind: "running", turnStartSeq: 5, turnEndSeq: -1 });
  assert.deepEqual(dshSubagentLogState([turnStart(5, 1), turnEnd(9, 1, "aborted")]), {
    kind: "ended",
    reason: "aborted",
    turnStartSeq: 5,
    turnEndSeq: 9,
  });
  // A resumed child opens a new turn in the same log.
  assert.deepEqual(dshSubagentLogState([turnStart(5, 1), turnEnd(9, 1, "completed"), turnStart(12, 2)]), {
    kind: "running",
    turnStartSeq: 12,
    turnEndSeq: 9,
  });

  assert.equal(dshSubagentTurnState("completed"), "completed");
  assert.equal(dshSubagentTurnState("max-tokens"), "completed");
  assert.equal(dshSubagentTurnState("aborted"), "canceled");
  assert.equal(dshSubagentTurnState("error"), "failed");
});

test("a host without subsessions sees today's tool cards only", async (t) => {
  const home = temporaryHome(t);
  writeSessionLog(home, "child-1", runningChildEvents());
  const fake = fakeProvider();
  const provider = withDshSubagents(fake.base, { ...TIMINGS, home: () => home });
  const connection = await provider.connect({ versions: [1], capabilities: ROOT_CAPABILITIES });
  t.after(() => connection.close());
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));

  assert.deepEqual([...connection.capabilities], ROOT_CAPABILITIES);
  await openRoot(connection, "root-1", { dshId: "parent-1" });
  const [rootOpened] = typed(events, "session.opened");
  assert.ok(!rootOpened?.capabilities.includes(DSH_SUBSESSION_CAPABILITY));

  bridge("root-1", "subagent-start", { callId: "call-1", childId: "child-1", provider: "spawn", label: "Review memory" });
  bridge("root-1", "subagent-end", { callId: "call-1", childId: "child-1", stopReason: "completed" });
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.deepEqual(events.map((event) => event.type), ["session.opened", "session.ready"]);
  assert.deepEqual(fake.inputs.map((input) => input.type), ["session.open"]);
});

test("subagent lifecycle opens a nested child and streams its transcript", async (t) => {
  const home = temporaryHome(t);
  writeSessionLog(home, "parent-1", [userMessage(1, "u1", "Audit the pool")]);
  writeSessionLog(home, "child-1", runningChildEvents());
  const fake = fakeProvider();
  const provider = withDshSubagents(fake.base, { ...TIMINGS, home: () => home });
  const connection = await provider.connect({ versions: [1], capabilities: HOST_CAPABILITIES });
  t.after(() => connection.close());
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));

  assert.deepEqual([...connection.capabilities], HOST_CAPABILITIES);
  await openRoot(connection, "root-1", { dshId: "parent-1" });
  const [rootOpened] = typed(events, "session.opened");
  assert.ok(rootOpened?.capabilities.includes(DSH_SUBSESSION_CAPABILITY));

  bridge("root-1", "subagent-start", { callId: "call-1", childId: "child-1", provider: "spawn", label: "Review memory" });
  await waitFor(() => childRows(events, "child-1").length > 0);

  assert.deepEqual(typed(events, "session.opened").filter((event) => event.sessionId === "child-1"), [{
    type: "session.opened",
    sessionId: "child-1",
    parentSessionId: "root-1",
    toolCallId: "call-1",
    capabilities: [],
    restoration: "parent",
    cwd: "/tmp",
    title: "Review memory",
  }]);
  // A working child announces rows only; the parent's timeline and the
  // adapter's inputs are untouched.
  assert.deepEqual(
    childRows(events, "child-1").map((item) => item.type === "user_message" ? item.text : item.type),
    ["Review the memory layer", "tool_call"],
  );
  assert.deepEqual(turnStates(events, "child-1"), []);
  assert.deepEqual(typed(events, "timeline.item").filter((event) => event.sessionId === "root-1"), []);
  assert.deepEqual(fake.inputs.map((input) => input.type), ["session.open"]);

  // The child keeps working: its log grows, so the new rows arrive and the turn settles.
  appendSessionLog(home, "child-1", [toolResult(4, "call-a", "src"), assistantMessage(5, "Memory is fine"), turnEnd(6, 1, "completed")]);
  await waitFor(() => turnStates(events, "child-1").length > 0);

  const rows = childRows(events, "child-1");
  assert.equal(rows.filter((item) => item.type === "user_message").length, 1, "a row is announced once");
  assert.equal(rows.filter((item) => item.type === "assistant_message").length, 1);
  assert.deepEqual(
    rows.filter((item) => item.type === "tool_call").map((item) => item.type === "tool_call" && item.status),
    ["running", "completed"],
  );
  // The last rows precede the settled turn that closes them.
  assert.deepEqual(typed(events, "session.turn").map((event) => event.state), ["completed"]);
  assert.equal(events.at(-1)?.type, "session.turn");
});

test("a bridge-reported end settles a child whose turn end never flushes", async (t) => {
  const home = temporaryHome(t);
  writeSessionLog(home, "parent-1", []);
  writeSessionLog(home, "child-1", runningChildEvents());
  const fake = fakeProvider();
  const provider = withDshSubagents(fake.base, { ...TIMINGS, endGraceMs: 60, home: () => home });
  const connection = await provider.connect({ versions: [1], capabilities: HOST_CAPABILITIES });
  t.after(() => connection.close());
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  await openRoot(connection, "root-1", { dshId: "parent-1" });

  bridge("root-1", "subagent-start", { callId: "call-1", childId: "child-1" });
  bridge("root-1", "subagent-end", { callId: "call-1", childId: "child-1", stopReason: "aborted" });
  await waitFor(() => turnStates(events, "child-1").length > 0);

  assert.deepEqual(turnStates(events, "child-1"), ["canceled"]);
  // The unflushed turn does not read as a fresh activation on later polls.
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(turnStates(events, "child-1"), ["canceled"]);
});

test("a reopened parent adopts its recorded children after its replayed rows", async (t) => {
  const home = temporaryHome(t);
  writeSessionLog(home, "parent-1", [
    userMessage(1, "u1", "Audit the pool"),
    delegation(2, "call-1", "Review memory"),
    started(3, "call-1", "child-1"),
    delegation(4, "call-2", "Fork the audit"),
    started(5, "call-2", "child-2"),
  ]);
  writeSessionLog(home, "child-1", [...runningChildEvents(), turnEnd(4, 1, "completed")]);
  // The previous process died before this child's end was flushed.
  writeSessionLog(home, "child-2", runningChildEvents());
  const fake = fakeProvider();
  const provider = withDshSubagents(withDshHistoryReplay(fake.base), { ...TIMINGS, home: () => home });
  const connection = await provider.connect({ versions: [1], capabilities: HOST_CAPABILITIES });
  t.after(() => connection.close());
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));

  await openRoot(connection, "root-1", { dshId: "parent-1", history: "replay" });
  await waitFor(() => turnStates(events, "child-1").length > 0 && turnStates(events, "child-2").length > 0);

  // The parent's own open, then its restored rows, go out first; the
  // children follow ready.
  const readyAt = events.findIndex((event) => event.type === "session.ready");
  assert.ok(readyAt > 1, "replayed rows precede ready");
  assert.equal(events[0]?.type, "session.opened");
  assert.ok(events.slice(1, readyAt).every((event) => event.type === "timeline.item" && event.sessionId === "root-1"));
  assert.ok(events.slice(readyAt + 1).every((event) => "sessionId" in event && event.sessionId !== "root-1"));

  const opened = typed(events, "session.opened").filter((event) => event.parentSessionId !== undefined);
  assert.deepEqual(opened.map((event) => [event.sessionId, event.toolCallId, event.title]), [
    ["child-1", "call-1", "Review memory"],
    ["child-2", "call-2", "Fork the audit"],
  ]);
  assert.deepEqual(turnStates(events, "child-1"), ["completed"]);
  assert.deepEqual(turnStates(events, "child-2"), ["canceled"]);
  assert.ok(childRows(events, "child-1").some((item) => item.type === "tool_call"));

  // The parent resumes the settled child: a new turn in the same log runs again.
  const before = events.length;
  appendSessionLog(home, "child-1", [turnStart(5, 2), userMessage(6, "task-2", "Now check the indexes")]);
  await waitFor(() => turnStates(events, "child-1").includes("started"));
  appendSessionLog(home, "child-1", [turnEnd(7, 2, "error")]);
  await waitFor(() => turnStates(events, "child-1").includes("failed"));
  assert.deepEqual(turnStates(events, "child-1"), ["completed", "started", "failed"]);
  assert.ok(childRows(events.slice(before), "child-1").some((item) => item.type === "user_message" && item.text === "Now check the indexes"));

  // Closing the parent closes its children, and nothing follows.
  await connection.send({ type: "session.close", requestId: "close-1", sessionId: "root-1" });
  const closed = typed(events, "session.closed").map((event) => event.sessionId);
  assert.deepEqual(closed, ["child-1", "child-2"]);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(events.at(-2)?.type === "session.closed" && events.at(-1)?.type === "session.closed", true);
  assert.equal(typed(events, "session.closed").length, 2);
});

test("a root the adapter reports closed takes its working child with it", async (t) => {
  const home = temporaryHome(t);
  writeSessionLog(home, "parent-1", []);
  writeSessionLog(home, "child-1", runningChildEvents());
  const fake = fakeProvider();
  const provider = withDshSubagents(fake.base, { ...TIMINGS, home: () => home });
  const connection = await provider.connect({ versions: [1], capabilities: HOST_CAPABILITIES });
  t.after(() => connection.close());
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  await openRoot(connection, "root-1", { dshId: "parent-1" });
  bridge("root-1", "subagent-start", { callId: "call-1", childId: "child-1" });
  await waitFor(() => childRows(events, "child-1").length > 0);

  fake.emit({ type: "session.closed", sessionId: "root-1" });
  const settled = events.length;

  // The host forgets a `restoration: "parent"` session without a round trip,
  // so the child settles and closes before its parent does.
  assert.deepEqual(
    events.slice(-3).map((event) => `${event.type}:${"sessionId" in event ? event.sessionId : ""}${event.type === "session.turn" ? `:${event.state}` : ""}`),
    ["session.turn:child-1:canceled", "session.closed:child-1", "session.closed:root-1"],
  );
  // A closed child is never polled again.
  appendSessionLog(home, "child-1", [turnEnd(4, 1, "completed")]);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(events.length, settled);
});

test("the transformer forwards only subagent lifecycle events", async (t) => {
  const home = temporaryHome(t);
  const fake = fakeProvider();
  const provider = withDshSubagents(fake.base, { home: () => home });
  const connection = await provider.connect({ versions: [1], capabilities: HOST_CAPABILITIES });
  t.after(() => connection.close());
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  await openRoot(connection, "root-1", { dshId: "parent-1" });

  assert.equal(bridge("root-1", "llm-retry", { retryId: "r1" }), null);
  assert.equal(bridge("root-1", "subagent-start", { callId: "c", childId: "x" }, "session/update"), null);
  // A lifecycle event of a session this connection does not own is dropped.
  assert.equal(bridge("someone-else", "subagent-start", { callId: "c", childId: "x" }), null);
  // Without a child or a call there is nothing to nest.
  assert.equal(bridge("root-1", "subagent-start", { provider: "spawn" }), null);
  assert.deepEqual(events.map((event) => event.type), ["session.opened", "session.ready"]);
});
