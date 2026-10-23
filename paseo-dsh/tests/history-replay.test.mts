import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import type { ProviderConnection, ProviderEvent, ProviderInput, ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { dshHistoryTimelineItems, withDshHistoryReplay } from "../server/history-replay.ts";
import { readDshSessionEvents, type DshSessionEvent } from "../server/probe-cleanup.ts";

function temporaryHome(): string {
  return mkdtempSync(join(tmpdir(), "dsh-history-replay-"));
}

function writeSessionLog(home: string, sessionId: string, events: readonly Record<string, unknown>[], compressed = true): string {
  const dir = join(home, "sessions", "--tmp--", sessionId);
  mkdirSync(dir, { recursive: true });
  const body = `${JSON.stringify({ type: "session", version: 4, id: sessionId, cwd: "/tmp" })}\n`
    + events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  const path = join(dir, compressed ? "session.v4.jsonl.zstd" : "session.v4.jsonl");
  writeFileSync(path, compressed ? zstdCompressSync(Buffer.from(body)) : body);
  return path;
}

const conversationEvents: Record<string, unknown>[] = [
  { type: "user/message", seq: 1, data: { id: "user-id", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "Hello" }] } },
  { type: "user/message", seq: 2, data: { id: "hidden-id", role: "user", source: { kind: "runtime-context", form: "snapshot" }, content: [{ type: "text", text: "Do not display this context" }] } },
  { type: "assistant/message", seq: 3, data: { message: { id: "assistant-id", role: "assistant", content: [{ type: "reasoning", text: "Thinking" }, { type: "text", text: "Hi there" }] } } },
  { type: "tool/call", seq: 4, data: { callId: "tool-1", name: "bash", arguments: JSON.stringify({ command: "pwd" }) } },
  { type: "tool/result", seq: 5, data: { message: { toolCallId: "tool-1", isError: false, content: [{ type: "text", text: "/tmp" }] } } },
];

test("reads bounded dsh JSONL histories from compressed and plain session logs", (t) => {
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeSessionLog(home, "history-a", conversationEvents);
  writeSessionLog(home, "history-b", conversationEvents, false);

  assert.deepEqual(readDshSessionEvents("history-a", { home }), readDshSessionEvents("history-b", { home }));
  assert.equal(readDshSessionEvents("../outside", { home }), undefined, "session ids cannot escape the dsh home");
  assert.equal(readDshSessionEvents("missing", { home }), undefined);
});

test("maps visible dsh conversation, generic tools and PTC sub-calls to stable timeline rows", () => {
  const ptcEvents: DshSessionEvent[] = [
    ...conversationEvents as DshSessionEvent[],
    { type: "tool/call", seq: 6, data: { callId: "run-1", name: "run_code", arguments: "{}" } },
    { type: "tool/ptc-dispatch-start", seq: 7, data: { rootCallId: "run-1", subCallId: "sub-1", name: "bash", arguments: { command: "echo ok" } } },
    { type: "tool/ptc-dispatch", seq: 8, data: { rootCallId: "run-1", subCallId: "sub-1", name: "bash", arguments: { command: "echo ok" }, content: [{ type: "text", text: "ok" }] } },
    { type: "tool/result", seq: 9, data: { message: { toolCallId: "run-1", isError: false, content: [{ type: "text", text: "ok" }] } } },
  ];

  const items = dshHistoryTimelineItems("history-a", ptcEvents);
  assert.deepEqual(items.map((item) => item.type), [
    "user_message", "reasoning", "assistant_message", "tool_call", "tool_call", "tool_call", "tool_call",
  ]);
  assert.equal(items[0]?.id, "user-id");
  assert.equal(items[0]?.type === "user_message" ? items[0].text : "", "Hello");
  assert.equal(items[1]?.type === "reasoning" ? items[1].text : "", "Thinking");
  assert.equal(items[2]?.type === "assistant_message" ? items[2].text : "", "Hi there");
  assert.equal(items[3]?.id, "tool-1");
  assert.equal(items[3]?.type === "tool_call" ? items[3].status : "", "running");
  assert.equal(items[4]?.id, "tool-1");
  assert.equal(items[4]?.type === "tool_call" ? items[4].status : "", "completed");
  assert.equal(items[5]?.id, "sub-1");
  assert.equal(items[6]?.id, "sub-1");
  assert.ok(!items.some((item) => item.id === "run-1"), "a run_code call with mirrored dispatches is not shown twice");
  assert.ok(!items.some((item) => item.type === "user_message" && item.text.includes("Do not display")));
});

test("history replay is emitted before ready only for restored sessions requesting replay", async (t) => {
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });
  writeSessionLog(home, "history-a", conversationEvents);

  let listener: ((event: ProviderEvent) => void) | undefined;
  const seenInputs: ProviderInput[] = [];
  const base: ProviderRegistration = {
    id: "mock",
    label: "mock",
    async connect() {
      const connection: ProviderConnection = {
        version: 1,
        capabilities: [],
        onEvent(next) {
          listener = next;
          return () => { listener = undefined; };
        },
        async send(input) {
          seenInputs.push(input);
          if (input.type === "session.open") listener?.({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
        },
        async close() {},
      };
      return connection;
    },
  };
  const provider = withDshHistoryReplay(base);
  const connection = await provider.connect({ versions: [1], capabilities: [] });
  t.after(() => connection.close());
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));

  const open = (sessionId: string, history: "replay" | "skip") => connection.send({
    type: "session.open",
    requestId: `open-${sessionId}`,
    sessionId,
    persistence: { version: 1, data: { sessionId: "history-a" } },
    history,
    config: { cwd: "/tmp", env: {}, mcpServers: {}, settings: {}, persist: true },
  });

  await open("replay", "replay");
  assert.deepEqual(events.map((event) => event.type), ["timeline.item", "timeline.item", "timeline.item", "timeline.item", "timeline.item", "session.ready"]);
  assert.deepEqual(seenInputs.map((input) => input.type), ["session.open"]);

  events.length = 0;
  await open("skip", "skip");
  assert.deepEqual(events.map((event) => event.type), ["session.ready"]);
});
