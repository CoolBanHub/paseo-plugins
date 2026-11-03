import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
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
