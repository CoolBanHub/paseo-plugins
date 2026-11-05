import type { PluginServerContext } from "@getpaseo/plugin/server";
import { larkBotChatsRpc, larkBotProvidersRpc, larkBotStatusRpc } from "./shared/contracts.ts";
import { createEventConsumer, type EventConsumer } from "./server/lark-events.ts";
import { applyAppCredentials, listChats, readCurrentAppId, resolveLarkCli } from "./server/lark.ts";
import { createDispatcher, type Dispatcher } from "./server/dispatcher.ts";
import type { SessionPaseoApi } from "./server/sessions.ts";
import { DEFAULT_BOT_VALUES, larkBotSettings, type BotValues } from "./shared/settings.ts";

/**
 * The daemon hands each hook/RPC call its own PaseoApi handle; there is no
 * instance on the contribution context. Capture the first one seen — agent
 * activity fires lifecycle hooks immediately, and the settings screen calls
 * the status RPC, so in practice the API is available before any chat message
 * needs a session.
 */
let paseo: SessionPaseoApi | null = null;
let dispatcher: Dispatcher | null = null;
let consumer: EventConsumer | null = null;
let consumerCli: string | null = null;
/** AppId confirmed written into lark-cli during this plugin lifetime. */
let appliedAppId: string | null = null;
let currentAppIdCache: string | null = null;
/** provider → provider/<default-model>, filled lazily per daemon lifetime. */
const providerModelCache = new Map<string, string>();

/**
 * Daemons since 0.15 reject bare provider ids in agents.create(); resolve
 * `dsh` to `dsh/<default-model>` using the provider snapshot. Older hosts
 * without the providers slice keep the input unchanged.
 */
async function resolveProviderModel(provider: string): Promise<string> {
  if (provider.includes("/")) return provider;
  const cached = providerModelCache.get(provider);
  if (cached) return cached;
  if (!paseo?.providers) return provider;
  try {
    const snapshot = await paseo.providers.waitForReady({ timeoutMs: 5_000 });
    const entry = snapshot.entries.find((candidate) => candidate.provider === provider);
    const model = entry?.models?.find((candidate) => candidate.isDefault)?.id ?? entry?.models?.[0]?.id;
    if (!model) return provider;
    const full = provider + "/" + model;
    providerModelCache.set(provider, full);
    return full;
  } catch {
    return provider;
  }
}

function ensureDispatcher(api: SessionPaseoApi, readValues: () => Promise<BotValues>): Dispatcher {
  paseo = api;
  if (!dispatcher) {
    dispatcher = createDispatcher({
      paseo: api,
      readValues,
      resolveProvider: resolveProviderModel,
      fetchLastReply: async (agentId: string) => {
        try {
          const payload = await api.agents.ref(agentId).timeline?.refetch({ limit: 30 });
          const entries = payload?.entries ?? [];
          for (let index = entries.length - 1; index >= 0; index -= 1) {
            const entry = entries[index];
            if (entry?.type === "assistant_message" && entry.text?.trim()) return entry.text.trim();
          }
        } catch {
          // Older hosts or missing permissions degrade to the plain notice.
        }
        return null;
      },
    });
  }
  return dispatcher;
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(larkBotSettings);

  const readValues = async (): Promise<BotValues> => {
    const state = await settings.read();
    return state.status === "ready" ? state.values : DEFAULT_BOT_VALUES;
  };

  const log = (message: string, detail?: unknown): void => {
    console.log("[lark-bot] " + message, detail === undefined ? "" : detail);
  };

  // Apply user-configured app credentials before anything talks to Feishu:
  // validate against the token endpoint, then write into lark-cli. Failures
  // never clobber the working keychain config and fall back to it.
  const applyCredentials = async (values: BotValues, cliPath: string | null): Promise<void> => {
    const wanted = values.appId.trim();
    if (!wanted || !values.appSecret || !cliPath || appliedAppId === wanted) return;
    try {
      const current = await readCurrentAppId(cliPath);
      currentAppIdCache = current;
      if (current !== wanted) {
        await applyAppCredentials({ cliPath, appId: wanted, appSecret: values.appSecret });
        log("已应用飞书应用凭证 " + wanted);
        currentAppIdCache = wanted;
        // The event bus was restarted; force a fresh consumer connection.
        await consumer?.stop();
        consumer = null;
        consumerCli = null;
      }
      appliedAppId = wanted;
    } catch (error) {
      log("应用飞书应用凭证失败，继续使用 lark-cli 现有配置", error instanceof Error ? error.message : String(error));
    }
  };

  // Start or stop the event consumer to match the current bindings; a changed
  // lark-cli path rebuilds it so the child process picks up the new binary.
  const syncConsumer = async (): Promise<void> => {
    const values = await readValues();
    const cliPath = resolveLarkCli(values.larkCliPath);
    await applyCredentials(values, cliPath);
    if (values.chats.length === 0) {
      await consumer?.stop();
      consumer = null;
      consumerCli = null;
      return;
    }
    if (!cliPath) return;
    if (consumer && consumerCli === cliPath) {
      consumer.start();
      return;
    }
    await consumer?.stop();
    consumerCli = cliPath;
    consumer = createEventConsumer({
      cliPath,
      onEvent: (event) => {
        if (dispatcher) void dispatcher.handleMessageEvent(event);
      },
    });
    consumer.start();
  };

  void syncConsumer();
  const offSettings = settings.subscribe(() => {
    void syncConsumer();
  });

  const capture = (api: unknown): void => {
    if (paseo || !api) return;
    ensureDispatcher(api as SessionPaseoApi, readValues);
  };

  server.handle(larkBotChatsRpc, async (_input, context) => {
    capture(context.paseo);
    const cliPath = resolveLarkCli((await readValues()).larkCliPath);
    if (!cliPath) return { chats: [], error: "找不到 lark-cli" };
    try {
      return { chats: await listChats(cliPath), error: null };
    } catch (error) {
      return { chats: [], error: error instanceof Error ? error.message : String(error) };
    }
  });

  server.handle(larkBotProvidersRpc, async (_input, context) => {
    capture(context.paseo);
    try {
      const snapshot = await context.paseo.providers.waitForReady({ timeoutMs: 5_000 });
      const providers = snapshot.entries
        .filter((entry) => entry.enabled)
        .map((entry) => ({ id: entry.provider, label: entry.label ?? entry.provider }));
      return { providers, error: null };
    } catch (error) {
      return { providers: [], error: error instanceof Error ? error.message : String(error) };
    }
  });

  server.handle(larkBotStatusRpc, async (_input, context) => {
    capture(context.paseo);
    const values = await readValues();
    const status = dispatcher?.status();
    const cliPath = resolveLarkCli(values.larkCliPath);
    if (cliPath && currentAppIdCache === null) {
      currentAppIdCache = await readCurrentAppId(cliPath).catch(() => null);
    }
    return {
      consumerState: consumer?.status().state ?? "stopped",
      lastError: consumer?.status().lastError ?? null,
      cliPath,
      currentAppId: currentAppIdCache,
      botOpenId: status?.botOpenId ?? null,
      sessions: status?.sessions ?? [],
      unmatched: status?.unmatched ?? [],
    };
  });

  const offTurnEnded = server.on("agent.turn_ended", (event, context) => {
    capture(context.paseo);
    dispatcher?.handleTurnEnded(event);
  });
  const offPermission = server.on("agent.permission_requested", (event, context) => {
    capture(context.paseo);
    void dispatcher?.handlePermission(event);
  });
  // agent.turn_started fires for every provider's turns; it is the earliest
  // reliable hook to capture the PaseoApi after a daemon restart.
  const offTurnStarted = server.on("agent.turn_started", (_event, context) => {
    capture(context.paseo);
  });

  return async () => {
    offTurnStarted();
    offTurnEnded();
    offPermission();
    offSettings();
    dispatcher = null;
    paseo = null;
    await consumer?.stop();
    consumer = null;
    consumerCli = null;
    appliedAppId = null;
    currentAppIdCache = null;
  };
}
