import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendFooter,
  buildPostContent,
  clipReply,
  condenseReply,
  formatPermissionNotice,
  formatTurnOutcome,
} from "../server/format.ts";

describe("condenseReply", () => {
  it("keeps CJK sentences when English reasoning is folded in", () => {
    const reply = condenseReply("Let me think about this problem. 分析完成：原因是配置缺失。已修复。");
    assert.ok(reply.includes("分析完成"));
    assert.ok(!reply.includes("Let me think"));
  });

  it("returns pure English replies unchanged", () => {
    assert.equal(condenseReply("All checks passed."), "All checks passed.");
  });

  it("preserves whitespace when there is no reasoning to strip", () => {
    assert.equal(condenseReply("hello   world"), "hello   world");
  });

  it("keeps all Chinese sentences and multi-line Markdown", () => {
    const reply = "# 结果\n\n第一句。第二句。第三句。\n\n- 改动 A\n- 改动 B";
    assert.equal(condenseReply(reply), reply);
  });

  it("keeps fenced code blocks untouched", () => {
    const reply = "修复完成。\n\n```ts\nconst a = 1;\n```";
    assert.equal(condenseReply(reply), reply);
  });

  it("strips only the leading English prose", () => {
    const reply = condenseReply("I checked the logs. 原因是配置缺失。已修复。");
    assert.equal(reply, "原因是配置缺失。已修复。");
  });
});

describe("clipReply", () => {
  it("keeps short replies intact", () => {
    const result = clipReply("short", 100);
    assert.deepEqual(result, { text: "short", clipped: false });
  });

  it("clips long replies with an ellipsis", () => {
    const result = clipReply("x".repeat(250), 100);
    assert.equal(result.clipped, true);
    assert.equal(result.text.length, 100);
    assert.ok(result.text.endsWith("…"));
  });
});

describe("appendFooter", () => {
  it("adds a footer only for clipped replies", () => {
    assert.equal(appendFooter("ok", false), "ok");
    assert.ok(appendFooter("ok…", true).includes("截断"));
  });
});

describe("buildPostContent", () => {
  it("wraps text in a single md post element", () => {
    const payload = JSON.parse(buildPostContent('答案 <at user_id="ou_x"></at>')) as {
      zh_cn: { content: { tag: string; text: string }[][] };
    };
    assert.equal(payload.zh_cn.content[0][0].tag, "md");
    assert.ok(payload.zh_cn.content[0][0].text.includes('<at user_id="ou_x">'));
  });
});

describe("formatTurnOutcome", () => {
  it("describes failures with the error", () => {
    assert.equal(formatTurnOutcome("failed", "boom"), "处理失败：boom");
  });

  it("describes cancellations", () => {
    assert.equal(formatTurnOutcome("canceled", null), "本轮处理已取消。");
  });

  it("leaves completed turns to the caller", () => {
    assert.equal(formatTurnOutcome("completed", null), "");
  });
});

describe("formatPermissionNotice", () => {
  it("includes the heading and points to Paseo", () => {
    const text = formatPermissionNotice({ heading: "执行命令：rm -rf build", extra: "清理构建产物" });
    assert.ok(text.includes("执行命令"));
    assert.ok(text.includes("Paseo"));
    assert.ok(text.includes("清理构建产物"));
  });
});
