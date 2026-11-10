import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProgressTracker, formatElapsed, renderProgressCard } from "../server/progress.ts";

function headerOf(card: Record<string, unknown>): Record<string, unknown> {
  return card.header as Record<string, unknown>;
}

describe("progress card rendering", () => {
  it("formats elapsed times", () => {
    assert.equal(formatElapsed(5_000), "5s");
    assert.equal(formatElapsed(65_000), "1m5s");
    assert.equal(formatElapsed(3_600_000), "1h0m");
  });

  it("renders phase, elapsed, queue and steps", () => {
    const card = renderProgressCard({
      phase: "running",
      elapsedMs: 12_000,
      queue: 2,
      steps: [{ icon: "🔧", text: "bash npm test" }],
      detail: "正在运行测试",
    });
    const text = JSON.stringify(card);
    assert.match(text, /正在处理/);
    assert.match(text, /12s/);
    assert.match(text, /排队/);
    assert.match(text, /npm test/);
    assert.match(text, /正在运行测试/);
    assert.equal((card.config as Record<string, unknown>).update_multi, true);
  });
});

describe("progress tracker", () => {
  it("sends once, throttles steps, and patches the final state", async () => {
    let now = 1_000;
    const cards: Record<string, unknown>[] = [];
    const patches: Record<string, unknown>[] = [];
    const tracker = createProgressTracker({
      sendCard: async (card) => {
        cards.push(card);
        return "om_card";
      },
      updateCard: async (_id, card) => {
        patches.push(card);
      },
      now: () => now,
      intervalMs: 60_000,
    });
    assert.equal(await tracker.start(), true);
    assert.equal(cards.length, 1);
    tracker.setQueue(1);
    tracker.step("🔧", "读取文件");
    tracker.detail("输出一行");
    now += 5_000;
    await tracker.finish("completed");
    assert.equal(patches.length, 1);
    assert.match(JSON.stringify(headerOf(patches[0]!)), /已完成/);
    assert.match(JSON.stringify(patches[0]), /读取文件/);
    assert.match(JSON.stringify(patches[0]), /5s/);
    tracker.dispose();
  });

  it("does not patch after dispose", async () => {
    let patches = 0;
    const tracker = createProgressTracker({
      sendCard: async () => "om_card",
      updateCard: async () => {
        patches += 1;
      },
    });
    await tracker.start();
    tracker.dispose();
    await tracker.finish("failed", "boom");
    assert.equal(patches, 0);
  });

  it("survives a failed card send", async () => {
    const tracker = createProgressTracker({
      sendCard: async () => {
        throw new Error("card unavailable");
      },
      updateCard: async () => undefined,
    });
    assert.equal(await tracker.start(), false);
    await tracker.finish("completed");
  });
});
