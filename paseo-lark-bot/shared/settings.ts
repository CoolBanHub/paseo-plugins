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

/**
 * Who to @ after a turn finishes. Mentions are sent as a separate plain-text
 * message because Feishu only fires mention notifications for `text` messages
 * (not post/card), and doing so keeps the answer's markdown intact.
 */
export const mentionOnReplySchema = z.enum(["off", "sender", "topic", "both"]);
export type MentionOnReply = z.output<typeof mentionOnReplySchema>;

export const MENTION_ON_REPLY_OPTIONS: ReadonlyArray<{
  value: MentionOnReply;
  label: string;
  hint: string;
}> = [
  { value: "off", label: "不 @", hint: "完成后不发额外提醒。" },
  {
    value: "sender",
    label: "@ 触发者",
    hint: "在群里 @ 本次发消息的人；单聊不适用。",
  },
  {
    value: "topic",
    label: "@ 话题发起人",
    hint: "在群里 @ 这个话题根消息的发送者；话题发起人≠触发者时也只提醒发起人。",
  },
  {
    value: "both",
    label: "@ 两者",
    hint: "同时 @ 触发者和话题发起人；同一人只 @ 一次。",
  },
];

/**
 * Reply-style presets are appended to the agent's system prompt. They are
 * instructions to the main turn only — no second model call, no extra cost.
 */
export const replyStyleSchema = z.enum(["default", "concise", "plain", "custom"]);
export type ReplyStyle = z.output<typeof replyStyleSchema>;

export const REPLY_STYLE_OPTIONS: ReadonlyArray<{
  value: ReplyStyle;
  label: string;
  hint: string;
}> = [
  { value: "default", label: "默认", hint: "不追加额外要求，沿用智能体自己的回答风格。" },
  {
    value: "concise",
    label: "简洁结论",
    hint: "3-5 句，先给结论和下一步；代码、命令、路径保留。",
  },
  {
    value: "plain",
    label: "通俗解释",
    hint: "面向非技术同事，少用术语；代码、命令、路径保留。",
  },
  {
    value: "custom",
    label: "自定义",
    hint: "在下方填写自己的回复要求，会追加到系统提示末尾；留空则不追加。",
  },
];

/** Prompt text appended for a reply style; empty for default or blank custom. */
export function replyStyleInstruction(style: ReplyStyle, custom: string): string {
  switch (style) {
    case "concise":
      return "回答控制在 3-5 句：先给结论，再给关键下一步或注意事项。只保留必要的细节，不要复述分析过程；代码块、命令、文件路径和链接原样保留，不要省略。";
    case "plain":
      return "面向非技术同事解释：先说结论，以及这对用户意味着什么、需要做什么。少用术语；必须使用术语时用一句话解释。代码块、命令、文件路径和链接原样保留。";
    case "custom":
      return custom.trim();
    default:
      return "";
  }
}

/**
 * Optional post-processing pass: run one extra model turn over the final
 * answer and send the shorter rewrite. Off by default; `long` only rewrites
 * answers over REPLY_REWRITE_LONG_CHARS, `always` rewrites every answer.
 */
export const replyRewriteSchema = z.enum(["off", "long", "always"]);
export type ReplyRewrite = z.output<typeof replyRewriteSchema>;

export const REPLY_REWRITE_LONG_CHARS = 800;

export const REPLY_REWRITE_OPTIONS: ReadonlyArray<{
  value: ReplyRewrite;
  label: string;
  hint: string;
}> = [
  { value: "off", label: "关闭", hint: "直接发送原始回答，不额外调用模型。" },
  {
    value: "long",
    label: "仅长回复",
    hint: `超过 ${REPLY_REWRITE_LONG_CHARS} 字才改写；短回答原样发送。`,
  },
  {
    value: "always",
    label: "总是",
    hint: "每条最终回答都改写；多一次模型调用和等待。",
  },
];

/** Fallback rewrite instruction when the binding has no reply-style prompt. */
export const DEFAULT_REWRITE_INSTRUCTION =
  "把回答改写成 3-5 句：先给结论，再给关键下一步或注意事项；面向非技术同事，少用术语；代码块、命令、文件路径、链接和数字原样保留。";

/**
 * A Feishu user allowed to drive the bot in one chat. Only `openId` is used
 * for matching; `name` is a display convenience kept from the member picker.
 */
export const allowedUserSchema = z.object({
  openId: z.string().min(1),
  name: z.string().default(""),
});

export type AllowedUser = z.output<typeof allowedUserSchema>;

/**
 * dsh's permission presets. Kept here (rather than imported from paseo-dsh)
 * because this plugin runs standalone and the values are dsh-protocol level.
 * Empty `permission` keeps the historical danger-full-access default.
 */
export const DSH_PERMISSION_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "read-only", label: "仅可查看" },
  { value: "workspace-write", label: "工作区内修改" },
  { value: "danger-full-access", label: "完全权限" },
];

export const DSH_DEFAULT_PERMISSION = "danger-full-access";

/** True for the bare dsh provider or `dsh/<model>`; custom ids stay untouched. */
export function isDshProvider(provider: string): boolean {
  return provider.split("/", 1)[0] === "dsh";
}

export const chatBindingSchema = z.object({
  /** Feishu chat_id (oc_…); group chats and p2p chats are keyed the same way. */
  chatId: z.string().min(1),
  /** Display name kept in sync from the chat list for the settings UI. */
  chatName: z.string().default(""),
  /** Paseo provider id, optionally `provider/model`. */
  provider: z.string().min(1),
  /** Model id; empty means the provider's default model. */
  model: z.string().default(""),
  /** Provider thinking option id; empty means the provider/model default. */
  thinkingOptionId: z.string().default(""),
  /**
   * Provider mode id for most providers (Claude/Codex/ZCode use modes for
   * approval behavior). For dsh this stores a permission preset such as
   * `workspace-write` and is applied as the dsh permission feature instead.
   * Empty keeps the plugin/provider default.
   */
  permission: z.string().default(""),
  /**
   * Who may @ the bot in this chat. Empty means everyone (default). Feishu
   * sender_id is an open_id, so entries are matched against `openId`.
   * This only gates triggering: messages from other members (including their
   * @-mentions) still contribute thread context.
   */
  allowedUsers: z.array(allowedUserSchema).default([]),
  /**
   * Working directory for the agent session; empty means the user's home
   * directory (resolved server-side — this shared bundle cannot import
   * node:os because the client loads it too).
   */
  cwd: z.string().default(""),
  /** Optional system prompt for this chat; replaces the plugin default when set. */
  systemPrompt: z.string().default(""),
  /**
   * Appended to the effective system prompt as an extra reply-style
   * instruction. `custom` uses replyStylePrompt below.
   */
  replyStyle: replyStyleSchema.default("default"),
  /** Custom reply instruction; only used when replyStyle is `custom`. */
  replyStylePrompt: z.string().default(""),
  /** Optional AI rewrite of the final answer before sending it to Feishu. */
  replyRewrite: replyRewriteSchema.default("off"),
  /** Provider used only for the rewrite; empty follows the main binding. */
  rewriteProvider: z.string().default(""),
  /** Model used only for the rewrite; empty means that provider's default. */
  rewriteModel: z.string().default(""),
  replyFormat: replyFormatSchema.default("markdown"),
  /** Who to @ in the group after the turn finishes. */
  mentionOnReply: mentionOnReplySchema.default("off"),
  /** Allow whitelisted members to use /agents and /delegate. */
  allowAgentDelegation: z.boolean().default(false),
});

export type ChatBinding = z.output<typeof chatBindingSchema>;

export const botValuesSchema = z.object({
  /**
   * Feishu app credentials. When both are set the plugin validates them
   * against the tenant_access_token endpoint and writes them into lark-cli
   * (non-interactive config init). Empty values keep lark-cli's existing
   * keychain configuration. Stored in plain text by design for local-only use:
   * the user explicitly does not want encryption here. Changing only the
   * secret for the same App ID is detected and written as well.
   */
  appId: z.string().default(""),
  appSecret: z.string().default(""),
  /**
   * Whether the plugin should listen for Feishu events. Turning this off is
   * the "unbind" switch: consumers stop, but the app, lark-cli config, and
   * chat bindings stay in place and can be re-enabled.
   */
  enabled: z.boolean().default(true),
  /** Explicit lark-cli binary path; empty means auto-discovery. */
  larkCliPath: z.string().default(""),
  /** Reply inside the source message's thread instead of the main stream. */
  replyInThread: z.boolean().default(true),
  /** Start a fresh agent session after this many idle minutes. */
  sessionIdleMinutes: z.number().int().min(0).max(24 * 60).default(30),
  /**
   * Split replies longer than this many characters into several thread
   * replies (code-fence aware) instead of clipping them.
   */
  maxReplyChars: z.number().int().min(200).max(30_000).default(4000),
  /** Hard cap on split parts per reply; the remainder is clipped. */
  maxReplyChunks: z.number().int().min(1).max(10).default(4),
  /** Reply with a hint when an unconfigured chat @-mentions the bot. */
  notifyUnmatched: z.boolean().default(false),
  /**
   * Emoji receipt on the triggering message (OnIt while queued/running,
   * DONE when the answer is delivered). Silent and dismissible, unlike a
   * text ack in an active group.
   */
  ackReaction: z.boolean().default(true),
  /** Post an explicit "received, working on it" text reply. Off by default. */
  ackOnReceive: z.boolean().default(false),
  /**
   * Keep one live progress card per topic while a turn runs: elapsed time,
   * queue depth, current tool and the latest output line. Requires the
   * app to be able to send interactive cards; card updates never push a
   * notification, so the DONE reaction marks completion.
   */
  progressCard: z.boolean().default(true),
  /** Split long replies into thread parts. */
  replySplit: z.boolean().default(true),
  /** Append model/tokens/duration to each answer. */
  replyFooter: z.boolean().default(false),
  /**
   * Accept files the agent drops into the plugin's outbox and post them back
   * to the topic. Off means the helper exists but its requests are discarded.
   */
  attachmentSend: z.boolean().default(true),
  /** Largest outbound attachment accepted, in MiB (inbound files cap at 20MB). */
  attachmentMaxMb: z.number().int().min(1).max(200).default(50),
  /**
   * Per-sender inbound turn budget per hour. 0 disables the limit. Commands
   * and messages from other senders do not consume another user's budget.
   */
  rateLimitPerHour: z.number().int().min(0).max(500).default(20),
  /**
   * Give each chat binding its own workspace (named after the chat) instead
   * of putting every topic agent in the shared "飞书任务" workspace. Use this
   * when bindings point at different project directories.
   */
  workspacePerBinding: z.boolean().default(false),
  /**
   * Name new topic sessions with a one-shot AI turn on the chat's bound
   * provider (adds a short delay to the first reply). On failure, timeout,
   * or when disabled, the title falls back to the sanitized topic text.
   */
  aiTitle: z.boolean().default(true),
  /**
   * Post permission requests to the chat. Off by default: requests are
   * resolved in the Paseo client, and the finished answer still returns to
   * the thread, so the extra notice is noise for most workflows.
   */
  notifyPermission: z.boolean().default(false),
  /**
   * Post dsh's ask_user_question as an interactive card in the topic and
   * accept the answer there. Requires the Feishu app's card.action.trigger
   * callback event. On by default because a pending question blocks the turn;
   * without the card the user has to answer in the Paseo client.
   */
  questionCards: z.boolean().default(true),
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
