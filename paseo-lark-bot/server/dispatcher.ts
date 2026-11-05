import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { LarkMessageEvent } from "./lark-events.ts";
import { readBotOpenId, readMessageDetail, readRawContent, replyMessage, resolveLarkCli, type MessageDetail } from "./lark.ts";
import {
  downloadMessageResource,
  extractVideoFrames,
  resolveFfmpeg,
  toImageAttachment,
} from "./media.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionImage } from "./sessions.ts";
import {
  appendFooter,
  clipReply,
  condenseReply,
  formatPermissionNotice,
  formatTurnOutcome,
} from "./format.ts";
import { routeMessage, extractPrompt } from "./router.ts";
import { createSessionRegistry, type SessionPaseoApi } from "./sessions.ts";
import type { BotValues, ReplyFormat } from "../shared/settings.ts";

export type TurnEndedEvent = PluginLifecycleEvents["agent.turn_ended"];
export type PermissionEvent = PluginLifecycleEvents["agent.permission_requested"];

export interface DispatcherOptions {
  paseo: SessionPaseoApi;
  readValues: () => Promise<BotValues>;
  /** Normalizes bare provider ids to provider/model for agents.create(). */
  resolveProvider?: (provider: string) => Promise<string>;
  /** Fallback reply lookup when turn_ended carries no assistant text. */
  fetchLastReply?: (agentId: string) => Promise<string | null>;
  resolveCli?: (explicit: string) => string | null;
  readOpenId?: (cliPath: string) => Promise<string | null>;
  reply?: (options: {
    cliPath: string;
    messageId: string;
    text: string;
    format: ReplyFormat;
    replyInThread: boolean;
  }) => Promise<string | null>;
  /** Injectable thread-root lookup for tests. */
  /** Injectable thread-root lookup for tests; may also learn sender names. */
  readThreadRootDetail?: (cliPath: string, messageId: string) => Promise<MessageDetail | null>;
  /** Injectable media pipeline for tests. */
  readRaw?: (cliPath: string, messageId: string) => Promise<Record<string, unknown> | null>;
  download?: (options: { cliPath: string; messageId: string; fileKey: string; type: "image" | "file" }) => Promise<{ bytes: Buffer; extension: string }>;
  extractFrames?: (videoPath: string, ffmpeg: string, maxFrames?: number) => Promise<Buffer[]>;
  log?: (message: string, detail?: unknown) => void;
}

const UNMATCHED_KEEP = 20;
/** Images attached per turn, and cached per topic, respectively. */
const MAX_IMAGES_PER_TURN = 4;
const MAX_TOPIC_IMAGES = 8;
/** Chinese labels for non-text message types in thread context. */
const MEDIA_LABELS: Record<string, string> = {
  image: "图片",
  media: "视频",
  file: "文件",
  audio: "语音",
  sticker: "表情",
  share_chat: "群名片",
  share_user: "名片",
  system: "系统消息",
};
const UNMATCHED_HINT = "这个会话还没有绑定 provider，请先在 Paseo 的「飞书机器人」设置里配置。";
const ACK_TEXT = "✅ 收到，正在处理，完成后在本话题回复。";
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
  const readThreadRootDetail = options.readThreadRootDetail || readMessageDetail;
  const readRaw = options.readRaw || readRawContent;
  const download = options.download || downloadMessageResource;
  const extractFrames = options.extractFrames || extractVideoFrames;
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
  // Thread roots rarely change; cache their text to avoid repeated mgets.
  const threadRootCache = new Map<string, MessageDetail | null>();
  /**
   * Every group message the event stream delivers lands here — including
   * messages that do not mention the bot — so later @-mentions inside the
   * thread can be answered with the full conversation as context. Bounded
   * per topic; lost on daemon restart (the root fallback covers the topic
   * subject via the messages-mget API).
   */
  const topicHistory = new Map<string, { senderType: string; text: string; messageId: string }[]>();
  /** Images collected per topic (downloads of image posts + video frames). */
  const topicImages = new Map<string, SessionImage[]>();
  /**
   * Stable per-sender labels for the transcript: real names when known
   * (thread-root lookups carry them), otherwise 成员A/成员B/… assigned by
   * first appearance.
   */
  const senderLabels = new Map<string, string>();
  let memberCounter = 0;

  // The idle window is read through a getter so settings edits apply without
  // rebuilding the registry.
  let valuesCache: BotValues = {
    appId: "",
    appSecret: "",
    larkCliPath: "",
    ackOnReceive: true,
    notifyPermission: false,
    replyInThread: true,
    sessionIdleMinutes: 30,
    maxReplyChars: 4000,
    notifyUnmatched: false,
    chats: [],
  };

  const sessions = createSessionRegistry({
    paseo: options.paseo,
    getIdleMs: () => valuesCache.sessionIdleMinutes * 60_000,
    resolveProvider: options.resolveProvider,
    fetchLastReply: options.fetchLastReply,
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

  function labelFor(senderId: string, senderType: string): string {
    if (senderType === "bot") return "机器人";
    let label = senderLabels.get(senderId);
    if (!label) {
      memberCounter += 1;
      label = "成员" + String.fromCharCode(64 + Math.min(memberCounter, 26));
      senderLabels.set(senderId, label);
    }
    return label;
  }

  function historyText(event: LarkMessageEvent): string {
    if (event.message_type === "text" || event.message_type === "post") {
      return extractPrompt(event);
    }
    const label = MEDIA_LABELS[event.message_type];
    if (!label) return "";
    const detail = extractPrompt(event).slice(0, 80);
    return "[" + label + (detail ? "：" + detail : "") + "]";
  }

  /**
   * Download media posted in a topic: images as-is, videos as extracted
   * frames. Everything is cached per topic so the next @-mention in the
   * thread carries it to the provider. Failures degrade to placeholders.
   */
  async function ingestMedia(cliPath: string, event: LarkMessageEvent): Promise<void> {
    if (event.chat_type !== "group") return;
    const kind =
      event.message_type === "image" ? "image" : event.message_type === "media" ? "video" : null;
    if (!kind) return;
    const key = event.root_id || event.message_id;
    try {
      const raw = await readRaw(cliPath, event.message_id);
      if (!raw) return;
      const fileKey =
        typeof raw.image_key === "string" && kind === "image" ? raw.image_key : typeof raw.file_key === "string" ? raw.file_key : null;
      if (!fileKey) return;
      const resource = await download({
        cliPath,
        messageId: event.message_id,
        fileKey,
        type: kind === "image" ? "image" : "file",
      });
      const buffers: { bytes: Buffer; mime: string }[] = [];
      if (kind === "image") {
        buffers.push({ bytes: resource.bytes, mime: resource.extension === ".png" ? "image/png" : "image/jpeg" });
      } else {
        const ffmpeg = resolveFfmpeg();
        if (!ffmpeg) return;
        const dir = mkdtempSync(join(tmpdir(), "lark-bot-video-"));
        try {
          const videoPath = join(dir, "video" + resource.extension);
          writeFileSync(videoPath, resource.bytes);
          for (const frame of await extractFrames(videoPath, ffmpeg, 3)) {
            buffers.push({ bytes: frame, mime: "image/jpeg" });
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      const images = topicImages.get(key) ?? [];
      for (const buffer of buffers) {
        const attachment = toImageAttachment(buffer.bytes, buffer.mime);
        if (attachment) images.push(attachment);
      }
      if (images.length > MAX_TOPIC_IMAGES) images.splice(0, images.length - MAX_TOPIC_IMAGES);
      topicImages.set(key, images);
    } catch (error) {
      log("处理话题媒体失败", error instanceof Error ? error.message : String(error));
    }
  }

  function recordHistory(event: LarkMessageEvent): void {
    if (event.chat_type !== "group") return;
    const key = event.root_id || event.message_id;
    const text = historyText(event);
    if (!text) return;
    const entries = topicHistory.get(key) ?? [];
    // The bot's own acks carry no context value; skip them.
    if (event.sender_type === "bot" && text.startsWith(ACK_TEXT.slice(0, 2))) return;
    entries.push({
      senderType: labelFor(event.sender_id, event.sender_type),
      text,
      messageId: event.message_id,
    });
    if (entries.length > 50) entries.splice(0, entries.length - 50);
    topicHistory.set(key, entries);
  }

  async function handleMessageEvent(event: LarkMessageEvent): Promise<void> {
    try {
      latestSeen.set(event.chat_id, event.message_id);
      recordHistory(event);
      const values = await currentValues();
      const cliPath = cliPathFor(values);
      if (!cliPath) return;
      const botOpenId = await ensureBotOpenId(cliPath);
      if (event.chat_type === "group" && !botOpenId) return;

      void ingestMedia(cliPath, event);
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
      if (values.ackOnReceive) {
        await send(cliPath, event.message_id, ACK_TEXT, values, "text");
      }
      const prompt = await withThreadContext(cliPath, event, decision.prompt);
      const images = (topicImages.get(topicKey) ?? []).slice(-MAX_IMAGES_PER_TURN);
      const finalPrompt =
        images.length > 0
          ? prompt + "\n\n【附图】本消息附加 " + images.length + " 张图片（含视频关键帧），请结合图片内容回答。"
          : prompt;
      sessions.enqueue(topicKey, event.chat_id, event.message_id, finalPrompt, decision.binding, images);
    } catch (error) {
      log("处理消息失败", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * A reply inside a thread usually refers to earlier messages ("你查一下"
   * → the thread topic), so prepend the recorded thread conversation as
   * context: every message seen in this thread (mentioned or not) plus the
   * root text fetched from the API when the in-memory history misses it.
   */
  async function withThreadContext(cliPath: string, event: LarkMessageEvent, prompt: string): Promise<string> {
    if (!event.root_id) return prompt;
    const history = (topicHistory.get(event.root_id) ?? []).filter(
      (entry) => entry.messageId !== event.message_id,
    );
    let rootText: string | null = null;
    const rootInHistory = history.length > 0 && history[0]?.messageId === event.root_id;
    if (!rootInHistory) {
      let detail: MessageDetail | null;
      if (threadRootCache.has(event.root_id)) {
        detail = threadRootCache.get(event.root_id) ?? null;
      } else {
        try {
          detail = await readThreadRootDetail(cliPath, event.root_id);
        } catch (error) {
          log("读取话题根消息失败", error instanceof Error ? error.message : String(error));
          detail = null;
        }
        threadRootCache.set(event.root_id, detail);
        if (threadRootCache.size > 100) {
          const oldest = threadRootCache.keys().next().value;
          if (oldest) threadRootCache.delete(oldest);
        }
      }
      if (detail?.senderOpenId && detail.senderName) {
        // A real name beats the provisional 成员A/B label.
        senderLabels.set(detail.senderOpenId, detail.senderName);
      }
      rootText = detail?.text ?? null;
    }
    const lines: string[] = [];
    if (rootText && rootText !== prompt) lines.push("【话题主题】" + rootText);
    const prior = rootInHistory ? history : history.filter((entry) => entry.messageId !== event.root_id);
    if (prior.length > 1 || (prior.length === 1 && !rootText)) {
      // senderType carries the stable per-sender label (机器人 / 成员A / 真名).
      const transcript = prior.map((entry) => entry.senderType + ": " + clipContext(entry.text)).join("\n");
      if (transcript && !lines.includes("【话题主题】" + transcript)) lines.push("【话题历史】\n" + transcript);
    }
    if (lines.length === 0) return prompt;
    return lines.join("\n\n") + "\n\n【本次消息】" + prompt;
  }

  function clipContext(text: string, limit = 400): string {
    const flat = text.trim();
    return flat.length > limit ? flat.slice(0, limit - 1) + "…" : flat;
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
    void sessions.handleTurnEnded(event.agent.id, {
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
      if (!values.notifyPermission) return;
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
    if (!text) return "本轮已完成，但没有可复述的文本结果（可能只有工具操作）。";
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
