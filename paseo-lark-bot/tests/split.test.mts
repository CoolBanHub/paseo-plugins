import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitReply } from "../server/split.ts";

describe("splitReply", () => {
  it("keeps short text in one part", () => {
    const result = splitReply("hello", 100);
    assert.deepEqual(result.chunks, ["hello"]);
    assert.equal(result.clipped, false);
  });

  it("splits on line boundaries within the limit", () => {
    const text = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
    const result = splitReply(text, 120, 10);
    assert.ok(result.chunks.length > 1);
    for (const chunk of result.chunks) assert.ok(chunk.length <= 120, chunk);
    assert.equal(result.chunks.join("\n").replace(/\n+/g, "\n"), text);
    assert.equal(result.clipped, false);
  });

  it("closes and reopens fenced code blocks", () => {
    const code = Array.from({ length: 30 }, (_, index) => `const value${index} = ${index};`).join("\n");
    const text = "before\n```ts\n" + code + "\n```\nafter";
    const result = splitReply(text, 160, 10);
    assert.ok(result.chunks.length > 1);
    for (const chunk of result.chunks) {
      const fences = chunk.match(/```/g)?.length ?? 0;
      assert.equal(fences % 2, 0, "each part must close its fence:\n" + chunk);
      assert.ok(chunk.length <= 160, chunk);
    }
    assert.ok(result.chunks.join("\n").includes("const value29 = 29;"));
  });

  it("caps the number of parts and reports clipping", () => {
    const text = Array.from({ length: 200 }, (_, index) => `row ${index} with some padding text`).join("\n");
    const result = splitReply(text, 120, 3);
    assert.equal(result.chunks.length, 3);
    assert.equal(result.clipped, true);
    assert.ok(result.chunks[2]!.endsWith("…"));
  });

  it("hard-splits a pathological single line", () => {
    const text = "x".repeat(500);
    const result = splitReply(text, 100, 10);
    assert.ok(result.chunks.length > 1);
    for (const chunk of result.chunks) assert.ok(chunk.length <= 100);
  });
});
