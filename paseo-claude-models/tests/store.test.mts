import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createModelRegistry, normalizeApiKey, normalizeBaseUrl } from "../server/store.ts";
import { PROVIDER_PRESETS } from "../shared/presets.ts";

const directories: string[] = [];
const registryIn = () => {
  const directory = mkdtempSync(join(tmpdir(), "custom-models-"));
  directories.push(directory);
  return createModelRegistry({ directory, now: () => "2026-10-26T00:00:00.000Z" });
};
afterEach(() => {
  for (const directory of directories.splice(0)) {
    // tmp cleanup is best-effort; the OS reaps its temp dir anyway.
    try { statSync(directory); } catch { /* gone */ }
  }
});

const glmPreset = PROVIDER_PRESETS.find((preset) => preset.id === "glm")!;

test("baseUrl validation: https except loopback, no credentials or query", () => {
  assert.equal(normalizeBaseUrl("https://api.deepseek.com/anthropic"), "https://api.deepseek.com/anthropic");
  assert.equal(normalizeBaseUrl("http://127.0.0.1:8000/v1/"), "http://127.0.0.1:8000/v1");
  assert.equal(normalizeBaseUrl("http://localhost:11434"), "http://localhost:11434");
  assert.throws(() => normalizeBaseUrl("http://api.deepseek.com/anthropic"), /https/);
  assert.throws(() => normalizeBaseUrl("ftp://example.com"), /http/);
  assert.throws(() => normalizeBaseUrl("https://user:pass@example.com"), /账号密码/);
  assert.throws(() => normalizeBaseUrl("https://example.com/?q=1"), /查询参数/);
  assert.throws(() => normalizeBaseUrl("not a url"), /格式/);
});

test("api keys are trimmed and shape-checked", () => {
  assert.equal(normalizeApiKey("  sk-abcdef1234  "), "sk-abcdef1234");
  assert.throws(() => normalizeApiKey("short"), /格式/);
  assert.throws(() => normalizeApiKey("has space inside"), /格式/);
});

test("save persists config and key, views never expose the key", async () => {
  const registry = registryIn();
  const saved = await registry.save({
    label: glmPreset.label, baseUrl: glmPreset.baseUrl, protocol: "anthropic", authHeader: "bearer",
    enabled: true, models: glmPreset.models.map((model) => ({ ...model })), apiKey: "sk-test-key-1234",
  });
  assert.equal(saved.id, "glm");
  const [view] = registry.views();
  assert.ok(view);
  assert.equal(view.keyConfigured, true);
  assert.equal(view.keyHint, "••••1234");
  assert.equal(view.models.length, glmPreset.models.length);
  // The key file itself is 0600 and inside the registry directory.
  assert.equal(readFileSync(join(registry.root, "keys", "glm.secret"), "utf8"), "sk-test-key-1234\n");
  assert.equal(registry.apiKey("glm"), "sk-test-key-1234");
});

test("save without a stored key refuses; empty key keeps the stored one", async () => {
  const registry = registryIn();
  const input = {
    label: "Kimi", baseUrl: "https://api.moonshot.ai/anthropic", protocol: "anthropic" as const,
    authHeader: "bearer" as const, enabled: true,
    models: [{ id: "kimi-k2.5", label: "Kimi K2.5", contextWindow: 262144 }],
  };
  await assert.rejects(() => registry.save(input), /API Key/);
  await registry.save({ ...input, apiKey: "sk-kimi-key-9999" });
  // An edit without an apiKey keeps the stored key.
  await registry.save({ ...input, id: "kimi" });
  assert.equal(registry.apiKey("kimi"), "sk-kimi-key-9999");
  assert.equal(registry.list().length, 1);
});

test("ids stay unique and stable across edits", async () => {
  const registry = registryIn();
  const base = {
    baseUrl: "https://example.com", protocol: "anthropic" as const, authHeader: "bearer" as const,
    enabled: true, models: [{ id: "m1", label: "M1" }], apiKey: "sk-key-0000001",
  };
  await registry.save({ ...base, label: "GLM" });
  await registry.save({ ...base, label: "GLM" });
  const renamed = await registry.save({ ...base, id: "glm", label: "智谱 GLM" });
  assert.equal(renamed.id, "glm");
  assert.deepEqual(registry.list().map((provider) => provider.id).sort(), ["glm-2", "glm"].sort());
  assert.equal(registry.list().length, 2);
});

test("menu models come only from enabled providers with keys, first listing wins", async () => {
  const registry = registryIn();
  await registry.save({
    label: "A", baseUrl: "https://a.example.com", protocol: "anthropic", authHeader: "bearer",
    enabled: true, models: [{ id: "shared-model", label: "Shared A" }, { id: "only-a", label: "Only A" }],
    apiKey: "sk-key-aaaaaaaa",
  });
  await registry.save({
    label: "B", baseUrl: "https://b.example.com", protocol: "anthropic", authHeader: "bearer",
    enabled: true, models: [{ id: "shared-model", label: "Shared B" }], apiKey: "sk-key-bbbbbbbb",
  });
  const menu = registry.menuModels();
  assert.deepEqual(menu.map((model) => model.id), ["cm:shared-model", "cm:only-a"]);
  assert.equal(menu[0]!.label, "Shared A");
  assert.equal(menu[0]!.description, "自定义模型 · A");
  assert.equal(menu[0]!.provider.label, "A");
  assert.equal(registry.isOwnMenuModel("cm:only-a"), true);
  assert.equal(registry.isOwnMenuModel("cm:missing"), false);

  // A disabled provider leaves the menu.
  await registry.save({
    id: "a", label: "A", baseUrl: "https://a.example.com", protocol: "anthropic", authHeader: "bearer",
    enabled: false, models: [{ id: "shared-model", label: "Shared A" }, { id: "only-a", label: "Only A" }],
  });
  assert.deepEqual(registry.menuModels().map((model) => model.id), ["cm:shared-model"]);
  assert.equal(registry.providerForModel("cm:shared-model")!.label, "B");
});

test("remove deletes config and key", async () => {
  const registry = registryIn();
  await registry.save({
    label: "DeepSeek", baseUrl: "https://api.deepseek.com/anthropic", protocol: "anthropic",
    authHeader: "bearer", enabled: true, models: [{ id: "deepseek-chat", label: "Chat" }], apiKey: "sk-key-ccccccc",
  });
  assert.equal(await registry.remove("deepseek"), true);
  assert.equal(await registry.remove("deepseek"), false);
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.apiKey("deepseek"), null);
});

test("env and alias overrides persist and are validated", async () => {
  const registry = registryIn();
  const base = {
    label: "GLM", baseUrl: "https://open.bigmodel.cn/api/anthropic", protocol: "anthropic" as const,
    authHeader: "bearer" as const, enabled: true,
    models: [{ id: "glm-5.3[1m]", label: "GLM-5.3 1M" }, { id: "glm-5.3", label: "GLM-5.3" }],
    apiKey: "sk-glm-key-000001",
  };
  const saved = await registry.save({
    ...base,
    env: { Z_AI_API_KEY: "${API_KEY}", Z_AI_BASE_URL: "https://open.bigmodel.cn/api/coding/paas/v4/" },
    aliasOverrides: { opus: "glm-5.3[1m]", haiku: "glm-5.3" },
  });
  assert.deepEqual(saved.env, { Z_AI_API_KEY: "${API_KEY}", Z_AI_BASE_URL: "https://open.bigmodel.cn/api/coding/paas/v4/" });
  assert.deepEqual(saved.aliasOverrides, { opus: "glm-5.3[1m]", haiku: "glm-5.3" });
  const [view] = registry.views();
  assert.equal(view!.env.Z_AI_API_KEY, "${API_KEY}");
  assert.equal(view!.aliasOverrides.opus, "glm-5.3[1m]");

  // The bridge-owned endpoint vars are refused; a bad alias is refused too.
  await assert.rejects(
    () => registry.save({ ...base, env: { ANTHROPIC_BASE_URL: "https://elsewhere.example.com" } }),
    /接管/,
  );
  await assert.rejects(
    () => registry.save({ ...base, aliasOverrides: { sonnet: "glm-9.9" } }),
    /不在列表里/,
  );
});
