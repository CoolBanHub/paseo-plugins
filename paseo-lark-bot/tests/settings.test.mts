import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { botValuesSchema, isDshProvider } from "../shared/settings.ts";

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
    assert.equal(binding.replyFormat, "markdown");
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
