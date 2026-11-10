import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractPrompt, routeMessage } from "../server/router.ts";
import type { LarkMessageEvent } from "../server/lark-events.ts";
import { DEFAULT_BOT_VALUES } from "../shared/settings.ts";

const BOT = "ou_bot";
const USER = "ou_user";

function event(overrides: Partial<LarkMessageEvent> = {}): LarkMessageEvent {
  return {
    chat_id: "oc_group",
    chat_type: "group",
    content: "@_user_1 帮我看看这个问题",
    message_id: "om_1",
    message_type: "text",
    sender_id: USER,
    sender_type: "user",
    mentions: [{ id: BOT, key: "@_user_1", name: "测试机器人" }],
    ...overrides,
  };
}

function values(overrides: Partial<typeof DEFAULT_BOT_VALUES> = {}) {
  return {
    ...DEFAULT_BOT_VALUES,
    chats: [
      {
        chatId: "oc_group",
        chatName: "测试群",
        provider: "claude",
        model: "",
        thinkingOptionId: "",
        permission: "",
        allowedUsers: [],
        cwd: "/tmp/project",
        systemPrompt: "",
        replyStyle: "default" as const,
        replyStylePrompt: "",
        replyFormat: "markdown" as const,
      },
      {
        chatId: "oc_p2p",
        chatName: "",
        provider: "codex",
        model: "",
        thinkingOptionId: "",
        permission: "",
        allowedUsers: [],
        cwd: "/tmp",
        systemPrompt: "",
        replyStyle: "default" as const,
        replyStylePrompt: "",
        replyFormat: "text" as const,
      },
    ],
    ...overrides,
  };
}

describe("routeMessage", () => {
  it("routes a group @-mention to its binding", () => {
    const decision = routeMessage(event(), values(), BOT);
    assert.equal(decision.reason, "ok");
    assert.equal(decision.binding?.provider, "claude");
    assert.equal(decision.prompt, "帮我看看这个问题");
  });

  it("blocks senders outside the per-chat allowlist", () => {
    const base = values();
    const first = base.chats[0];
    assert.ok(first);
    const restricted = values({
      chats: [
        { ...first, allowedUsers: [{ openId: "ou_boss", name: "指定人" }] },
        base.chats[1]!,
      ],
    });

    const blocked = routeMessage(event({ sender_id: "ou_other" }), restricted, BOT);
    assert.equal(blocked.reason, "blocked");
    assert.equal(blocked.binding, null);

    const allowed = routeMessage(event({ sender_id: "ou_boss" }), restricted, BOT);
    assert.equal(allowed.reason, "ok");
    assert.equal(allowed.binding?.provider, "claude");
  });

  it("keeps every sender allowed when the allowlist is empty", () => {
    const decision = routeMessage(event({ sender_id: "ou_anyone" }), values(), BOT);
    assert.equal(decision.reason, "ok");
  });

  it("ignores group messages without an @-mention of this bot", () => {
    const decision = routeMessage(
      event({ content: "普通聊天", mentions: [{ id: "ou_other", key: "@_user_1", name: "别人" }] }),
      values(),
      BOT,
    );
    assert.equal(decision.reason, "ignored");
  });

  it("handles p2p messages without any mention", () => {
    const decision = routeMessage(
      event({ chat_id: "oc_p2p", chat_type: "p2p", content: "直接提问", mentions: undefined }),
      values(),
      BOT,
    );
    assert.equal(decision.reason, "ok");
    assert.equal(decision.binding?.provider, "codex");
  });

  it("ignores messages sent by the bot itself", () => {
    const decision = routeMessage(event({ sender_id: BOT }), values(), BOT);
    assert.equal(decision.reason, "ignored");
  });

  it("ignores non-text message types", () => {
    const decision = routeMessage(event({ message_type: "image" }), values(), BOT);
    assert.equal(decision.reason, "ignored");
  });

  it("reports unbound chats as unmatched", () => {
    const decision = routeMessage(event({ chat_id: "oc_unknown" }), values(), BOT);
    assert.equal(decision.reason, "unmatched");
    assert.equal(decision.binding, null);
  });

  it("ignores group chats when the bot open_id is unknown", () => {
    const decision = routeMessage(event(), values(), null);
    assert.equal(decision.reason, "ignored");
  });
});

describe("extractPrompt", () => {
  it("strips every mention placeholder", () => {
    const prompt = extractPrompt(
      event({
        content: "@_user_1 转给 @_user_2 看看",
        mentions: [
          { id: BOT, key: "@_user_1", name: "bot" },
          { id: "ou_other", key: "@_user_2", name: "别人" },
        ],
      }),
    );
    assert.equal(prompt, "转给 看看");
  });

  it("strips pre-rendered @name mentions", () => {
    const prompt = extractPrompt(
      event({ content: "@测试机器人 帮我看看这个问题" }),
    );
    assert.equal(prompt, "帮我看看这个问题");
  });

  it("keeps p2p text as-is", () => {
    const prompt = extractPrompt(event({ content: "  直接提问  ", mentions: undefined }));
    assert.equal(prompt, "直接提问");
  });
});
