import assert from "node:assert/strict";
import { test } from "node:test";
import { testVendorModel } from "../server/test-model.ts";

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

test("an anthropic round-trip reports latency and the reply", async () => {
  const result = await testVendorModel({
    baseUrl: "https://api.deepseek.com/anthropic/",
    protocol: "anthropic",
    authHeader: "bearer",
    key: "sk-test-key-0001",
    model: "deepseek-v4-pro[1m]",
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), "https://api.deepseek.com/anthropic/v1/messages");
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.authorization, "Bearer sk-test-key-0001");
      assert.equal(headers["anthropic-version"], "2023-06-01");
      // The [1m] switch never reaches the vendor.
      assert.equal(JSON.parse(String(init?.body)).model, "deepseek-v4-pro");
      return jsonResponse(200, { content: [{ type: "text", text: "ok" }] });
    }) as typeof fetch,
  });
  assert.equal(result.ok, true);
  assert.equal((result as { reply: string }).reply, "ok");
  assert.ok((result as { latencyMs: number }).latencyMs >= 0);
});

test("a chat round-trip reads choices and speaks x-api-key", async () => {
  const result = await testVendorModel({
    baseUrl: "http://127.0.0.1:8",
    protocol: "chat",
    authHeader: "x-api-key",
    key: "sk-test-key-0002",
    model: "qwen3-coder-plus",
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), "http://127.0.0.1:8/v1/chat/completions");
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers["x-api-key"], "sk-test-key-0002");
      return jsonResponse(200, { choices: [{ message: { content: "  ok  " } }] });
    }) as typeof fetch,
  });
  assert.equal(result.ok, true);
  assert.equal((result as { reply: string }).reply, "ok");
});

test("vendor failures surface their own message", async () => {
  const cases: Array<{ status: number; body: unknown; expect: RegExp }> = [
    { status: 401, body: { error: { type: "authentication_error", message: "Invalid API key" } }, expect: /API Key 无效.*Invalid API key/ },
    { status: 404, body: { error: { type: "not_found_error", message: "Model Not Exist" } }, expect: /404.*Model Not Exist/ },
    { status: 500, body: "oops", expect: /500/ },
  ];
  for (const testCase of cases) {
    const result = await testVendorModel({
      baseUrl: "https://api.example.com",
      protocol: "anthropic",
      authHeader: "bearer",
      key: "sk-test-key-0003",
      model: "glm-5.3",
      fetchImpl: (async () => jsonResponse(testCase.status, testCase.body)) as typeof fetch,
    });
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, testCase.expect);
  }
});

test("a missing model id fails before any request", async () => {
  const result = await testVendorModel({
    baseUrl: "https://api.example.com",
    protocol: "anthropic",
    authHeader: "bearer",
    key: "sk-test-key-0004",
    model: "  ",
    fetchImpl: (async () => { throw new Error("should not be called"); }) as typeof fetch,
  });
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /模型 ID/);
});
