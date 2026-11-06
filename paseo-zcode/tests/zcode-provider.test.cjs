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
const { createZcodeProvider, prepareZcodePrompt, subagentSyncTiming } = require("../server/zcode-provider.ts");
const { PROVIDER_PROTOCOL_VERSION } = require("@getpaseo/plugin/server/provider");

const ACCOUNT = "account:bigmodel-individual-coding-plan";
const BINGLM = "zai-api::GLM-5.3";
const FLASH = "zai-api::GLM-5.3-Flash";
const accountModel = `${ACCOUNT}::GLM-5.3`;

/** Drains the promise chains started by fired mock timers. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};
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
  let beforeSubagents;
  let rejectSend = false;
  const snapshot = (sessionId) => {
    const state = states.get(sessionId);
    return {
      session: {
        sessionId,
        mode: state.runtimeMode ?? state.mode,
        model: state.model,
        status: state.sessionStatus ?? "idle",
        ...(state.sessionKind ? { sessionKind: state.sessionKind } : {}),
        ...(state.target !== undefined ? { target: structuredClone(state.target) } : {}),
      },
      settings: {
        mode: { current: state.mode },
        model: { available, current: state.model },
        thoughtLevel: { current: state.model?.options?.reasoningLevel },
      },
      runtime: {
        stateRevision: state.revision,
        eventSeq: state.eventSeq,
        ...(state.activeTurnKind ? { activeTurnKind: state.activeTurnKind } : {}),
      },
      projection: {
        contextWindow: 500_000,
        mode: state.runtimeMode ?? state.mode,
        ...(state.contextUsed !== undefined ? { contextUsed: state.contextUsed } : {}),
        ...(state.target !== undefined ? { target: structuredClone(state.target) } : {}),
        ...(state.backgroundJobs ? { backgroundJobs: structuredClone(state.backgroundJobs) } : {}),
      },
      ...(state.slashCommands ? { slashCommands: structuredClone(state.slashCommands) } : {}),
      ...(state.todos ? { todos: structuredClone(state.todos) } : {}),
    };
  };
  t.mock.method(protocol.ZcodeProtocolClient.prototype, "request", async (method, params) => {
    requests.push({ method, params: structuredClone(params) });
    if (method === "session/create" || method === "session/resume") {
      const id = params.sessionId ?? `sess_mock_${++nextSession}`;
      // Pre-seeded fields (subagent listings, child transcripts) survive resume.
      states.set(id, {
        ...states.get(id),
        mode: options.initialMode ?? "build",
        runtimeMode: "build",
        revision: 0,
        eventSeq: 0,
        subscribed: false,
        model: structuredClone(method === "session/resume" ? options.resumeSelection ?? defaultSelection : defaultSelection),
        ...(options.initialTodos ? { todos: structuredClone(options.initialTodos) } : {}),
        ...(options.initialBackgroundJobs ? { backgroundJobs: structuredClone(options.initialBackgroundJobs) } : {}),
        ...(options.slashCommands ? { slashCommands: structuredClone(options.slashCommands) } : {}),
        ...(options.initialTarget !== undefined ? { target: structuredClone(options.initialTarget) } : {}),
        ...(options.initialContextUsed !== undefined ? { contextUsed: options.initialContextUsed } : {}),
        goalActions: [],
        forkTargets: [],
        cancelledTasks: [],
        compactionRequests: 0,
      });
      return { result: snapshot(id) };
    }
    if (method === "session/read") return { result: {
      ...snapshot(params.sessionId),
      messages: structuredClone(states.get(params.sessionId)?.messages ?? options.historyMessages ?? []),
    } };
    if (method === "session/subagents") {
      if (beforeSubagents) await beforeSubagents();
      const listing = states.get(params.sessionId)?.subagents;
      return { result: structuredClone(listing ?? { childSessionIds: [], running: [], ended: { total: 0, items: [] } }) };
    }
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
        const baseMode = params.mode === "plan" ? options.planBaseMode ?? "build" : params.mode;
        state.mode = baseMode;
        state.runtimeMode = baseMode;
        state.planEnabled = params.mode === "plan";
        state.eventSeq++;
        const payload = { mode: state.mode, planEnabled: state.planEnabled };
        const seq = state.eventSeq;
        const notifyMode = () => eventListener({
          type: "session.updated", sessionId: params.sessionId, seq,
          payload,
        });
        if (state.subscribed) {
          if (options.deferModeEvent) setImmediate(notifyMode);
          else notifyMode();
        }
      }
      state.revision++;
      return { result: snapshot(params.sessionId) };
    }
    if (method === "session/subscribe") states.get(params.sessionId).subscribed = true;
    if (method === "session/send" && rejectSend) return { error: { code: -1, message: "send rejected" } };
    if (method === "session/compact") {
      const state = states.get(params.sessionId);
      state.compactionRequests++;
      state.activeTurnKind = "compact";
      state.revision++;
      return { result: { snapshot: snapshot(params.sessionId), compact: { state: "accepted" } } };
    }
    if (method === "session/goal") {
      const state = states.get(params.sessionId);
      state.goalActions.push({ action: params.action, objective: params.objective });
      if (params.action === "clear") state.target = null;
      else if (params.action === "pause" && state.target) state.target = { ...state.target, status: "paused" };
      else if (params.action === "resume" && state.target) state.target = { ...state.target, status: "active" };
      else if (params.action !== "show") {
        state.target = {
          targetID: "goal-1",
          objective: params.objective ?? state.target?.objective ?? "Goal",
          status: "active",
          tokensUsed: 0,
          tokenBudget: null,
          timeUsedSeconds: 0,
        };
      }
      state.revision++;
      return {
        result: {
          response: params.action === "show" ? "Goal active" : "Goal " + params.action,
          snapshot: snapshot(params.sessionId),
          startedTurn: false,
        },
      };
    }
    if (method === "session/fork") {
      const state = states.get(params.sessionId);
      state.forkTargets.push(structuredClone(params.target));
      if (!states.has("forked-session")) {
        states.set("forked-session", {
          sessionKind: "fork",
          mode: "build",
          runtimeMode: "build",
          model: structuredClone(defaultSelection),
          revision: 0,
          eventSeq: 0,
        });
      }
      return {
        result: {
          forkedSessionId: "forked-session",
          parentSessionId: params.sessionId,
          targetMessageId: "message-1",
          response: "",
          // Real ZCode returns the forked session's snapshot here.
          snapshot: snapshot("forked-session"),
        },
      };
    }
    if (method === "session/cancelBackgroundTask") {
      const state = states.get(params.sessionId);
      state.cancelledTasks.push(params.taskId);
      const job = state.backgroundJobs?.find((entry) => entry.taskId === params.taskId);
      if (job) job.status = "cancelled";
      return { result: {} };
    }
    if (method === "session/usage") {
      return { result: {
        sessionId: params.sessionId,
        totalTokens: 1234,
        inputTokens: 1000,
        outputTokens: 234,
        reasoningTokens: 10,
        cacheReadTokens: 50,
        cacheCreationTokens: 0,
        modelRequestCount: 3,
        modelErrorCount: 0,
      } };
    }
    return { result: {} };
  });
  const connection = await createZcodeProvider().connect({ versions: [PROVIDER_PROTOCOL_VERSION], capabilities: ["prompt.message", "prompt.command", "prompt.image", "session.configure", "session.persistence", "session.archive", "session.unarchive", ...(options.subsessions === false ? [] : ["session.subsession"])] });
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
  const command = (name, args = "", clientMessageId = "command-message") => connection.send({
    type: "session.prompt", sessionId: "paseo-session",
    prompt: { clientMessageId, delivery: "auto", input: { type: "command", name, arguments: args } },
  });
  return {
    events, open, configure, prompt, command, connection, archiveCalls,
    session: (sessionId, patch) => {
      let state = states.get(sessionId);
      if (!state) { state = {}; states.set(sessionId, state); }
      Object.assign(state, structuredClone(patch));
    },
    setSubagents: (sessionId, listing) => {
      let state = states.get(sessionId);
      if (!state) { state = {}; states.set(sessionId, state); }
      state.subagents = structuredClone(listing);
    },
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
    notify: (patch, revision, reason) => stateListener({ sessionId: fSessionId(), scope: "session", revision, patch, ...(reason ? { reason } : {}) }),
    sessionEvent: (event) => eventListener({ seq: 1, timestamp: Date.now(), payload: {}, ...event }),
    serverRequest: (id, params, method = "interaction/requestPermission") => serverRequestListener({ id, method, params }),
    serverReplies,
    setTodos: (todos) => { states.get(fSessionId()).todos = structuredClone(todos); },
    calls: (method) => requests.filter((request) => request.method === method).map((request) => request.params),
    config: () => events.filter((event) => event.type === "session.config").at(-1)?.config,
    rejectModel: (id) => { rejectModel = id; },
    beforeSet: (fn) => { beforeSet = fn; },
    beforeSubagents: (fn) => { beforeSubagents = fn; },
    rejectSend: () => { rejectSend = true; },
    commandList: () => events.filter((event) => event.type === "session.commands").at(-1)?.commands,
    goalItems: () => events.filter((event) => event.type === "timeline.item" && event.item.type === "tool_call" && event.item.id.endsWith(":goal")),
    compactionItems: () => events.filter((event) => event.type === "timeline.item" && event.item.type === "compaction"),
    notifications: () => events.filter((event) => event.type === "timeline.item" && event.item.type === "notification"),
    state: (id = fSessionId()) => states.get(id),
    listSessions: () => connection.send({ type: "sessions", requestId: "sessions" }),
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
  // Paseo's plan card renders the body from metadata.planText.
  assert.deepEqual(card.request.metadata, { planText: plan });
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

test("resuming a plan session accepts the underlying permission mode from the setMode snapshot", async (t) => {
  const f = await fixture(t, { initialMode: "yolo", planBaseMode: "yolo", deferModeEvent: true });
  await f.open({ mode: "plan" }, { version: 1, data: { zcodeSessionId: "sess_plan" } });
  assert.equal(f.calls("session/setMode").at(-1).mode, "plan");
  assert.equal(f.config().mode, "plan");
  assert.ok(f.events.some((event) => event.type === "session.ready"));
  assert.ok(!f.events.some((event) => event.type === "request.failed"));
  await flush();
  assert.equal(f.config().mode, "plan");
  await f.prompt();
  assert.equal(f.calls("session/send").length, 1);
  assert.equal(f.config().mode, "plan");
  await f.configure({ mode: "yolo" });
  assert.equal(f.config().mode, "yolo");
  assert.ok(!f.events.some((event) => event.type === "request.failed"));
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

test("tool.updated scheduled supplies arguments that streaming never delivered", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  const sessionId = f.events.find((event) => event.type === "session.persistence").persistence.data.zcodeSessionId;
  const items = () => f.events.filter((event) => event.type === "timeline.item" && event.item.id === "scheduled-shell");

  f.sessionEvent({
    type: "tool.updated", sessionId, turnId: "turn-scheduled",
    payload: { kind: "scheduled", toolCallId: "scheduled-shell", toolName: "Bash", input: { command: "echo hi" } },
  });
  let item = items().at(-1).item;
  assert.equal(item.status, "running");
  assert.deepEqual(item.detail, { type: "shell", command: "echo hi" });

  // The started event repeats the name but carries no arguments; the row
  // must keep the scheduled input and not emit an empty replacement.
  f.sessionEvent({
    type: "tool.updated", sessionId, turnId: "turn-scheduled",
    payload: { kind: "started", toolCallId: "scheduled-shell", toolName: "Bash" },
  });
  assert.equal(items().length, 1);

  f.sessionEvent({
    type: "tool.updated", sessionId, turnId: "turn-scheduled",
    payload: { kind: "result", toolCallId: "scheduled-shell", result: { success: true, content: "hi" } },
  });
  item = items().at(-1).item;
  assert.equal(item.status, "completed");
  assert.deepEqual(item.detail, { type: "shell", command: "echo hi", output: "hi" });
});

test("a started tool row is enriched when its scheduled arguments arrive later", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  const sessionId = f.events.find((event) => event.type === "session.persistence").persistence.data.zcodeSessionId;
  const items = () => f.events.filter((event) => event.type === "timeline.item" && event.item.id === "late-read");

  f.sessionEvent({
    type: "tool.updated", sessionId, turnId: "turn-late",
    payload: { kind: "started", toolCallId: "late-read", toolName: "Read" },
  });
  assert.deepEqual(items().at(-1).item.detail, { type: "plain_text", label: "Read" });

  f.sessionEvent({
    type: "tool.updated", sessionId, turnId: "turn-late",
    payload: { kind: "scheduled", toolCallId: "late-read", toolName: "Read", input: { file_path: "/workspace/README.md" } },
  });
  assert.deepEqual(items().at(-1).item.detail, { type: "read", filePath: "/workspace/README.md" });

  f.sessionEvent({
    type: "tool.updated", sessionId, turnId: "turn-late",
    payload: { kind: "result", toolCallId: "late-read", result: { success: true, content: "# README" } },
  });
  assert.deepEqual(items().at(-1).item.detail, {
    type: "read", filePath: "/workspace/README.md", content: "# README",
  });
});

test("replayed tool parts recover arguments persisted only in state.raw", async (t) => {
  const f = await fixture(t, {
    historyMessages: [
      {
        info: { role: "assistant", messageId: "assistant-raw", semantics: { transcriptVisibility: "visible" } },
        parts: [
          {
            type: "tool", partId: "tool-raw", callId: "tool-raw", tool: "Bash",
            state: {
              status: "completed",
              raw: JSON.stringify({ tool: "Bash", input: { command: "pwd" } }),
              output: "/workspace",
            },
          },
        ],
      },
    ],
  });

  await f.open({}, { version: 1, data: { zcodeSessionId: "sess_raw" } }, "replay");
  const item = f.events.find((event) => event.type === "timeline.item" && event.item.id === "tool-raw").item;
  assert.deepEqual(item.detail, { type: "shell", command: "pwd", output: "/workspace" });
});

test("a replayed tool without any recoverable input falls back to a named row", async (t) => {
  const f = await fixture(t, {
    historyMessages: [
      {
        info: { role: "assistant", messageId: "assistant-noinput", semantics: { transcriptVisibility: "visible" } },
        parts: [
          {
            type: "tool", partId: "tool-noinput", callId: "tool-noinput", tool: "Read",
            state: { status: "completed", output: "file contents" },
          },
        ],
      },
    ],
  });

  await f.open({}, { version: 1, data: { zcodeSessionId: "sess_noinput" } }, "replay");
  const item = f.events.find((event) => event.type === "timeline.item" && event.item.id === "tool-noinput").item;
  assert.deepEqual(item.detail, { type: "plain_text", label: "Read" });
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

test("pausing (turn.completed resultType cancelled) reports a canceled turn, not a failure", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  await f.prompt();
  const sessionId = f.events.find((event) => event.type === "session.persistence").persistence.data.zcodeSessionId;
  f.sessionEvent({ type: "turn.started", sessionId, turnId: "turn_paused" });
  f.sessionEvent({
    type: "turn.completed", sessionId, turnId: "turn_paused",
    payload: { response: "", resultType: "cancelled", tokenCount: 0, toolCallCount: 0 },
  });
  const turnEnd = f.events.find((event) => event.type === "session.turn" && event.turnId === "turn_paused" && event.state !== "started");
  assert.equal(turnEnd.state, "canceled");
  assert.equal(turnEnd.error, undefined);
  assert.ok(!f.events.some((event) => event.type === "session.turn" && event.state === "failed"));
  assert.ok(!f.events.some((event) => event.type === "timeline.item" && event.item.type === "error"));
  assert.ok(!f.events.some((event) => event.type === "session.prompt_result" && event.result.type === "failed"));
});

test("execution error result types still close the turn as failed", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  await f.prompt();
  const sessionId = f.events.find((event) => event.type === "session.persistence").persistence.data.zcodeSessionId;
  f.sessionEvent({ type: "turn.started", sessionId, turnId: "turn_errored" });
  f.sessionEvent({
    type: "turn.completed", sessionId, turnId: "turn_errored",
    payload: { response: "", resultType: "error_max_turns", tokenCount: 0, toolCallCount: 0 },
  });
  const turnEnd = f.events.find((event) => event.type === "session.turn" && event.turnId === "turn_errored" && event.state !== "started");
  assert.equal(turnEnd.state, "failed");
  assert.equal(turnEnd.error.message, "error_max_turns");
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
  await f.configure({ mode: "guarded" });
  assert.equal(f.config().mode, "build");
  const failure = f.events.find((event) => event.type === "request.failed" && event.requestId === "configure");
  assert.match(failure.error.message, /did not apply mode/);
});

test("running ZCode subagents attach as nested Paseo subsessions and poll until done", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  const sessionId = f.events.find((event) => event.type === "session.persistence").persistence.data.zcodeSessionId;
  f.setSubagents(sessionId, {
    revision: 1,
    childSessionIds: ["sess_subagent_a"],
    running: [{
      childSessionId: "sess_subagent_a", agentId: "agent_a", toolCallId: "agent-call-1",
      subagentType: "Explore", title: "探索结构", status: "running",
    }],
    ended: { total: 0, items: [] },
  });
  f.session("sess_subagent_a", {
    sessionStatus: "running",
    messages: [
      { info: { role: "user", messageId: "cu-1", semantics: { transcriptVisibility: "visible" } }, parts: [{ type: "text", partId: "cu-1", text: "调研任务" }] },
    ],
  });

  f.sessionEvent({
    type: "model.streaming", sessionId, turnId: "turn-agent",
    payload: { kind: "tool_call", toolCallId: "agent-call-1", toolName: "Agent", input: { description: "探索结构", subagent_type: "Explore" } },
  });
  t.mock.timers.tick(subagentSyncTiming.spawnMs); await flush();

  const opened = f.events.find((event) => event.type === "session.opened" && event.sessionId === "sess_subagent_a");
  assert.ok(opened, "child subsession must be opened");
  assert.equal(opened.parentSessionId, "paseo-session");
  assert.equal(opened.toolCallId, "agent-call-1");
  assert.equal(opened.restoration, "parent");
  assert.equal(opened.title, "探索结构");
  const card = f.events.filter((event) => event.type === "timeline.item" && event.item.id === "agent-call-1").at(-1).item;
  assert.equal(card.status, "running");
  assert.equal(card.detail.type, "sub_agent");
  assert.equal(card.detail.childSessionId, "sess_subagent_a");
  assert.equal(card.detail.subAgentType, "Explore");
  assert.equal(card.detail.description, "探索结构");
  const childItems = () => f.events.filter((event) => event.type === "timeline.item" && event.sessionId === "sess_subagent_a");
  assert.deepEqual(childItems().map((event) => event.item.id), ["cu-1"]);

  // Polling streams new child rows as they appear in the transcript.
  f.session("sess_subagent_a", { messages: [
    { info: { role: "user", messageId: "cu-1", semantics: { transcriptVisibility: "visible" } }, parts: [{ type: "text", partId: "cu-1", text: "调研任务" }] },
    { info: { role: "assistant", messageId: "ca-1", semantics: { transcriptVisibility: "visible" } }, parts: [{ type: "text", partId: "ca-1", text: "调研结论" }] },
  ] });
  t.mock.timers.tick(subagentSyncTiming.subagentPollMs); await flush();
  assert.deepEqual(childItems().map((event) => event.item.id), ["cu-1", "ca-1:text:0"]);

  // When the child leaves the active status set the turn is settled and polling stops;
  // one final backfill re-read catches rows persisted after the status flipped.
  f.session("sess_subagent_a", { sessionStatus: "idle" });
  t.mock.timers.tick(subagentSyncTiming.subagentPollMs); await flush();
  const childTurn = f.events.find((event) => event.type === "session.turn" && event.sessionId === "sess_subagent_a");
  assert.equal(childTurn.state, "completed");
  const readsAfterDone = f.calls("session/read").filter((call) => call.sessionId === "sess_subagent_a").length;
  t.mock.timers.tick(subagentSyncTiming.backfillMs); await flush();
  assert.equal(f.calls("session/read").filter((call) => call.sessionId === "sess_subagent_a").length, readsAfterDone + 1);
  t.mock.timers.tick(subagentSyncTiming.backfillMs * 4); await flush();
  assert.equal(f.calls("session/read").filter((call) => call.sessionId === "sess_subagent_a").length, readsAfterDone + 1);
});

test("a finished Agent tool call replays the ended subagent with its outcome", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  const sessionId = f.events.find((event) => event.type === "session.persistence").persistence.data.zcodeSessionId;

  f.sessionEvent({
    type: "model.streaming", sessionId, turnId: "turn-agent-2",
    payload: { kind: "tool_call", toolCallId: "agent-call-2", toolName: "Agent", input: { description: "读文档", subagent_type: "Explore" } },
  });
  f.setSubagents(sessionId, {
    childSessionIds: ["sess_subagent_b"],
    running: [],
    ended: {
      total: 1,
      items: [{ childSessionId: "sess_subagent_b", toolCallId: "agent-call-2", subagentType: "Explore", title: "读文档", status: "success", summary: "调研完成" }],
    },
  });
  f.session("sess_subagent_b", { messages: [
    { info: { role: "assistant", messageId: "cb-1", semantics: { transcriptVisibility: "visible" } }, parts: [{ type: "text", partId: "cb-1", text: "调研结论" }] },
  ] });
  f.sessionEvent({
    type: "tool.updated", sessionId, turnId: "turn-agent-2",
    payload: { kind: "result", toolCallId: "agent-call-2", result: { success: true, content: "调研完成汇报" } },
  });
  t.mock.timers.tick(0); await flush();

  assert.ok(!f.calls("session/subscribe").some((call) => call.sessionId === "sess_subagent_b"), "ended children are not followed live");
  const opened = f.events.find((event) => event.type === "session.opened" && event.sessionId === "sess_subagent_b");
  assert.equal(opened.parentSessionId, "paseo-session");
  assert.equal(opened.toolCallId, "agent-call-2");
  const childItems = f.events.filter((event) => event.type === "timeline.item" && event.sessionId === "sess_subagent_b");
  assert.deepEqual(childItems.map((event) => event.item.id), ["cb-1:text:0"]);
  const childTurn = f.events.find((event) => event.type === "session.turn" && event.sessionId === "sess_subagent_b");
  assert.equal(childTurn.state, "completed");
  const card = f.events.filter((event) => event.type === "timeline.item" && event.item.id === "agent-call-2").at(-1).item;
  assert.equal(card.status, "completed");
  assert.equal(card.detail.childSessionId, "sess_subagent_b");
  assert.equal(card.detail.log, "调研完成汇报");
});

test("subagent subsessions close with their parent session", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  const sessionId = f.events.find((event) => event.type === "session.persistence").persistence.data.zcodeSessionId;
  f.setSubagents(sessionId, {
    childSessionIds: ["sess_subagent_e"],
    running: [{ childSessionId: "sess_subagent_e", toolCallId: "agent-call-5", subagentType: "Explore" }],
    ended: { total: 0, items: [] },
  });
  f.sessionEvent({
    type: "model.streaming", sessionId, turnId: "turn-agent-5",
    payload: { kind: "tool_call", toolCallId: "agent-call-5", toolName: "Agent", input: {} },
  });
  t.mock.timers.tick(subagentSyncTiming.spawnMs); await flush();
  assert.ok(f.events.some((event) => event.type === "session.opened" && event.sessionId === "sess_subagent_e"));

  await f.connection.send({ type: "session.close", requestId: "close", sessionId: "paseo-session" });
  assert.ok(f.events.some((event) => event.type === "session.closed" && event.sessionId === "sess_subagent_e"));
  assert.ok(f.events.some((event) => event.type === "session.closed" && event.sessionId === "paseo-session"));
});

test("subagent subsessions wait for the parent open handshake", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t);
  const parentSessionId = "sess_resume_parent";
  f.setSubagents(parentSessionId, {
    revision: 1,
    childSessionIds: ["sess_subagent_deferred"],
    running: [{
      childSessionId: "sess_subagent_deferred", toolCallId: "agent-call-deferred",
      subagentType: "Explore", title: "延迟挂载", status: "running",
    }],
    ended: { total: 0, items: [] },
  });
  f.session(parentSessionId, { sessionStatus: "running" });
  f.session("sess_subagent_deferred", { sessionStatus: "running", messages: [] });

  let releaseSetModel;
  f.beforeSet(() => new Promise((resolve) => { releaseSetModel = resolve; }));
  const opening = f.open({}, { version: 1, data: { zcodeSessionId: parentSessionId } }, "replay");
  await flush();
  assert.ok(releaseSetModel, "the open handshake reaches model selection");

  // The app-server replays subagent background jobs while the handshake is
  // still waiting on model selection, i.e. before session.opened is emitted.
  f.sessionEvent({
    type: "session.updated", sessionId: parentSessionId,
    payload: { backgroundJobs: [{ taskId: "task-deferred", taskKind: "subagent", status: "running" }] },
  });
  t.mock.timers.tick(0); await flush();
  assert.ok(
    !f.events.some((event) => event.type === "session.opened" && event.sessionId === "sess_subagent_deferred"),
    "a subsession must not open before the parent session.opened",
  );

  releaseSetModel();
  await opening; await flush();
  t.mock.timers.tick(0); await flush();
  const parentIndex = f.events.findIndex((event) => event.type === "session.opened" && event.sessionId === "paseo-session");
  const childIndex = f.events.findIndex((event) => event.type === "session.opened" && event.sessionId === "sess_subagent_deferred");
  assert.ok(parentIndex >= 0, "the parent session must open");
  assert.ok(childIndex > parentIndex, "the child opens only after the parent");
});

test("in-flight subagent adoption stops when the parent session closes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  const sessionId = f.events.find((event) => event.type === "session.persistence").persistence.data.zcodeSessionId;
  f.setSubagents(sessionId, {
    childSessionIds: ["sess_subagent_late"],
    running: [{ childSessionId: "sess_subagent_late", toolCallId: "agent-call-late", subagentType: "Explore" }],
    ended: { total: 0, items: [] },
  });
  f.session("sess_subagent_late", { sessionStatus: "running", messages: [] });
  let releaseListing;
  f.beforeSubagents(() => new Promise((resolve) => { releaseListing = resolve; }));
  f.sessionEvent({
    type: "model.streaming", sessionId, turnId: "turn-late",
    payload: { kind: "tool_call", toolCallId: "agent-call-late", toolName: "Agent", input: {} },
  });
  t.mock.timers.tick(subagentSyncTiming.spawnMs); await flush();
  assert.ok(releaseListing, "the reconciliation pass is waiting on the listing");

  await f.connection.send({ type: "session.close", requestId: "close", sessionId: "paseo-session" });
  releaseListing(); await flush();
  t.mock.timers.tick(subagentSyncTiming.spawnFollowUpMs); await flush();
  assert.ok(!f.events.some((event) => event.type === "session.opened" && event.sessionId === "sess_subagent_late"));
});

test("without session.subsession, subagents stay on the legacy background card", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t, { subsessions: false });
  await f.open({ model: BINGLM });
  const sessionId = f.events.find((event) => event.type === "session.persistence").persistence.data.zcodeSessionId;

  f.sessionEvent({ type: "session.updated", sessionId, payload: { taskId: "bg-sub-1", taskKind: "subagent", status: "running" } });
  t.mock.timers.tick(0); await flush();
  assert.ok(f.events.some((event) => event.type === "timeline.item" && event.item.id === "zcode:background:bg-sub-1"));

  f.setSubagents(sessionId, {
    childSessionIds: ["sess_subagent_c"],
    running: [{ childSessionId: "sess_subagent_c", toolCallId: "agent-call-3", subagentType: "Explore" }],
    ended: { total: 0, items: [] },
  });
  f.sessionEvent({ type: "turn.completed", sessionId, turnId: "turn-x", payload: { resultType: "success" } });
  t.mock.timers.tick(subagentSyncTiming.settledMs); await flush();
  assert.equal(f.calls("session/subagents").length, 0);
  assert.ok(!f.events.some((event) => event.type === "session.opened" && event.sessionId === "sess_subagent_c"));
});

test("with session.subsession, subagent background tasks render as subsessions instead of shell cards", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  const sessionId = f.events.find((event) => event.type === "session.persistence").persistence.data.zcodeSessionId;
  f.sessionEvent({ type: "session.updated", sessionId, payload: { taskId: "bg-sub-2", taskKind: "subagent", status: "running" } });
  t.mock.timers.tick(0); await flush();
  assert.ok(!f.events.some((event) => event.type === "timeline.item" && event.item.id === "zcode:background:bg-sub-2"));
  // bash background tasks keep their shell card
  f.sessionEvent({ type: "session.updated", sessionId, payload: { taskId: "bg-bash-1", taskKind: "bash", command: "npm test", status: "running" } });
  t.mock.timers.tick(0); await flush();
  assert.ok(f.events.some((event) => event.type === "timeline.item" && event.item.id === "zcode:background:bg-bash-1"));
});

test("history replay links Agent cards to subagent subsessions", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t, {
    historyMessages: [
      {
        info: { role: "assistant", messageId: "ha-1", semantics: { transcriptVisibility: "visible" } },
        parts: [{
          type: "tool", partId: "hp-1", callId: "agent-call-4", tool: "Agent",
          state: { status: "completed", input: { description: "历史调研", subagent_type: "Explore" }, output: "历史结论" },
        }],
      },
    ],
  });
  f.setSubagents("sess_history", {
    childSessionIds: ["sess_subagent_d"],
    running: [],
    ended: {
      total: 1,
      items: [{ childSessionId: "sess_subagent_d", toolCallId: "agent-call-4", subagentType: "Explore", title: "历史调研", status: "success" }],
    },
  });
  f.session("sess_subagent_d", { messages: [
    { info: { role: "assistant", messageId: "cd-1", semantics: { transcriptVisibility: "visible" } }, parts: [{ type: "text", partId: "cd-1", text: "子会话结论" }] },
  ] });

  await f.open({}, { version: 1, data: { zcodeSessionId: "sess_history" } }, "replay");
  t.mock.timers.tick(0); await flush();

  const parentCard = f.events.find((event) => event.type === "timeline.item" && event.item.id === "agent-call-4").item;
  assert.equal(parentCard.detail.childSessionId, "sess_subagent_d");
  assert.equal(parentCard.detail.log, "历史结论");
  const cardIndex = f.events.findIndex((event) => event.type === "timeline.item" && event.item.id === "agent-call-4");
  const openedIndex = f.events.findIndex((event) => event.type === "session.opened" && event.sessionId === "sess_subagent_d");
  assert.ok(openedIndex > cardIndex, "child subsession opens after the parent timeline rows");
  assert.ok(f.events.some((event) => event.type === "timeline.item" && event.sessionId === "sess_subagent_d" && event.item.text === "子会话结论"));
  const childTurn = f.events.find((event) => event.type === "session.turn" && event.sessionId === "sess_subagent_d");
  assert.equal(childTurn.state, "completed");
});

test("generic AskUserQuestion requests use Paseo's native question form", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  const sessionId = f.events.find((event) => event.type === "session.persistence").persistence.data.zcodeSessionId;

  f.serverRequest("server-question-1", {
    sessionId,
    requestId: "ask-1",
    toolName: "AskUserQuestion",
    questions: [{
      header: "Confirm",
      question: "Proceed with the migration?",
      options: [{ label: "Yes", description: "Run it" }, { label: "No" }],
    }],
  }, "interaction/requestUserInput");

  const card = f.events.find((event) => event.type === "session.permission");
  assert.equal(card.request.kind, "question");
  assert.equal(card.request.name, "AskUserQuestion");
  assert.deepEqual(card.request.input, {
    questions: [{
      header: "Confirm",
      question: "Proceed with the migration?",
      options: [{ label: "Yes", description: "Run it" }, { label: "No" }],
      multiSelect: false,
      allowOther: true,
      allowEmpty: false,
    }],
  });
  assert.deepEqual(card.request.actions, []);
  assert.deepEqual(f.serverReplies, []);

  await f.connection.send({
    type: "session.permission",
    sessionId: "paseo-session",
    permissionId: "server-question-1",
    response: { behavior: "allow", updatedInput: { answers: { Confirm: "Yes" } } },
  });
  assert.deepEqual(f.serverReplies, [{
    id: "server-question-1",
    result: { action: "accept", content: { answers: { "Proceed with the migration?": "Yes" } } },
  }]);
});

test("declining a generic question resolves as declined", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  const sessionId = f.events.find((event) => event.type === "session.persistence").persistence.data.zcodeSessionId;
  f.serverRequest("server-question-2", {
    sessionId,
    requestId: "ask-2",
    toolName: "AskUserQuestion",
    questions: [{ header: "Confirm", question: "Proceed?", options: [{ label: "Yes" }] }],
  }, "interaction/requestUserInput");

  await f.connection.send({
    type: "session.permission",
    sessionId: "paseo-session",
    permissionId: "server-question-2",
    response: { behavior: "deny" },
  });
  assert.deepEqual(f.serverReplies, [{ id: "server-question-2", result: { action: "decline" } }]);
});

test("the command catalog exposes ZCode commands Paseo can execute", async (t) => {
  const f = await fixture(t, {
    slashCommands: [
      { name: "compact", description: "Compact the conversation", inputHint: "[instructions]", source: "builtin" },
      { name: "goal", description: "Show or set the goal", inputHint: "[objective]", source: "builtin" },
      { name: "fork", description: "Fork from a checkpoint", inputHint: "[latest|id]", source: "builtin" },
      { name: "help", description: "Show help", source: "builtin" },
      { name: "review", description: "Review the diff", source: "custom" },
    ],
  });
  await f.open({ model: BINGLM });
  assert.deepEqual(
    f.commandList().map((command) => command.name),
    ["compact", "goal", "fork", "review", "tasks", "stop-task", "usage"],
    "supported builtins and custom commands stay; UI-only builtins are filtered",
  );
  assert.equal(f.commandList().find((command) => command.name === "compact").argumentHint, "[instructions]");
});

test("slash commands execute through ZCode and settle Paseo prompts", async (t) => {
  const f = await fixture(t, {
    initialBackgroundJobs: [{ taskId: "task-1", status: "running", toolName: "Bash", command: "npm test" }],
  });
  await f.open({ model: BINGLM });
  const zcodeSessionId = f.events.find((event) => event.type === "session.persistence").persistence.data.zcodeSessionId;

  await f.command("compact", "focus on tests");
  assert.equal(f.calls("session/compact").at(-1).sessionId, zcodeSessionId);
  assert.equal(f.calls("session/compact").at(-1).instructions, "focus on tests");
  assert.equal(f.compactionItems().at(-1).item.trigger, "manual");
  assert.equal(f.compactionItems().at(-1).item.status, "loading");
  assert.ok(f.events.some((event) => event.type === "session.prompt_result" && event.clientMessageId === "command-message" && event.result.type === "completed"));

  await f.command("goal", "Ship the migration");
  const goalCall = f.calls("session/goal").at(-1);
  assert.equal(goalCall.sessionId, zcodeSessionId);
  assert.equal(goalCall.action, "set");
  assert.equal(goalCall.objective, "Ship the migration");
  const goal = f.goalItems().at(-1).item;
  assert.equal(goal.status, "running");
  assert.match(goal.detail.text, /Ship the migration/);

  await f.command("tasks");
  assert.match(f.notifications().at(-1).item.message, /task-1/);
  await f.command("stop-task", "task-1");
  assert.deepEqual(f.calls("session/cancelBackgroundTask").at(-1), {
    sessionId: zcodeSessionId,
    taskId: "task-1",
  });
  assert.match(f.notifications().at(-1).item.message, /task-1/);

  await f.command("usage");
  assert.match(f.notifications().at(-1).item.message, /total: 1234/);
  await f.command("fork", "latest");
  assert.deepEqual(f.calls("session/fork").at(-1).target, { kind: "latestCheckpoint" });
  assert.match(f.notifications().at(-1).item.message, /forked-session/);

  await f.command("review", "src/app.ts");
  assert.equal(f.calls("session/send").at(-1).content, "/review src/app.ts");
});

test("goal state and context usage surface on open and update", async (t) => {
  const f = await fixture(t, {
    initialTarget: {
      targetID: "goal-1",
      objective: "Ship the migration",
      status: "active",
      tokensUsed: 10,
      tokenBudget: 100,
      timeUsedSeconds: 5,
    },
    initialContextUsed: 1234,
  });
  await f.open({ model: BINGLM });
  const goal = f.goalItems().at(-1).item;
  assert.equal(goal.status, "running");
  assert.equal(goal.detail.label, "Goal · active");
  assert.match(goal.detail.text, /Tokens: 10 \/ 100/);
  const usage = f.events.filter((event) => event.type === "session.usage").at(-1);
  assert.equal(usage.usage.contextWindowUsedTokens, 1234);
  assert.equal(usage.usage.contextWindowMaxTokens, 500_000);

  await f.command("goal", "pause");
  assert.equal(f.goalItems().at(-1).item.detail.label, "Goal · paused");
  await f.command("goal", "clear");
  assert.equal(f.goalItems().at(-1).item.status, "completed");
  assert.match(f.goalItems().at(-1).item.detail.text, /目标已清除/);
});

test("turn.completed reports decode speed from model stream timing", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  await f.prompt();
  const sessionId = f.events.find((event) => event.type === "session.persistence").persistence.data.zcodeSessionId;

  f.sessionEvent({ type: "turn.started", sessionId, turnId: "turn-speed", timestamp: 900 });
  f.sessionEvent({
    type: "model.streaming", sessionId, turnId: "turn-speed", timestamp: 1_000,
    payload: { kind: "start", assistantMessageId: "assistant-1" },
  });
  f.sessionEvent({
    type: "model.streaming", sessionId, turnId: "turn-speed", timestamp: 1_100,
    payload: { kind: "reasoning_start", assistantMessageId: "assistant-1" },
  });
  f.sessionEvent({
    type: "model.streaming", sessionId, turnId: "turn-speed", timestamp: 1_200,
    payload: { kind: "reasoning_delta", assistantMessageId: "assistant-1", delta: "thinking" },
  });
  f.sessionEvent({
    type: "model.streaming", sessionId, turnId: "turn-speed", timestamp: 2_100,
    payload: { kind: "finish", assistantMessageId: "assistant-1" },
  });
  f.sessionEvent({
    type: "turn.completed", sessionId, turnId: "turn-speed", timestamp: 2_200,
    payload: {
      response: "done",
      resultType: "success",
      usage: { inputTokens: 1200, outputTokens: 100, cacheReadTokens: 45000, cacheWriteTokens: 0 },
    },
  });

  const notice = f.notifications().find((event) => event.item.id.includes(":usage:"));
  assert.ok(notice, "a usage notice was emitted");
  assert.match(notice.item.message, /Token 用量：输入 1\.2k · 缓存读 45k · 输出 100 · 速度 100 tok\/s/);
  assert.equal(f.events.filter((event) => event.type === "session.usage").at(-1).usage.outputTokens, 100);
});

test("decode speed aggregates every model request and skips tool-only requests", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  await f.prompt();
  const sessionId = f.events.find((event) => event.type === "session.persistence").persistence.data.zcodeSessionId;

  // Two content requests: 500ms + 1000ms of decode time.
  f.sessionEvent({ type: "model.streaming", sessionId, turnId: "turn-multi", timestamp: 1_000, payload: { kind: "start" } });
  f.sessionEvent({ type: "model.streaming", sessionId, turnId: "turn-multi", timestamp: 1_100, payload: { kind: "text_start" } });
  f.sessionEvent({ type: "model.streaming", sessionId, turnId: "turn-multi", timestamp: 1_600, payload: { kind: "finish" } });
  f.sessionEvent({ type: "model.streaming", sessionId, turnId: "turn-multi", timestamp: 1_700, payload: { kind: "start" } });
  f.sessionEvent({ type: "model.streaming", sessionId, turnId: "turn-multi", timestamp: 1_800, payload: { kind: "reasoning_start" } });
  f.sessionEvent({ type: "model.streaming", sessionId, turnId: "turn-multi", timestamp: 2_800, payload: { kind: "finish" } });
  f.sessionEvent({
    type: "turn.completed", sessionId, turnId: "turn-multi", timestamp: 2_900,
    payload: { response: "done", resultType: "success", usage: { outputTokens: 150 } },
  });
  assert.match(f.notifications().at(-1).item.message, /速度 100 tok\/s/);

  // A tool-only request has no content boundary and contributes no decode time.
  f.sessionEvent({ type: "model.streaming", sessionId, turnId: "turn-tool-only", timestamp: 3_000, payload: { kind: "start" } });
  f.sessionEvent({
    type: "model.streaming", sessionId, turnId: "turn-tool-only", timestamp: 3_100,
    payload: { kind: "tool_call", toolCallId: "tool-1", toolName: "bash", input: {} },
  });
  f.sessionEvent({ type: "model.streaming", sessionId, turnId: "turn-tool-only", timestamp: 3_800, payload: { kind: "finish" } });
  f.sessionEvent({
    type: "turn.completed", sessionId, turnId: "turn-tool-only", timestamp: 3_900,
    payload: { response: "done", resultType: "success", usage: { outputTokens: 38 } },
  });
  assert.ok(!f.notifications().some((event) => event.item.id.includes(":usage:turn-tool-only")));

  // Under ten tokens per second keeps one decimal, like the dsh provider.
  f.sessionEvent({ type: "model.streaming", sessionId, turnId: "turn-slow", timestamp: 4_000, payload: { kind: "start" } });
  f.sessionEvent({ type: "model.streaming", sessionId, turnId: "turn-slow", timestamp: 4_100, payload: { kind: "text_start" } });
  f.sessionEvent({ type: "model.streaming", sessionId, turnId: "turn-slow", timestamp: 8_100, payload: { kind: "finish" } });
  f.sessionEvent({
    type: "turn.completed", sessionId, turnId: "turn-slow", timestamp: 8_200,
    payload: { response: "done", resultType: "success", usage: { outputTokens: 38 } },
  });
  assert.match(f.notifications().at(-1).item.message, /速度 9\.5 tok\/s/);

  // A resumed stream may omit the start marker; the first delta still opens
  // the decode window.
  f.sessionEvent({
    type: "model.streaming", sessionId, turnId: "turn-delta-only", timestamp: 9_000,
    payload: { kind: "text_delta", delta: "x" },
  });
  f.sessionEvent({ type: "model.streaming", sessionId, turnId: "turn-delta-only", timestamp: 10_000, payload: { kind: "finish" } });
  f.sessionEvent({
    type: "turn.completed", sessionId, turnId: "turn-delta-only", timestamp: 10_100,
    payload: { response: "done", resultType: "success", usage: { outputTokens: 10 } },
  });
  assert.match(f.notifications().at(-1).item.message, /速度 10 tok\/s/);
});

test("delta-only streams close the decode window at turn completion and tool calls", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  await f.prompt();
  const sessionId = f.events.find((event) => event.type === "session.persistence").persistence.data.zcodeSessionId;

  // The app-server forwards content as delta frames only: no start/finish.
  f.sessionEvent({ type: "model.streaming", sessionId, turnId: "turn-deltas", timestamp: 1_000, payload: { kind: "text_delta", delta: "S" } });
  f.sessionEvent({ type: "model.streaming", sessionId, turnId: "turn-deltas", timestamp: 1_100, payload: { kind: "reasoning_delta", delta: "R" } });
  f.sessionEvent({
    type: "turn.completed", sessionId, turnId: "turn-deltas", timestamp: 2_000,
    payload: { response: "SPEED_OK", resultType: "success", usage: { outputTokens: 5 } },
  });
  assert.match(f.notifications().at(-1).item.message, /输出 5 · 速度 5 tok\/s/);

  // A tool call closes the current model segment; the next delta reopens it.
  f.sessionEvent({ type: "model.streaming", sessionId, turnId: "turn-tool-split", timestamp: 3_000, payload: { kind: "text_delta", delta: "a" } });
  f.sessionEvent({
    type: "model.streaming", sessionId, turnId: "turn-tool-split", timestamp: 3_500,
    payload: { kind: "tool_call", toolCallId: "tool-1", toolName: "bash", input: {} },
  });
  f.sessionEvent({ type: "model.streaming", sessionId, turnId: "turn-tool-split", timestamp: 4_500, payload: { kind: "text_delta", delta: "b" } });
  f.sessionEvent({
    type: "turn.completed", sessionId, turnId: "turn-tool-split", timestamp: 5_000,
    payload: { response: "done", resultType: "success", usage: { outputTokens: 10 } },
  });
  assert.match(f.notifications().at(-1).item.message, /速度 10 tok\/s/);
});

test("compaction state updates render loading and completed rows", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  const before = f.state().revision ?? 0;
  f.notify({}, before + 1, "compact_started");
  assert.equal(f.compactionItems().at(-1).item.status, "loading");
  f.notify({}, before + 2, "session_compacted");
  assert.equal(f.compactionItems().at(-1).item.status, "completed");
});

test("forked ZCode sessions appear in the import list", async (t) => {
  const f = await fixture(t);
  await f.open({ model: BINGLM });
  f.session("forked-session", {
    sessionKind: "fork",
    mode: "build",
    runtimeMode: "build",
    model: structuredClone(defaultSelection),
    revision: 0,
    eventSeq: 0,
  });
  f.session("side-chat", {
    sessionKind: "selection_side_chat",
    mode: "build",
    runtimeMode: "build",
    model: structuredClone(defaultSelection),
    revision: 0,
    eventSeq: 0,
  });
  await f.listSessions();
  const sessions = f.events.filter((event) => event.type === "sessions").at(-1).sessions;
  const ids = sessions.map((session) => session.persistence.data.zcodeSessionId);
  assert.ok(ids.includes("forked-session"), "forked sessions are importable");
  assert.ok(!ids.includes("side-chat"), "auxiliary side chats stay out of the picker");
});

test("history replay surfaces compaction, fork and goal-verification markers", async (t) => {
  const f = await fixture(t, {
    historyMessages: [{
      info: { role: "assistant", messageId: "history-marker-1", semantics: { transcriptVisibility: "visible" } },
      parts: [
        { type: "compaction", partId: "compact-part-1", auto: true },
        {
          type: "timeline", partId: "compact-part-2", timelineType: "context_compaction",
          status: "completed", trigger: "manual", preCompactTokenCount: 12345,
        },
        {
          type: "timeline", partId: "verify-part-1", timelineType: "goal_verification",
          verification: { passed: false, reason: "tests fail" },
        },
        {
          type: "timeline", partId: "fork-part-1", timelineType: "session_fork",
          targetCheckpointId: "checkpoint-9",
        },
        { type: "text", partId: "text-part-1", text: "done" },
      ],
    }],
  });
  await f.open({}, { version: 1, data: { zcodeSessionId: "sess_history_markers" } }, "replay");

  const items = f.events
    .filter((event) => event.type === "timeline.item" && event.sessionId === "paseo-session")
    .map((event) => event.item);
  const compactions = items.filter((item) => item.type === "compaction");
  assert.equal(compactions.length, 2);
  assert.equal(compactions[0].trigger, "auto");
  assert.equal(compactions[1].trigger, "manual");
  assert.equal(compactions[1].preTokens, 12345);
  const notifications = items.filter((item) => item.type === "notification");
  assert.ok(notifications.some((item) => /not satisfied/.test(item.message)));
  assert.ok(notifications.some((item) => /checkpoint-9/.test(item.message)));
  assert.ok(items.some((item) => item.type === "assistant_message" && item.text === "done"));
});
