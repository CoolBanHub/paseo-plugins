// Minimal fake dsh ACP agent for connector tests. Speaks newline-delimited
// JSON-RPC on stdio and mimics the parts of dsh's ACP surface the connector
// compensates for: no loadSession capability, session/load rejected,
// session/resume supported. PTC prompts also append the same JSONL mirror
// records the connector's in-dsh bridge plugin writes for PTC sub-calls.
const fs = require("node:fs");
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });
let nextId = 1;
const created = [];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

// Reproduce the bridge plugin's PTC mirror: one started + finished sub-call
// pair per tool, mirroring a real run_code program's dispatches.
function mirrorPtcDispatches(sessionId) {
  const file = process.env.DSH_PTC_EVENT_FILE;
  if (!file || !sessionId) return;
  const dispatches = [
    {
      name: "bash",
      arguments: { command: "ls -la", description: "List repo root" },
      isError: false,
      content: [{ type: "text", text: "file-a\nfile-b" }],
    },
    {
      name: "edit",
      arguments: { file_path: "/tmp/src/a.ts", old_string: "x", new_string: "y" },
      isError: true,
      content: [{ type: "text", text: "edit failed: no match" }],
    },
    {
      name: "todo_write",
      arguments: {
        todos: [
          { content: "scan the repo", status: "completed" },
          { content: "fix the bug", status: "in_progress" },
        ],
      },
      isError: false,
      content: [],
    },
  ];
  dispatches.forEach((dispatch, index) => {
    const subCallId = `call-ptc-1:ptc:${index + 1}`;
    const write = (kind, extra) =>
      fs.appendFileSync(file, `${JSON.stringify({ kind, sessionId, data: { rootCallId: "call-ptc-1", subCallId, ...dispatch, ...extra } })}\n`);
    write("call");
    write("result");
  });
}

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
        agentInfo: {
          name: "mock-dsh",
          version: `${process.env.DSH_AGENT_PRESET ?? "unset"}|${process.argv.slice(2).join(" ")}`,
        },
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
      const dispatchesTools = !prompt.includes("no dispatch");
      if (dispatchesTools) mirrorPtcDispatches(message.params?.sessionId);
      // Like real dsh PTC: one aggregate run_code tool call wraps the
      // program; only the title says "run_code", and the settle update
      // carries nested content blocks.
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params?.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call-ptc-1",
            title: "run_code",
            kind: "other",
            status: "in_progress",
            rawInput: {
              code: "const r = await tools.bash({ command: 'ls -la' });\nconsole.log(r);",
              description: dispatchesTools ? "List repo root" : "Compute without tools",
            },
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params?.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call-ptc-1",
            status: "completed",
            content: [{
              type: "content",
              content: { type: "text", text: dispatchesTools ? "file-a\nfile-b" : "computed offline" },
            }],
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: message.params?.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call-perm-1",
            status: "failed",
            content: [],
          },
        },
      });
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
    case "session/set_config_option":
      respond({
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: message.params?.value ?? "m",
            options: [{ value: "m", name: "M" }],
          },
          {
            id: "reasoning_effort",
            name: "Reasoning effort",
            category: "thought_level",
            type: "select",
            currentValue: "off",
            options: [{ value: "off", name: "Off" }],
          },
        ],
      });
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
