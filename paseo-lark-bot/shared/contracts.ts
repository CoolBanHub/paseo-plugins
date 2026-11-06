import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Group chats the bot has joined (lark-cli im +chat-list). */
export const larkBotChatsRpc = defineRpc({
  name: "lark-bot.chats.list",
  input: z.object({}).strict(),
  output: z.object({
    chats: z.array(z.object({ chatId: z.string(), name: z.string() })),
    error: z.string().nullable(),
  }),
});

/** Enabled Paseo providers with the options the binding UI can select. */
export const larkBotProvidersRpc = defineRpc({
  name: "lark-bot.providers.list",
  input: z.object({}).strict(),
  output: z.object({
    providers: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        models: z.array(
          z.object({
            id: z.string(),
            label: z.string(),
            isDefault: z.boolean(),
            thinkingOptions: z.array(z.object({ id: z.string(), label: z.string() })),
            defaultThinkingOptionId: z.string().nullable(),
          }),
        ),
        modes: z.array(
          z.object({ id: z.string(), label: z.string(), description: z.string().nullable() }),
        ),
        /**
         * How `permission` is applied: dsh uses a permission preset feature,
         * other providers use their mode id, and `none` means no selectable
         * permission option is available.
         */
        permissionKind: z.enum(["dsh-preset", "mode", "none"]),
        permissionOptions: z.array(z.object({ value: z.string(), label: z.string() })),
        /** Effective provider default when the binding leaves permission empty. */
        defaultPermission: z.string().nullable(),
      }),
    ),
    error: z.string().nullable(),
  }),
});

/** Members of one chat, for the per-binding allowlist picker. */
export const larkBotChatMembersRpc = defineRpc({
  name: "lark-bot.chat.members",
  input: z.object({ chatId: z.string().min(1) }).strict(),
  output: z.object({
    members: z.array(z.object({ openId: z.string(), name: z.string() })),
    error: z.string().nullable(),
  }),
});

export type LarkBotProviderInfo = z.output<typeof larkBotProvidersRpc.output>["providers"][number];
export type LarkBotChatMember = z.output<typeof larkBotChatMembersRpc.output>["members"][number];

/** Runtime status for the settings screen. */
export const larkBotStatusRpc = defineRpc({
  name: "lark-bot.status",
  input: z.object({}).strict(),
  output: z.object({
    consumerState: z.enum(["stopped", "starting", "ready", "retrying"]),
    lastError: z.string().nullable(),
    cliPath: z.string().nullable(),
    currentAppId: z.string().nullable(),
    botOpenId: z.string().nullable(),
    sessions: z.array(
      z.object({
        chatId: z.string(),
        topicKey: z.string(),
        agentId: z.string().nullable(),
        busy: z.boolean(),
        queued: z.number(),
      }),
    ),
    /** Recently seen chats without a binding, offered as one-click additions. */
    unmatched: z.array(
      z.object({ chatId: z.string(), chatType: z.string(), lastSeenAt: z.number() }),
    ),
  }),
});
