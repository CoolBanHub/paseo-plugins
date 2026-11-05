import type { LarkMessageEvent } from "./lark-events.ts";
import type { BotValues, ChatBinding } from "../shared/settings.ts";

/** Message types whose pre-rendered content is meaningful agent input. */
const HANDLED_MESSAGE_TYPES = new Set(["text", "post"]);

export interface RoutingDecision {
  binding: ChatBinding | null;
  prompt: string;
  reason: "ok" | "unmatched" | "ignored";
}

/**
 * Decide whether an inbound event should run through an agent and produce the
 * cleaned prompt. Group chats require an @-mention of this bot; p2p chats are
 * handled directly. The bot's own outgoing messages and non-text types are
 * ignored.
 */
export function routeMessage(event: LarkMessageEvent, values: BotValues, botOpenId: string | null): RoutingDecision {
  if (!HANDLED_MESSAGE_TYPES.has(event.message_type)) {
    return { binding: null, prompt: "", reason: "ignored" };
  }
  // Feishu never delivers the bot's own messages to it, but guard anyway so a
  // future relay setup cannot create a reply loop.
  if (botOpenId && event.sender_id === botOpenId) {
    return { binding: null, prompt: "", reason: "ignored" };
  }
  if (event.chat_type === "group") {
    // Without the bot's own open_id there is no way to verify the mention.
    if (!botOpenId) {
      return { binding: null, prompt: "", reason: "ignored" };
    }
    const mentioned = (event.mentions ?? []).some((mention) => mention.id === botOpenId);
    if (!mentioned) {
      return { binding: null, prompt: "", reason: "ignored" };
    }
  }

  const binding = values.chats.find((chat) => chat.chatId === event.chat_id) ?? null;
  if (!binding) {
    return { binding: null, prompt: "", reason: "unmatched" };
  }
  return { binding, prompt: extractPrompt(event), reason: "ok" };
}

/**
 * Strip @-mention placeholders (@_user_N keys defined in event.mentions) and
 * surrounding whitespace, leaving the instruction text.
 */
export function extractPrompt(event: LarkMessageEvent): string {
  let text = event.content ?? "";
  for (const mention of event.mentions ?? []) {
    // The CLI pre-renders mentions two ways: the raw placeholder key
    // (@_user_N) or the display name (@测试机器人); strip both.
    for (const form of [mention.key, mention.name ? "@" + mention.name : null]) {
      if (form) {
        text = text.split(form).join(" ");
      }
    }
  }
  // Replaced mentions leave consecutive spaces; collapse horizontal
  // whitespace only so multi-line instructions keep their line breaks.
  return text.replace(/\u2005/g, " ").replace(/[^\S\n]+/g, " ").trim();
}
