// Live acceptance script (not part of `npm test`): drives one real dsh
// session through the connector, exercises the file-checkpoint receipts and
// the /rewind slash path, then reopens the session and replays the log to
// confirm the native replace marker hid the rewound exchange.
import { ClientSideConnection } from "@agentclientprotocol/sdk";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createDshConnector } from "../server/dsh-acp.ts";
import { readDshSessionEventsTail } from "../server/probe-cleanup.ts";
import { dshHistoryTimelineItems } from "../server/history-replay.ts";

const workdir = mkdtempSync(join(tmpdir(), "dsh-revert-live-"));
const paseoHome = mkdtempSync(join(tmpdir(), "paseo-dsh-revert-live-"));
process.env.PASEO_HOME = paseoHome;
process.env.DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");

const log = (message: string, detail?: unknown) =>
  console.log("[live]", message, detail === undefined ? "" : JSON.stringify(detail).slice(0, 300));

const updates: string[] = [];
const makeConnection = async () => {
  const stream = await createDshConnector(log, () => ({ cwd: workdir, mode: "standard" }))();
  const client = {
    requestPermission: async () => ({ outcome: { outcome: "cancelled" as const } }),
    sessionUpdate: (notification: unknown) => {
      const update = (notification as { update?: { sessionUpdate?: string } }).update;
      if (update?.sessionUpdate) updates.push(update.sessionUpdate);
    },
  };
  const connection = new ClientSideConnection(() => client as never, stream as never);
  await connection.initialize({ protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "revert-live", version: "1" } });
  return connection;
};

const connection = await makeConnection();
const session = await connection.newSession({ cwd: workdir, mcpServers: [] });
log("session", session.sessionId);

const model = (session.configOptions ?? []).find((option) => option.category === "model");
if (model?.type !== "select") throw new Error("model selector missing");
const choices = model.options.flatMap((option) => "group" in option ? option.options : [option]);
const flash = choices.find((option) => {
  try {
    const [provider, modelId] = JSON.parse(option.value) as [string, string];
    return modelId.includes("flash");
  } catch {
    return false;
  }
});
if (!flash) throw new Error("no flash model option");
await connection.setSessionConfigOption({ sessionId: session.sessionId, configId: model.id, value: flash.value });

// Turn 1: a tiny exchange with one file write (checkpoints the receipts).
const target = join(workdir, "revert-live.txt");
writeFileSync(target, "original\n");
await connection.prompt({
  sessionId: session.sessionId,
  prompt: [{
    type: "text",
    text:
      `Use the write tool exactly once to overwrite the file ${target} with the single line: changed-by-agent. ` +
      "Do not use bash. Reply with just: WROTE",
  }],
});
log("turn 1 done; file now:", readFileSync(target, "utf8").trim());

// Turn 2: a plain exchange that the rewind will remove.
await connection.prompt({
  sessionId: session.sessionId,
  prompt: [{ type: "text", text: "Reply with exactly: SECOND_OK" }],
});
log("turn 2 done");

await new Promise((resolve) => setTimeout(resolve, 1_000));
const receiptsDir = join(paseoHome, "plugin-data", "dsh", "file-receipts");
const receiptLog = join(receiptsDir, `${session.sessionId}.jsonl`);
if (!existsSync(receiptLog)) throw new Error("no persisted file receipts were written");
const receipts = readFileSync(receiptLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
log("receipts", receipts.map((receipt) => ({ path: receipt.path, seq: receipt.seq, absent: receipt.absentBefore })));

// File revert via /revert-files restores the original bytes.
await connection.prompt({
  sessionId: session.sessionId,
  prompt: [{ type: "text", text: "/revert-files 1" }],
});
await new Promise((resolve) => setTimeout(resolve, 500));
const restored = readFileSync(target, "utf8").trim();
log("after /revert-files, file:", restored);
if (restored !== "original") throw new Error("file revert did not restore the original bytes");

// Conversation rewind to the first user message removes turn 1 and 2.
await connection.prompt({
  sessionId: session.sessionId,
  prompt: [{ type: "text", text: "/rewind 2" }],
});
// The connector closes the stream ~1.5s after a successful rewind.
await new Promise((resolve) => setTimeout(resolve, 3_000));
log("rewind requested; reopening");

const events = (await readDshSessionEventsTail(session.sessionId, { home: process.env.DSH_HOME })) ?? [];
const marker = events.find((event) => event.type === "user/message" && (event.data?.source as { kind?: string } | undefined)?.kind === "paseo-rewind");
if (!marker) throw new Error("no paseo-rewind marker found in the durable log");
log("marker", { seq: marker.seq, surfaceOp: marker.surfaceOp });

const items = dshHistoryTimelineItems(session.sessionId, events);
const texts = items.map((item) => item.type === "user_message" || item.type === "assistant_message" ? item.text : `<${item.type}>`);
log("replayed timeline:", texts);
// Only the first user message and the rewind marker survive; the second
// exchange (unique to the rewound turns) is gone.
if (texts.some((text) => String(text).includes("SECOND_OK"))) {
  throw new Error("rewound turns still render after replay");
}
if (!texts.some((text) => String(text).includes("overwrite the file"))) {
  throw new Error("the kept first user message is missing from replay");
}
console.log("LIVE REVERT ACCEPTANCE: PASS");
rmSync(workdir, { recursive: true, force: true });
rmSync(paseoHome, { recursive: true, force: true });
process.exit(0);
