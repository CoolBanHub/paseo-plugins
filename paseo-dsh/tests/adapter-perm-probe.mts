// Drives the real runAcpProvider adapter in-process against real dsh to
// reproduce the permission flow end to end. Usage:
//   node --experimental-strip-types tests/adapter-perm-probe.mts
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import { PROVIDER_PROTOCOL_VERSION } from "@getpaseo/plugin/server/provider";
import { homedir } from "node:os";
import { join } from "node:path";
import { createDshConnector } from "../server/dsh-acp.ts";

const log = (message: string, detail?: unknown) =>
  console.log("[dsh]", message, detail === undefined ? "" : JSON.stringify(detail).slice(0, 200));

const provider = runAcpProvider({
  id: "dsh",
  label: "dsh",
  connector: createDshConnector((message, detail) => {
    if (message.startsWith("wire") || message.includes("permission")) {
      console.log("[dsh]", message, detail === undefined ? "" : JSON.stringify(detail).slice(0, 300));
    }
  }),
  acpOptions: { startupTimeoutMs: 60_000 },
});

const connection = await provider.connect({
  versions: [PROVIDER_PROTOCOL_VERSION],
  capabilities: ["prompt.message", "session.list", "session.persistence", "session.configure", "permission"],
} as never);

connection.onEvent((event) => {
  const summary =
    event.type === "session.permission"
      ? JSON.stringify(event)
      : event.type === "timeline.item"
        ? `timeline ${(event as { item: { type: string } }).item.type}`
        : "";
  console.log("EVENT:", event.type, summary.slice(0, 400));
});

const send = (input: unknown) =>
  new Promise<void>((resolve, reject) => {
    connection.send(input as never).then(resolve, (error: unknown) => {
      console.error("SEND FAILED:", input, String(error).slice(0, 300));
      reject(error);
    });
  });

let ready: () => void;
const readyPromise = new Promise<void>((resolve) => {
  ready = resolve;
});
const originalOnEvent = connection.onEvent;
connection.onEvent((event) => {
  if ((event as { type: string }).type === "session.ready") ready();
});
void originalOnEvent;

await send({
  type: "session.open",
  requestId: "r-open",
  sessionId: "paseo-session-1",
  config: { cwd: join(homedir(), "dsh-perm-test"), settings: {}, persist: false, env: {}, mcpServers: {} },
  history: "skip",
});
await Promise.race([readyPromise, new Promise((r) => setTimeout(r, 60_000))]);
console.log("opened");

await send({
  type: "session.prompt",
  sessionId: "paseo-session-1",
  prompt: {
    clientMessageId: "m1",
    delivery: "auto",
    input: { type: "message", content: [{ type: "text", text: `Create a file at ${join(homedir(), "dsh-probe-outside2.txt")} with content hi. Do not retry more than twice.` }] },
  },
});
console.log("prompt settled");

// Leave the permission pending long enough to observe, then answer deny.
setTimeout(async () => {
  await connection.close();
  process.exit(0);
}, 120_000);
