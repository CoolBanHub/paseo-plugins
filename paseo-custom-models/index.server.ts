import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { deleteProviderRpc, listProvidersRpc, saveProviderRpc } from "./shared/contracts.ts";
import type { ProviderInput, ProviderView } from "./shared/contracts.ts";
import { createBridge } from "./server/bridge.ts";
import { claudeSessionEnv, MODEL_SELECTED_ENV, sessionModels, takeSelectedMarker } from "./server/session.ts";
import { syncClaudeModels, type ProviderApi } from "./server/sync.ts";
import { createModelRegistry } from "./server/store.ts";

/**
 * Assembly: providers are configured through RPC from the settings screen,
 * their models join the built-in Claude provider's model picker, and Claude
 * sessions on one of them are routed through the plugin's loopback bridge.
 */

/** The agent's current model, for sessions reopened without our marker. */
async function readAgentModel(paseo: PaseoApi, agentId: string): Promise<string | null> {
  try {
    const result = await paseo.agents.ref(agentId).refresh();
    return result?.agent.model ?? null;
  } catch {
    return null;
  }
}

export default function contribute(server: PluginServerContext) {
  const registry = createModelRegistry();
  const bridge = createBridge({ registry });
  let lastPaseo: ProviderApi | undefined;
  // Menu entries persist in daemon config; one sync per plugin instance
  // catches edits made outside it (plus every save re-syncs).
  let initialSyncDone = false;

  const syncMenu = async (): Promise<void> => {
    if (!lastPaseo) return;
    await syncClaudeModels(lastPaseo, registry.menuModels())
      .catch((error) => console.warn("[custom-models] 模型菜单同步失败", error));
  };
  const ensureSynced = async (): Promise<void> => {
    if (initialSyncDone) return;
    initialSyncDone = true;
    await syncMenu();
  };

  const views = (providers: ProviderView[]) => ({ ok: true, error: null, providers });

  server.handle(listProvidersRpc, async (_input, context) => {
    lastPaseo = context.paseo;
    await ensureSynced();
    return views(registry.views());
  });

  server.handle(saveProviderRpc, async (input: ProviderInput, context) => {
    lastPaseo = context.paseo;
    try {
      await registry.save(input);
      await syncMenu();
      return views(registry.views());
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), providers: registry.views() };
    }
  });

  server.handle(deleteProviderRpc, async (input, context) => {
    lastPaseo = context.paseo;
    try {
      await registry.remove(input.id);
      await syncMenu();
      return views(registry.views());
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), providers: registry.views() };
    }
  });

  // A new Claude session on one of our models: tell the session-open hook,
  // which has no model of its own, to put it on the bridge.
  const removeCreate = server.before("agent.create", ({ request }) => {
    if (request.config.internal) return;
    if (request.config.provider !== "claude") return;
    const model = request.config.model;
    if (typeof model === "string" && registry.isOwnMenuModel(model)) {
      return { ...request, env: { ...request.env, [MODEL_SELECTED_ENV]: model } };
    }
  });

  const removeSessionOpen = server.before("agent.session_open", async ({ request }, context) => {
    if (request.provider !== "claude") return;
    lastPaseo = context.paseo;
    void ensureSynced();
    const { env, selected } = takeSelectedMarker(request.env);
    const plain = { ...request, env };
    // History replays need no bridge and no key.
    if (request.purpose !== "interactive") return selected ? plain : undefined;
    const model = selected ?? (await readAgentModel(context.paseo, request.agentId));
    if (typeof model !== "string" || !registry.isOwnMenuModel(model)) {
      // Reopened on an official Claude model ends the session's bridge route.
      bridge.release(request.agentId);
      return selected ? plain : undefined;
    }
    const provider = registry.providerForModel(model);
    if (!provider) throw new Error("自定义模型不可用：Provider 未启用或 Key 缺失");
    try {
      const route = await bridge.openRoute(request.agentId, model);
      return { ...plain, env: claudeSessionEnv({
        address: route.address,
        capability: route.capability,
        models: sessionModels(provider.models),
        preferred: model,
      }, plain.env) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[custom-models] 会话 ${request.agentId} 打开模型线路失败`, error);
      throw new Error(`自定义模型不可用：${message}`);
    }
  });

  const removeClosed = server.on("agent.closed", (event) => bridge.release(event.agent.id));
  const removeArchived = server.on("agent.archived", (event) => bridge.release(event.agent.id));

  return async () => {
    removeCreate();
    removeSessionOpen();
    removeClosed();
    removeArchived();
    // Leave the picker clean when the plugin goes away; the bridge's saved
    // routes stay on disk so a reload puts live sessions back.
    if (lastPaseo) await syncClaudeModels(lastPaseo, []).catch(() => undefined);
    await bridge.close();
  };
}
