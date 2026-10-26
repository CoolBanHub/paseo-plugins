import assert from "node:assert/strict";
import { test } from "node:test";
import { syncClaudeModels, type ProviderApi } from "../server/sync.ts";
import type { MenuModel } from "../server/store.ts";
import { ownModelDescription } from "../shared/model-id.ts";

type ConfigState = { providers: Record<string, { additionalModels?: Array<Record<string, unknown>> }> };

function fakePaseo(initial: ConfigState) {
  const state = initial;
  const patches: unknown[] = [];
  const refreshes: string[][] = [];
  const api: ProviderApi = {
    config: {
      get: async () => ({ config: { providers: state.providers } }),
      patch: async (patch: unknown) => {
        patches.push(patch);
        const providers = (patch as { providers?: Record<string, { additionalModels?: Array<Record<string, unknown>> }> }).providers ?? {};
        for (const [id, entry] of Object.entries(providers)) {
          state.providers[id] = { ...(state.providers[id] ?? {}), ...(entry.additionalModels !== undefined ? { additionalModels: entry.additionalModels } : {}) };
        }
        return {};
      },
    },
    providers: { refresh: async (options?: { providers?: string[] }) => { refreshes.push(options?.providers ?? []); return {}; } },
  };
  return { api, state, patches, refreshes };
}

const model = (id: string, label: string, provider: string): MenuModel => ({
  id, label, description: ownModelDescription(provider), provider: { id: provider, label: provider, baseUrl: "https://x", protocol: "anthropic", authHeader: "bearer", enabled: true, models: [], updatedAt: "" },
});

test("places our models next to the person's own entries", async () => {
  const { api, state, patches, refreshes } = fakePaseo({
    providers: { claude: { additionalModels: [
      { id: "my-own-model", label: "我自己的", description: "手动加的" },
      { id: "cm:old-entry", label: "旧的", description: ownModelDescription("DeepSeek") },
    ] } },
  });
  await syncClaudeModels(api, [model("cm:glm-4.6", "GLM-4.6", "GLM")]);
  const entries = state.providers.claude!.additionalModels!;
  assert.deepEqual(entries.map((entry) => entry.id), ["my-own-model", "cm:glm-4.6"]);
  assert.equal(patches.length, 1);
  assert.deepEqual(refreshes, [["claude"]]);
});

test("writes nothing when the stored list already matches", async () => {
  const { api, patches } = fakePaseo({ providers: {} });
  await syncClaudeModels(api, [model("cm:glm-4.6", "GLM-4.6", "GLM")]);
  assert.equal(patches.length, 1);
  // Paseo reorders keys when storing; the canonical compare must still match.
  await syncClaudeModels(api, [{ ...model("cm:glm-4.6", "GLM-4.6", "GLM") }]);
  assert.equal(patches.length, 1);
});

test("an empty model list removes only our entries", async () => {
  const { api, state } = fakePaseo({
    providers: { claude: { additionalModels: [
      { id: "my-own-model", label: "我自己的", description: "手动加的" },
      { id: "cm:glm-4.6", label: "GLM-4.6", description: ownModelDescription("GLM") },
    ] } },
  });
  await syncClaudeModels(api, []);
  assert.deepEqual(state.providers.claude!.additionalModels!.map((entry) => entry.id), ["my-own-model"]);
});

test("a colliding id the person added themselves stays theirs", async () => {
  const { api, state } = fakePaseo({
    providers: { claude: { additionalModels: [{ id: "cm:glm-4.6", label: "占位", description: "手动加的" }] } },
  });
  await syncClaudeModels(api, [model("cm:glm-4.6", "GLM-4.6", "GLM")]);
  assert.deepEqual(state.providers.claude!.additionalModels, [{ id: "cm:glm-4.6", label: "占位", description: "手动加的" }]);
});
