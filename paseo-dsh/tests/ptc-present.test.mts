import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClientSideConnection } from "@agentclientprotocol/sdk";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { createDshConnector } from "../server/dsh-acp.ts";
import {
  DSH_PTC_CALL_METHOD,
  DSH_PTC_RESULT_METHOD,
  dshPtcTimelineUpdates,
} from "../server/ptc-present.ts";

// PTC sub-call presentation: the connector mirrors dsh's internal
// tool/ptc-dispatch events out of the spawned process and re-emits them as
// vendor notifications; the transformer maps each onto a native Paseo
// timeline row (Shell / Edit / todo, like the ZCode provider).

const testsDir = dirname(fileURLToPath(import.meta.url));
const mockAgent = join(testsDir, "mock-dsh-agent.cjs");
const noLog = () => undefined;

const home = mkdtempSync(join(tmpdir(), "dsh-ptc-test-"));
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
`);
for (const preset of ["standard", "ptc", "minimal", "cordis"]) {
  writeFileSync(join(presetPatchRoot, `${preset}.patch.yml`), `# ${preset}\n`);
}
process.env.DSH_BIN = mockAgent;
const nvmNodeRoot = join(homedir(), ".nvm", "versions", "node");
// The mock agent runs on node, not electron, so any node works.
const nvmNodes = existsSync(nvmNodeRoot)
  ? readdirSync(nvmNodeRoot).map((version) => join(nvmNodeRoot, version, "bin", "node"))
  : [];
process.env.DSH_NODE_PATH = nvmNodes.find((path) => existsSync(path)) ?? process.execPath;
process.env.PASEO_HOME = home;
process.env.DSH_HOME = home;
process.env.DSH_WEB_PRESET_ROOT = presetPatchRoot;
process.env.DSH_WEB_PROFILE_ROOT = webProfileRoot;
process.env.DSH_ACP_PROFILE_ROOT = acpProfileRoot;
test.after(() => rmSync(home, { recursive: true, force: true }));

type PtcNotification = { method: string; params: Record<string, unknown> };

async function openConnection() {
  const ptcNotifications: PtcNotification[] = [];
  const stream = await createDshConnector(noLog, () => ({ cwd: "/tmp", mode: "ptc" }))();
  // Paseo's adapter diverts non-ACP notification methods to the plugin's
  // transformer before the SDK connection; mirror that routing here so the
  // SDK never observes dsh/ptc/* messages, and keep them for assertions.
  const readable = stream.readable.pipeThrough(
    new TransformStream<AcpStreamMessage, AcpStreamMessage>({
      transform(message, controller) {
        if ("method" in message && !("id" in message) && message.method.startsWith("dsh/ptc/")) {
          ptcNotifications.push({
            method: message.method,
            params: (message.params ?? {}) as Record<string, unknown>,
          });
          return;
        }
        controller.enqueue(message);
      },
    }),
  );
  const client = {
    requestPermission: async () => ({ outcome: { outcome: "cancelled" as const } }),
    sessionUpdate: () => undefined,
  };
  const connection = new ClientSideConnection(
    () => client as never,
    { writable: stream.writable, readable } as never,
  );
  return { stream, connection, ptcNotifications };
}

async function waitForPtcRecords(notifications: PtcNotification[], count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (notifications.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("PTC sub-calls reach Paseo as detailed timeline rows", async () => {
  const conn = await openConnection();
  try {
    await conn.connection.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    // The bridge plugin mounted into every dsh spawn must carry the PTC tap.
    const bridgeSource = readFileSync(
      join(home, "plugin-data", "dsh", "agent-presets", "agent-preset-bridge.js"),
      "utf8",
    );
    assert.match(bridgeSource, /DSH_PTC_EVENT_FILE/);
    assert.match(bridgeSource, /tool\/ptc-dispatch/);

    const session = await conn.connection.newSession({
      cwd: "/tmp",
      mcpServers: [],
      _meta: { _paseo: {} },
    } as never);
    await conn.connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Run the program" }],
    });
    await waitForPtcRecords(conn.ptcNotifications, 6);

    // Each dispatched sub-call is announced, then settled, in dispatch order.
    assert.deepEqual(
      conn.ptcNotifications.map((notification) => notification.method),
      [
        DSH_PTC_CALL_METHOD, DSH_PTC_RESULT_METHOD,
        DSH_PTC_CALL_METHOD, DSH_PTC_RESULT_METHOD,
        DSH_PTC_CALL_METHOD, DSH_PTC_RESULT_METHOD,
      ],
    );
    const bashCall = conn.ptcNotifications[0].params;
    assert.equal(bashCall.name, "bash");
    assert.deepEqual(bashCall.arguments, { command: "ls -la", description: "List repo root" });
    const bashResult = conn.ptcNotifications[1].params;
    assert.equal(bashResult.isError, false);
    assert.equal(bashResult.output, "file-a\nfile-b");

    // The transformer maps the mirrored records onto native rows: bash gets
    // a Shell card, the failed edit keeps its error text, and todo_write
    // also refreshes the native todo list.
    const items = conn.ptcNotifications
      .flatMap((notification) =>
        dshPtcTimelineUpdates(notification.method, notification.params, "paseo-session") ?? [])
      .filter((update) => update.type === "timeline")
      .map((update) => update.item);
    const bashRows = items.filter((item) => item.type === "tool_call" && item.name === "bash");
    assert.equal(bashRows.length, 2, "bash is announced running, then settled");
    assert.equal(bashRows[0].status, "running");
    assert.deepEqual(
      bashRows[1].detail,
      { type: "shell", command: "ls -la", output: "file-a\nfile-b" },
      "settled bash dispatch renders as a Shell row with its command and output",
    );
    const editRows = items.filter((item) => item.type === "tool_call" && item.name === "edit");
    const settledEdit = editRows.at(-1);
    assert.equal(settledEdit?.status, "failed");
    assert.equal(settledEdit?.error, "edit failed: no match");
    assert.deepEqual(
      settledEdit?.detail,
      { type: "edit", filePath: "/tmp/src/a.ts", oldString: "x", newString: "y" },
    );
    const todo = items.find((item) => item.type === "todo");
    assert.deepEqual(
      todo && todo.type === "todo" && todo.items.map(({ text, status }) => ({ text, status })),
      [
        { text: "scan the repo", status: "completed" },
        { text: "fix the bug", status: "in_progress" },
      ],
      "todo_write refreshes the native todo list",
    );
  } finally {
    await conn.stream.writable.close();
  }
  // The sidecar is removed when the agent process exits (or at the close
  // deadline), mirroring the probe-cleanup lifecycle.
  const dataDir = join(home, "plugin-data", "dsh");
  const deadline = Date.now() + 7_000;
  let leftovers = readdirSync(dataDir).filter((file) => file.startsWith("ptc-events-"));
  while (leftovers.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    leftovers = readdirSync(dataDir).filter((file) => file.startsWith("ptc-events-"));
  }
  assert.equal(leftovers.length, 0, "ptc mirror sidecar removed after the connection closes");
});

test("transformer ignores unrelated and malformed notifications", () => {
  assert.equal(dshPtcTimelineUpdates("session/update", {}, "session"), null);
  assert.equal(dshPtcTimelineUpdates(DSH_PTC_CALL_METHOD, { name: "bash" }, "session"), null);
  assert.equal(dshPtcTimelineUpdates(DSH_PTC_CALL_METHOD, "not-an-object", "session"), null);
});
