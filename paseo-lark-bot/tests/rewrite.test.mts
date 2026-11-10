import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionPaseoApi } from "../server/sessions.ts";
import { rewriteReplyWithModel } from "../server/rewrite.ts";

interface Captured {
  create?: Record<string, unknown>;
  prompt?: string;
  runOptions?: { timeoutMs?: number };
}

function fakePaseo(
  captured: Captured,
  run: () => Promise<{ lastMessage: string | null }>,
): SessionPaseoApi {
  return {
    agents: {
      create: async (request: Record<string, unknown>) => {
        captured.create = request;
        return {
          id: "agent-rewrite",
          send: async () => {},
          run: async (prompt: string, options?: { timeoutMs?: number }) => {
            captured.prompt = prompt;
            captured.runOptions = options;
            return { status: "idle", error: null, ...(await run()) };
          },
          respondToPermission: async () => {},
        };
      },
      ref: () => {
        throw new Error("unexpected ref");
      },
    },
  } as unknown as SessionPaseoApi;
}

const baseOptions = {
  provider: "claude/claude-sonnet-4",
  cwd: "/tmp/project",
  chatId: "oc_group",
  topicKey: "oc_group:om_1",
  text: "很长很长的原始回答",
  instruction: "用三句话回答",
};

describe("rewriteReplyWithModel", () => {
  it("runs a one-shot rewrite and returns the trimmed answer", async () => {
    const captured: Captured = {};
    const result = await rewriteReplyWithModel({
      ...baseOptions,
      paseo: fakePaseo(captured, async () => ({ lastMessage: "  短版回答  " })),
    });
    assert.equal(result, "短版回答");
    assert.match(captured.prompt ?? "", /用三句话回答/);
    assert.match(captured.prompt ?? "", /很长很长的原始回答/);

    const create = captured.create!;
    assert.equal((create.config as { provider?: string }).provider, "claude/claude-sonnet-4");
    assert.equal((create.labels as Record<string, string>)["lark-bot-purpose"], "rewrite");
    assert.equal(create.autoArchive, true);
    assert.equal(create.background, true);
    assert.equal(create.cwd, "/tmp/project");
    assert.equal(captured.runOptions?.timeoutMs, 30_000);
  });

  it("falls back to the default instruction for a blank style prompt", async () => {
    const captured: Captured = {};
    const result = await rewriteReplyWithModel({
      ...baseOptions,
      instruction: "   ",
      paseo: fakePaseo(captured, async () => ({ lastMessage: "短版" })),
    });
    assert.equal(result, "短版");
    assert.match(captured.prompt ?? "", /3-5 句/);
  });

  it("returns null when the rewrite is empty", async () => {
    const result = await rewriteReplyWithModel({
      ...baseOptions,
      paseo: fakePaseo({}, async () => ({ lastMessage: "   " })),
    });
    assert.equal(result, null);
  });

  it("returns null and logs when the rewrite turn fails", async () => {
    const logs: string[] = [];
    const result = await rewriteReplyWithModel({
      ...baseOptions,
      paseo: fakePaseo({}, async () => {
        throw new Error("provider exploded");
      }),
      log: (message) => logs.push(message),
    });
    assert.equal(result, null);
    assert.ok(logs.some((line) => line.includes("回复改写失败")), logs.join("\n"));
  });

  it("passes a custom timeout to the one-shot turn", async () => {
    const captured: Captured = {};
    await rewriteReplyWithModel({
      ...baseOptions,
      timeoutMs: 1_234,
      paseo: fakePaseo(captured, async () => ({ lastMessage: "短版" })),
    });
    assert.equal(captured.runOptions?.timeoutMs, 1_234);
  });
});
