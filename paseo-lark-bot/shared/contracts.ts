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

/** Enabled Paseo providers, for the per-chat provider picker. */
export const larkBotProvidersRpc = defineRpc({
  name: "lark-bot.providers.list",
  input: z.object({}).strict(),
  output: z.object({
    providers: z.array(z.object({ id: z.string(), label: z.string() })),
    error: z.string().nullable(),
  }),
});

/** Runtime status for the settings screen. */
export const larkBotStatusRpc = defineRpc({
  name: "lark-bot.status",
  input: z.object({}).strict(),
  output: z.object({
    consumerState: z.enum(["stopped", "starting", "ready", "retrying"]),
    lastError: z.string().nullable(),
    cliPath: z.string().nullable(),
    botOpenId: z.string().nullable(),
    sessions: z.array(
      z.object({
        chatId: z.string(),
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
