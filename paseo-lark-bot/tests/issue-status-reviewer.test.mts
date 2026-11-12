import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseIssueStatusReview } from "../server/issue-status-reviewer.ts";

describe("issue status review parsing", () => {
  it("reads the strict JSON and code-fenced JSON", () => {
    assert.deepEqual(
      parseIssueStatusReview('```json\n{"done":true,"summary":"已修复并验证","reason":"提出人说已上线"}\n```'),
      { done: true, summary: "已修复并验证", reason: "提出人说已上线" },
    );
    assert.deepEqual(parseIssueStatusReview('{"done":false,"summary":"","reason":"还在处理"}'), {
      done: false,
      summary: null,
      reason: "还在处理",
    });
  });

  it("rejects malformed or non-boolean results", () => {
    assert.equal(parseIssueStatusReview('{"done":"yes"}'), null);
    assert.equal(parseIssueStatusReview("not json"), null);
    assert.equal(parseIssueStatusReview(null), null);
  });
});
