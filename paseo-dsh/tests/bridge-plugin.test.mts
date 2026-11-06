import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createDshConnector } from "../server/dsh-acp.ts";

// The bridge plugin runs inside the dsh process, so it has no TypeScript
// harness of its own. Generate the exact file the connector installs and
// drive it through a fake Cordis context.

const testsDir = dirname(fileURLToPath(import.meta.url));
const mockAgent = join(testsDir, "mock-dsh-agent.cjs");
const noLog = () => undefined;

const home = mkdtempSync(join(tmpdir(), "dsh-bridge-test-"));
const presetPatchRoot = join(home, "web-presets");
const webProfileRoot = join(home, "profiles", "web");
const acpProfileRoot = join(home, "profiles", "acp");
for (const dir of [presetPatchRoot, webProfileRoot, acpProfileRoot]) mkdirSync(dir, { recursive: true });
writeFileSync(join(acpProfileRoot, "cordis.patch.yml"), `- id: llm-pi-ai
  config:
    providers:
      bai:
        api: openai-completions
        baseURL: https://example.invalid/v1
        apiKeyEnv: BAI_API_KEY
`);
writeFileSync(join(webProfileRoot, "cordis.patch.yml"), `- id: llm-pi-ai
  config:
    providers:
      bai:
        models:
          - id: deepseek-v4.1-flash
`);
for (const preset of ["standard", "ptc", "minimal", "cordis"]) {
  writeFileSync(join(presetPatchRoot, `${preset}.patch.yml`), `# ${preset}\n`);
}
process.env.DSH_BIN = mockAgent;
process.env.DSH_NODE_PATH = process.execPath;
process.env.PASEO_HOME = home;
process.env.DSH_HOME = home;
process.env.DSH_WEB_PRESET_ROOT = presetPatchRoot;
process.env.DSH_WEB_PROFILE_ROOT = webProfileRoot;
process.env.DSH_ACP_PROFILE_ROOT = acpProfileRoot;

const eventFile = join(home, "bridge-events.jsonl");
const requestDir = join(home, "bridge-requests");
const responseDir = join(home, "bridge-responses");
const commandCatalogFile = join(home, "bridge-commands.json");
const planControlFile = join(home, "bridge-plan.json");
writeFileSync(eventFile, "");
writeFileSync(commandCatalogFile, "{}");
writeFileSync(planControlFile, "{}");
mkdirSync(requestDir, { recursive: true });
mkdirSync(responseDir, { recursive: true });
process.env.DSH_EVENT_FILE = eventFile;
process.env.DSH_BRIDGE_REQUEST_DIR = requestDir;
process.env.DSH_BRIDGE_RESPONSE_DIR = responseDir;
process.env.DSH_COMMAND_CATALOG_FILE = commandCatalogFile;
process.env.DSH_PLAN_CONTROL_FILE = planControlFile;

test.after(() => rmSync(home, { recursive: true, force: true }));

type Handler = (...args: unknown[]) => unknown;

function fakeContext() {
  const handlers = new Map<string, Handler[]>();
  const calls = {
    commands: [] as string[],
    plans: [] as boolean[],
  };
  const commands = {
    list: () => [{ name: "plan", description: "Toggle plan mode", input: { hint: "[off|message]" } }],
    execute: async (_agent: unknown, line: string) => {
      calls.commands.push(line);
      return { commandId: "command-1", result: { kind: "success", text: `ran ${line}` } };
    },
  };
  const planMode = {
    set: (_agent: unknown, active: boolean) => {
      calls.plans.push(active);
      return "committed";
    },
  };
  const ctx = {
    on(name: string, handler: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => {};
    },
    get(name: string) {
      if (name === "commands") return commands;
      if (name === "planMode") return planMode;
      return undefined;
    },
    logger: { warn() {} },
    permissionPresets: {
      catalog: async () => ({
        options: [{ value: "workspace-write", name: "Workspace" }],
        defaultPreset: "workspace-write",
      }),
      current: () => "workspace-write",
      set: async () => {},
    },
    agentPresets: {
      mount: async () => {},
      select: async () => {},
      stateOf: () => undefined,
    },
    sessionProjections: { stateOf: () => undefined },
    effect: () => {},
  };
  return {
    ctx,
    calls,
    emit(name: string, ...args: unknown[]) {
      for (const handler of handlers.get(name) ?? []) handler(...args);
    },
    handlers(name: string) {
      return handlers.get(name) ?? [];
    },
  };
}

async function generatedBridgePath(): Promise<string> {
  // Building the preset patches is side-effect free from the bridge's point
  // of view; opening one connector installs the exact file under test.
  const stream = await createDshConnector(noLog, () => ({ cwd: "/tmp", mode: "standard" }))();
  await stream.writable.close();
  return join(home, "plugin-data", "dsh", "agent-presets", "agent-preset-bridge.js");
}

function readEvents(): Array<Record<string, unknown>> {
  return readFileSync(eventFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("the installed bridge mirrors events, questions, commands and plan changes", async () => {
  const bridgePath = await generatedBridgePath();
  const bridge = await import(`${pathToFileURL(bridgePath).href}?v=${Date.now()}`) as {
    apply(ctx: unknown): void;
  };
  const fake = fakeContext();
  bridge.apply(fake.ctx);

  const agent = { session: { id: "session-1" }, ctx: {} };
  const created = fake.handlers("agent/created");
  assert.equal(created.length, 1);
  await (created[0] as (arg: unknown) => Promise<void>)({ agent });

  // Session events flow into the sidecar the connector tails.
  fake.emit("session/event", { header: { id: "session-1" } }, {
    type: "llm/retry",
    data: { retryId: "r1", retry: 1, maxRetries: 3, delayMs: 1000, failure: { message: "busy" } },
  });
  fake.emit("session/event", { header: { id: "session-1" } }, {
    type: "job/registered",
    data: {
      jobId: "job-1",
      kind: "bash",
      label: "Build",
      toolCall: { callId: "call-1" },
    },
  });
  let events = readEvents();
  assert.equal(events[0]?.kind, "llm-retry");
  assert.equal(events[1]?.kind, "job-registered");

  // A user question is forwarded and resumes with the answer file.
  const questionHandlers = fake.handlers("user-questions/request");
  assert.equal(questionHandlers.length, 1);
  const answerPromise = (questionHandlers[0] as (
    request: unknown,
    next: () => Promise<unknown>,
  ) => Promise<unknown>)({
    agent,
    questions: [{
      id: "q1",
      header: "Confirm",
      question: "Proceed?",
      options: [{ label: "Yes" }, { label: "No" }],
    }],
  }, async () => {
    throw new Error("the bridge should claim the question");
  });
  events = readEvents();
  const question = events.find((event) => event.kind === "question");
  assert.ok(question, "question reached the sidecar");
  const requestId = String((question as { data?: { requestId?: unknown } }).data?.requestId);
  writeFileSync(join(responseDir, `${requestId}.json`), JSON.stringify({
    answers: [{ id: "q1", selected: ["Yes"] }],
  }));
  assert.deepEqual(await answerPromise, { answers: [{ id: "q1", selected: ["Yes"] }] });

  // Commands and plan changes are executed through the injected services.
  writeFileSync(join(requestDir, "cmd-test.json"), JSON.stringify({
    kind: "command",
    requestId: "cmd-test",
    sessionId: "session-1",
    line: "/plan off",
  }));
  writeFileSync(join(requestDir, "plan-test.json"), JSON.stringify({
    kind: "plan",
    requestId: "plan-test",
    sessionId: "session-1",
    active: true,
  }));
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(fake.calls.commands, ["/plan off"]);
  assert.deepEqual(fake.calls.plans, [true]);
  assert.deepEqual(
    JSON.parse(readFileSync(join(responseDir, "cmd-test.json"), "utf8")),
    { ok: true, result: { kind: "success", text: "ran /plan off" } },
  );
  assert.deepEqual(JSON.parse(readFileSync(join(responseDir, "plan-test.json"), "utf8")), { ok: true });

  // Control-file plan toggles are applied once per request id. dsh changing
  // plan mode itself (/plan) must not be undone by the previous request.
  writeFileSync(planControlFile, JSON.stringify({
    "session-1": { active: true, requestId: "plan-toggle-1" },
  }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(fake.calls.plans, [true, true], "the control toggle is applied");
  fake.emit("session/event", { header: { id: "session-1" } }, {
    type: "plan/mode",
    data: { active: false },
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(fake.calls.plans, [true, true], "a stale control toggle does not fight dsh's /plan");
  writeFileSync(planControlFile, JSON.stringify({
    "session-1": { active: true, requestId: "plan-toggle-2" },
  }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(fake.calls.plans, [true, true, true], "a fresh toggle with the same value applies again");

  // The command catalog is available to the connector.
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const catalog = JSON.parse(readFileSync(commandCatalogFile, "utf8"));
  assert.deepEqual(catalog["session-1"], [{
    name: "plan",
    description: "Toggle plan mode",
    argumentHint: "[off|message]",
  }]);
});

test("the bridge mirrors usage, turn ends, revert points and stream previews", async () => {
  process.env.DSH_STREAM_REVEAL_MS = "0";
  process.env.DSH_STREAM_INTERVAL_MS = "0";
  const bridgePath = await generatedBridgePath();
  const bridge = await import(`${pathToFileURL(bridgePath).href}?v=${Date.now()}`) as {
    apply(ctx: unknown): void;
  };
  const fake = fakeContext();
  bridge.apply(fake.ctx);
  const agent = { session: { id: "session-2", header: { id: "session-2" } }, ctx: {} };
  await (fake.handlers("agent/created")[0] as (arg: unknown) => Promise<void>)({ agent });

  fake.emit("session/event", { header: { id: "session-2" } }, {
    type: "user/message",
    seq: 11,
    data: { id: "user-11", source: { kind: "user" }, content: [{ type: "text", text: "Fix it" }] },
  });
  fake.emit("session/event", { header: { id: "session-2" } }, {
    type: "assistant/message",
    time: 12_000,
    data: {
      turn: 3,
      step: 1,
      message: { content: [] },
      usage: { inputTokens: 10, outputTokens: 5 },
      stream: [
        { type: "chunk", time: 9_000, chunk: { type: "block-start", index: 0, blockType: "reasoning" } },
        // Packed runs reconstruct the first non-empty member's time from time0/dt.
        { type: "reasoning-chunks", time0: 10_000, index: 0, dt: [500], texts: ["", "hi"] },
        { type: "chunk", time: 11_000, chunk: { type: "text-delta", text: "ok" } },
      ],
    },
  });
  fake.emit("session/event", { header: { id: "session-2" } }, {
    type: "turn/end",
    data: { turn: 3, reason: { kind: "error", error: { code: "QUOTA", message: "quota text" } } },
  });

  // Streaming frames: quick reveal knobs are zeroed for the test, so chunks
  // surface immediately and the end frame settles the row.
  const streamAgent = { session: { header: { id: "session-2" } } };
  fake.emit("agent/assistant-stream", { agent: streamAgent, frame: { type: "start", attemptId: "at-1", revision: 1, turn: 3, step: 1 } });
  fake.emit("agent/assistant-stream", { agent: streamAgent, frame: { type: "chunk", attemptId: "at-1", revision: 2, index: 0, chunk: { type: "text-delta", text: "Hello " } } });
  fake.emit("agent/assistant-stream", { agent: streamAgent, frame: { type: "chunk", attemptId: "at-1", revision: 3, index: 1, chunk: { type: "text-delta", text: "world" } } });
  fake.emit("agent/assistant-stream", { agent: streamAgent, frame: { type: "end", attemptId: "at-1", revision: 4, index: 2, outcome: { kind: "committed", eventType: "assistant/message", seq: 12 } } });
  // A reasoning delta never reaches the preview.
  fake.emit("agent/assistant-stream", { agent: streamAgent, frame: { type: "start", attemptId: "at-2", revision: 1 } });
  fake.emit("agent/assistant-stream", { agent: streamAgent, frame: { type: "chunk", attemptId: "at-2", revision: 2, index: 0, chunk: { type: "reasoning-delta", text: "hidden" } } });
  fake.emit("agent/assistant-stream", { agent: streamAgent, frame: { type: "end", attemptId: "at-2", revision: 3, index: 1, outcome: { kind: "abandoned" } } });

  const events = readEvents();
  const revertPoint = events.find((event) => event.kind === "revert-point");
  assert.deepEqual(revertPoint?.data, { messageId: "user-11", seq: 11, text: "Fix it" });
  const usage = events.find((event) => event.kind === "usage");
  assert.deepEqual(usage?.data, {
    turn: 3,
    step: 1,
    usage: { inputTokens: 10, outputTokens: 5 },
    decodeMs: 1_500,
  });
  const turnEnd = events.find((event) => event.kind === "turn-end");
  assert.deepEqual(turnEnd?.data, { turn: 3, reason: { kind: "error", error: { code: "QUOTA", message: "quota text" } } });

  const streamRows = events.filter((event) => event.kind === "stream-row");
  // Zeroed knobs surface every chunk: two running previews then the settled
  // row (production throttles to at most one row per interval).
  assert.equal(streamRows.length, 3, "two running previews and one settled row");
  assert.equal((streamRows[0] as { data?: { text?: string } }).data?.text, "Hello ");
  assert.equal((streamRows[1] as { data?: { text?: string } }).data?.text, "Hello world");
  assert.equal((streamRows[2] as { data?: { text?: string; phase?: string } }).data?.text, "Hello world");
  assert.equal((streamRows[2] as { data?: { phase?: string } }).data?.phase, "completed");
  assert.ok(!events.some((event) => event.kind === "stream-row" && JSON.stringify(event).includes("hidden")),
    "reasoning deltas stay out of the preview");

  delete process.env.DSH_STREAM_REVEAL_MS;
  delete process.env.DSH_STREAM_INTERVAL_MS;
});

test("the bridge derives decode timing from every assistant stream shape", async () => {
  const decodeEvents = join(home, "bridge-decode-events.jsonl");
  writeFileSync(decodeEvents, "");
  const previousEventFile = process.env.DSH_EVENT_FILE;
  process.env.DSH_EVENT_FILE = decodeEvents;
  try {
    const bridgePath = await generatedBridgePath();
    const bridge = await import(`${pathToFileURL(bridgePath).href}?v=${Date.now()}`) as {
      apply(ctx: unknown): void;
    };
    const fake = fakeContext();
    bridge.apply(fake.ctx);
    const agent = { session: { id: "session-decode", header: { id: "session-decode" } }, ctx: {} };
    await (fake.handlers("agent/created")[0] as (arg: unknown) => Promise<void>)({ agent });

    const emitMessage = (step: number, time: number, stream?: unknown[]) => {
      fake.emit("session/event", { header: { id: "session-decode" } }, {
        type: "assistant/message",
        time,
        data: {
          turn: 1,
          step,
          message: { content: [] },
          usage: { outputTokens: 10 },
          ...(stream ? { stream } : {}),
        },
      });
    };
    // An empty delta is not a token; the next non-empty delta starts the clock.
    emitMessage(1, 8_000, [
      { type: "chunk", time: 5_000, chunk: { type: "text-delta", text: "" } },
      { type: "chunk", time: 6_000, chunk: { type: "text-delta", text: "x" } },
    ]);
    emitMessage(2, 8_000, [
      { type: "chunk", time: 5_000, chunk: { type: "reasoning-delta", text: "think" } },
    ]);
    // A named tool-call run starts at its first member.
    emitMessage(3, 8_000, [
      { type: "tool-call-chunks", name: "bash", args: ["x"], time0: 3_000, dt: [1_000] },
    ]);
    // An unnamed run starts at its first non-empty argument.
    emitMessage(4, 8_000, [
      { type: "tool-call-chunks", args: ["", "abc"], time0: 3_000, dt: [1_000] },
    ]);
    emitMessage(5, 8_000);

    const usages = readFileSync(decodeEvents, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind?: string; data?: { decodeMs?: number } })
      .filter((event) => event.kind === "usage");
    assert.deepEqual(usages.map((event) => event.data?.decodeMs), [2_000, 3_000, 5_000, 4_000, undefined]);
  } finally {
    process.env.DSH_EVENT_FILE = previousEventFile;
  }
});

test("the bridge checkpoints write/edit calls and records file receipts", async () => {
  const receiptFile = join(home, "bridge-receipts.jsonl");
  writeFileSync(receiptFile, "");
  process.env.DSH_RECEIPT_FILE = receiptFile;
  const bridgePath = await generatedBridgePath();
  const bridge = await import(`${pathToFileURL(bridgePath).href}?v=${Date.now()}`) as {
    apply(ctx: unknown): void;
  };
  const fake = fakeContext();
  bridge.apply(fake.ctx);
  const target = join(home, "checkpoint-target.txt");
  writeFileSync(target, "before-bytes");

  const agent = {
    session: { id: "session-3", header: { id: "session-3" }, snapshotEvents: () => [{ seq: 1 }, { seq: 2 }] },
  };
  const preExecute = fake.handlers("tools/pre-execute")[0] as (
    call: unknown,
    next: () => Promise<unknown>,
  ) => Promise<unknown>;
  const result = fake.handlers("tools/result")[0] as (call: unknown, result: unknown) => void;

  await preExecute({ callId: "w1", name: "write", arguments: JSON.stringify({ file_path: target, content: "after" }), agent }, async () => "done");
  writeFileSync(target, "after");
  result({ callId: "w1", name: "write", agent }, { isError: false });
  // A failed call and a bash call record nothing.
  await preExecute({ callId: "w2", name: "edit", arguments: JSON.stringify({ file_path: target }), agent }, async () => "done");
  result({ callId: "w2", name: "edit", agent }, { isError: true });
  await preExecute({ callId: "w3", name: "bash", arguments: JSON.stringify({ command: "echo hi" }), agent }, async () => "done");
  result({ callId: "w3", name: "bash", agent }, { isError: false });

  const receipts = readFileSync(receiptFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(receipts.length, 1);
  const receipt = receipts[0]!;
  assert.equal(receipt.callId, "w1");
  assert.equal(receipt.sessionId, "session-3");
  assert.equal(receipt.path, target);
  assert.equal(receipt.seq, 2, "the session event count orders receipts against revert tokens");
  assert.equal(receipt.beforeB64, Buffer.from("before-bytes").toString("base64"));
  assert.equal(receipt.afterDigest, createHash("sha256").update("after").digest("hex"));
  delete process.env.DSH_RECEIPT_FILE;
});

test("rewind requests append a native replace marker under the maintenance lock", async () => {
  // Every imported bridge keeps its own 100ms request poll alive, so earlier
  // instances must not race this one for the rewind request; point this
  // instance at fresh directories before it evaluates its env constants.
  const rewindRequestDir = join(home, "rewind-requests");
  const rewindResponseDir = join(home, "rewind-responses");
  mkdirSync(rewindRequestDir, { recursive: true });
  mkdirSync(rewindResponseDir, { recursive: true });
  const previousRequestDir = process.env.DSH_BRIDGE_REQUEST_DIR;
  const previousResponseDir = process.env.DSH_BRIDGE_RESPONSE_DIR;
  process.env.DSH_BRIDGE_REQUEST_DIR = rewindRequestDir;
  process.env.DSH_BRIDGE_RESPONSE_DIR = rewindResponseDir;
  const bridgePath = await generatedBridgePath();
  const bridge = await import(`${pathToFileURL(bridgePath).href}?v=${Date.now()}`) as {
    apply(ctx: unknown): void;
  };
  process.env.DSH_BRIDGE_REQUEST_DIR = previousRequestDir;
  process.env.DSH_BRIDGE_RESPONSE_DIR = previousResponseDir;
  const fake = fakeContext();
  (fake.ctx as { sessions?: unknown }).sessions = { flush: async () => true };
  bridge.apply(fake.ctx);

  const appended: unknown[] = [];
  const events: unknown[] = [];
  for (let seq = 0; seq <= 6; seq += 1) {
    events.push({ seq, type: "turn/start", turn: 1, data: { turn: 1 } });
  }
  events[1] = {
    seq: 1,
    type: "user/message",
    surfaceOp: "append",
    data: { id: "u1", source: { kind: "user" }, content: [{ type: "text", text: "Keep this message" }] },
  };
  events[2] = { seq: 2, type: "assistant/message", surfaceOp: "append", data: { message: { content: [{ type: "text", text: "answer" }] } } };
  events[3] = {
    seq: 3,
    type: "user/message",
    surfaceOp: "append",
    data: { id: "u2", source: { kind: "user" }, content: [{ type: "text", text: "Rewind me" }] },
  };
  events[4] = { seq: 4, type: "assistant/message", surfaceOp: "append", data: { message: { content: [{ type: "text", text: "later answer" }] } } };
  events[5] = { seq: 5, type: "turn/end", turn: 1, data: { turn: 1, reason: { kind: "completed" } } };
  events[6] = { seq: 6, type: "step/end", turn: 1, step: 1, data: {} };
  const agent = {
    session: { id: "session-4" },
    status: "idle",
    inbox: { nextTurn: [], nextStep: [] },
    runMaintenance: async (task: (signal: AbortSignal) => Promise<void>) => task(new AbortController().signal),
    sessionRefs: undefined,
  };
  Object.assign(agent, {
    session: {
      id: "session-4",
      snapshotEvents: () => events,
      surface: { nodes: [1, 2, 3, 4] },
      append: (type: string, message: unknown, options: unknown) => {
        appended.push({ type, message, options });
        return { seq: 7, type, data: message };
      },
    },
  });
  await (fake.handlers("agent/created")[0] as (arg: unknown) => Promise<void>)({ agent });

  writeFileSync(join(rewindRequestDir, "rewind-ok.json"), JSON.stringify({
    kind: "rewind",
    requestId: "rewind-ok",
    sessionId: "session-4",
    messageId: "u1",
  }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  const ok = JSON.parse(readFileSync(join(rewindResponseDir, "rewind-ok.json"), "utf8"));
  assert.equal(ok.ok, true);
  assert.equal(ok.result.messageId, "u1");
  assert.match(ok.result.summary, /Keep this message/);
  assert.equal(appended.length, 1);
  const marker = appended[0] as { type: string; options: { surfaceOp: { op: string; startSeq: number; endSeq: number }; sourceEventSeqs: number[] } };
  assert.equal(marker.type, "user/message");
  assert.deepEqual(marker.options.surfaceOp, { op: "replace", startSeq: 2, endSeq: 4 });
  assert.deepEqual(marker.options.sourceEventSeqs, [2, 3, 4]);

  // A busy agent and an unsupportable transcript both fail closed.
  (agent as unknown as { status: string }).status = "running";
  writeFileSync(join(rewindRequestDir, "rewind-busy.json"), JSON.stringify({
    kind: "rewind",
    requestId: "rewind-busy",
    sessionId: "session-4",
    back: 1,
  }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  const busy = JSON.parse(readFileSync(join(rewindResponseDir, "rewind-busy.json"), "utf8"));
  assert.equal(busy.ok, false);
  assert.match(busy.error, /忙碌/);

  (agent as unknown as { status: string }).status = "idle";
  events[4] = { seq: 4, type: "job/registered", turn: 1, data: {} };
  writeFileSync(join(rewindRequestDir, "rewind-plain.json"), JSON.stringify({
    kind: "rewind",
    requestId: "rewind-plain",
    sessionId: "session-4",
    messageId: "u1",
  }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  const plain = JSON.parse(readFileSync(join(rewindResponseDir, "rewind-plain.json"), "utf8"));
  assert.equal(plain.ok, false);
  assert.match(plain.error, /不支持在此处回退/);
  events[4] = { seq: 4, type: "assistant/message", surfaceOp: "append", data: { message: { content: [{ type: "text", text: "later answer" }] } } };
});

test("a timed-out dsh question emits question-cancelled", async () => {
  const bridgePath = await generatedBridgePath();
  const bridge = await import(`${pathToFileURL(bridgePath).href}?v=${Date.now()}`) as {
    apply(ctx: unknown): void;
  };
  const fake = fakeContext();
  bridge.apply(fake.ctx);
  const agent = { session: { id: "session-5" }, ctx: {} };
  await (fake.handlers("agent/created")[0] as (arg: unknown) => Promise<void>)({ agent });

  const controller = new AbortController();
  controller.abort();
  const handler = fake.handlers("user-questions/request")[0] as (
    request: unknown,
    next: () => Promise<unknown>,
  ) => Promise<unknown>;
  await assert.rejects(
    handler({ agent, questions: [], signal: controller.signal }, async () => undefined),
    /cancelled/,
  );
  const cancelled = readEvents().find((event) => event.kind === "question-cancelled");
  assert.ok(cancelled, "the cancellation is mirrored so the connector can dismiss the form");
});
