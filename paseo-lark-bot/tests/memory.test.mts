import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createMemoryStore, formatMemoryList } from "../server/memory.ts";

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "lark-memory-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("memory store", () => {
  it("stores rules per chat and isolates chats", () => {
    withTempDir((dir) => {
      const store = createMemoryStore(join(dir, "memory.json"), { now: () => 1_700_000_000_000 });
      const entry = store.remember("oc_a", "不要用内部代号，先说结论", "ou_owner");
      assert.ok(entry);
      assert.equal(entry.id, 1);
      store.remember("oc_b", "回答用英文", "ou_b");
      assert.equal(store.list("oc_a").length, 1);
      assert.equal(store.list("oc_b").length, 1);
      assert.equal(store.list("oc_c").length, 0);
    });
  });

  it("refreshes an identical rule instead of duplicating it", () => {
    let now = 1_700_000_000_000;
    withTempDir((dir) => {
      const store = createMemoryStore(join(dir, "memory.json"), { now: () => now });
      store.remember("oc_a", "先说结论", "ou_1");
      now += 86_400_000;
      const again = store.remember("oc_a", "先说结论", "ou_2");
      assert.ok(again);
      assert.equal(again.id, 1);
      assert.equal(store.list("oc_a").length, 1);
      assert.equal(store.list("oc_a")[0]?.createdBy, "ou_2");
    });
  });

  it("moves a refreshed rule to the newest position", () => {
    let now = 1_700_000_000_000;
    withTempDir((dir) => {
      const store = createMemoryStore(join(dir, "memory.json"), {
        now: () => now,
        maxPromptEntries: 2,
        maxPromptChars: 10_000,
      });
      store.remember("oc_a", "规则A", "ou_1");
      now += 86_400_000;
      store.remember("oc_a", "规则B", "ou_1");
      now += 86_400_000;
      store.remember("oc_a", "规则C", "ou_1");
      now += 86_400_000;
      // Refreshing A makes it the newest rule even though its id stays 1.
      store.remember("oc_a", "规则A", "ou_1");
      const prompt = store.promptFor("oc_a");
      assert.ok(prompt);
      assert.match(prompt, /规则A/);
      assert.match(prompt, /规则C/);
      assert.doesNotMatch(prompt, /规则B/);
      assert.match(prompt, /另有 1 条较早记忆未展开/);
    });
  });

  it("persists entries and survives a reload", () => {
    withTempDir((dir) => {
      const path = join(dir, "memory.json");
      createMemoryStore(path, { now: () => 1_700_000_000_000 }).remember(
        "oc_a",
        "文件用绝对路径",
        "ou_owner",
      );
      const reloaded = createMemoryStore(path, { now: () => 1_700_000_000_000 });
      assert.deepEqual(
        reloaded.list("oc_a").map((entry) => entry.text),
        ["文件用绝对路径"],
      );
    });
  });

  it("forgets by id and reports unknown ids", () => {
    withTempDir((dir) => {
      const store = createMemoryStore(join(dir, "memory.json"));
      store.remember("oc_a", "第一条", "ou_1");
      store.remember("oc_a", "第二条", "ou_1");
      assert.ok(store.forget("oc_a", "#2"));
      assert.deepEqual(
        store.list("oc_a").map((entry) => entry.text),
        ["第一条"],
      );
      assert.equal(store.forget("oc_a", "9"), null);
      assert.equal(store.forget("oc_a", "abc"), null);
    });
  });

  it("builds a prompt with dates, newest entries last, and a budget note", () => {
    withTempDir((dir) => {
      let now = 1_700_000_000_000;
      const store = createMemoryStore(join(dir, "memory.json"), {
        now: () => now,
        maxPromptEntries: 2,
        maxPromptChars: 10_000,
      });
      for (let index = 1; index <= 4; index += 1) {
        store.remember("oc_a", `规则${index}`, "ou_1");
        now += 86_400_000;
      }
      const prompt = store.promptFor("oc_a");
      assert.ok(prompt);
      assert.match(prompt, /### 会话记忆（长期有效）/);
      assert.match(prompt, /规则3/);
      assert.match(prompt, /规则4/);
      assert.doesNotMatch(prompt, /规则1/);
      assert.match(prompt, /另有 2 条较早记忆未展开/);
      assert.match(prompt, /与当前消息冲突/);
    });
  });

  it("returns null when the chat has no memory and renders an empty list hint", () => {
    withTempDir((dir) => {
      const store = createMemoryStore(join(dir, "memory.json"));
      assert.equal(store.promptFor("oc_empty"), null);
      assert.match(formatMemoryList(store.list("oc_empty")), /还没有记忆/);
    });
  });

  it("flattens newlines so one correction stays one line", () => {
    withTempDir((dir) => {
      const store = createMemoryStore(join(dir, "memory.json"));
      store.remember("oc_a", "第一行\n第二行", "ou_1");
      assert.equal(store.list("oc_a")[0]?.text, "第一行 第二行");
    });
  });

  it("keeps the newest entries when the store hits its cap", () => {
    withTempDir((dir) => {
      const store = createMemoryStore(join(dir, "memory.json"), { maxEntries: 3 });
      for (let index = 1; index <= 5; index += 1) store.remember("oc_a", `规则${index}`, "ou_1");
      assert.deepEqual(
        store.list("oc_a").map((entry) => entry.text),
        ["规则3", "规则4", "规则5"],
      );
      // Ids stay monotonic after the trim, so /forget references never reuse a
      // retired number.
      assert.equal(store.remember("oc_a", "规则6", "ou_1")?.id, 6);
    });
  });

  it("ignores blank corrections", () => {
    withTempDir((dir) => {
      const store = createMemoryStore(join(dir, "memory.json"));
      assert.equal(store.remember("oc_a", "   \n ", "ou_1"), null);
      assert.equal(store.list("oc_a").length, 0);
    });
  });
});
