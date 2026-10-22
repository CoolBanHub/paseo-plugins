import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClientSideConnection } from "@agentclientprotocol/sdk";
import { createDshConnector } from "../server/dsh-acp.ts";
import { dshCatalogCacheKey, writeWebModelOverlay } from "../server/dsh-catalog.ts";
import {
  currentDshSessionLaunchContext,
  withDshSessionLaunchContext,
} from "../server/session-launch-context.ts";

const testsDir = dirname(fileURLToPath(import.meta.url));
const mockAgent = join(testsDir, "mock-dsh-agent.cjs");
const noLog = () => undefined;

const home = mkdtempSync(join(tmpdir(), "dsh-plugin-test-"));
const presetPatchRoot = join(home, "web-presets");
const webProfileRoot = join(home, "profiles", "web");
const acpProfileRoot = join(home, "profiles", "acp");
mkdirSync(presetPatchRoot, { recursive: true });
mkdirSync(webProfileRoot, { recursive: true });
mkdirSync(acpProfileRoot, { recursive: true });
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
            reasoningEfforts:
              low: low
              high: high
              max: max
`);
for (const preset of ["standard", "ptc", "minimal", "cordis"]) {
  writeFileSync(join(presetPatchRoot, `${preset}.patch.yml`), `# ${preset}\n`);
}
const registryFile = join(home, "plugin-data", "dsh", "probe-sessions.json");
mkdirSync(dirname(registryFile), { recursive: true });
writeFileSync(registryFile, `${JSON.stringify({ ids: ["legacy-probe"] })}\n`);

process.env.DSH_BIN = mockAgent;
const nvmNodeRoot = join(homedir(), ".nvm", "versions", "node");
process.env.DSH_NODE_PATH = readdirSync(nvmNodeRoot)
  .map((version) => join(nvmNodeRoot, version, "bin", "node"))
  .find((path) => existsSync(path)) ?? process.execPath;
process.env.PASEO_HOME = home;
process.env.DSH_WEB_PRESET_ROOT = presetPatchRoot;
process.env.DSH_WEB_PROFILE_ROOT = webProfileRoot;
process.env.DSH_ACP_PROFILE_ROOT = acpProfileRoot;
test.after(() => rmSync(home, { recursive: true, force: true }));

async function openConnection(options?: { mode?: string }) {
  const permissionRequests: Array<Record<string, unknown>> = [];
  const sessionUpdates: Array<Record<string, unknown>> = [];
  const stream = await createDshConnector(
    noLog,
    options ? () => ({ cwd: "/tmp", mode: options.mode }) : undefined,
  )();
  const client = {
    requestPermission: async (request: Record<string, unknown>) => {
      permissionRequests.push(request);
      return { outcome: { outcome: "cancelled" as const } };
    },
    sessionUpdate: (notification: Record<string, unknown>) => {
      sessionUpdates.push(notification);
    },
  };
  const connection = new ClientSideConnection(() => client as never, stream as never);
  return { stream, connection, permissionRequests, sessionUpdates };
}

test("connector adapts dsh ACP for Paseo", async (t) => {
  const first = await openConnection({ mode: "ptc" });
  try {
    const initialized = await first.connection.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(initialized.agentCapabilities?.loadSession, true, "loadSession capability injected");

    // Discovery probe: session/new without _meta._paseo.
    const probe = await first.connection.newSession({ cwd: "/tmp", mcpServers: [] });
    // Real open: session/new with _meta._paseo (Paseo always sends it).
    const real = await first.connection.newSession({
      cwd: "/tmp",
      mcpServers: [],
      _meta: { _paseo: {} },
    } as never);
    assert.deepEqual(
      real.modes?.availableModes.map((mode) => mode.id),
      ["standard", "ptc", "minimal", "cordis"],
      "Paseo receives dsh agent presets in its native selector",
    );
    assert.equal(real.modes?.currentModeId, "ptc");
    const thinking = (real.configOptions ?? []).find((option) => option.category === "thought_level");
    assert.deepEqual(
      (thinking?.options ?? []).map((option) => ("value" in option ? option.value : undefined)),
      ["off", "high", "max"],
      "empty-string thinking options stripped while max is retained",
    );
    assert.equal(thinking?.currentValue, "off", "empty current thinking value re-pointed");

    const permissions = (real.configOptions ?? []).find((option) => option.id === "paseo_dsh_permission_preset");
    assert.equal(permissions?.category, "dsh_permission_preset", "permission preset exposed separately from mode");
    assert.deepEqual(
      (permissions?.options ?? []).map((option) => option.value),
      ["workspace-write", "read-only", "danger-full-access"],
    );
    const modelChange = await first.connection.setSessionConfigOption({
      sessionId: real.sessionId,
      configId: "model",
      value: "m",
    });
    assert.ok(
      modelChange.configOptions.some((option) => option.id === "paseo_dsh_permission_preset"),
      "regular dsh config changes preserve the separate permission setting",
    );
    const changedPermissions = await first.connection.setSessionConfigOption({
      sessionId: real.sessionId,
      configId: "paseo_dsh_permission_preset",
      value: "read-only",
    });
    const selectedPermission = changedPermissions.configOptions.find(
      (option) => option.id === "paseo_dsh_permission_preset",
    );
    assert.equal(selectedPermission?.currentValue, "read-only", "Paseo receives the selected permission value");
    const controlFile = readdirSync(join(home, "plugin-data", "dsh"))
      .find((file) => file.startsWith("permission-control-"));
    assert.ok(controlFile, "per-process permission control file exists");
    assert.equal(
      JSON.parse(readFileSync(join(home, "plugin-data", "dsh", controlFile!), "utf8"))[real.sessionId],
      "read-only",
      "selected permission is forwarded to the dsh bridge",
    );

    await first.connection.setSessionMode({ sessionId: real.sessionId, modeId: "ptc" });
    await first.connection.prompt({
      sessionId: real.sessionId,
      prompt: [{ type: "text", text: "Make the requested edits" }],
    });
    const promptEcho = first.sessionUpdates
      .map((notification) => notification.update as { content?: { text?: string } } | undefined)
      .map((update) => update?.content?.text ?? "")
      .join("\n");
    assert.match(promptEcho, /Make the requested edits/);

    // dsh's minimal permission request must reach the client enriched with
    // the observed tool_call snapshot (Paseo's adapter crashes on a missing
    // rawInput).
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(first.permissionRequests.length, 1, "permission request forwarded");
    const toolCall = (first.permissionRequests[0] as { toolCall?: Record<string, unknown> }).toolCall;
    assert.equal(toolCall?.title, "write", "permission toolCall enriched with tracked title");
    assert.deepEqual(
      toolCall?.rawInput,
      { file_path: "/tmp/outside.txt", content: "hi" },
      "permission toolCall enriched with tracked rawInput",
    );

    // Paseo resumes via session/load; the mock (like dsh) rejects it, so
    // success proves the rewrite to session/resume.
    const resumed = await first.connection.loadSession({ sessionId: real.sessionId, cwd: "/tmp" });
    assert.ok(resumed, "session/load translated to session/resume");

    const listed = await first.connection.listSessions({ cwd: "/tmp" });
    const ids = listed.sessions.map((session) => session.sessionId);
    assert.ok(!ids.includes(probe.sessionId), "live probe session hidden");
    assert.ok(!ids.includes("legacy-probe"), "registry session hidden");
    assert.ok(ids.includes(real.sessionId), "real session visible");
  } finally {
    await first.stream.writable.close();
  }

  // A fresh connector (new dsh process, same Paseo home) must keep hiding
  // probe sessions via the persisted registry.
  const second = await openConnection({ mode: "ptc" });
  try {
    const listed = await second.connection.listSessions({ cwd: "/tmp" });
    const ids = listed.sessions.map((session) => session.sessionId);
    assert.ok(!ids.includes("legacy-probe"), "registry survives connector restarts");
    assert.ok(!ids.includes("mock-1"), "earlier probe stays hidden across processes");
    const nextSession = await second.connection.newSession({
      cwd: "/tmp",
      mcpServers: [],
      _meta: { _paseo: {} },
    } as never);
    const inheritedPermission = nextSession.configOptions?.find(
      (option) => option.id === "paseo_dsh_permission_preset",
    );
    assert.equal(inheritedPermission?.currentValue, "read-only", "new sessions inherit the project's permission preset");
  } finally {
    await second.stream.writable.close();
  }
});

test("workspace-selected PTC preset reaches the dsh process", async () => {
  const preset = await openConnection({ mode: "ptc" });
  try {
    const initialized = await preset.connection.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.match(initialized.agentInfo?.version ?? "", /^ptc\|--profile acp --patch .*cordis\.patch\.yml --patch .*ptc\.patch\.yml --patch .*web-models\.patch\.yml$/);
  } finally {
    await preset.stream.writable.close();
  }
});

test("session-open mode context survives async provider dispatch", async () => {
  let observed: unknown;
  const provider = withDshSessionLaunchContext({
    id: "dsh",
    label: "dsh",
    connect: async () => ({
      version: 1,
      capabilities: [],
      onEvent: () => () => undefined,
      close: async () => undefined,
      send: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        observed = currentDshSessionLaunchContext();
      },
    }),
  });
  const connection = await provider.connect({ versions: [1], capabilities: [] });

  await connection.send({
    type: "session.open",
    requestId: "request",
    sessionId: "session",
    config: {
      cwd: "/workspace/project-a",
      env: {},
      mcpServers: {},
      settings: {},
      persist: true,
      mode: "full-access",
    },
  } as never);

  assert.deepEqual(observed, { cwd: "/workspace/project-a", mode: "full-access", settings: {} });
});

test("catalog cache key changes when either profile changes", async (t) => {
  const profiles = mkdtempSync(join(tmpdir(), "dsh-profile-cache-test-"));
  t.after(() => rmSync(profiles, { recursive: true, force: true }));
  const acp = join(profiles, "acp");
  const web = join(profiles, "web");
  mkdirSync(acp);
  mkdirSync(web);
  writeFileSync(join(acp, "cordis.patch.yml"), "model: mimo-v2.6-pro\n");
  writeFileSync(join(web, "cordis.patch.yml"), "model: mimo-v2.6-pro\n");

  const options = { scope: "workspace" as const, cwd: "/tmp" };
  const before = dshCatalogCacheKey(options, profiles);
  writeFileSync(join(web, "cordis.patch.yml"), "model: deepseek-v4.1-flash\n");

  const afterWebChange = dshCatalogCacheKey(options, profiles);
  assert.notEqual(afterWebChange, before);
  writeFileSync(join(acp, "cordis.patch.yml"), "model: deepseek-v4-pro\n");
  assert.notEqual(dshCatalogCacheKey(options, profiles), afterWebChange);
});

test("Web model overlay keeps ACP route settings and current model capabilities", async (t) => {
  const profile = mkdtempSync(join(tmpdir(), "dsh-web-profile-test-"));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  const acp = join(profile, "acp");
  const web = join(profile, "web");
  mkdirSync(acp);
  mkdirSync(web);
  const output = join(profile, "generated", "models.patch.yml");
  writeFileSync(join(acp, "cordis.patch.yml"), `- id: llm-pi-ai
  config:
    providers:
      bai:
        api: openai-completions
        baseURL: https://example.invalid/v1
        apiKeyEnv: BAI_API_KEY
        apiKey: do-not-copy
`);
  writeFileSync(join(web, "cordis.patch.yml"), `- id: llm-pi-ai
  config:
    providers:
      bai:
        models:
          - id: flash
            reasoningEfforts:
              low: low
              high: high
              max: max
`);

  assert.deepEqual(writeWebModelOverlay(acp, web, output), ["flash"]);
  const overlay = readFileSync(output, "utf8");
  assert.match(overlay, /api: openai-completions/);
  assert.match(overlay, /baseURL: https:\/\/example\.invalid\/v1/);
  assert.match(overlay, /apiKeyEnv: BAI_API_KEY/);
  assert.match(overlay, /max: max/);
  assert.doesNotMatch(overlay, /do-not-copy/, "raw API keys are never copied into the overlay");
});
