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

const { zcodeFailurePresentation, zcodeFailureText } = require("../server/zcode-error-present.ts");

test("known numeric codes map to short Chinese guidance", () => {
  assert.equal(zcodeFailureText({ code: 401 }), "认证失败（401），请在 ZCode 客户端重新登录");
  assert.equal(zcodeFailureText({ code: 429 }), "请求过于频繁（429），请稍后重试");
  assert.equal(zcodeFailureText({ code: 402 }), "额度或配额不足（402），请检查 ZCode 套餐额度");
});

test("well-known message patterns map even without a code", () => {
  assert.match(zcodeFailurePresentation({ message: "账号 quota exhausted, balance is not enough" }), /额度或配额不足/);
  assert.match(zcodeFailurePresentation({ message: "request rate limit exceeded" }), /请求过于频繁/);
  assert.match(zcodeFailurePresentation({ message: "invalid token, please login again" }), /认证失败/);
  assert.match(zcodeFailurePresentation({ message: "prompt is too long: 300000 tokens" }), /上下文窗口已超限/);
});

test("unknown failures keep the original message", () => {
  assert.equal(zcodeFailurePresentation({ message: "something odd happened" }), "something odd happened");
  assert.equal(zcodeFailurePresentation(undefined), "ZCode 请求失败");
});

// Protocol-level: a spawn failure must reject pending requests immediately
// (previously only "exit" was hooked, so ENOENT hung every request for 120s).
test("protocol rejects pending on spawn error and notifies exit listeners", async () => {
  const protocol = require("../server/zcode-protocol.ts");
  const client = new protocol.ZcodeProtocolClient({
    cliPath: "/nonexistent/zcode-cli.mjs",
    nodePath: "/nonexistent/node",
    cwd: process.cwd(),
    onLog: () => {},
  });
  const exits = [];
  client.onProcessExit((info) => exits.push(info));
  const pending = client.request("session/read", { sessionId: "s" }, 5_000);
  await assert.rejects(pending, /ENOENT|spawn/i);
  assert.equal(exits.length, 1);
  assert.ok(exits[0].spawnError, "the spawn error reaches the exit listener");
});
