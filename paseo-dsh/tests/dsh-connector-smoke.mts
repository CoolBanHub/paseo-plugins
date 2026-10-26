import { ClientSideConnection } from "@agentclientprotocol/sdk";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createDshConnector } from "../server/dsh-acp.ts";

const paseoHome = mkdtempSync(join(tmpdir(), "paseo-dsh-smoke-"));
process.env.PASEO_HOME = paseoHome;

const log = (message: string, detail?: unknown) =>
  console.log("[smoke]", message, detail === undefined ? "" : JSON.stringify(detail));

const updates: unknown[] = [];
const stream = await createDshConnector(log, () => ({ cwd: "/tmp", mode: process.env.DSH_AGENT_PRESET }))();
const client = {
  requestPermission: async (request: unknown) => {
    log("permission request", request);
    return { outcome: { outcome: "cancelled" as const } };
  },
  sessionUpdate: (notification: unknown) => {
    updates.push((notification as { update?: { sessionUpdate?: string } }).update?.sessionUpdate);
  },
};
const connection = new ClientSideConnection(() => client as never, stream as never);

const initialized = await connection.initialize({
  protocolVersion: 1,
  clientCapabilities: {},
  clientInfo: { name: "paseo-smoke", version: "1" },
});
console.log("STEP1 initialize loadSession capability:", initialized.agentCapabilities?.loadSession);
if (initialized.agentCapabilities?.loadSession !== true) throw new Error("loadSession capability was not injected");

const session = await connection.newSession({ cwd: "/tmp", mcpServers: [] });
console.log("STEP2 session/new:", session.sessionId);
const model = (session.configOptions ?? []).find((o) => o.category === "model");
if (model?.type !== "select") throw new Error("model selector was not exposed");
console.log("STEP2 model option current:", model?.currentValue, "choices:", JSON.stringify(model?.options).slice(0, 400));
const modelChoices = model?.options.flatMap((option) => "group" in option ? option.options : [option]) ?? [];
const deepseekFlash = modelChoices.find((option) => {
  try {
    const [provider, modelId] = JSON.parse(option.value) as [string, string];
    return provider === "bai" && modelId === "deepseek-v4.1-flash";
  } catch {
    return false;
  }
});
if (!model || !deepseekFlash) throw new Error("bai/deepseek-v4.1-flash model option was not found");
const selected = await connection.setSessionConfigOption({
  sessionId: session.sessionId,
  configId: model.id,
  value: deepseekFlash.value,
});
const thinking = selected.configOptions.find((option) => option.category === "thought_level");
if (thinking?.type !== "select") throw new Error("thinking selector was not exposed");
console.log("STEP2 DeepSeek-V4.1-Flash thinking options:", JSON.stringify(thinking?.options));
if (!thinking?.options.some((option) => "value" in option && option.value === "max")) {
  throw new Error("bai/deepseek-v4.1-flash did not expose the max thinking option");
}

const permissionSetting = selected.configOptions.find((option) => option.id === "paseo_dsh_permission_preset");
if (permissionSetting?.type !== "select") throw new Error("dsh permission preset setting was not exposed");
console.log("STEP2 dsh permission options:", JSON.stringify(permissionSetting.options));
await connection.setSessionConfigOption({
  sessionId: session.sessionId,
  configId: permissionSetting.id,
  value: "read-only",
});
await new Promise((resolve) => setTimeout(resolve, 300));
const dataDir = join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugin-data", "dsh");
const permissionCatalogFiles = readdirSync(dataDir)
  .filter((file) => file.startsWith("permission-catalog-") && file.endsWith(".json"));
const savedPermission = permissionCatalogFiles.map((file) => {
  try {
    const catalog = JSON.parse(readFileSync(join(dataDir, file), "utf8")) as {
      sessionPermissions?: Record<string, string>;
    };
    return catalog.sessionPermissions?.[session.sessionId];
  } catch {
    return undefined;
  }
}).find((value) => value !== undefined);
if (savedPermission !== "read-only") throw new Error(`dsh did not apply read-only permission preset: ${savedPermission}`);
console.log("STEP2 dsh applied permission preset:", savedPermission);

await connection.closeSession({ sessionId: session.sessionId });
console.log("STEP3 session/close ok");

// Paseo reopens persisted sessions with session/load; the connector must
// translate this into dsh's session/resume.
const resumed = await connection.loadSession({ sessionId: session.sessionId, cwd: "/tmp", mcpServers: [] });
console.log("STEP4 session/load -> resume ok, configOptions:", (resumed.configOptions ?? []).length);

const listed = await connection.listSessions({ cwd: "/tmp" });
console.log("STEP5 session/list entries:", JSON.stringify(listed.sessions));

await connection.closeSession({ sessionId: session.sessionId });
await stream.writable.close();
rmSync(paseoHome, { recursive: true, force: true });
console.log("STEP6 closed; updates observed:", updates.length);
process.exit(0);
