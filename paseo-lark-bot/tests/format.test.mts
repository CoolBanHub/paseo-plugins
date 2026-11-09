import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendFooter,
  buildPostContent,
  clipReply,
  condenseReply,
  formatPermissionNotice,
  formatTurnOutcome,
  isTransientTurnError,
  sanitizeTopicText,
} from "../server/format.ts";

describe("isTransientTurnError", () => {
  it("treats rate limits, 5xx and transport blips as transient", () => {
    assert.equal(isTransientTurnError("HTTP 429"), true);
    assert.equal(isTransientTurnError("turn failed: 503 Service Unavailable"), true);
    assert.equal(isTransientTurnError("网关错误（HTTP 502），请稍后重试"), true);
    assert.equal(isTransientTurnError("请求超时 ETIMEDOUT"), true);
    assert.equal(isTransientTurnError("ECONNRESET socket hang up"), true);
  });

  it("treats auth and configuration errors as fatal", () => {
    assert.equal(isTransientTurnError("HTTP 401"), false);
    assert.equal(isTransientTurnError("HTTP 403 Forbidden"), false);
    assert.equal(isTransientTurnError("HTTP 404"), false);
    assert.equal(isTransientTurnError("provider 崩溃"), false);
  });
});

describe("sanitizeTopicText", () => {
  it("replaces pre-rendered image markdown with a placeholder", () => {
    assert.equal(sanitizeTopicText("![Image](img_v2_abc) 这个设计稿"), "[图片] 这个设计稿");
  });

  it("keeps link labels and collapses bare links", () => {
    assert.equal(sanitizeTopicText("看 [文档](https://example.com) 和 [](https://x.dev)"), "看 文档 和 [链接]");
  });

  it("collapses whitespace across lines", () => {
    assert.equal(sanitizeTopicText("第一行\n  第二行\t\t更多"), "第一行 第二行 更多");
  });

  it("clips overlong text with an ellipsis", () => {
    assert.equal(sanitizeTopicText("长".repeat(50), 10), "长".repeat(9) + "…");
  });

  it("keeps short plain text unchanged", () => {
    assert.equal(sanitizeTopicText("现在的构建失败原因是什么"), "现在的构建失败原因是什么");
  });
});

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

  it("replaces an upstream HTML 403 with an actionable hint", () => {
    const text = formatTurnOutcome(
      "failed",
      "Internal error: turn failed: 403 <html> <head><title>403 Forbidden</title></head> <body><center><h1>403 Forbidden</h1></center></body></html>",
    );
    assert.ok(text.includes("HTTP 403"), text);
    assert.ok(text.includes("API Key"), text);
    assert.ok(text.includes("Paseo"), text);
    assert.ok(!text.includes("<html>"), text);
    assert.ok(!text.includes("Internal error"), text);
  });

  it("maps common HTTP failures without dumping the raw body", () => {
    assert.ok(formatTurnOutcome("failed", "HTTP 401 Unauthorized").includes("认证失败"));
    assert.ok(formatTurnOutcome("failed", "HTTP 403 Forbidden").includes("拒绝访问"));
    assert.ok(formatTurnOutcome("failed", "HTTP 429 Too Many Requests").includes("限流"));
    assert.ok(formatTurnOutcome("failed", "HTTP 503 Service Unavailable").includes("暂时不可用"));
  });

  it("strips HTML from non-HTTP errors", () => {
    assert.equal(formatTurnOutcome("failed", "<b>boom</b>\n<html>bad</html>"), "处理失败：boom bad");
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
