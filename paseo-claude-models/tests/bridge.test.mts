import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBridge } from "../server/bridge.ts";
import { createModelRegistry } from "../server/store.ts";
import { menuModelId } from "../shared/model-id.ts";

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

type Upstream = Awaited<ReturnType<typeof startUpstream>>;

type Fixture = {
  cleanup: () => Promise<void>;
  bridgeUrl: (model: string, agentId?: string) => Promise<{ address: string; capability: string }>;
  registry: ReturnType<typeof createModelRegistry>;
  /** The shared mock vendor every provider without its own one uses. */
  upstream: Upstream;
  /** The mock vendor a saved provider actually posts to. */
  upstreamOf: (providerId: string) => Upstream;
  /** The provider id the registry assigned a label (its menu-id scope). */
  idOf: (label: string) => string;
};

async function fixture(
  providers: Array<{ label: string; protocol: "anthropic" | "chat"; models: string[]; upstream?: Upstream; apiKey?: string }>,
): Promise<Fixture> {
  const shared = await startUpstream();
  const upstreams = new Map<string, Upstream>();
  const ids = new Map<string, string>();
  const directory = mkdtempSync(join(tmpdir(), "custom-models-bridge-"));
  const registry = createModelRegistry({ directory });
  for (const provider of providers) {
    const saved = await registry.save({
      label: provider.label, baseUrl: (provider.upstream ?? shared).url, protocol: provider.protocol, authHeader: "bearer",
      enabled: true,
      models: provider.models.map((id) => ({ id, label: id, ...(id.includes("air") ? { contextWindow: 204800 } : {}) })),
      apiKey: provider.apiKey ?? "sk-upstream-key",
    });
    ids.set(provider.label, saved.id);
    upstreams.set(saved.id, provider.upstream ?? shared);
  }
  const bridge = createBridge({ registry, directory: join(directory), requestTimeoutMs: 5_000 });
  return {
    upstream: shared,
    upstreamOf: (providerId) => upstreams.get(providerId) ?? shared,
    idOf: (label) => {
      const id = ids.get(label);
      if (!id) throw new Error(`no provider saved for label ${label}`);
      return id;
    },
    registry,
    bridgeUrl: async (model: string, agentId = "agent-1") => bridge.openRoute(agentId, model),
    cleanup: async () => {
      await bridge.close();
      // The shared mock is closed even when no provider ended up using it.
      for (const upstream of new Set([shared, ...upstreams.values()])) {
        await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
      }
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
    const glm = menuModelId(world.idOf("GLM"), "glm-4.6");
    const { address, capability } = await world.bridgeUrl(glm);
    const response = await post(`${address}/v1/messages?beta=true`, {
      model: glm, stream: true, max_tokens: 64,
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
    const glm = menuModelId(world.idOf("GLM"), "glm-5.3[1m]");
    const { address, capability } = await world.bridgeUrl(glm);
    const response = await post(`${address}/v1/messages`, {
      model: glm, stream: false, max_tokens: 16, messages: [],
    }, { authorization: `Bearer ${capability}` });
    assert.equal(response.status, 200);
    assert.equal(world.upstream.captured[0]!.body.model, "glm-5.3");
  } finally {
    await world.cleanup();
  }
});

test("two providers listing the same model id are both routable", async () => {
  const upstreamA = await startUpstream();
  const upstreamB = await startUpstream();
  const world = await fixture([
    { label: "A", protocol: "anthropic", models: ["shared-model"], upstream: upstreamA, apiKey: "sk-key-aaaaaaaa" },
    { label: "B", protocol: "anthropic", models: ["shared-model"], upstream: upstreamB, apiKey: "sk-key-bbbbbbbb" },
  ]);
  try {
    const menuA = menuModelId(world.idOf("A"), "shared-model");
    const menuB = menuModelId(world.idOf("B"), "shared-model");
    assert.deepEqual(world.registry.menuModels().map((model) => model.id), [menuA, menuB]);
    const routeA = await world.bridgeUrl(menuA, "agent-a");
    const routeB = await world.bridgeUrl(menuB, "agent-b");
    for (const [route, menuId] of [[routeA, menuA], [routeB, menuB]] as const) {
      const response = await post(`${route.address}/v1/messages`, {
        model: menuId, stream: false, max_tokens: 16, messages: [],
      }, { authorization: `Bearer ${route.capability}` });
      assert.equal(response.status, 200);
    }
    // Each request reached its own provider's vendor, with its own key and
    // the scope stripped from the model id.
    assert.equal(upstreamA.captured.length, 1);
    assert.equal(upstreamA.captured[0]!.body.model, "shared-model");
    assert.equal(upstreamA.captured[0]!.headers.authorization, "Bearer sk-key-aaaaaaaa");
    assert.equal(upstreamB.captured.length, 1);
    assert.equal(upstreamB.captured[0]!.body.model, "shared-model");
    assert.equal(upstreamB.captured[0]!.headers.authorization, "Bearer sk-key-bbbbbbbb");
  } finally {
    await world.cleanup();
    for (const upstream of [upstreamA, upstreamB]) {
      await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
    }
  }
});

test("unscoped ids route to the first enabled owner and follow it when disabled", async () => {
  const upstreamA = await startUpstream();
  const upstreamB = await startUpstream();
  const world = await fixture([
    { label: "A", protocol: "anthropic", models: ["shared-model"], upstream: upstreamA, apiKey: "sk-key-aaaaaaaa" },
    { label: "B", protocol: "anthropic", models: ["shared-model"], upstream: upstreamB, apiKey: "sk-key-bbbbbbbb" },
  ]);
  try {
    // A menu id from before provider scopes resolves to the first owner.
    const { address, capability } = await world.bridgeUrl("cm:shared-model");
    const response = await post(`${address}/v1/messages`, {
      model: "cm:shared-model", stream: false, max_tokens: 16, messages: [],
    }, { authorization: `Bearer ${capability}` });
    assert.equal(response.status, 200);
    assert.equal(upstreamA.captured.length, 1);

    // With A disabled, both the unscoped id and A's scoped one land on B.
    await world.registry.save({
      id: world.idOf("A"), label: "A", baseUrl: upstreamA.url, protocol: "anthropic", authHeader: "bearer",
      enabled: false, models: [{ id: "shared-model", label: "shared-model" }],
    });
    const again = await post(`${address}/v1/messages`, {
      model: "cm:shared-model", stream: false, max_tokens: 16, messages: [],
    }, { authorization: `Bearer ${capability}` });
    assert.equal(again.status, 200);
    const scoped = await post(`${address}/v1/messages`, {
      model: menuModelId(world.idOf("A"), "shared-model"), stream: false, max_tokens: 16, messages: [],
    }, { authorization: `Bearer ${capability}` });
    assert.equal(scoped.status, 200);
    assert.equal(upstreamA.captured.length, 1); // A's vendor saw nothing more
    assert.equal(upstreamB.captured.length, 2);
  } finally {
    await world.cleanup();
    for (const upstream of [upstreamA, upstreamB]) {
      await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
    }
  }
});

test("a wrong capability is rejected", async () => {
  const world = await fixture([{ label: "GLM", protocol: "anthropic", models: ["glm-4.6"] }]);
  try {
    const { address } = await world.bridgeUrl(menuModelId(world.idOf("GLM"), "glm-4.6"));
    const response = await post(`${address}/v1/messages`, { model: "cm:glm/glm-4.6", messages: [] }, { authorization: "Bearer wrong" });
    assert.equal(response.status, 403);
  } finally {
    await world.cleanup();
  }
});

test("claude aliases land on the provider's strong model", async () => {
  const world = await fixture([{ label: "GLM", protocol: "anthropic", models: ["glm-4.6", "glm-4.5-air"] }]);
  try {
    const { address, capability } = await world.bridgeUrl(menuModelId(world.idOf("GLM"), "glm-4.6"));
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
    const menu = menuModelId(world.idOf("OpenAI 兼容"), "qwen3-coder-plus");
    const { address, capability } = await world.bridgeUrl(menu);
    const response = await post(`${address}/v1/messages`, {
      model: menu, stream: true, max_tokens: 64,
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
    const glmMenu = menuModelId(world.idOf("GLM"), "glm-4.6");
    const glm = await world.bridgeUrl(glmMenu, "agent-glm");
    const passed = await post(`${glm.address}/v1/messages/count_tokens`, {
      model: glmMenu, messages: [{ role: "user", content: "hello" }],
    }, { authorization: `Bearer ${glm.capability}` });
    assert.equal(passed.status, 200);
    assert.ok((JSON.parse(await passed.text()) as { input_tokens: number }).input_tokens >= 1);

    // A chat route never asks upstream at all.
    const chatMenu = menuModelId(world.idOf("OpenAI 兼容"), "qwen3-coder-plus");
    const chat = await world.bridgeUrl(chatMenu, "agent-chat");
    const estimated = await post(`${chat.address}/v1/messages/count_tokens`, {
      model: chatMenu, messages: [{ role: "user", content: "hello" }],
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
    const menu = menuModelId(world.idOf("GLM"), "glm-4.6");
    const { address, capability } = await world.bridgeUrl(menu);
    const response = await post(`${address}/v1/messages`, {
      model: menu, stream: false, max_tokens: 16, messages: [],
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
  const saved = await registry.save({
    label: "GLM", baseUrl: upstream.url, protocol: "anthropic", authHeader: "bearer", enabled: true,
    models: [{ id: "glm-4.6", label: "GLM-4.6" }], apiKey: "sk-upstream-key",
  });
  const menu = menuModelId(saved.id, "glm-4.6");
  const first = createBridge({ registry, directory });
  const opened = await first.openRoute("agent-1", menu);
  await first.close();

  // A new instance (plugin reload) must rebind the same port and route.
  const second = createBridge({ registry, directory });
  try {
    const reopened = await second.openRoute("agent-2", menu);
    const portOf = (address: string) => Number(new URL(address).port);
    assert.equal(portOf(reopened.address), portOf(opened.address));
    // The old session's capability still works on the restored route, and a
    // model id from before provider scopes still reaches the vendor.
    const response = await post(`${opened.address}/v1/messages`, {
      model: "cm:glm-4.6", stream: false, max_tokens: 16, messages: [],
    }, { authorization: `Bearer ${opened.capability}` });
    assert.equal(response.status, 200);
    assert.equal(upstream.captured[0]!.body.model, "glm-4.6");
  } finally {
    await second.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
});
