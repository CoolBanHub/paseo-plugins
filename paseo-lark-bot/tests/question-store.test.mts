import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPendingQuestions,
  writePendingQuestions,
  type PendingQuestion,
} from "../server/question-store.ts";

function pending(overrides: Partial<PendingQuestion> = {}): PendingQuestion {
  return {
    requestId: "permission:paseo-question-q-1",
    agentId: "agent-1",
    chatId: "oc_group",
    topicKey: "om_topic",
    questions: [
      {
        header: "选择方案",
        question: "选哪个方案？",
        options: [{ label: "方案A" }, { label: "方案B", description: "B 的描述" }],
        multiSelect: false,
        allowOther: true,
        allowEmpty: false,
      },
    ],
    answers: new Map([[0, "方案B"]]),
    cardMessageId: "om_card",
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("pending question store", () => {
  it("round-trips a pending question and its partial answers", () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-bot-pending-"));
    const path = join(dir, "pending-questions.json");
    try {
      writePendingQuestions(path, [pending()]);
      const restored = readPendingQuestions(path);
      assert.equal(restored.length, 1);
      assert.equal(restored[0]?.requestId, "permission:paseo-question-q-1");
      assert.equal(restored[0]?.cardMessageId, "om_card");
      assert.deepEqual(restored[0]?.questions, pending().questions);
      assert.deepEqual([...(restored[0]?.answers ?? [])], [[0, "方案B"]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips malformed entries without dropping valid ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-bot-pending-"));
    const path = join(dir, "pending-questions.json");
    try {
      const valid = {
        ...pending(),
        answers: { 0: "方案A" },
      };
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          pending: [valid, { requestId: "broken" }],
        }),
      );
      const restored = readPendingQuestions(path);
      assert.equal(restored.length, 1);
      assert.equal(restored[0]?.answers.get(0), "方案A");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty list for missing or corrupt files", () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-bot-pending-"));
    const path = join(dir, "pending-questions.json");
    try {
      assert.deepEqual(readPendingQuestions(path), []);
      writeFileSync(path, "not json");
      assert.deepEqual(readPendingQuestions(path), []);
      writeFileSync(path, JSON.stringify({ version: 2, pending: [] }));
      assert.deepEqual(readPendingQuestions(path), []);
      assert.deepEqual(readPendingQuestions(undefined), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
