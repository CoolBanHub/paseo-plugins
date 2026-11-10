import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SlidingWindowLimiter, formatRetryAfter } from "../server/rate-limit.ts";

describe("SlidingWindowLimiter", () => {
  it("allows the budget then reports the wait", () => {
    let now = 1_000_000;
    const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 60_000, now: () => now });
    assert.equal(limiter.take("a").allowed, true);
    now += 1_000;
    assert.equal(limiter.take("a").allowed, true);
    now += 1_000;
    const denied = limiter.take("a");
    assert.equal(denied.allowed, false);
    assert.equal(denied.retryAfterMs, 58_000);
    assert.equal(limiter.remaining("a"), 0);
  });

  it("slides the window and isolates keys", () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 10_000, now: () => now });
    assert.equal(limiter.take("a").allowed, true);
    assert.equal(limiter.take("b").allowed, true);
    assert.equal(limiter.take("a").allowed, false);
    now = 10_001;
    assert.equal(limiter.take("a").allowed, true);
  });

  it("disables at zero and can be updated at runtime", () => {
    const limiter = new SlidingWindowLimiter({ limit: 0, windowMs: 10_000 });
    for (let index = 0; index < 100; index += 1) assert.equal(limiter.take("a").allowed, true);
    limiter.setLimit(1);
    assert.equal(limiter.take("a").allowed, true);
    assert.equal(limiter.take("a").allowed, false);
    limiter.setLimit(0);
    assert.equal(limiter.take("a").allowed, true);
  });

  it("formats a human wait", () => {
    assert.equal(formatRetryAfter(30_000), "约 1 分钟");
    assert.equal(formatRetryAfter(120_000), "约 2 分钟");
  });
});
