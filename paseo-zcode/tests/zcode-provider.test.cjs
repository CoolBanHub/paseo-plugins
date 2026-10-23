const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  module._compile(compiled.outputText, filename);
};

const protocol = require("../server/zcode-protocol.ts");
const accounts = require("../server/zcode-account.ts");
const taskIndex = require("../server/zcode-task-index.ts");
const { createZcodeProvider, prepareZcodePrompt } = require("../server/zcode-provider.ts");
const { PROVIDER_PROTOCOL_VERSION } = require("@getpaseo/plugin/server/provider");

const ACCOUNT = "account:bigmodel-individual-coding-plan";
const BINGLM = "zai-api::GLM-5.3";
const FLASH = "zai-api::GLM-5.3-Flash";
const accountModel = `${ACCOUNT}::GLM-5.3`;
const defaultSelection = { providerId: ACCOUNT, modelId: "GLM-5.3", options: { reasoningLevel: "max" } };
const available = [
  [ACCOUNT, "GLM-5.3", "个人套餐", ["low", "high", "max"]],
  ["zai-api", "GLM-5.3", "binglm", ["low", "high", "max"]],
  ["zai-api", "GLM-5.3-Flash", "binglm", ["low", "high", "max"]],
  ["anthropic", "claude", "Anthropic", ["low", "high", "xhigh", "max"]],
  ["plain", "simple", "Plain", []],
].map(([providerId, modelId, providerLabel, levels]) => ({
  ref: { providerId, modelId }, label: modelId, providerLabel, contextWindow: 1_000_000,
  reasoning: { levels: levels.map((value) => ({ value })), defaultLevel: levels.at(-1) },
}));

async function fixture(t, options = {}) {
  t.mock.method(console, "log", () => {});
  t.mock.method(protocol, "resolveZcodeCliPath", () => "/mock/zcode.cjs");
  t.mock.method(accounts, "readAccountProviders", () => []);
  t.mock.getter(taskIndex.ZcodeTaskIndex.prototype, "available", () => true);
  const archived = new Set();
  const archiveCalls = [];
  let archiveError;
  t.mock.method(taskIndex.ZcodeTaskIndex.prototype, "hiddenSessionIds", async () => new Set(archived));
  t.mock.method(taskIndex.ZcodeTaskIndex.prototype, "setArchived", async (sessionId, value) => {
    archiveCalls.push({ sessionId, archived: value });
    if (archiveError) throw new Error(archiveError);
    if (value) archived.add(sessionId);
    else archived.delete(sessionId);
    return { sessionId, archived: value };
  });
  let stateListener;
  let eventListener;
  let serverRequestListener;
  const serverReplies = [];
  t.mock.method(protocol.ZcodeProtocolClient.prototype, "onStateUpdate", (listener) => { stateListener = listener; return () => {}; });
  t.mock.method(protocol.ZcodeProtocolClient.prototype, "onSessionEvent", (listener) => { eventListener = listener; return () => {}; });
  t.mock.method(protocol.ZcodeProtocolClient.prototype, "onServerRequest", (listener) => { serverRequestListener = listener; return () => {}; });
  t.mock.method(protocol.ZcodeProtocolClient.prototype, "replyServerRequest", (id, result) => { serverReplies.push({ id, result }); });
  const requests = [];
  const states = new Map();
  let nextSession = 0;
  let rejectModel;
  let beforeSet;
  let rejectSend = false;
  const snapshot = (sessionId) => {
    const state = states.get(sessionId);
    return {
      session: { sessionId, mode: state.runtimeMode ?? state.mode, model: state.model },
      settings: {
        mode: { current: state.mode },
        model: { available, current: state.model },
        thoughtLevel: { current: state.model.options?.reasoningLevel },
      },
      runtime: { stateRevision: state.revision, eventSeq: state.eventSeq },
      projection: {
        contextWindow: 500_000,
        mode: state.runtimeMode ?? state.mode,
        ...(state.backgroundJobs ? { backgroundJobs: structuredClone(state.backgroundJobs) } : {}),
      },
      ...(state.todos ? { todos: structuredClone(state.todos) } : {}),
    };
  };
  t.mock.method(protocol.ZcodeProtocolClient.prototype, "request", async (method, params) => {
    requests.push({ method, params: structuredClone(params) });
    if (method === "session/create" || method === "session/resume") {
      const id = params.sessionId ?? `sess_mock_${++nextSession}`;
      states.set(id, {
        mode: options.initialMode ?? "build",
        runtimeMode: "build",
        revision: 0,
        eventSeq: 0,
        subscribed: false,
        model: structuredClone(method === "session/resume" ? options.resumeSelection ?? defaultSelection : defaultSelection),
        ...(options.initialTodos ? { todos: structuredClone(options.initialTodos) } : {}),
        ...(options.initialBackgroundJobs ? { backgroundJobs: structuredClone(options.initialBackgroundJobs) } : {}),
      });
      return { result: snapshot(id) };
    }
    if (method === "session/read") return { result: {
      ...snapshot(params.sessionId),
      messages: structuredClone(options.historyMessages ?? []),
    } };
    if (method === "session/list") return { result: { sessions: [...states.keys()].map((id) => snapshot(id).session) } };
    if (method === "session/setModel") {
      if (beforeSet) await beforeSet();
      if (rejectModel === params.model.modelId) return { error: { code: -1, message: "model switch rejected" } };
      const entry = available.find((model) => model.ref.providerId === params.model.providerId && model.ref.modelId === params.model.modelId);
      assert.ok(entry, "setModel must select an exact provider/model pair");
      if (entry.reasoning.levels.length) {
        assert.ok(entry.reasoning.levels.some((level) => level.value === params.model.options?.reasoningLevel), "reasoning level must be supplied and supported");
      }
      states.get(params.sessionId).model = structuredClone(params.model);
      states.get(params.sessionId).revision++;
      return { result: snapshot(params.sessionId) };
    }
    if (method === "session/setMode") {
      const state = states.get(params.sessionId);
      if (!options.ignoreModeChange) {
        state.mode = params.mode === "plan" ? "build" : params.mode;
        state.runtimeMode = params.mode === "plan" ? "build" : params.mode;
        state.planEnabled = params.mode === "plan";
        state.eventSeq++;
        if (state.subscribed) eventListener({
          type: "session.updated", sessionId: params.sessionId, seq: state.eventSeq,
          payload: { mode: state.mode, planEnabled: state.planEnabled },
        });
      }
      state.revision++;
      return { result: snapshot(params.sessionId) };
    }
    if (method === "session/subscribe") states.get(params.sessionId).subscribed = true;
    if (method === "session/send" && rejectSend) return { error: { code: -1, message: "send rejected" } };
    return { result: {} };
  });
  const connection = await createZcodeProvider().connect({ versions: [PROVIDER_PROTOCOL_VERSION], capabilities: ["prompt.message", "prompt.image", "session.configure", "session.persistence", "session.archive", "session.unarchive"] });
  t.after(() => connection.close());
  const events = [];
  connection.onEvent((event) => events.push(structuredClone(event)));
  const open = (config = {}, persistence, history = "skip") => connection.send({
    type: "session.open", requestId: "open", sessionId: "paseo-session", persistence,
    history,
    config: { cwd: "/mock/workspace", env: {}, mcpServers: {}, settings: {}, persist: true, ...config },
  });
  const configure = (changes) => connection.send({ type: "session.configure", requestId: "configure", sessionId: "paseo-session", changes });
  const prompt = (delivery = "auto", content = [{ type: "text", text: "hello" }]) => connection.send({
    type: "session.prompt", sessionId: "paseo-session",
    prompt: { clientMessageId: "message", delivery, input: { type: "message", content } },
  });
  return {
    events, open, configure, prompt, connection, archiveCalls,
    archive: (sessionId, value = true) => connection.send({ type: value ? "session.archive" : "session.unarchive", requestId: "archive", persistence: { version: 1, data: { zcodeSessionId: sessionId } } }),
    rejectArchive: (message) => { archiveError = message; },
    externalState: (patch, revision, notify = true) => {
      const id = fSessionId();
      const state = states.get(id);
      if (patch.model?.current) state.model = structuredClone(patch.model.current);
      if (patch.mode?.current) {
        state.mode = patch.mode.current === "plan" ? "build" : patch.mode.current;
        state.planEnabled = patch.mode.current === "plan";
        state.eventSeq++;
        if (notify) eventListener({
          type: "session.updated", sessionId: id, seq: state.eventSeq,
          payload: { mode: state.mode, planEnabled: state.planEnabled },
        });
      }
      state.revision = revision;
      if (notify) stateListener({ sessionId: id, scope: "session", revision, patch });
    },
    notify: (patch, revision) => stateListener({ sessionId: fSessionId(), scope: "session", revision, patch }),
    sessionEvent: (event) => eventListener({ seq: 1, timestamp: Date.now(), payload: {}, ...event }),
    serverRequest: (id, params, method = "interaction/requestPermission") => serverRequestListener({ id, method, params }),
    serverReplies,
    setTodos: (todos) => { states.get(fSessionId()).todos = structuredClone(todos); },
    calls: (method) => requests.filter((request) => request.method === method).map((request) => request.params),
    config: () => events.filter((event) => event.type === "session.config").at(-1)?.config,
    rejectModel: (id) => { rejectModel = id; },
    beforeSet: (fn) => { beforeSet = fn; },
    rejectSend: () => { rejectSend = true; },
  };
  function fSessionId() {
    return events.find((event) => event.type === "session.persistence")?.persistence.data.zcodeSessionId;
  }
}

test("opening applies the selected provider and reasoning before reporting config", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM, thinkingOption: "low", mode: "plan" });
  assert.deepEqual(f.calls("session/setModel").at(-1).model, { providerId: "zai-api", modelId: "GLM-5.3", options: { reasoningLevel: "low" } });
  assert.equal(f.config().model, BINGLM);
  assert.equal(f.config().thinkingOption, "low");
  assert.equal(f.config().mode, "plan");
  assert.ok(f.events.filter((event) => event.type === "session.config").every((event) => event.config.model === BINGLM));
  assert.equal(f.config().models.find((model) => model.id === BINGLM).label, "binglm/GLM-5.3");
  assert.notEqual(f.config().models.find((model) => model.id === accountModel).label, "binglm/GLM-5.3");
});

test("opening supplies the model default when reasoning is unspecified", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  assert.equal(f.calls("session/setModel").at(-1).model.options.reasoningLevel, "max");
});

test("pending permission reannouncements share one detailed Paseo card", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  const sessionId = f.events.find((event) => event.type === "session.persistence").persistence.data.zcodeSessionId;
  const params = {
    sessionId,
    requestId: "permission-logical-1",
    toolCallId: "tool-call-1",
    toolName: "Bash",
    reason: "Run a shell command",
    input: { command: "git status --short" },
    options: [
      { optionId: "allow_once", kind: "allow_once", name: "Allow once", response: { decision: "allow" } },
      { optionId: "deny", kind: "deny", name: "Deny", response: { decision: "deny" } },
    ],
  };

  f.serverRequest("server-permission-1", params);
  f.serverRequest("server-permission-2", params);

  const cards = f.events.filter((event) => event.type === "session.permission");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].request.description, "Run a shell command");
  assert.deepEqual(cards[0].request.detail, { type: "shell", command: "git status --short" });
  assert.equal(cards[0].request.actions[0].label, "Allow once");
  assert.deepEqual(f.serverReplies, []);

  await f.connection.send({
    type: "session.permission",
    sessionId: "paseo-session",
    permissionId: "server-permission-1",
    response: { behavior: "allow", selectedActionId: "allow_once" },
  });
  assert.deepEqual(f.serverReplies, [{ id: "server-permission-1", result: { approved: true } }]);

  f.serverRequest("server-permission-3", { ...params, requestId: "permission-logical-2", toolCallId: "tool-call-2" });
  assert.equal(f.events.filter((event) => event.type === "session.permission").length, 2);
});

test("plan approval user-input requests become an actionable Paseo plan card", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM, mode: "yolo" });
  const sessionId = f.events.find((event) => event.type === "session.persistence").persistence.data.zcodeSessionId;
  const plan = "# MCP integration plan\n\nAdd an MCP tools package and tests.";

  f.serverRequest("server-plan-approval-1", {
    sessionId,
    requestId: "plan-approval-1",
    toolCallId: "exit-plan-mode-1",
    toolName: "ExitPlanMode",
    prompt: "Review this implementation plan.",
    schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
    input: { plan },
    questions: [{
      header: "Plan",
      question: "Review this implementation plan.",
      options: [{ label: "Approve", value: "approve", description: "Exit plan mode and start implementation." }],
    }],
  }, "interaction/requestUserInput");

  const card = f.events.find((event) => event.type === "session.permission");
  assert.equal(card.sessionId, "paseo-session");
  assert.equal(card.request.kind, "plan");
  assert.equal(card.request.name, "ExitPlanMode");
  assert.deepEqual(card.request.detail, { type: "plan", text: plan });
  assert.deepEqual(card.request.actions, [
    { id: "approve", label: "批准并开始实施", behavior: "allow", intent: "implement_resume" },
    { id: "decline", label: "拒绝计划", behavior: "deny", intent: "dismiss" },
  ]);
  assert.deepEqual(f.serverReplies, []);

  await f.connection.send({
    type: "session.permission",
    sessionId: "paseo-session",
    permissionId: "server-plan-approval-1",
    response: { behavior: "allow", selectedActionId: "approve" },
  });
  assert.deepEqual(f.serverReplies, [{
    id: "server-plan-approval-1",
    result: { action: "accept", content: { answer: "approve" } },
  }]);
});

test("declining a plan approval resolves the ZCode user-input request as declined", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM, mode: "yolo" });
  const sessionId = f.events.find((event) => event.type === "session.persistence").persistence.data.zcodeSessionId;

  f.serverRequest("server-plan-approval-2", {
    sessionId,
    requestId: "plan-approval-2",
    toolName: "ExitPlanMode",
    schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
    input: { plan: "Implementation plan" },
    questions: [{ header: "Plan", question: "Review plan.", options: [{ label: "Approve", value: "approve" }] }],
  }, "interaction/requestUserInput");

  await f.connection.send({
    type: "session.permission",
    sessionId: "paseo-session",
    permissionId: "server-plan-approval-2",
    response: { behavior: "deny", selectedActionId: "decline" },
  });
  assert.deepEqual(f.serverReplies, [{ id: "server-plan-approval-2", result: { action: "decline" } }]);
});

test("ZCode todo snapshots and TodoWrite updates reach the Paseo timeline", async (t) => {
  const initialTodos = [
    { content: "Inspect provider events", status: "in_progress", priority: "high" },
    { content: "Add regression coverage", status: "pending", priority: "medium" },
  ];
  const f = await fixture(t, { initialTodos });
  await f.open({ model: BINGLM });
  const todoItems = () => f.events.filter((event) => event.type === "timeline.item" && event.item.type === "todo");
  assert.deepEqual(todoItems().at(-1).item.items.map((item) => [item.text, item.status]), [
    ["Inspect provider events", "in_progress"],
    ["Add regression coverage", "pending"],
  ]);

  const sessionId = f.events.find((event) => event.type === "session.persistence").persistence.data.zcodeSessionId;
  f.sessionEvent({
    type: "model.streaming", sessionId, turnId: "turn-todos",
    payload: { kind: "tool_call", toolCallId: "todo-write-1", toolName: "TodoWrite", input: { todos: [] } },
  });
  f.setTodos([{ content: "Regression coverage", status: "completed", priority: "high" }]);
  f.sessionEvent({
    type: "tool.updated", sessionId, turnId: "turn-todos",
    payload: { kind: "result", toolCallId: "todo-write-1", result: { success: true, content: "Updated" } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(todoItems().at(-1).item.items.map((item) => [item.text, item.status, item.completed]), [
    ["Regression coverage", "completed", true],
  ]);
});

test("ZCode background terminal lifecycle is mirrored as a shell tool call", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  const sessionId = f.events.find((event) => event.type === "session.persistence").persistence.data.zcodeSessionId;
  const task = {
    taskId: "background-1",
    toolCallId: "background-tool-1",
    toolName: "Bash",
    taskKind: "bash",
    command: "npm run test:e2e",
  };
  f.sessionEvent({ type: "session.updated", sessionId, payload: { ...task, status: "running" } });
  f.sessionEvent({ type: "session.updated", sessionId, payload: { ...task, status: "completed", outputTail: "passed" } });

  const jobs = f.events.filter((event) => event.type === "timeline.item" && event.item.id === "zcode:background:background-1");
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].item.status, "running");
  assert.equal(jobs[0].item.detail.command, "npm run test:e2e");
  assert.equal(jobs[1].item.status, "completed");
  assert.equal(jobs[1].item.detail.output, "passed");
});

test("opening accepts Guarded from official settings even when session projection remains Build", async (t) => {
  const f = await fixture(t, { initialMode: "guarded" });
  await f.open({ model: accountModel, thinkingOption: "max", mode: "guarded" });
  assert.equal(f.config().mode, "guarded");
  assert.ok(f.events.some((event) => event.type === "session.ready"));
  assert.ok(!f.events.some((event) => event.type === "request.failed"));
  assert.equal(f.calls("session/setMode").length, 0);
  await f.prompt();
  assert.equal(f.calls("session/send").length, 1);
  assert.equal(f.calls("session/send")[0].modelSelection.providerId, ACCOUNT);
  assert.equal(f.config().model, accountModel);
});

test("resuming can switch models within the same provider", async (t) => {
  const f = await fixture(t, { resumeSelection: { providerId: "zai-api", modelId: "GLM-5.3", options: { reasoningLevel: "low" } } });
  await f.open({ model: FLASH }, { version: 1, data: { zcodeSessionId: "sess_resumed" } });
  assert.equal(f.calls("session/setModel").at(-1).model.modelId, "GLM-5.3-Flash");
  assert.equal(f.config().model, FLASH);
  assert.equal(f.config().thinkingOption, "low");
});

test("resuming without an override preserves the saved model and reasoning", async (t) => {
  const f = await fixture(t, { resumeSelection: { providerId: "zai-api", modelId: "GLM-5.3", options: { reasoningLevel: "high" } } });
  await f.open({}, { version: 1, data: { zcodeSessionId: "sess_resumed" } });
  await f.prompt();
  assert.equal(f.config().model, BINGLM);
  assert.equal(f.calls("session/send").at(-1).modelSelection.options.reasoningLevel, "high");
});

test("resuming replays visible ZCode history before session.ready when requested", async (t) => {
  const f = await fixture(t, {
    historyMessages: [
      {
        info: { role: "user", messageId: "user-1", semantics: { transcriptVisibility: "visible" } },
        parts: [{ type: "text", partId: "user-part-1", text: "Question" }],
      },
      {
        info: { role: "user", messageId: "hidden-1", semantics: { transcriptVisibility: "hidden" } },
        parts: [{ type: "text", partId: "hidden-part-1", text: "Injected instructions" }],
      },
      {
        info: { role: "user", messageId: "unknown-visibility-1" },
        parts: [{ type: "text", partId: "unknown-visibility-part-1", text: "Unclassified runtime content" }],
      },
      {
        info: { role: "assistant", messageId: "assistant-1", semantics: { transcriptVisibility: "visible" } },
        parts: [
          { type: "reasoning", partId: "reasoning-1", text: "Thinking" },
          { type: "text", partId: "assistant-part-1", text: "Answer" },
          {
            type: "tool", partId: "tool-part-1", callId: "tool-1", tool: "Bash",
            state: { status: "completed", input: { command: "pwd" }, output: "/workspace" },
          },
        ],
      },
    ],
  });

  await f.open({}, { version: 1, data: { zcodeSessionId: "sess_history" } }, "replay");

  const history = f.events.filter((event) => event.type === "timeline.item");
  assert.deepEqual(history.map((event) => event.item.type), [
    "user_message", "reasoning", "assistant_message", "tool_call",
  ]);
  assert.deepEqual(history.map((event) => event.item.id), [
    "user-1", "reasoning-1", "assistant-1:text:0", "tool-1",
  ]);
  assert.equal(history[0].item.text, "Question");
  assert.equal(history[2].item.text, "Answer");
  assert.equal(history[3].item.status, "completed");
  assert.deepEqual(history[3].item.detail, { type: "shell", command: "pwd", output: "/workspace" });
  assert.ok(!history.some((event) => event.item.text === "Injected instructions"));
  assert.ok(!history.some((event) => event.item.text === "Unclassified runtime content"));
  assert.ok(f.events.findIndex((event) => event.type === "timeline.item") < f.events.findIndex((event) => event.type === "session.ready"));
  assert.equal(f.calls("session/read").filter((call) => call.messageLimit === 1000).length, 1);
});

test("resuming with history skip does not fetch or replay the old ZCode transcript", async (t) => {
  const f = await fixture(t, {
    historyMessages: [{ info: { role: "user", messageId: "user-1" }, parts: [{ type: "text", text: "Old prompt" }] }],
  });

  await f.open({}, { version: 1, data: { zcodeSessionId: "sess_history" } }, "skip");

  assert.equal(f.calls("session/read").filter((call) => call.messageLimit === 1000).length, 0);
  assert.equal(f.events.filter((event) => event.type === "timeline.item" && event.item.type === "user_message").length, 0);
});

test("changing only mode preserves the selected provider and reasoning", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM, thinkingOption: "low" });
  await f.configure({ mode: "guarded" });
  await f.prompt();
  assert.equal(f.config().model, BINGLM);
  assert.equal(f.config().mode, "guarded");
  assert.equal(f.config().thinkingOption, "low");
  assert.equal(f.calls("session/send").at(-1).modelSelection.providerId, "zai-api");
});

test("changing only reasoning preserves the selected model and mode", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM, mode: "plan" });
  await f.configure({ thinkingOption: "high" });
  await f.prompt();
  assert.equal(f.config().model, BINGLM);
  assert.equal(f.config().mode, "plan");
  assert.equal(f.config().thinkingOption, "high");
  assert.equal(f.calls("session/send").at(-1).modelSelection.options.reasoningLevel, "high");
});

test("switching between same-name account and API models changes the actual send selection", async (t) => {
  const f = await fixture(t);
  await f.open({ model: accountModel, thinkingOption: "low" });
  await f.configure({ model: BINGLM });
  await f.prompt();
  assert.equal(f.calls("session/send").at(-1).modelSelection.providerId, "zai-api");
  await f.configure({ model: accountModel, thinkingOption: "high" });
  await f.prompt("steer");
  assert.equal(f.calls("session/setModel").at(-1).model.providerId, ACCOUNT);
  assert.deepEqual(f.calls("session/send").at(-1).modelSelection, { providerId: ACCOUNT, modelId: "GLM-5.3", options: { reasoningLevel: "high" } });
});

test("an incompatible previous reasoning level falls back to the new model default", async (t) => {
  const f = await fixture(t);
  await f.open({ model: "anthropic::claude", thinkingOption: "xhigh" });
  await f.configure({ model: BINGLM });
  assert.equal(f.config().thinkingOption, "max");
});

test("models with no reasoning options can be selected and sent", async (t) => {
  const f = await fixture(t);
  await f.open({ model: "plain::simple" });
  await f.prompt();
  assert.deepEqual(f.calls("session/send").at(-1).modelSelection, { providerId: "plain", modelId: "simple" });
});

test("failed switching reports failure and retains the previous confirmed selection", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM, thinkingOption: "low" });
  f.rejectModel("GLM-5.3-Flash");
  await f.configure({ model: FLASH });
  assert.ok(f.events.some((event) => event.type === "request.failed" && event.requestId === "configure"));
  assert.equal(f.config().model, BINGLM);
  await f.prompt();
  assert.equal(f.calls("session/send").at(-1).modelSelection.modelId, "GLM-5.3");
});

test("failed initialization never reports ready or sends on the default provider", async (t) => {
  const f = await fixture(t);
  f.rejectModel("GLM-5.3");
  await f.open({ model: BINGLM });
  await f.prompt();
  assert.ok(f.events.some((event) => event.type === "request.failed" && event.requestId === "open"));
  assert.ok(!f.events.some((event) => event.type === "session.ready" || event.type === "session.opened"));
  assert.equal(f.calls("session/send").length, 0);
  assert.ok(f.events.some((event) => event.type === "session.prompt_result" && event.result.type === "failed"));
});

test("unknown model IDs and unsupported explicit reasoning fail without fallback", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  const count = f.calls("session/setModel").length;
  await f.configure({ model: "GLM-5.3" });
  await f.configure({ model: BINGLM, thinkingOption: "medium" });
  assert.equal(f.calls("session/setModel").length, count);
  assert.equal(f.events.filter((event) => event.type === "request.failed").length, 2);
  assert.equal(f.config().model, BINGLM);
});

test("prompt waits for an in-flight model change", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  f.beforeSet(() => { started(); return held; });
  const change = f.configure({ model: FLASH, thinkingOption: "low" });
  await entered;
  const prompt = f.prompt();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls("session/send").length, 0);
  release();
  await Promise.all([change, prompt]);
  assert.deepEqual(f.calls("session/send").at(-1).modelSelection, { providerId: "zai-api", modelId: "GLM-5.3-Flash", options: { reasoningLevel: "low" } });
});

test("send errors reach the client prompt result", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  f.rejectSend();
  await f.prompt();
  const result = f.events.find((event) => event.type === "session.prompt_result");
  assert.equal(result.result.type, "failed");
  assert.match(result.result.error.message, /send rejected/);
});

test("Paseo image prompts are sent as ZCode native image attachments", async (t) => {
  const f = await fixture(t);
  assert.ok(f.connection.capabilities.includes("prompt.image"));
  await f.open({ model: BINGLM });
  const imageData = Buffer.from("tiny png fixture").toString("base64");
  await f.prompt("auto", [
    { type: "text", text: "Describe " },
    { type: "image", mimeType: "image/png", data: imageData },
    { type: "text", text: " briefly." },
  ]);
  const send = f.calls("session/send").at(-1);
  assert.equal(send.content, "Describe  briefly.");
  assert.deepEqual(send.attachments, [{
    kind: "image",
    filename: "image-1.png",
    mimeType: "image/png",
    sizeBytes: Buffer.byteLength("tiny png fixture"),
    dataBase64: imageData,
  }]);
});

test("image-only prompts preserve image attachments without requiring text", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  await f.prompt("auto", [{ type: "image", mimeType: "image/jpeg", data: "/9j/2Q==" }]);
  assert.equal(f.calls("session/send").at(-1).content, "");
  assert.equal(f.calls("session/send").at(-1).attachments[0].kind, "image");
});

test("image data URLs override a generic MIME type and malformed images fail clearly", () => {
  assert.deepEqual(prepareZcodePrompt([
    { type: "image", mimeType: "image/*", data: "data:image/webp;base64,aGVsbG8=" },
  ]).attachments, [{
    kind: "image", filename: "image-1.webp", mimeType: "image/webp",
    sizeBytes: 5, dataBase64: "aGVsbG8=",
  }]);
  assert.throws(() => prepareZcodePrompt([{ type: "image", mimeType: "image/png", data: "not base64!" }]), /not valid base64/);
  assert.throws(() => prepareZcodePrompt([{ type: "image", mimeType: "text/plain", data: "aGVsbG8=" }]), /MIME type/);
});

test("an early provider failure emits one timeline error without fabricating a failed turn", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  await f.prompt();
  const sessionId = f.events.find((event) => event.type === "session.persistence").persistence.data.zcodeSessionId;
  f.sessionEvent({ type: "zcode.turn_failed", sessionId, turnId: "turn_early_failure" });
  assert.equal(f.events.filter((event) => event.type === "timeline.item" && event.item.type === "error").length, 1);
  assert.ok(f.events.some((event) => event.type === "session.prompt_result" && event.result.type === "failed"));
  assert.ok(!f.events.some((event) => event.type === "session.turn" && event.state === "failed"));
});

test("a provider failure after turn start closes that turn as failed", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  await f.prompt();
  const sessionId = f.events.find((event) => event.type === "session.persistence").persistence.data.zcodeSessionId;
  f.sessionEvent({ type: "turn.started", sessionId, turnId: "turn_started" });
  f.sessionEvent({ type: "zcode.turn_failed", sessionId, turnId: "turn_started" });
  assert.ok(f.events.some((event) => event.type === "session.turn" && event.turnId === "turn_started" && event.state === "failed"));
});

test("resetting reasoning preserves the model and uses its advertised default", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM, thinkingOption: "low" });
  await f.configure({ thinkingOption: null });
  assert.equal(f.config().model, BINGLM);
  assert.equal(f.config().thinkingOption, "max");
});

test("official state notifications update the UI and reject older revisions", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  f.externalState({ model: { current: { providerId: "zai-api", modelId: "GLM-5.3-Flash", options: { reasoningLevel: "low" } } }, mode: { current: "plan" } }, 8);
  assert.equal(f.config().model, FLASH);
  assert.equal(f.config().thinkingOption, "low");
  assert.equal(f.config().mode, "plan");
  f.notify({ model: { current: defaultSelection }, mode: { current: "build" } }, 7);
  assert.equal(f.config().model, FLASH);
  assert.equal(f.config().mode, "plan");
  await f.prompt();
  assert.equal(f.calls("session/send").at(-1).expectedRevision, 8);
  assert.equal(f.calls("session/send").at(-1).modelSelection.modelId, "GLM-5.3-Flash");
});

test("sending reads authoritative state even if a notification was missed", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  f.externalState({ model: { current: { providerId: "zai-api", modelId: "GLM-5.3-Flash", options: { reasoningLevel: "high" } } } }, 4, false);
  await f.prompt();
  assert.equal(f.config().model, FLASH);
  assert.equal(f.calls("session/send").at(-1).modelSelection.modelId, "GLM-5.3-Flash");
  assert.equal(f.calls("session/send").at(-1).expectedRevision, 4);
});

test("catalog probes use deferred persistence", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  assert.equal(f.calls("session/create")[1].persistence, "deferred");
});

test("archive and unarchive use the desktop task index even for a closed session", async (t) => {
  const f = await fixture(t);
  assert.ok(f.connection.capabilities.includes("session.archive"));
  await f.archive("sess_closed");
  await f.archive("sess_closed", false);
  assert.deepEqual(f.archiveCalls, [{ sessionId: "sess_closed", archived: true }, { sessionId: "sess_closed", archived: false }]);
  assert.equal(f.events.filter((event) => event.type === "request.completed" && event.requestId === "archive").length, 2);
});

test("failed desktop archiving never reports success", async (t) => {
  const f = await fixture(t);
  f.rejectArchive("task is missing");
  await f.archive("sess_missing");
  assert.ok(f.events.some((event) => event.type === "request.failed" && event.requestId === "archive"));
  assert.ok(!f.events.some((event) => event.type === "request.completed" && event.requestId === "archive"));
});

test("archived desktop sessions are excluded from the import picker", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  const id = f.events.find((event) => event.type === "session.persistence").persistence.data.zcodeSessionId;
  await f.archive(id);
  await f.connection.send({ type: "sessions", requestId: "list" });
  const list = f.events.filter((event) => event.type === "sessions").at(-1);
  assert.ok(!list.sessions.some((session) => session.persistence.data.zcodeSessionId === id));
});

test("a mode change that the runtime does not apply reports failure and retains official state", async (t) => {
  const f = await fixture(t, { ignoreModeChange: true });
  await f.open({ model: BINGLM });
  await f.configure({ mode: "plan" });
  assert.equal(f.config().mode, "build");
  const failure = f.events.find((event) => event.type === "request.failed" && event.requestId === "configure");
  assert.match(failure.error.message, /did not apply mode/);
});
