import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBridge } from "../server/bridge.ts";
import { createModelRegistry } from "../server/store.ts";

/**
 * End-to-end over real loopback sockets: a mock vendor behind the bridge,
 * exercised the way Claude Code would (POST /v1/messages with the session's
 * bearer capability).
 */

type Captured = { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: any };

const anthropicSse = [
  'data: {"type":"message_start","message":{"id":"m1","model":"glm-4.6","role":"assistant","content":[],"usage":{"input_tokens":3,"output_tokens":1}}}',
  "",
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  "",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}',
  "",
  'data: {"type":"content_block_stop","index":0}',
  "",
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}',
  "",
  'data: {"type":"message_stop"}',
  "",
].join("\n");

const chatSse = [
  'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"嗨"}}]}',
  "",
  'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":1}}',
  "",
  "data: [DONE]",
  "",
].join("\n");

async function startUpstream(): Promise<{ server: Server; url: string; captured: Captured[]; respond: (handler: (captured: Captured) => { status: number; body: string; type: string }) => void }> {
  const captured: Captured[] = [];
  let handler: (captured: Captured) => { status: number; body: string; type: string } = () => ({ status: 200, body: anthropicSse, type: "text/event-stream" });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let body: any = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; }
      const entry: Captured = { method: request.method ?? "", url: request.url ?? "", headers: request.headers, body };
      captured.push(entry);
      const answer = handler(entry);
      response.writeHead(answer.status, { "content-type": answer.type });
      response.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no upstream port");
  return {
    server, url: `http://127.0.0.1:${address.port}`, captured,
    respond: (next) => { handler = next; },
  };
}

type Fixture = {
  cleanup: () => Promise<void>;
  bridgeUrl: (model: string) => Promise<{ address: string; capability: string }>;
  registry: ReturnType<typeof createModelRegistry>;
  upstream: Awaited<ReturnType<typeof startUpstream>>;
};

async function fixture(providers: Array<{ label: string; protocol: "anthropic" | "chat"; models: string[] }>): Promise<Fixture> {
  const upstream = await startUpstream();
  const directory = mkdtempSync(join(tmpdir(), "custom-models-bridge-"));
  const registry = createModelRegistry({ directory });
  for (const provider of providers) {
    await registry.save({
      label: provider.label, baseUrl: upstream.url, protocol: provider.protocol, authHeader: "bearer",
      enabled: true,
      models: provider.models.map((id) => ({ id, label: id, ...(id.includes("air") ? { contextWindow: 204800 } : {}) })),
      apiKey: "sk-upstream-key",
    });
  }
  const bridge = createBridge({ registry, directory: join(directory), requestTimeoutMs: 5_000 });
  return {
    upstream,
    registry,
    bridgeUrl: async (model: string) => bridge.openRoute("agent-1", model),
    cleanup: async () => {
      await bridge.close();
      await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
    },
  };
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("anthropic protocol passes through with the key and stripped model id", async () => {
  const world = await fixture([{ label: "GLM", protocol: "anthropic", models: ["glm-4.6"] }]);
  try {
    const { address, capability } = await world.bridgeUrl("cm:glm-4.6");
    const response = await post(`${address}/v1/messages?beta=true`, {
      model: "cm:glm-4.6", stream: true, max_tokens: 64,
      messages: [{ role: "user", content: "你好" }],
    }, { authorization: `Bearer ${capability}`, "anthropic-version": "2023-06-01", "anthropic-beta": "interleaved-thinking-2025-05-14, unknown-beta-x" });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type")!.startsWith("text/event-stream"));
    const text = await response.text();
    assert.ok(text.includes("message_start"));
    assert.ok(text.includes("你好"));
    const seen = world.upstream.captured[0]!;
    assert.equal(seen.url, "/v1/messages");
    assert.equal(seen.body.model, "glm-4.6");
    assert.equal(seen.headers.authorization, "Bearer sk-upstream-key");
    assert.equal(seen.headers["anthropic-version"], "2023-06-01");
    // Only whitelisted beta features travel upstream.
    assert.equal(seen.headers["anthropic-beta"], "interleaved-thinking-2025-05-14");
  } finally {
    await world.cleanup();
  }
});

test("the [1m] window switch never reaches the vendor", async () => {
  const world = await fixture([{ label: "GLM", protocol: "anthropic", models: ["glm-5.3[1m]", "glm-5.3-flash"] }]);
  try {
    const { address, capability } = await world.bridgeUrl("cm:glm-5.3[1m]");
    const response = await post(`${address}/v1/messages`, {
      model: "cm:glm-5.3[1m]", stream: false, max_tokens: 16, messages: [],
    }, { authorization: `Bearer ${capability}` });
    assert.equal(response.status, 200);
    assert.equal(world.upstream.captured[0]!.body.model, "glm-5.3");
  } finally {
    await world.cleanup();
  }
});

test("a wrong capability is rejected", async () => {
  const world = await fixture([{ label: "GLM", protocol: "anthropic", models: ["glm-4.6"] }]);
  try {
    const { address } = await world.bridgeUrl("cm:glm-4.6");
    const response = await post(`${address}/v1/messages`, { model: "cm:glm-4.6", messages: [] }, { authorization: "Bearer wrong" });
    assert.equal(response.status, 403);
  } finally {
    await world.cleanup();
  }
});

test("claude aliases land on the provider's strong model", async () => {
  const world = await fixture([{ label: "GLM", protocol: "anthropic", models: ["glm-4.6", "glm-4.5-air"] }]);
  try {
    const { address, capability } = await world.bridgeUrl("cm:glm-4.6");
    const response = await post(`${address}/v1/messages`, {
      model: "claude-3-5-haiku-latest", stream: false, max_tokens: 16, messages: [],
    }, { authorization: `Bearer ${capability}` });
    assert.equal(response.status, 200);
    assert.equal(world.upstream.captured[0]!.body.model, "glm-4.5-air");
  } finally {
    await world.cleanup();
  }
});

test("chat protocol is converted to anthropic events", async () => {
  const world = await fixture([{ label: "OpenAI 兼容", protocol: "chat", models: ["qwen3-coder-plus"] }]);
  try {
    world.upstream.respond(() => ({ status: 200, body: chatSse, type: "text/event-stream" }));
    const { address, capability } = await world.bridgeUrl("cm:qwen3-coder-plus");
    const response = await post(`${address}/v1/messages`, {
      model: "cm:qwen3-coder-plus", stream: true, max_tokens: 64,
      messages: [{ role: "user", content: "嗨" }],
    }, { authorization: `Bearer ${capability}` });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(text.includes("message_start"));
    assert.ok(text.includes("嗨"));
    assert.ok(text.includes("message_stop"));
    const seen = world.upstream.captured[0]!;
    assert.equal(seen.url, "/v1/chat/completions");
    assert.equal(seen.body.model, "qwen3-coder-plus");
  } finally {
    await world.cleanup();
  }
});

test("count_tokens falls back to a local estimate", async () => {
  const world = await fixture([
    { label: "GLM", protocol: "anthropic", models: ["glm-4.6"] },
    { label: "OpenAI 兼容", protocol: "chat", models: ["qwen3-coder-plus"] },
  ]);
  try {
    world.upstream.respond(() => ({ status: 404, body: "{}", type: "application/json" }));
    const glm = await world.bridgeUrl("cm:glm-4.6");
    const passed = await post(`${glm.address}/v1/messages/count_tokens`, {
      model: "cm:glm-4.6", messages: [{ role: "user", content: "hello" }],
    }, { authorization: `Bearer ${glm.capability}` });
    assert.equal(passed.status, 200);
    assert.ok((JSON.parse(await passed.text()) as { input_tokens: number }).input_tokens >= 1);

    // A chat route never asks upstream at all.
    const chat = await world.bridgeUrl("cm:qwen3-coder-plus");
    const estimated = await post(`${chat.address}/v1/messages/count_tokens`, {
      model: "cm:qwen3-coder-plus", messages: [{ role: "user", content: "hello" }],
    }, { authorization: `Bearer ${chat.capability}` });
    assert.equal(estimated.status, 200);
    assert.equal(world.upstream.captured.length, 1); // only the 404 probe from above
  } finally {
    await world.cleanup();
  }
});

test("vendor errors keep their status and shape", async () => {
  const world = await fixture([{ label: "GLM", protocol: "anthropic", models: ["glm-4.6"] }]);
  try {
    world.upstream.respond(() => ({
      status: 529,
      body: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "过载" } }),
      type: "application/json",
    }));
    const { address, capability } = await world.bridgeUrl("cm:glm-4.6");
    const response = await post(`${address}/v1/messages`, {
      model: "cm:glm-4.6", stream: false, max_tokens: 16, messages: [],
    }, { authorization: `Bearer ${capability}` });
    assert.equal(response.status, 529);
    const parsed = JSON.parse(await response.text()) as { error: { type: string; message: string } };
    assert.equal(parsed.error.type, "overloaded_error");
    assert.equal(parsed.error.message, "过载");
  } finally {
    await world.cleanup();
  }
});

test("routes survive a bridge restart on the same port", async () => {
  const directory = mkdtempSync(join(tmpdir(), "custom-models-reload-"));
  const upstream = await startUpstream();
  const registry = createModelRegistry({ directory });
  await registry.save({
    label: "GLM", baseUrl: upstream.url, protocol: "anthropic", authHeader: "bearer", enabled: true,
    models: [{ id: "glm-4.6", label: "GLM-4.6" }], apiKey: "sk-upstream-key",
  });
  const first = createBridge({ registry, directory });
  const opened = await first.openRoute("agent-1", "cm:glm-4.6");
  await first.close();

  // A new instance (plugin reload) must rebind the same port and route.
  const second = createBridge({ registry, directory });
  try {
    const reopened = await second.openRoute("agent-2", "cm:glm-4.6");
    const portOf = (address: string) => Number(new URL(address).port);
    assert.equal(portOf(reopened.address), portOf(opened.address));
    // The old session's capability still works on the restored route.
    const response = await post(`${opened.address}/v1/messages`, {
      model: "cm:glm-4.6", stream: false, max_tokens: 16, messages: [],
    }, { authorization: `Bearer ${opened.capability}` });
    assert.equal(response.status, 200);
  } finally {
    await second.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
});
