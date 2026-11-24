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

const { ZcodeProtocolClient } = require("../server/zcode-protocol.ts");

function clientWithReplies() {
  const client = new ZcodeProtocolClient({
    cliPath: "/mock/zcode.cjs",
    nodePath: "/mock/node",
    cwd: "/mock",
  });
  const replies = [];
  client.replyServerRequest = (id, result) => replies.push({ id, result });
  client.replyServerRequestError = (id, code, message) => replies.push({ id, error: { code, message } });
  return { client, replies };
}

test("ZCode 4.0 reply-language requests keep the ZCode default", () => {
  const { client, replies } = clientWithReplies();
  client.handleServerRequest({
    id: 7,
    method: "session/readReplyLanguage",
    params: { sessionId: "sess_1" },
  });
  assert.deepEqual(replies, [{ id: 7, result: { language: null } }]);
});

test("credential cipher requests are declined instead of returning an invalid result", () => {
  const { client, replies } = clientWithReplies();
  client.handleServerRequest({
    id: 8,
    method: "interaction/requestCredentialCipher",
    params: { requestId: "8f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f", payload: {} },
  });
  assert.deepEqual(replies, [{
    id: 8,
    error: { code: -32603, message: "Credential cipher host is unavailable" },
  }]);
});

test("subagent runtime config requests fall back to ZCode's built-in profiles", () => {
  const { client, replies } = clientWithReplies();
  client.handleServerRequest({
    id: 9,
    method: "subagents/readRuntimeConfig",
    params: { sessionId: "sess_1" },
  });
  assert.deepEqual(replies, [{ id: 9, result: { kind: "built-in-fallback" } }]);
});
