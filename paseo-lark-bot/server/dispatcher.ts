import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { LarkMessageEvent } from "./lark-events.ts";
import { readBotOpenId, readMessageDetail, readRawContent, replyMessage, resolveLarkCli, type MessageDetail } from "./lark.ts";
import {
  downloadMessageResource,
  extractVideoFrames,
  resolveFfmpeg,
  toImageAttachment,
} from "./media.ts";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionImage } from "./sessions.ts";
import {
  appendFooter,
  clipReply,
  condenseReply,
  formatPermissionNotice,
  formatTurnOutcome,
} from "./format.ts";
import { mentionsBot, routeMessage, extractPrompt, isSenderAllowed } from "./router.ts";
import { createSessionRegistry, type SessionPaseoApi } from "./sessions.ts";
import type { BotValues, ReplyFormat } from "../shared/settings.ts";

export type TurnEndedEvent = PluginLifecycleEvents["agent.turn_ended"];
export type PermissionEvent = PluginLifecycleEvents["agent.permission_requested"];

export interface DispatcherOptions {
  /**
   * Path of the persisted message-id dedup log. When set, the newest 1,000
   * seen ids survive a daemon restart, so at-least-once event redelivery
   * right after a restart does not answer the same message twice.
   */
  dedupStorePath?: string;
  paseo: SessionPaseoApi;
  readValues: () => Promise<BotValues>;
  /** Normalizes bare provider ids to provider/model for agents.create(). */
  resolveProvider?: (provider: string, model: string) => Promise<string>;
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
  /** Injectable thread-root lookup for tests; may also learn sender names. */
  readThreadRootDetail?: (cliPath: string, messageId: string) => Promise<MessageDetail | null>;
  /** Injectable media pipeline for tests. */
  readRaw?: (cliPath: string, messageId: string) => Promise<Record<string, unknown> | null>;
  download?: (options: { cliPath: string; messageId: string; fileKey: string; type: "image" | "file"; maxBytes?: number }) => Promise<{ bytes: Buffer; extension: string }>;
  extractFrames?: (videoPath: string, ffmpeg: string, maxFrames?: number) => Promise<Buffer[]>;
  log?: (message: string, detail?: unknown) => void;
}

const UNMATCHED_KEEP = 20;
/** Images attached per turn, and cached per topic, respectively. */
const MAX_IMAGES_PER_TURN = 4;
const MAX_TOPIC_IMAGES = 8;
/** Bound in-memory topic state for long-running daemons and busy tenants. */
const MAX_TOPIC_HISTORY = 500;
const MAX_TOPIC_IMAGE_TOPICS = 50;
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
const BLOCKED_HINT = "当前会话仅允许指定成员 @ 我处理，请让指定成员发起请求，或联系会话管理员。";
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
  // Event delivery is at-least-once; message_id is the documented dedup key.
  const seenMessageIds = new Set<string>();
  const seenMessageOrder: string[] = [];
  // Optional persistence of the dedup window across daemon restarts.
  const dedupStorePath = options.dedupStorePath;
  let dedupFlushTimer: ReturnType<typeof setTimeout> | null = null;
  if (dedupStorePath) {
    try {
      const parsed = JSON.parse(readFileSync(dedupStorePath, "utf8")) as { ids?: unknown };
      if (Array.isArray(parsed.ids)) {
        for (const id of parsed.ids.slice(-1_000)) {
          if (typeof id === "string" && id) {
            seenMessageIds.add(id);
            seenMessageOrder.push(id);
          }
        }
      }
    } catch {
      // Absent or unreadable store; start empty.
    }
  }
  const scheduleDedupFlush = (): void => {
    if (!dedupStorePath || dedupFlushTimer) return;
    dedupFlushTimer = setTimeout(() => {
      dedupFlushTimer = null;
      try {
        mkdirSync(dirname(dedupStorePath), { recursive: true });
        const temporary = `${dedupStorePath}.tmp`;
        writeFileSync(temporary, JSON.stringify({ ids: seenMessageOrder.slice(-1_000) }), { mode: 0o600 });
        renameSync(temporary, dedupStorePath);
      } catch (error) {
        log("去重记录写入失败", error instanceof Error ? error.message : String(error));
      }
    }, 5_000);
    dedupFlushTimer.unref?.();
  };
  // Serialize preprocessing per topic so a slow root lookup cannot let a later
  // message overtake an earlier one.
  const topicChains = new Map<string, Promise<void>>();
  const unmatchedRecent = new Map<string, { chatId: string; chatType: string; lastSeenAt: number }>();
  // Thread roots rarely change; cache their text to avoid repeated mgets.
  const threadRootCache = new Map<string, MessageDetail | null>();
  /**
   * Every group message the event stream delivers lands here — including
   * messages that do not mention the bot — so a later @ can be answered with
   * the messages since the previous trigger. Bounded per topic; lost on
   * daemon restart (the root fallback covers the topic subject).
   */
  const topicHistory = new Map<string, { senderType: string; text: string; messageId: string }[]>();
  /** Last message that actually triggered a bot turn, per topic. */
  const lastTriggerMessage = new Map<string, string>();
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

  /** Returns false when this message was already delivered. Bounded LRU. */
  function firstDelivery(messageId: string): boolean {
    if (!messageId || seenMessageIds.has(messageId)) return false;
    seenMessageIds.add(messageId);
    seenMessageOrder.push(messageId);
    if (seenMessageOrder.length > 1_000) {
      const oldest = seenMessageOrder.shift();
      if (oldest) seenMessageIds.delete(oldest);
    }
    scheduleDedupFlush();
    return true;
  }

  /**
   * A p2p chat is one continuous conversation; a group thread is keyed by its
   * root (falling back to thread/reply ids), and a fresh @ starts its own key.
   */
  function topicKeyFor(event: LarkMessageEvent): string {
    if (event.chat_type === "p2p") return event.chat_id;
    return event.root_id || event.thread_id || event.reply_to || event.message_id;
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

  /** Credentials/app switch changed the bot identity; re-read it. */
  function resetIdentity(): void {
    cachedBotOpenId = null;
    openIdLoaded = false;
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
      if (senderLabels.size > 500) {
        const oldest = senderLabels.keys().next().value;
        if (oldest) senderLabels.delete(oldest);
      }
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

  /** Recursively collect image keys from a raw post payload. */
  function collectImageKeys(value: unknown, output: Set<string>, depth = 0): void {
    if (depth > 8 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) collectImageKeys(item, output, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.image_key === "string" && record.image_key.startsWith("img_")) {
      output.add(record.image_key);
    }
    for (const item of Object.values(record)) collectImageKeys(item, output, depth + 1);
  }

  function cacheImages(key: string, buffers: { bytes: Buffer; mime: string }[]): void {
    const images = topicImages.get(key) ?? [];
    for (const buffer of buffers) {
      const attachment = toImageAttachment(buffer.bytes, buffer.mime);
      if (attachment) images.push(attachment);
    }
    if (images.length > MAX_TOPIC_IMAGES) images.splice(0, images.length - MAX_TOPIC_IMAGES);
    topicImages.set(key, images);
    pruneMap(topicImages, MAX_TOPIC_IMAGE_TOPICS, key);
  }

  /**
   * Download media posted in a topic: images (including images embedded in a
   * post) as-is, videos as extracted frames. Everything is cached per topic so
   * the next @-mention in the thread carries it to the provider. Failures
   * degrade to placeholders.
   */
  async function ingestMedia(cliPath: string, event: LarkMessageEvent): Promise<void> {
    if (event.chat_type !== "group") return;
    const kind =
      event.message_type === "image" ? "image" : event.message_type === "media" ? "video" : null;
    if (!kind && event.message_type !== "post") return;
    const key = topicKeyFor(event);
    try {
      const raw = await readRaw(cliPath, event.message_id);
      if (!raw) return;
      let imageKeys: string[] = [];
      if (event.message_type === "post") {
        const keys = new Set<string>();
        collectImageKeys(raw, keys);
        imageKeys = [...keys];
      } else {
        const fileKey =
          typeof raw.image_key === "string" && kind === "image"
            ? raw.image_key
            : typeof raw.file_key === "string"
              ? raw.file_key
              : null;
        if (!fileKey) return;
        if (kind === "image") {
          const resource = await download({
            cliPath,
            messageId: event.message_id,
            fileKey,
            type: "image",
            maxBytes: 5 * 1024 * 1024,
          });
          cacheImages(key, [
            { bytes: resource.bytes, mime: resource.extension === ".png" ? "image/png" : "image/jpeg" },
          ]);
          return;
        }
        const resource = await download({
          cliPath,
          messageId: event.message_id,
          fileKey,
          type: "file",
          maxBytes: 50 * 1024 * 1024,
        });
        const ffmpeg = resolveFfmpeg();
        if (!ffmpeg) return;
        const dir = mkdtempSync(join(tmpdir(), "lark-bot-video-"));
        try {
          const videoPath = join(dir, "video" + resource.extension);
          writeFileSync(videoPath, resource.bytes);
          const buffers: { bytes: Buffer; mime: string }[] = [];
          for (const frame of await extractFrames(videoPath, ffmpeg, 3)) {
            buffers.push({ bytes: frame, mime: "image/jpeg" });
          }
          cacheImages(key, buffers);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
        return;
      }

      const buffers: { bytes: Buffer; mime: string }[] = [];
      for (const fileKey of imageKeys.slice(0, MAX_IMAGES_PER_TURN)) {
        const resource = await download({
          cliPath,
          messageId: event.message_id,
          fileKey,
          type: "image",
          maxBytes: 5 * 1024 * 1024,
        });
        buffers.push({ bytes: resource.bytes, mime: resource.extension === ".png" ? "image/png" : "image/jpeg" });
      }
      cacheImages(key, buffers);
    } catch (error) {
      log("处理话题媒体失败", error instanceof Error ? error.message : String(error));
    }
  }

  function pruneMap<T>(map: Map<string, T>, max: number, keep: string): void {
    while (map.size > max) {
      const oldest = map.keys().next().value;
      if (!oldest || oldest === keep) break;
      map.delete(oldest);
    }
  }

  function recordHistory(event: LarkMessageEvent): void {
    const key = topicKeyFor(event);
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
    pruneMap(topicHistory, MAX_TOPIC_HISTORY, key);
  }

  async function handleMessageEvent(event: LarkMessageEvent): Promise<void> {
    if (!firstDelivery(event.message_id)) return;
    const key = topicKeyFor(event);
    const previous = topicChains.get(key) ?? Promise.resolve();
    const next = previous.then(
      () => processMessageEvent(event),
      () => processMessageEvent(event),
    );
    topicChains.set(key, next);
    try {
      await next;
    } finally {
      if (topicChains.get(key) === next) topicChains.delete(key);
    }
  }

  async function processMessageEvent(event: LarkMessageEvent): Promise<void> {
    try {
      latestSeen.set(event.chat_id, event.message_id);
      if (latestSeen.size > 500) {
        const oldest = latestSeen.keys().next().value;
        if (oldest) latestSeen.delete(oldest);
      }
      const values = await currentValues();
      const cliPath = cliPathFor(values);
      if (!cliPath) return;
      const botOpenId = await ensureBotOpenId(cliPath);
      if (event.chat_type === "group" && !botOpenId) return;

      // Only chats with a binding may be recorded or downloaded. Unbound chats
      // get at most the configured "not configured" hint.
      const binding = values.chats.find((chat) => chat.chatId === event.chat_id) ?? null;
      if (!binding) {
        const unmatched = routeMessage(event, values, botOpenId);
        if (unmatched.reason === "unmatched") {
          rememberUnmatched(event);
          if (values.notifyUnmatched) {
            await send(cliPath, event.message_id, UNMATCHED_HINT, values, "text");
          }
        }
        return;
      }

      // Record/ingest before routing so unmentioned messages in a bound chat
      // still contribute thread context; awaiting the download keeps a fast
      // follow-up @ from reading an empty image cache. Disallowed senders are
      // stopped here so their text/media never enters the topic transcript.
      if (!isSenderAllowed(binding, event.sender_id)) {
        const triggered =
          event.chat_type === "p2p" || (event.chat_type === "group" && mentionsBot(event, botOpenId));
        if (triggered && event.sender_type !== "bot") {
          log(`会话 ${event.chat_id} 收到未授权成员 ${event.sender_id} 的 @，已拒绝处理`);
          await send(cliPath, event.message_id, BLOCKED_HINT, values, "text");
        }
        return;
      }
      recordHistory(event);
      await ingestMedia(cliPath, event);
      const decision = routeMessage(event, values, botOpenId);
      if (decision.reason === "ignored") return;
      if (decision.reason === "unmatched" || !decision.binding) {
        rememberUnmatched(event);
        return;
      }
      // One agent session per Feishu thread: replies inside a topic share
      // context, while each fresh @-mention starts an independent topic. P2P
      // has no thread root, so the chat itself is the continuous topic.
      const topicKey = topicKeyFor(event);
      const images = (topicImages.get(topicKey) ?? []).slice(-MAX_IMAGES_PER_TURN);

      // A bare @-mention means "go handle the thread": proceed whenever the
      // thread carries any context (topic subject, history, or images) and
      // only ask for text when there is truly nothing to work on.
      let instruction = decision.prompt;
      if (!instruction) {
        const probe = await withThreadContext(cliPath, event, "");
        if (!probe.hasContext && images.length === 0) {
          await send(cliPath, event.message_id, EMPTY_PROMPT_HINT, values, "text");
          return;
        }
        instruction = "请查看并处理上方话题内容。";
      }
      if (values.ackOnReceive) {
        await send(cliPath, event.message_id, ACK_TEXT, values, "text");
      }
      const { text: prompt } = await withThreadContext(cliPath, event, instruction);
      const finalPrompt =
        images.length > 0
          ? prompt + "\n\n【附图】本消息附加 " + images.length + " 张图片（含视频关键帧），请结合图片内容回答。"
          : prompt;
      if (sessions.enqueue(topicKey, event.chat_id, event.message_id, finalPrompt, decision.binding, images)) {
        lastTriggerMessage.set(topicKey, event.message_id);
        pruneMap(lastTriggerMessage, MAX_TOPIC_HISTORY, topicKey);
      }
    } catch (error) {
      log("处理消息失败", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * First @ in a topic gets the root subject plus the recorded history; later
   * @s only get messages after the previous trigger because the agent already
   * holds the earlier turns. A rebuilt/expired agent is treated as a first @.
   */
  async function withThreadContext(
    cliPath: string,
    event: LarkMessageEvent,
    prompt: string,
  ): Promise<{ text: string; hasContext: boolean }> {
    const historyKey = topicKeyFor(event);
    const history = (topicHistory.get(historyKey) ?? []).filter(
      (entry) => entry.messageId !== event.message_id,
    );
    // A fresh/expired agent has no prior turns in its own context, so treat
    // this as the first message and include the topic root/history again.
    if (sessions.needsRebuild(historyKey)) lastTriggerMessage.delete(historyKey);
    const previousTrigger = lastTriggerMessage.get(historyKey);
    const previousIndex = previousTrigger
      ? history.findIndex((entry) => entry.messageId === previousTrigger)
      : -1;
    const incremental = previousTrigger
      ? previousIndex >= 0
        ? history.slice(previousIndex + 1)
        : history
      : history;
    const transcriptOf = (entries: typeof history): string =>
      entries
        .slice(-20)
        .map((entry) => entry.senderType + ": " + clipContext(entry.text))
        .join("\n");

    // p2p has no thread root; one chat is one conversation. Only inject what
    // arrived since the previous bot turn, because the agent already has the
    // earlier turns in its own context.
    if (event.chat_type === "p2p") {
      if (previousTrigger) {
        const transcript = transcriptOf(incremental);
        if (!transcript) return { text: prompt, hasContext: true };
        return {
          text: "【上次消息之后】\n" + transcript + (prompt ? "\n\n【本次消息】" + prompt : ""),
          hasContext: true,
        };
      }
      if (history.length === 0) return { text: prompt, hasContext: false };
      return {
        text: "【最近对话】\n" + transcriptOf(history) + (prompt ? "\n\n【本次消息】" + prompt : ""),
        hasContext: true,
      };
    }

    // A second (or later) @ in the same topic must not repeat the topic root
    // or the whole history. The agent already has those from its previous
    // turns; only the conversation since the last trigger is new.
    if (previousTrigger) {
      const transcript = transcriptOf(incremental);
      if (!transcript) return { text: prompt, hasContext: true };
      return {
        text: "【上次消息之后】\n" + transcript + (prompt ? "\n\n【本次消息】" + prompt : ""),
        hasContext: true,
      };
    }

    const rootId = event.root_id || event.reply_to;
    if (!rootId) return { text: prompt, hasContext: false };
    let rootText: string | null = null;
    const rootInHistory = history.length > 0 && history[0]?.messageId === rootId;
    if (rootInHistory) {
      rootText = history[0]?.text ?? null;
    } else {
      let detail: MessageDetail | null;
      if (threadRootCache.has(rootId)) {
        detail = threadRootCache.get(rootId) ?? null;
      } else {
        try {
          detail = await readThreadRootDetail(cliPath, rootId);
        } catch (error) {
          log("读取话题根消息失败", error instanceof Error ? error.message : String(error));
          detail = null;
        }
        threadRootCache.set(rootId, detail);
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
    const prior = history.filter((entry) => entry.messageId !== rootId);
    if (prior.length > 0) {
      const transcript = transcriptOf(prior);
      if (transcript && !lines.includes("【话题主题】" + transcript)) lines.push("【话题历史】\n" + transcript);
    }
    if (lines.length === 0) return { text: prompt, hasContext: false };
    const text = lines.join("\n\n") + (prompt ? "\n\n【本次消息】" + prompt : "");
    return { text, hasContext: true };
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
    // Prefer the topic's own trigger/most recent message; the chat-level
    // latestSeen can belong to a different topic in the same group.
    const target = sessions.targetForAgent(event.agent.id) ?? (chatId ? latestSeen.get(chatId) : undefined);
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
    // A dropped reply means the user saw an ack but never got the answer.
    // Retryable failures (rate limit, transient transport) retry with backoff
    // under one idempotency key, so a retry can never duplicate a message.
    const key = `lb-${createHash("sha256").update(`${messageId}:${finalText}`).digest("hex").slice(0, 40)}`;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await reply({
          cliPath,
          messageId,
          text: finalText,
          format,
          replyInThread: values.replyInThread,
          idempotencyKey: key,
        });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retryable = attempt < 3 && /429|rate\s*limit|too many requests|频率|限流|timeout|timed out|ETIMEDOUT|ECONNRESET|network|temporarily/i.test(message);
        if (!retryable) {
          log("回复消息失败", message);
          return;
        }
        const backoffMs = /429|rate\s*limit|too many requests|频率|限流/i.test(message) ? 5_000 : 1_000 * attempt;
        log(`回复消息失败，${Math.round(backoffMs / 1000)}s 后重试（第 ${attempt} 次）`, message.slice(0, 200));
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
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
    resetIdentity,
    status: () => ({
      sessions: sessions.status(),
      unmatched: [...unmatchedRecent.values()],
      botOpenId: cachedBotOpenId,
    }),
  };
}

export type Dispatcher = ReturnType<typeof createDispatcher>;
