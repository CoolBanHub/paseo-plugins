// Minimal fake dsh ACP agent for connector tests. Speaks newline-delimited
// JSON-RPC on stdio and mimics the parts of dsh's ACP surface the connector
// compensates for: no loadSession capability, session/load rejected,
// session/resume supported.
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });
let nextId = 1;
const created = [];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined || message.id === null) return;
  const respond = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  const fail = (message_text) =>
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: message_text } });
  switch (message.method) {
    case "initialize":
      respond({
        protocolVersion: 1,
        // Echo the injected permission preset so tests can assert it.
        agentInfo: { name: "mock-dsh", version: process.env.DSH_PERMISSION_MODE ?? "unset" },
        agentCapabilities: { sessionCapabilities: { close: {}, list: {}, resume: {} } },
        authMethods: [],
      });
      // Like real dsh: stream a tool_call update, then a minimal
      // session/request_permission carrying only {toolCallId}.
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "any",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "call-perm-1",
              title: "write",
              kind: "other",
              status: "in_progress",
              rawInput: { file_path: "/tmp/outside.txt", content: "hi" },
            },
          },
        });
        send({
          jsonrpc: "2.0",
          id: "perm-req-1",
          method: "session/request_permission",
          params: {
            sessionId: "any",
            toolCall: { toolCallId: "call-perm-1" },
            options: [
              { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
              { optionId: "reject-once", name: "Reject", kind: "reject_once" },
            ],
          },
        });
      }, 30);
      break;
    case "session/new": {
      const sessionId = `mock-${nextId++}`;
      created.push(sessionId);
      respond({
        sessionId,
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "m",
            options: [{ value: "m", name: "M" }],
          },
          {
            // Includes dsh's empty-string "Provider default" entry that the
            // connector must strip for Paseo's thinking-option schema.
            id: "reasoning_effort",
            name: "Reasoning effort",
            category: "thought_level",
            type: "select",
            currentValue: "",
            options: [
              { value: "", name: "Provider default" },
              { value: "off", name: "Off" },
              { value: "high", name: "High" },
              { value: "max", name: "Max" },
            ],
          },
        ],
      });
      break;
    }
    case "session/load":
      fail("Method not found: session/load");
      break;
    case "session/resume":
      respond({
        configOptions: [
          {
            id: "reasoning_effort",
            category: "thought_level",
            currentValue: "",
            options: [
              { value: "", name: "Provider default" },
              { value: "off", name: "Off" },
            ],
          },
        ],
      });
      break;
    case "session/prompt": {
      const prompt = Array.isArray(message.params?.prompt)
        ? message.params.prompt.map((part) => part.text ?? "").join("\n")
        : "";
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params?.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: prompt },
          },
        },
      });
      respond({ stopReason: "end_turn" });
      break;
    }
    case "session/set_mode":
      respond({});
      break;
    case "session/list":
      respond({
        sessions: [
          ...created.map((sessionId) => ({ sessionId, cwd: "/tmp" })),
          { sessionId: "legacy-probe", cwd: "/tmp" },
        ],
      });
      break;
    case "session/close":
      respond({});
      break;
    default:
      fail(`Method not found: ${message.method}`);
  }
});
