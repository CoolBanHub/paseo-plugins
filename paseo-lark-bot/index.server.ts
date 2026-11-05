import { createHash } from "node:crypto";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { larkBotChatsRpc, larkBotProvidersRpc, larkBotStatusRpc } from "./shared/contracts.ts";
import { createEventConsumer, type EventConsumer, type LarkMessageEvent } from "./server/lark-events.ts";
import { applyAppCredentials, listChats, readCurrentAppId, resolveLarkCli } from "./server/lark.ts";
import { createDispatcher, type Dispatcher } from "./server/dispatcher.ts";
import type { SessionPaseoApi } from "./server/sessions.ts";
import { lastAssistantText } from "./server/timeline.ts";
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
/** appId + secret fingerprint confirmed in this plugin lifetime. */
let appliedCredentialKey: string | null = null;
let currentAppIdCache: string | null = null;
/** Events that arrived before the first PaseoApi handle; replayed on capture. */
const pendingEvents: LarkMessageEvent[] = [];
const MAX_PENDING_EVENTS = 50;
/** provider → provider/<default-model>, filled lazily per daemon lifetime. */
const providerModelCache = new Map<string, string>();

function credentialFingerprint(appId: string, appSecret: string): string {
  return createHash("sha256").update(appId).update("\0").update(appSecret).digest("hex");
}

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
        // The turn_ended projection can lag the persisted timeline by a few
        // hundred milliseconds; retry briefly before giving up.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const payload = await api.agents.ref(agentId).timeline?.refetch({ limit: 30 });
            const text = lastAssistantText(payload?.entries);
            if (text) return text;
          } catch {
            // Older hosts or missing permissions degrade to the plain notice.
          }
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 300));
        }
        return null;
      },
    });
  }
  if (pendingEvents.length > 0) {
    const replay = pendingEvents.splice(0);
    for (const event of replay) void dispatcher.handleMessageEvent(event);
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
    if (!wanted || !values.appSecret || !cliPath) return;
    // Compare the secret too: rotating the secret for the same App ID must
    // still validate and write. The Secret stays plaintext in host settings by
    // design (local-only use); only a hash is kept in memory here.
    const fingerprint = credentialFingerprint(wanted, values.appSecret);
    if (appliedCredentialKey === fingerprint) return;
    try {
      const previous = currentAppIdCache ?? (await readCurrentAppId(cliPath));
      currentAppIdCache = previous;
      // Stop our consumer before stopping/restarting the shared event bus.
      await consumer?.stop();
      consumer = null;
      consumerCli = null;
      await applyAppCredentials({
        cliPath,
        appId: wanted,
        appSecret: values.appSecret,
        previousAppId: previous,
      });
      appliedCredentialKey = fingerprint;
      currentAppIdCache = wanted;
      dispatcher?.resetIdentity();
      log("已应用飞书应用凭证 " + wanted);
    } catch (error) {
      log("应用飞书应用凭证失败，继续使用 lark-cli 现有配置", error instanceof Error ? error.message : String(error));
    }
  };

  let disposed = false;
  let syncQueue: Promise<void> = Promise.resolve();

  // Start or stop the event consumer to match the current bindings; a changed
  // lark-cli path rebuilds it so the child process picks up the new binary.
  const syncConsumer = async (): Promise<void> => {
    const values = await readValues();
    if (disposed) return;
    const cliPath = resolveLarkCli(values.larkCliPath);
    await applyCredentials(values, cliPath);
    if (disposed) return;
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
    if (disposed) return;
    consumerCli = cliPath;
    consumer = createEventConsumer({ cliPath, onEvent: deliverEvent });
    consumer.start();
  };

  /** Serialize settings saves so concurrent syncs cannot leak a consumer. */
  const requestSync = (): void => {
    syncQueue = syncQueue
      .then(async () => {
        if (!disposed) await syncConsumer();
      })
      .catch((error) => {
        log("同步事件监听失败", error instanceof Error ? error.message : String(error));
      });
  };

  const deliverEvent = (event: LarkMessageEvent): void => {
    if (dispatcher) {
      void dispatcher.handleMessageEvent(event);
      return;
    }
    // The daemon may restart the plugin before any hook/RPC hands us a
    // PaseoApi. Buffer a bounded window instead of silently dropping messages.
    if (pendingEvents.length >= MAX_PENDING_EVENTS) pendingEvents.shift();
    pendingEvents.push(event);
  };

  requestSync();
  const offSettings = settings.subscribe(() => {
    requestSync();
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
    disposed = true;
    offTurnStarted();
    offTurnEnded();
    offPermission();
    offSettings();
    await syncQueue.catch(() => undefined);
    dispatcher = null;
    paseo = null;
    await consumer?.stop();
    consumer = null;
    consumerCli = null;
    pendingEvents.length = 0;
    appliedCredentialKey = null;
    currentAppIdCache = null;
  };
}
