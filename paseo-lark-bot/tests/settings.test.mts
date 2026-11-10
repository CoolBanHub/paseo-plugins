import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { botValuesSchema, isDshProvider, replyStyleInstruction } from "../shared/settings.ts";

describe("chat binding schema", () => {
  it("fills the new model/thinking/permission/allowlist fields for old settings", () => {
    const parsed = botValuesSchema.parse({
      chats: [{ chatId: "oc_group", provider: "dsh" }],
    });
    const binding = parsed.chats[0];
    assert.ok(binding);
    assert.equal(binding.model, "");
    assert.equal(binding.thinkingOptionId, "");
    assert.equal(binding.permission, "");
    assert.deepEqual(binding.allowedUsers, []);
    // Existing cwd/system-prompt/reply-format defaults are unchanged.
    assert.equal(binding.cwd, "");
    assert.equal(binding.systemPrompt, "");
    assert.equal(binding.replyStyle, "default");
    assert.equal(binding.replyStylePrompt, "");
    assert.equal(binding.replyRewrite, "off");
    assert.equal(binding.replyFormat, "markdown");
  });

  it("accepts explicit AI rewrite modes", () => {
    const parse = (value: string) =>
      botValuesSchema.parse({ chats: [{ chatId: "oc_group", provider: "dsh", replyRewrite: value }] }).chats[0]
        .replyRewrite;
    assert.equal(parse("off"), "off");
    assert.equal(parse("long"), "long");
    assert.equal(parse("always"), "always");
  });

  it("maps reply-style presets to prompt text and trims custom text", () => {
    assert.equal(replyStyleInstruction("default", "ignored"), "");
    assert.match(replyStyleInstruction("concise", ""), /3-5 句/);
    assert.match(replyStyleInstruction("plain", ""), /非技术同事/);
    assert.equal(replyStyleInstruction("custom", "  用三句话回答  "), "用三句话回答");
    assert.equal(replyStyleInstruction("custom", "   "), "");
  });

  it("keeps an explicit allowlist and trims nothing implicitly", () => {
    const parsed = botValuesSchema.parse({
      chats: [
        {
          chatId: "oc_group",
          provider: "claude",
          model: "claude-opus-4",
          thinkingOptionId: "high",
          permission: "plan",
          allowedUsers: [{ openId: "ou_boss", name: "老板" }],
        },
      ],
    });
    const binding = parsed.chats[0];
    assert.ok(binding);
    assert.equal(binding.model, "claude-opus-4");
    assert.equal(binding.thinkingOptionId, "high");
    assert.equal(binding.permission, "plan");
    assert.deepEqual(binding.allowedUsers, [{ openId: "ou_boss", name: "老板" }]);
  });

  it("enables question cards while keeping permission notices opt-in", () => {
    const parsed = botValuesSchema.parse({});
    assert.equal(parsed.questionCards, true);
    assert.equal(parsed.notifyPermission, false);
    assert.equal(parsed.enabled, true);
    assert.equal(botValuesSchema.parse({ enabled: false }).enabled, false);
  });

  it("defaults to quiet receipts, progress cards and split replies", () => {
    const parsed = botValuesSchema.parse({});
    assert.equal(parsed.ackReaction, true);
    assert.equal(parsed.ackOnReceive, false);
    assert.equal(parsed.progressCard, true);
    assert.equal(parsed.replySplit, true);
    assert.equal(parsed.maxReplyChunks, 4);
    assert.equal(parsed.replyFooter, false);
    assert.equal(parsed.attachmentSend, true);
    assert.equal(parsed.attachmentMaxMb, 50);
    assert.equal(parsed.rateLimitPerHour, 20);
    assert.equal(parsed.workspacePerBinding, false);
  });

  it("defaults completion mentions off and preserves a per-chat choice", () => {
    const parsed = botValuesSchema.parse({
      chats: [{ chatId: "oc_group", provider: "dsh", mentionOnReply: "both" }],
    });
    assert.equal(parsed.chats[0]?.mentionOnReply, "both");
    assert.equal(botValuesSchema.parse({ chats: [{ chatId: "oc_group", provider: "dsh" }] }).chats[0]?.mentionOnReply, "off");
  });
});

describe("isDshProvider", () => {
  it("matches the bare dsh provider and dsh/model only", () => {
    assert.equal(isDshProvider("dsh"), true);
    assert.equal(isDshProvider("dsh/deepseek-v4.1-flash"), true);
    assert.equal(isDshProvider("claude"), false);
    assert.equal(isDshProvider("dshx"), false);
  });
});
