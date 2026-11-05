import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lastAssistantText } from "../server/timeline.ts";

describe("lastAssistantText", () => {
  it("reads the real refetch entry shape (entry.item)", () => {
    const entries = [
      { provider: "claude", item: { type: "user_message", text: "问题" } },
      { provider: "claude", item: { type: "assistant_message", text: "答案" } },
    ];
    assert.equal(lastAssistantText(entries), "答案");
  });

  it("returns the latest non-empty assistant message", () => {
    const entries = [
      { item: { type: "assistant_message", text: "旧的" } },
      { item: { type: "assistant_message", text: "新的" } },
    ];
    assert.equal(lastAssistantText(entries), "新的");
  });

  it("returns null for flat legacy entries or empty pages", () => {
    // @ts-expect-error legacy flat entries are not the daemon contract
    assert.equal(lastAssistantText([{ type: "assistant_message", text: "flat" }]), null);
    assert.equal(lastAssistantText([]), null);
    assert.equal(lastAssistantText(undefined), null);
  });
});
