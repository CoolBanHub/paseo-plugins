import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  larkBotAppCreationRpc,
  larkBotChatMembersRpc,
  larkBotChatsRpc,
  larkBotProvidersRpc,
  larkBotStatusRpc,
} from "./shared/contracts.ts";
import {
  createEventConsumer,
  type EventConsumer,
  type LarkCardActionEvent,
  type LarkMessageEvent,
} from "./server/lark-events.ts";
import {
  applyAppCredentials,
  listChatMembers,
  listChats,
  readCliVersion,
  readCurrentAppId,
  resolveLarkCli,
  stopLarkEventBus,
} from "./server/lark.ts";
import { createAppCreationController } from "./server/app-creation.ts";
import { createDispatcher, type Dispatcher } from "./server/dispatcher.ts";
import type { SessionPaseoApi } from "./server/sessions.ts";
import { lastAssistantText } from "./server/timeline.ts";
import { resolveFfmpeg } from "./server/media.ts";
import { installMembersHelper, installOutboxHelper } from "./server/attachments.ts";
import { renderDoctorReport, runDoctorChecks } from "./server/doctor.ts";
import {
  DSH_DEFAULT_PERMISSION,
  DSH_PERMISSION_OPTIONS,
  DEFAULT_BOT_VALUES,
  isDshProvider,
  larkBotSettings,
  type BotValues,
} from "./shared/settings.ts";

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
let cardConsumer: EventConsumer | null = null;
let cardConsumerCli: string | null = null;
/** appId + secret fingerprint confirmed in this plugin lifetime. */
let appliedCredentialKey: string | null = null;
let currentAppIdCache: string | null = null;
/** Events that arrived before the first PaseoApi handle; replayed on capture. */
const pendingEvents: LarkMessageEvent[] = [];
const MAX_PENDING_EVENTS = 50;
/** Card actions that arrived before the dispatcher; replayed on capture. */
const pendingCardActions: LarkCardActionEvent[] = [];
const MAX_PENDING_CARD_ACTIONS = 20;
/** provider → provider/<default-model>, filled lazily per daemon lifetime. */
const providerModelCache = new Map<string, string>();
/** All plugin-owned state (stores, media, outbox, helper) lives here. */
const PLUGIN_DATA_ROOT = join(
  process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
  "plugin-data",
  "lark-bot",
);

function credentialFingerprint(appId: string, appSecret: string): string {
  return createHash("sha256").update(appId).update("\0").update(appSecret).digest("hex");
}

/**
 * Daemons since 0.15 reject bare provider ids in agents.create(); resolve
 * `dsh` to `dsh/<default-model>` using the provider snapshot. A model selected
 * in the chat binding takes precedence. Older hosts without the providers
 * slice keep the input unchanged.
 */
async function resolveProviderModel(provider: string, model = ""): Promise<string> {
  const slash = provider.indexOf("/");
  const base = slash > 0 ? provider.slice(0, slash) : provider;
  const legacyModel = slash > 0 ? provider.slice(slash + 1) : "";
  const chosen = model.trim() || legacyModel;
  // Paseo splits provider/model at the first slash, so a model id that itself
  // contains slashes (e.g. OpenRouter) is carried through unchanged.
  if (chosen) return base + "/" + chosen;
  if (provider.includes("/")) return provider;
  const cached = providerModelCache.get(base);
  if (cached) return cached;
  if (!paseo?.providers) return provider;
  try {
    const snapshot = await paseo.providers.waitForReady({ timeoutMs: 5_000 });
    const entry = snapshot.entries.find((candidate) => candidate.provider === base);
    const chosenModel =
      entry?.models?.find((candidate) => candidate.isDefault)?.id ?? entry?.models?.[0]?.id;
    if (!chosenModel) return provider;
    const full = base + "/" + chosenModel;
    providerModelCache.set(base, full);
    return full;
  } catch {
    return provider;
  }
}

function ensureDispatcher(
  api: SessionPaseoApi,
  readValues: () => Promise<BotValues>,
  doctor: () => Promise<string>,
): Dispatcher {
  paseo = api;
  if (!dispatcher) {
    let helperPath: string | null = null;
    try {
      helperPath = installOutboxHelper(PLUGIN_DATA_ROOT, process.execPath);
    } catch (error) {
      console.log(
        "[lark-bot] 附件回传 helper 安装失败",
        error instanceof Error ? error.message : String(error),
      );
    }
    let membersHelperPath: string | null = null;
    try {
      membersHelperPath = installMembersHelper(PLUGIN_DATA_ROOT, process.execPath);
    } catch (error) {
      console.log(
        "[lark-bot] 群成员搜索 helper 安装失败",
        error instanceof Error ? error.message : String(error),
      );
    }
    dispatcher = createDispatcher({
      dedupStorePath: join(PLUGIN_DATA_ROOT, "seen-message-ids.json"),
      topicStorePath: join(PLUGIN_DATA_ROOT, "topic-agents.json"),
      pendingStorePath: join(PLUGIN_DATA_ROOT, "pending-questions.json"),
      mediaStoreDir: join(PLUGIN_DATA_ROOT, "media"),
      pluginDataDir: PLUGIN_DATA_ROOT,
      attachmentOutboxDir: join(PLUGIN_DATA_ROOT, "outbox"),
      ...(helperPath ? { attachmentHelperPath: helperPath } : {}),
      ...(membersHelperPath ? { membersHelperPath } : {}),
      cronStorePath: join(PLUGIN_DATA_ROOT, "cron-jobs.json"),
      paseo: api,
      readValues,
      doctor,
      readProviders: async () => {
        try {
          return await api.providers?.waitForReady({ timeoutMs: 3_000 }) ?? null;
        } catch {
          return null;
        }
      },
      resolveProvider: resolveProviderModel,
      fetchLastReply: async (agentId: string) => {
        // The turn_ended projection can lag the persisted timeline by a few
        // hundred milliseconds; retry briefly before giving up.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const payload = await api.agents.ref(agentId).timeline?.refetch({ limit: 30 });
            const text = lastAssistantText(payload?.entries);
            if (text) {
              console.log(`[lark-bot] 时间线兜底取到回复文本（${text.length} 字）`);
              return text;
            }
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
  if (pendingCardActions.length > 0) {
    const replayCards = pendingCardActions.splice(0);
    for (const event of replayCards) void dispatcher.handleCardAction(event);
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

  /** `/doctor` — reports the silent-degradation states this plugin can hit. */
  const buildDoctor = async (): Promise<string> => {
    const values = await readValues();
    const status = dispatcher?.status();
    const cliPath = resolveLarkCli(values.larkCliPath);
    const cliVersion = cliPath ? await readCliVersion(cliPath) : null;
    let appId = currentAppIdCache ?? (values.appId.trim() || null);
    if (!appId && cliPath) {
      appId = await readCurrentAppId(cliPath).catch(() => null);
      if (appId) currentAppIdCache = appId;
    }
    let providerCount = 0;
    if (paseo?.providers) {
      try {
        const snapshot = await paseo.providers.waitForReady({ timeoutMs: 3_000 });
        providerCount = snapshot.entries.filter((entry) => entry.enabled !== false).length;
      } catch {
        providerCount = 0;
      }
    }
    return renderDoctorReport(
      runDoctorChecks({
        cliPath,
        cliVersion,
        currentAppId: appId,
        botOpenId: status?.botOpenId ?? null,
        consumerState: consumer?.status().state ?? "stopped",
        consumerError: consumer?.status().lastError ?? null,
        cardConsumerState: cardConsumer?.status().state ?? "stopped",
        cardConsumerError: cardConsumer?.status().lastError ?? null,
        bindingCount: values.chats.length,
        providerCount,
        ffmpegPath: resolveFfmpeg(),
        pluginDataDir: PLUGIN_DATA_ROOT,
        cronJobs: status?.cron ?? [],
        pendingQuestions: status?.pendingQuestions ?? 0,
      }),
    );
  };

  // Apply user-configured app credentials before anything talks to Feishu:
  // validate against the token endpoint, then write into lark-cli. Failures
  // never clobber the working keychain config and fall back to it.
  const applyCredentials = async (values: BotValues, cliPath: string | null): Promise<void> => {
    const wanted = values.appId.trim();
    if (!wanted || !values.appSecret || !cliPath) {
      // The user cleared the plugin-level credentials (typically after the
      // scan flow created a new app). Drop the identity this lifetime applied
      // and reconnect with lark-cli's current keychain config.
      if (appliedCredentialKey !== null) {
        await consumer?.stop();
        consumer = null;
        consumerCli = null;
        appliedCredentialKey = null;
        currentAppIdCache = null;
        dispatcher?.resetIdentity();
        log("已清空插件内应用凭证，改用 lark-cli 当前配置");
      }
      return;
    }
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

  const startCardConsumer = async (cliPath: string): Promise<void> => {
    if (cardConsumer && cardConsumerCli === cliPath) {
      cardConsumer.start();
      return;
    }
    await cardConsumer?.stop();
    if (disposed) return;
    cardConsumerCli = cliPath;
    cardConsumer = createEventConsumer<LarkCardActionEvent>({
      cliPath,
      eventKey: "card.action.trigger",
      fatalErrorPattern: /requires callbacks not subscribed|failed_precondition/i,
      onEvent: deliverCardAction,
    });
    cardConsumer.start();
  };

  const stopConsumers = async (): Promise<void> => {
    await consumer?.stop();
    consumer = null;
    consumerCli = null;
    await cardConsumer?.stop();
    cardConsumer = null;
    cardConsumerCli = null;
  };

  // Start or stop the event consumers to match the current bindings; a changed
  // lark-cli path rebuilds them so the child processes pick up the new binary.
  const syncConsumer = async (): Promise<void> => {
    const values = await readValues();
    if (disposed) return;
    // "Unbind" stops the listeners but keeps the app, lark-cli credentials,
    // and chat bindings so a later enable can resume without reconfiguring.
    if (!values.enabled) {
      await stopConsumers();
      dispatcher?.resetIdentity();
      return;
    }
    const cliPath = resolveLarkCli(values.larkCliPath);
    await applyCredentials(values, cliPath);
    if (disposed) return;
    if (values.chats.length === 0) {
      await stopConsumers();
      return;
    }
    if (!cliPath) return;
    if (consumer && consumerCli === cliPath) {
      consumer.start();
      await startCardConsumer(cliPath);
      return;
    }
    await stopConsumers();
    if (disposed) return;
    consumerCli = cliPath;
    consumer = createEventConsumer({ cliPath, onEvent: deliverEvent });
    consumer.start();
    await startCardConsumer(cliPath);
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

  const deliverCardAction = (event: LarkCardActionEvent): void => {
    if (dispatcher) {
      void dispatcher.handleCardAction(event);
      return;
    }
    // After a reload the card consumer can deliver a click before the first
    // hook/RPC hands us a PaseoApi; buffer a bounded window instead of losing
    // the answer.
    if (pendingCardActions.length >= MAX_PENDING_CARD_ACTIONS) pendingCardActions.shift();
    pendingCardActions.push(event);
  };

  // One-click app creation. The CLI owns the device flow and writes the new
  // App ID/Secret into its keychain; we only restart the consumers so they
  // pick it up (when no plugin-level credentials override it).
  const appCreation = createAppCreationController({
    readAppId: readCurrentAppId,
    log,
    onSuccess: async (appId, cliPath) => {
      const previous = currentAppIdCache;
      currentAppIdCache = appId;
      if (previous && previous !== appId) {
        await stopLarkEventBus(cliPath, previous);
      }
      if (disposed) return;
      const values = await readValues();
      // Saved plugin credentials take precedence over lark-cli's config, so
      // wait for the settings screen to clear them before restarting. With no
      // override we can switch the consumers immediately.
      if (!values.appId.trim() || !values.appSecret) {
        dispatcher?.resetIdentity();
        await stopConsumers();
        requestSync();
      }
    },
  });

  requestSync();
  const offSettings = settings.subscribe(() => {
    requestSync();
  });

  const capture = (api: unknown): void => {
    if (paseo || !api) return;
    ensureDispatcher(api as SessionPaseoApi, readValues, buildDoctor);
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
        .map((entry) => {
          const modes = (entry.modes ?? []).map((mode) => ({
            id: mode.id,
            label: mode.label,
            description: mode.description ?? null,
          }));
          const models = (entry.models ?? [])
            .filter((model) => model.isSelectable !== false)
            .map((model) => ({
              id: model.id,
              label: model.label,
              isDefault: model.isDefault === true,
              thinkingOptions: (model.thinkingOptions ?? []).map((option) => ({
                id: option.id,
                label: option.label,
              })),
              defaultThinkingOptionId: model.defaultThinkingOptionId ?? null,
            }));
          const dsh = isDshProvider(entry.provider);
          return {
            id: entry.provider,
            label: entry.label ?? entry.provider,
            models,
            modes,
            permissionKind: dsh ? ("dsh-preset" as const) : modes.length > 0 ? ("mode" as const) : ("none" as const),
            permissionOptions: dsh
              ? DSH_PERMISSION_OPTIONS.map((option) => ({ ...option }))
              : modes.map((mode) => ({ value: mode.id, label: mode.label })),
            defaultPermission: dsh ? DSH_DEFAULT_PERMISSION : (entry.defaultModeId ?? null),
          };
        });
      return { providers, error: null };
    } catch (error) {
      return { providers: [], error: error instanceof Error ? error.message : String(error) };
    }
  });

  server.handle(larkBotChatMembersRpc, async (input) => {
    const values = await readValues();
    const cliPath = resolveLarkCli(values.larkCliPath);
    if (!cliPath) return { members: [], error: "找不到 lark-cli" };
    try {
      return { members: await listChatMembers(cliPath, input.chatId), error: null };
    } catch (error) {
      return { members: [], error: error instanceof Error ? error.message : String(error) };
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
      cardConsumerState: cardConsumer?.status().state ?? "stopped",
      cardLastError: cardConsumer?.status().lastError ?? null,
      cliPath,
      currentAppId: currentAppIdCache,
      enabled: values.enabled,
      botOpenId: status?.botOpenId ?? null,
      sessions: status?.sessions ?? [],
      unmatched: status?.unmatched ?? [],
      cron: status?.cron ?? [],
      pendingQuestions: status?.pendingQuestions ?? 0,
    };
  });

  server.handle(larkBotAppCreationRpc, async (input) => {
    if (input.action === "status") return appCreation.status();
    if (input.action === "cancel") return appCreation.cancel();
    const values = await readValues();
    const cliPath = resolveLarkCli(values.larkCliPath);
    if (!cliPath) {
      return {
        state: "error" as const,
        url: null,
        qrDataUrl: null,
        appId: null,
        error: "找不到 lark-cli，请先在全局设置填写路径",
      };
    }
    try {
      return appCreation.start(cliPath);
    } catch (error) {
      return {
        state: "error" as const,
        url: null,
        qrDataUrl: null,
        appId: null,
        error: "启动扫码创建失败：" + (error instanceof Error ? error.message : String(error)),
      };
    }
  });

  const offTurnEnded = server.on("agent.turn_ended", (event, context) => {
    capture(context.paseo);
    dispatcher?.handleTurnEnded(event);
  });
  const offPermission = server.on("agent.permission_requested", (event, context) => {
    capture(context.paseo);
    void dispatcher?.handlePermission(event);
  });
  const offPermissionResolved = server.on("agent.permission_resolved", (event, context) => {
    capture(context.paseo);
    dispatcher?.handlePermissionResolved(event);
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
    offPermissionResolved();
    offSettings();
    appCreation.dispose();
    await syncQueue.catch(() => undefined);
    // Stop retry/watchdog/fallback timers and flush the topic store before the
    // registry becomes unreachable; otherwise a 30-minute watchdog could fire
    // into an already unloaded plugin.
    dispatcher?.dispose();
    dispatcher = null;
    paseo = null;
    await consumer?.stop();
    consumer = null;
    consumerCli = null;
    await cardConsumer?.stop();
    cardConsumer = null;
    cardConsumerCli = null;
    pendingEvents.length = 0;
    pendingCardActions.length = 0;
    appliedCredentialKey = null;
    currentAppIdCache = null;
  };
}
