import assert from "node:assert/strict";
import { test } from "node:test";
import { expandFetchedModels, fetchVendorModels } from "../server/fetch-models.ts";

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

test("fetched ids gain the presets' knowledge and 1M variants", () => {
  const models = expandFetchedModels([
    "glm-4.6", "glm-5.3", "deepseek-chat", "some-unknown-model", "", "../etc/passwd", 42, "glm-4.6",
  ]);
  assert.deepEqual(models, [
    // Preset match fills label and window; GLM's preset knows a 1M variant.
    { id: "glm-4.6", label: "GLM-4.6", contextWindow: 204800 },
    { id: "glm-5.3", label: "GLM-5.3" },
    { id: "glm-5.3[1m]", label: "GLM-5.3 1M", contextWindow: 1000000 },
    { id: "deepseek-chat", label: "DeepSeek Chat", contextWindow: 131072 },
    { id: "some-unknown-model" },
  ]);
});

test("fetch parses the shared OpenAI/Anthropic list shape", async () => {
  const result = await fetchVendorModels({
    baseUrl: "https://api.example.com/",
    authHeader: "bearer",
    key: "sk-example-key",
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), "https://api.example.com/v1/models");
      assert.equal(init?.method, "GET");
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer sk-example-key");
      return jsonResponse(200, { data: [
        { id: "glm-4.6" },
        { id: "selfhosted-70b", context_length: 131072 },
        { id: "bad/../id" },
      ] });
    }) as typeof fetch,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.models, [
    { id: "glm-4.6", label: "GLM-4.6", contextWindow: 204800 },
    // A gateway-provided window wins when no preset knows the model.
    { id: "selfhosted-70b", contextWindow: 131072 },
  ]);
});

test("fetch speaks x-api-key and maps vendor failures to hints", async () => {
  const seenHeaders: string[] = [];
  const failWith = (status: number) => (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seenHeaders.push((init?.headers as Record<string, string>)["x-api-key"] ?? "");
    return jsonResponse(status, {});
  }) as typeof fetch;
  const keyAuth = { baseUrl: "https://api.example.com", authHeader: "x-api-key" as const, key: "sk-xkey-000001" };

  const unauthorized = await fetchVendorModels({ ...keyAuth, fetchImpl: failWith(401) });
  assert.equal(unauthorized.ok, false);
  assert.equal((unauthorized as { error: string }).error, "API Key 无效或无权限");
  assert.equal(seenHeaders[0], "sk-xkey-000001");

  const missing = await fetchVendorModels({ ...keyAuth, fetchImpl: failWith(404) });
  assert.equal((missing as { error: string }).error, "该端点不提供模型列表，请手动添加模型");

  const odd = await fetchVendorModels({ ...keyAuth, fetchImpl: (async () => jsonResponse(200, { nope: true })) as typeof fetch });
  assert.equal((odd as { error: string }).error, "端点返回的模型列表格式无法识别");
});
