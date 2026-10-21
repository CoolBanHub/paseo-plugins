import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClientSideConnection } from "@agentclientprotocol/sdk";
import { createDshConnector } from "../server/dsh-acp.ts";

const testsDir = dirname(fileURLToPath(import.meta.url));
const mockAgent = join(testsDir, "mock-dsh-agent.cjs");
const noLog = () => undefined;

const home = mkdtempSync(join(tmpdir(), "dsh-plugin-test-"));
const registryFile = join(home, "plugin-data", "dsh", "probe-sessions.json");
mkdirSync(dirname(registryFile), { recursive: true });
writeFileSync(registryFile, `${JSON.stringify({ ids: ["legacy-probe"] })}\n`);

process.env.DSH_BIN = mockAgent;
process.env.PASEO_HOME = home;

async function openConnection(options?: { permissionMode?: string }) {
  const permissionRequests: Array<Record<string, unknown>> = [];
  const sessionUpdates: Array<Record<string, unknown>> = [];
  const stream = await createDshConnector(noLog, options ? () => options.permissionMode : undefined)();
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
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const first = await openConnection();
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
      ["standard", "plan"],
      "Paseo receives the standard and plan mode choices",
    );
    const thinking = (real.configOptions ?? []).find((option) => option.category === "thought_level");
    assert.deepEqual(
      (thinking?.options ?? []).map((option) => ("value" in option ? option.value : undefined)),
      ["off", "high", "max"],
      "empty-string thinking options stripped while max is retained",
    );
    assert.equal(thinking?.currentValue, "off", "empty current thinking value re-pointed");

    await first.connection.setSessionMode({ sessionId: real.sessionId, modeId: "plan" });
    await first.connection.prompt({
      sessionId: real.sessionId,
      prompt: [{ type: "text", text: "Make the requested edits" }],
    });
    const promptEcho = first.sessionUpdates
      .map((notification) => notification.update as { content?: { text?: string } } | undefined)
      .map((update) => update?.content?.text ?? "")
      .join("\n");
    assert.match(promptEcho, /Paseo plan mode/);
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
  const second = await openConnection();
  try {
    const listed = await second.connection.listSessions({ cwd: "/tmp" });
    const ids = listed.sessions.map((session) => session.sessionId);
    assert.ok(!ids.includes("legacy-probe"), "registry survives connector restarts");
    assert.ok(!ids.includes("mock-1"), "earlier probe stays hidden across processes");
  } finally {
    await second.stream.writable.close();
  }
});

test("permission preset setting reaches the dsh process", async () => {
  const preset = await openConnection({ permissionMode: "danger-full-access" });
  try {
    const initialized = await preset.connection.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(initialized.agentInfo?.version, "danger-full-access");
  } finally {
    await preset.stream.writable.close();
  }
});
