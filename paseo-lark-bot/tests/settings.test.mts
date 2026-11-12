import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_ISSUE_REACTION_EMOJIS,
  botValuesSchema,
  isDshProvider,
  larkBotSettings,
  replyStyleInstruction,
} from "../shared/settings.ts";

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
    assert.equal(binding.rewriteProvider, "");
    assert.equal(binding.rewriteModel, "");
    assert.equal(binding.rewriteIgnoreStyle, false);
    assert.equal(binding.allowAgentDelegation, false);
    assert.equal(binding.replyFormat, "markdown");
    assert.equal(binding.issueReactionAccept, true);
    assert.deepEqual(binding.issueReactionEmojis, [...DEFAULT_ISSUE_REACTION_EMOJIS]);
    assert.equal(binding.issueAcceptMode, "requester");
  });

  it("accepts explicit AI rewrite modes and an independent model", () => {
    const parse = (value: string) =>
      botValuesSchema.parse({ chats: [{ chatId: "oc_group", provider: "dsh", replyRewrite: value }] }).chats[0]
        .replyRewrite;
    assert.equal(parse("off"), "off");
    assert.equal(parse("long"), "long");
    assert.equal(parse("always"), "always");

    const binding = botValuesSchema.parse({
      chats: [
        {
          chatId: "oc_group",
          provider: "dsh",
          rewriteProvider: "codex",
          rewriteModel: "gpt-5-mini",
        },
      ],
    }).chats[0];
    assert.equal(binding.rewriteProvider, "codex");
    assert.equal(binding.rewriteModel, "gpt-5-mini");
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

  it("defaults to reaction receipts, progress cards and split replies", () => {
    const parsed = botValuesSchema.parse({});
    assert.equal(parsed.ackMode, "reaction");
    assert.equal(parsed.progressCard, true);
    assert.equal(parsed.replySplit, true);
    assert.equal(parsed.maxReplyChunks, 4);
    assert.equal(parsed.replyFooter, false);
    assert.equal(parsed.attachmentSend, true);
    assert.equal(parsed.attachmentMaxMb, 50);
    assert.equal(parsed.rateLimitPerHour, 20);
    assert.equal(parsed.workspacePerBinding, false);
  });

  it("accepts one ack mode at a time and rejects combinations", () => {
    for (const mode of ["reaction", "text", "off"] as const) {
      assert.equal(botValuesSchema.parse({ ackMode: mode }).ackMode, mode);
    }
    assert.equal(botValuesSchema.safeParse({ ackMode: "both" }).success, false);
  });

  it("migrates v1 ack flags into one mutually exclusive mode", async () => {
    assert.equal(larkBotSettings.version, 2);
    const migrate = larkBotSettings.migrate;
    assert.ok(migrate);
    const at = async (values: Record<string, unknown>) =>
      (await migrate(values, 1)) as Record<string, unknown>;

    assert.equal((await at({ ackReaction: true, ackOnReceive: false })).ackMode, "reaction");
    // Both on in v1 produced the duplicate text ack; the emoji wins.
    assert.equal((await at({ ackReaction: true, ackOnReceive: true })).ackMode, "reaction");
    assert.equal((await at({ ackReaction: false, ackOnReceive: true })).ackMode, "text");
    assert.equal((await at({ ackReaction: false, ackOnReceive: false })).ackMode, "off");
    // Missing flags use the v1 defaults: reaction on, text off.
    assert.equal((await at({})).ackMode, "reaction");

    const migrated = await at({ ackReaction: false, ackOnReceive: true, enabled: false });
    assert.equal(migrated.enabled, false);
    assert.equal("ackReaction" in migrated, false);
    assert.equal("ackOnReceive" in migrated, false);
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
