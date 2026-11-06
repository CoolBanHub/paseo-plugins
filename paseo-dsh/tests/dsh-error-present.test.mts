import assert from "node:assert/strict";
import test from "node:test";
import { dshFailurePresentation, dshFailureText } from "../server/dsh-error-present.ts";

test("maps stable dsh failure codes to short Chinese guidance", () => {
  assert.equal(dshFailureText({ code: "QUOTA" }), "账号额度或余额已用尽");
  assert.equal(
    dshFailureText({ code: "CONTEXT_WINDOW_EXCEEDED" }),
    "上下文窗口已超限，请压缩上下文或开启新会话",
  );
  assert.equal(dshFailureText({ code: "UNKNOWN_CODE" }), undefined);
  assert.equal(dshFailureText(undefined), undefined);
});

test("presentation prefers the mapped code and appends the HTTP status", () => {
  assert.equal(
    dshFailurePresentation({ code: "RATE_LIMIT", status: 429 }),
    "模型请求过于频繁，已被限流（HTTP 429）",
  );
  assert.equal(
    dshFailurePresentation({ code: "WEIRD", message: "provider text" }),
    "provider text",
  );
  assert.equal(dshFailurePresentation(undefined), "dsh 回合未完成");
  assert.equal(dshFailurePresentation({}), "dsh 回合未完成");
});
