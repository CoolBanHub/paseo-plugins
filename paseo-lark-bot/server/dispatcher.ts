import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { LarkMessageEvent } from "./lark-events.ts";
import { readBotOpenId, replyMessage, resolveLarkCli } from "./lark.ts";
import {
  appendFooter,
  clipReply,
  condenseReply,
  formatPermissionNotice,
  formatTurnOutcome,
} from "./format.ts";
import { routeMessage } from "./router.ts";
import { createSessionRegistry, type SessionPaseoApi } from "./sessions.ts";
import type { BotValues, ReplyFormat } from "../shared/settings.ts";

export type TurnEndedEvent = PluginLifecycleEvents["agent.turn_ended"];
export type PermissionEvent = PluginLifecycleEvents["agent.permission_requested"];

export interface DispatcherOptions {
  paseo: SessionPaseoApi;
  readValues: () => Promise<BotValues>;
  resolveCli?: (explicit: string) => string | null;
  readOpenId?: (cliPath: string) => Promise<string | null>;
  reply?: (options: {
    cliPath: string;
    messageId: string;
    text: string;
    format: ReplyFormat;
    replyInThread: boolean;
  }) => Promise<string | null>;
  log?: (message: string, detail?: unknown) => void;
}

const UNMATCHED_KEEP = 20;
const UNMATCHED_HINT = "这个会话还没有绑定 provider，请先在 Paseo 的「飞书机器人」设置里配置。";
const EMPTY_PROMPT_HINT = "收到，但没有读到文字内容。";

/**
 * Wires inbound Feishu message events to per-chat agent sessions and sends
 * every reply back under the triggering message. turn_ended is the single
 * reply signal; permission requests are surfaced in the chat but resolved in
 * the Paseo client.
 */
export function createDispatcher(options: DispatcherOptions) {
  const resolveCli = options.resolveCli || ((explicit: string) => resolveLarkCli(explicit));
  const readOpenId = options.readOpenId || readBotOpenId;
  const reply = options.reply || replyMessage;
  const log =
    options.log ||
    ((message: string, detail?: unknown) => {
      console.log("[lark-bot] " + message, detail === undefined ? "" : detail);
    });

  let cachedBotOpenId: string | null = null;
  let openIdLoaded = false;
  let warnedMissingCli = false;
  // Latest inbound message per chat: fallback reply target for notices.
  const latestSeen = new Map<string, string>();
  const unmatchedRecent = new Map<string, { chatId: string; chatType: string; lastSeenAt: number }>();

  // The idle window is read through a getter so settings edits apply without
  // rebuilding the registry.
  let valuesCache: BotValues = {
    larkCliPath: "",
    replyInThread: true,
    sessionIdleMinutes: 30,
    maxReplyChars: 4000,
    notifyUnmatched: false,
    chats: [],
  };

  const sessions = createSessionRegistry({
    paseo: options.paseo,
    getIdleMs: () => valuesCache.sessionIdleMinutes * 60_000,
    callbacks: {
      onReply: (chatId, messageId, outcome) => {
        void deliver(chatId, messageId, buildReplyText(outcome));
      },
      onNotice: (chatId, messageId, text) => {
        if (chatId) void deliver(chatId, messageId, text);
      },
      log,
    },
  });

  async function currentValues(): Promise<BotValues> {
    valuesCache = await options.readValues();
    return valuesCache;
  }

  async function ensureBotOpenId(cliPath: string): Promise<string | null> {
    if (openIdLoaded) return cachedBotOpenId;
    try {
      cachedBotOpenId = await readOpenId(cliPath);
      openIdLoaded = true;
      if (!cachedBotOpenId) log("无法读取机器人 open_id，群聊 @ 识别将不可用");
    } catch (error) {
      log("读取机器人 open_id 失败", error instanceof Error ? error.message : String(error));
    }
    return cachedBotOpenId;
  }

  function cliPathFor(values: BotValues): string | null {
    const cliPath = resolveCli(values.larkCliPath);
    if (!cliPath && !warnedMissingCli) {
      warnedMissingCli = true;
      log("找不到 lark-cli（可在设置里填写 larkCliPath）");
    }
    return cliPath;
  }

  async function handleMessageEvent(event: LarkMessageEvent): Promise<void> {
    try {
      latestSeen.set(event.chat_id, event.message_id);
      const values = await currentValues();
      const cliPath = cliPathFor(values);
      if (!cliPath) return;
      const botOpenId = await ensureBotOpenId(cliPath);
      if (event.chat_type === "group" && !botOpenId) return;

      const decision = routeMessage(event, values, botOpenId);
      if (decision.reason === "ignored") return;
      if (decision.reason === "unmatched" || !decision.binding) {
        rememberUnmatched(event);
        if (values.notifyUnmatched) {
          await send(cliPath, event.message_id, UNMATCHED_HINT, values, "text");
        }
        return;
      }
      if (!decision.prompt) {
        await send(cliPath, event.message_id, EMPTY_PROMPT_HINT, values, "text");
        return;
      }
      // One agent session per Feishu thread: replies inside a topic share
      // context, while each fresh @-mention starts an independent topic.
      const topicKey = event.root_id || event.message_id;
      sessions.enqueue(topicKey, event.chat_id, event.message_id, decision.prompt, decision.binding);
    } catch (error) {
      log("处理消息失败", error instanceof Error ? error.message : String(error));
    }
  }

  function rememberUnmatched(event: LarkMessageEvent): void {
    unmatchedRecent.set(event.chat_id, {
      chatId: event.chat_id,
      chatType: event.chat_type,
      lastSeenAt: Date.now(),
    });
    if (unmatchedRecent.size > UNMATCHED_KEEP) {
      const oldest = unmatchedRecent.keys().next().value;
      if (oldest) unmatchedRecent.delete(oldest);
    }
  }

  function handleTurnEnded(event: TurnEndedEvent): void {
    if (!sessions.ownsAgent(event.agent.id)) return;
    let lastText: string | null = null;
    for (let index = event.timeline.length - 1; index >= 0; index -= 1) {
      const item = event.timeline[index];
      if (item && item.type === "assistant_message" && item.text.trim()) {
        lastText = item.text.trim();
        break;
      }
    }
    sessions.handleTurnEnded(event.agent.id, {
      outcome: event.outcome.kind,
      lastText,
      lastError: event.outcome.kind === "failed" ? event.outcome.error.message : null,
    });
  }

  function handlePermission(event: PermissionEvent): void {
    if (!sessions.ownsAgent(event.agent.id)) return;
    const chatId = sessions.chatIdForAgent(event.agent.id);
    const target = chatId ? latestSeen.get(chatId) : undefined;
    if (!chatId || !target) return;
    const heading = (
      event.request.title || [event.request.kind, event.request.name].filter(Boolean).join(" ")
    ).trim();
    void (async () => {
      const values = await currentValues();
      const cliPath = cliPathFor(values);
      if (!cliPath) return;
      await send(
        cliPath,
        target,
        formatPermissionNotice({ heading, extra: event.request.description?.trim() || null }),
        values,
        "markdown",
      );
    })();
  }

  function buildReplyText(outcome: {
    outcome: "completed" | "failed" | "canceled" | null;
    lastText: string | null;
    lastError: string | null;
  }): string {
    if (outcome.outcome === "failed" || outcome.outcome === "canceled") {
      return formatTurnOutcome(outcome.outcome, outcome.lastError);
    }
    const text = condenseReply(outcome.lastText ?? "");
    if (!text) return "本轮处理完成（没有文本回复）。打开 Paseo 查看时间线。";
    return text;
  }

  async function send(
    cliPath: string,
    messageId: string,
    text: string,
    values: BotValues,
    format: ReplyFormat,
  ): Promise<void> {
    const { text: clipped, clipped: wasClipped } = clipReply(text, values.maxReplyChars);
    const finalText = appendFooter(clipped, wasClipped);
    try {
      await reply({ cliPath, messageId, text: finalText, format, replyInThread: values.replyInThread });
    } catch (error) {
      log("回复消息失败", error instanceof Error ? error.message : String(error));
    }
  }

  async function deliver(chatId: string, messageId: string, text: string): Promise<void> {
    const values = await currentValues();
    const cliPath = cliPathFor(values);
    if (!cliPath) return;
    const binding = values.chats.find((chat) => chat.chatId === chatId);
    await send(cliPath, messageId, text, values, binding?.replyFormat ?? "markdown");
  }

  return {
    handleMessageEvent,
    handleTurnEnded,
    handlePermission,
    status: () => ({
      sessions: sessions.status(),
      unmatched: [...unmatchedRecent.values()],
      botOpenId: cachedBotOpenId,
    }),
  };
}

export type Dispatcher = ReturnType<typeof createDispatcher>;
