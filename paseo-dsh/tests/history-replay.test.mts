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

function writeSessionLog(home: string, sessionId: string, events: readonly DshSessionEvent[], compressed = true): string {
  const dir = join(home, "sessions", "--tmp--", sessionId);
  mkdirSync(dir, { recursive: true });
  const body = `${JSON.stringify({ type: "session", version: 4, id: sessionId, cwd: "/tmp" })}\n`
    + events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  const path = join(dir, compressed ? "session.v4.jsonl.zstd" : "session.v4.jsonl");
  writeFileSync(path, compressed ? zstdCompressSync(Buffer.from(body)) : body);
  return path;
}

const conversationEvents: DshSessionEvent[] = [
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
    ...conversationEvents,
    { type: "tool/call", seq: 6, data: { callId: "run-1", name: "run_code", arguments: "{}" } },
    { type: "tool/ptc-dispatch-start", seq: 7, data: { rootCallId: "run-1", subCallId: "sub-1", name: "bash", arguments: { command: "echo ok" } } },
    { type: "tool/ptc-dispatch", seq: 8, data: { rootCallId: "run-1", subCallId: "sub-1", name: "bash", arguments: { command: "echo ok" }, content: [{ type: "text", text: "ok" }] } },
    { type: "tool/result", seq: 9, data: { message: { toolCallId: "run-1", isError: false, content: [{ type: "text", text: "ok" }] } } },
    {
      type: "todo/write",
      seq: 10,
      data: {
        todos: [
          { content: "scan the repo", status: "completed" },
          { content: "fix the bug", status: "in_progress" },
        ],
      },
    },
    {
      type: "job/registered",
      seq: 11,
      data: {
        jobId: "job-1",
        owner: "session",
        kind: "bash",
        label: "Build",
        startedAt: 1,
        toolCall: { callId: "tool-1", rootCallId: "tool-1" },
      },
    },
    {
      type: "job/settled",
      seq: 12,
      data: {
        jobId: "job-1",
        owner: "session",
        kind: "bash",
        label: "Build",
        startedAt: 1,
        finishedAt: 2,
        status: "completed",
        cause: "producer",
        producerReported: true,
        toolCall: { callId: "tool-1", rootCallId: "tool-1" },
      },
    },
    { type: "compaction/start", seq: 13, data: { compactionId: "compaction-1", turn: 1 } },
    { type: "compaction/end", seq: 14, data: { compactionId: "compaction-1", turn: 1 } },
    {
      type: "goal/change",
      seq: 15,
      data: {
        kind: "goal/change",
        version: 1,
        operation: "create",
        goal: { id: "goal-1", revision: 1, objective: "Ship it", phase: "active" },
        roundsStarted: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    },
  ];

  const items = dshHistoryTimelineItems("history-a", ptcEvents);
  assert.deepEqual(items.map((item) => item.type), [
    "user_message", "tool_call", "reasoning", "assistant_message",
    "tool_call", "tool_call", "tool_call", "tool_call", "todo",
    "tool_call", "tool_call", "compaction", "compaction", "tool_call",
  ]);
  assert.equal(items[0]?.id, "user-id");
  assert.deepEqual(
    items[1]?.type === "tool_call" ? items[1].revertToken : undefined,
    { v: 1, kind: "dsh-rewind", messageId: "user-id", seq: 1 },
    "every visible user message carries a native revert token",
  );
  assert.equal(items[0]?.type === "user_message" ? items[0].text : "", "Hello");
  assert.equal(items[2]?.type === "reasoning" ? items[2].text : "", "Thinking");
  assert.equal(items[3]?.type === "assistant_message" ? items[3].text : "", "Hi there");
  assert.equal(items[4]?.id, "tool-1");
  assert.equal(items[4]?.type === "tool_call" ? items[4].status : "", "running");
  assert.equal(items[5]?.id, "tool-1");
  assert.equal(items[5]?.type === "tool_call" ? items[5].status : "", "completed");
  assert.equal(items[6]?.id, "sub-1");
  assert.equal(items[7]?.id, "sub-1");
  assert.deepEqual(
    items[8]?.type === "todo"
      ? items[8].items.map(({ text, status }) => ({ text, status }))
      : undefined,
    [
      { text: "scan the repo", status: "completed" },
      { text: "fix the bug", status: "in_progress" },
    ],
    "the durable todo/write event restores the native plan list",
  );
  const job = items[9];
  assert.equal(job?.type === "tool_call" && job.name, "Build");
  assert.deepEqual(
    job?.type === "tool_call" && job.detail,
    { type: "shell", command: "pwd" },
    "a background job restores with its originating command",
  );
  assert.equal(items[10]?.type === "tool_call" && items[10].status, "completed");
  assert.equal(items[11]?.type === "compaction" && items[11].status, "loading");
  assert.equal(items[12]?.type === "compaction" && items[12].status, "completed");
  assert.equal(items[13]?.id, "dsh:goal");
  assert.ok(!items.some((item) => item.id === "run-1"), "a run_code call with mirrored dispatches is not shown twice");
  assert.ok(!items.some((item) => item.type === "user_message" && item.text.includes("Do not display")));
});

test("surface replace ops hide shadowed events and rewind markers render as notices", () => {
  const rewound: DshSessionEvent[] = [
    { type: "user/message", seq: 1, surfaceOp: { op: "append" }, data: { id: "u1", source: { kind: "user" }, content: [{ type: "text", text: "Keep me" }] } },
    { type: "assistant/message", seq: 2, surfaceOp: { op: "append" }, data: { message: { id: "a1", content: [{ type: "text", text: "Old answer" }] } } },
    { type: "user/message", seq: 3, surfaceOp: { op: "append" }, data: { id: "u2", source: { kind: "user" }, content: [{ type: "text", text: "Rewound prompt" }] } },
    { type: "assistant/message", seq: 4, surfaceOp: { op: "append" }, data: { message: { id: "a2", content: [{ type: "text", text: "Gone answer" }] } } },
    {
      type: "user/message",
      seq: 5,
      surfaceOp: { op: "replace", startSeq: 3, endSeq: 4 },
      data: { id: "marker", source: { kind: "paseo-rewind" }, content: [{ type: "text", text: "Paseo rewind" }] },
    },
  ];

  const items = dshHistoryTimelineItems("history-r", rewound);
  const texts = items.map((item) => item.type === "user_message" || item.type === "assistant_message" ? item.text : item.type);
  // seq 1-2 survive (only 3..4 are replaced); the rewound prompt, its answer
  // and the marker's own user row never render as conversation messages.
  assert.deepEqual(texts, ["Keep me", "tool_call", "Old answer", "notification"]);
  assert.ok(!texts.includes("Gone answer"), "the replaced assistant message is gone");
  assert.ok(!texts.includes("Rewound prompt"), "the replaced user message is gone");
  const notice = items.find((item) => item.type === "notification");
  assert.equal(notice?.type === "notification" ? notice.message : "", "会话已回退到此处");
  // The shadowed user message leaves no revert marker either.
  assert.equal(items.filter((item) => item.id.includes("revert")).length, 1);
});

test("a tool call whose result was shadowed does not dangle as running", () => {
  const events: DshSessionEvent[] = [
    { type: "user/message", seq: 1, surfaceOp: { op: "append" }, data: { id: "u1", source: { kind: "user" }, content: [{ type: "text", text: "Hi" }] } },
    { type: "tool/call", seq: 2, data: { callId: "c1", name: "bash", arguments: "{}" } },
    { type: "tool/result", seq: 3, surfaceOp: { op: "append" }, data: { message: { toolCallId: "c1", content: [{ type: "text", text: "out" }] } } },
    {
      type: "user/message",
      seq: 4,
      surfaceOp: { op: "replace", startSeq: 3, endSeq: 3 },
      data: { id: "marker", source: { kind: "paseo-rewind" }, content: [{ type: "text", text: "Rewind" }] },
    },
  ];
  const items = dshHistoryTimelineItems("history-d", events);
  assert.ok(!items.some((item) => item.type === "tool_call" && item.id === "c1"), "the shadowed call is dropped entirely");
});

test("attachment blocks replay with name and size annotations", () => {
  const events: DshSessionEvent[] = [{
    type: "user/message",
    seq: 1,
    surfaceOp: { op: "append" },
    data: {
      id: "u1",
      source: { kind: "user" },
      content: [
        { type: "text", text: "Look at this" },
        { type: "image", attachment: { mediaType: "image/png", bytes: 2048 } },
        { type: "file", attachment: { name: "report.pdf", bytes: 3 * 1024 * 1024 } },
      ],
    },
  }];
  const items = dshHistoryTimelineItems("history-att", events);
  const text = items[0]?.type === "user_message" ? items[0].text : "";
  assert.match(text, /\[图片 image\/png · 2KB\]/);
  assert.match(text, /\[文件 report\.pdf · 3\.0MB\]/);
});

test("oversized histories keep the newest window instead of disabling replay", async (t) => {
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // 50,100 events exceeds MAX_HISTORY_EVENTS; the tail reader must keep the
  // newest 50,000 rather than returning undefined.
  const lines: string[] = [JSON.stringify({ type: "session", version: 4, id: "history-big", cwd: "/tmp" })];
  for (let seq = 1; seq <= 50_100; seq += 1) {
    lines.push(JSON.stringify({ type: "user/message", seq, data: { id: `u${seq}`, source: { kind: "user" }, content: [{ type: "text", text: `m${seq}` }] } }));
  }
  const dir = join(home, "sessions", "--tmp--", "history-big");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.v4.jsonl"), `${lines.join("\n")}\n`);

  const { readDshSessionEventsTail } = await import("../server/probe-cleanup.ts");
  const events = await readDshSessionEventsTail("history-big", { home });
  assert.equal(events?.length, 50_000);
  assert.equal(events?.[0]?.seq, 101);
  assert.equal(events?.[49_999]?.seq, 50_100);
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
  assert.deepEqual(events.map((event) => event.type), [
    "timeline.item", "timeline.item", "timeline.item", "timeline.item",
    "timeline.item", "timeline.item", "session.ready",
  ]);
  assert.deepEqual(seenInputs.map((input) => input.type), ["session.open"]);

  events.length = 0;
  await open("skip", "skip");
  assert.deepEqual(events.map((event) => event.type), ["session.ready"]);
});
