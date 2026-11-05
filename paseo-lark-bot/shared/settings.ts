import { defineSettings, settingsRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Host-scoped settings for the Feishu bot. Shared between the settings screen
 * (client) and the event wiring (server) — must not import from server/ or
 * client/. Every field has a default so the plugin loads with no
 * configuration; the event consumer only starts once a chat is bound.
 */

/**
 * `markdown` renders headings/lists/code blocks; `text` preserves literal
 * output; `post` keeps inline `<at user_id=...>` mentions intact so replies
 * can trigger other agents in the chat (agent-at-agent handoff).
 */
export const replyFormatSchema = z.enum(["markdown", "text", "post"]);
export type ReplyFormat = z.output<typeof replyFormatSchema>;

export const chatBindingSchema = z.object({
  /** Feishu chat_id (oc_…); group chats and p2p chats are keyed the same way. */
  chatId: z.string().min(1),
  /** Display name kept in sync from the chat list for the settings UI. */
  chatName: z.string().default(""),
  /** Paseo provider id, optionally `provider/model`. */
  provider: z.string().min(1),
  /**
   * Working directory for the agent session; empty means the user's home
   * directory (resolved server-side — this shared bundle cannot import
   * node:os because the client loads it too).
   */
  cwd: z.string().default(""),
  /** Optional extra system prompt prepended for this chat. */
  systemPrompt: z.string().default(""),
  replyFormat: replyFormatSchema.default("markdown"),
});

export type ChatBinding = z.output<typeof chatBindingSchema>;

export const botValuesSchema = z.object({
  /** Explicit lark-cli binary path; empty means auto-discovery. */
  larkCliPath: z.string().default(""),
  /** Reply inside the source message's thread instead of the main stream. */
  replyInThread: z.boolean().default(true),
  /** Start a fresh agent session after this many idle minutes. */
  sessionIdleMinutes: z.number().int().min(0).max(24 * 60).default(30),
  /** Clip replies longer than this many characters. */
  maxReplyChars: z.number().int().min(200).max(30_000).default(4000),
  /** Reply with a hint when an unconfigured chat @-mentions the bot. */
  notifyUnmatched: z.boolean().default(false),
  chats: z.array(chatBindingSchema).default([]),
});

export type BotValues = z.output<typeof botValuesSchema>;

export const DEFAULT_BOT_VALUES: BotValues = botValuesSchema.parse({});

export const larkBotSettings = defineSettings({
  id: "lark_bot",
  scope: "host",
  version: 1,
  schema: botValuesSchema,
});

/** read/write contracts handled host-side once registerSettings ran. */
export const larkBotSettingsRpc = settingsRpc(larkBotSettings.id);
