import test from "node:test";
import assert from "node:assert/strict";
import { DSH_EVENT_METHOD, dshEventUpdates } from "../server/dsh-events.ts";

const map = (kind: string, data: Record<string, unknown>) =>
  dshEventUpdates(DSH_EVENT_METHOD, { kind, data }, "paseo-session") ?? [];

test("model retries become warning notices", () => {
  const updates = map("llm-retry", {
    retryId: "r1",
    retry: 2,
    maxRetries: 5,
    delayMs: 3000,
    failure: { message: "rate limited" },
  });
  assert.equal(updates.length, 1);
  const update = updates[0]!;
  assert.equal(update.type, "notice");
  if (update.type === "notice") {
    assert.equal(update.notice.severity, "warning");
    assert.match(update.notice.description ?? "", /2\/5/);
    assert.match(update.notice.description ?? "", /rate limited/);
  }
});

test("compaction events become native compaction items", () => {
  const start = map("compaction-start", { compactionId: "c1", sourceCommandId: "cmd" });
  assert.deepEqual(start, [{
    type: "timeline",
    item: { type: "compaction", id: "dsh:compaction:c1", status: "loading", trigger: "manual" },
  }]);
  const summary = map("compaction-summary", { compactionId: "c1", shadowedTokenCount: 1234 });
  assert.equal(summary[0]?.type === "timeline" && summary[0].item.type, "compaction");
  const end = map("compaction-end", { compactionId: "c1" });
  assert.equal(end[0]?.type === "timeline" && end[0].item.type === "compaction" && end[0].item.status, "completed");
});

test("background jobs become shell rows with their status", () => {
  const registered = map("job-registered", {
    jobId: "j1",
    kind: "bash",
    label: "Build",
    command: "go build ./...",
    toolCall: { callId: "call-1" },
  });
  const row = registered[0]?.type === "timeline" ? registered[0].item : undefined;
  assert.equal(row?.type, "tool_call");
  if (row?.type === "tool_call") {
    assert.equal(row.status, "running");
    assert.deepEqual(row.detail, { type: "shell", command: "go build ./..." });
  }
  const settled = map("job-settled", {
    jobId: "j1",
    kind: "bash",
    label: "Build",
    command: "go build ./...",
    status: "failed",
    detail: "exit 1",
    toolCall: { callId: "call-1" },
  });
  const settledRow = settled[0]?.type === "timeline" ? settled[0].item : undefined;
  assert.equal(settledRow?.type === "tool_call" && settledRow.status, "failed");
  assert.equal(settledRow?.type === "tool_call" && settledRow.error, "exit 1");
});

test("subagent events enrich the tool row with a child session", () => {
  const start = map("subagent-start", {
    callId: "call-sub",
    childId: "child-1",
    provider: "spawn",
    label: "Review memory",
  });
  const running = start[0]?.type === "timeline" ? start[0].item : undefined;
  assert.equal(running?.type === "tool_call" && running.detail.type, "sub_agent");
  assert.equal(
    running?.type === "tool_call" && running.detail.type === "sub_agent" && running.detail.childSessionId,
    "child-1",
  );
  const end = map("subagent-end", {
    callId: "call-sub",
    childId: "child-1",
    provider: "spawn",
    label: "Review memory",
    stopReason: "completed",
    output: "done",
  });
  const finished = end[0]?.type === "timeline" ? end[0].item : undefined;
  assert.equal(finished?.type === "tool_call" && finished.status, "completed");
  assert.equal(
    finished?.type === "tool_call" && finished.detail.type === "sub_agent" && finished.detail.log,
    "done",
  );
});

test("goal changes become a stable Goal row", () => {
  const created = map("goal-change", {
    operation: "create",
    goal: { objective: "Ship the fix", phase: "active" },
  });
  const row = created[0]?.type === "timeline" ? created[0].item : undefined;
  assert.equal(row?.id, "dsh:goal");
  assert.equal(row?.type === "tool_call" && row.detail.type === "plain_text" && row.detail.text, "Ship the fix");
  const cleared = map("goal-change", { operation: "clear" });
  const clearedItem = cleared[0]?.type === "timeline" ? cleared[0].item : undefined;
  assert.equal(clearedItem?.type === "tool_call" && clearedItem.status, "completed");
});

test("question cards and command results render as timeline text and notices", () => {
  const card = map("question-card", {
    requestId: "q1",
    index: 0,
    header: "Confirm",
    question: "Proceed?",
    status: "running",
  });
  const item = card[0]?.type === "timeline" ? card[0].item : undefined;
  assert.equal(item?.type === "tool_call" && item.detail.type === "plain_text" && item.detail.label, "Confirm");
  const result = map("command-result", {
    requestId: "cmd1",
    line: "/compact",
    kind: "error",
    text: "nothing to compact",
  });
  const notice = result[0]!;
  assert.equal(notice.type, "notice");
  if (notice.type === "notice") {
    assert.equal(notice.notice.severity, "error");
    assert.equal(notice.notice.description, "nothing to compact");
  }
});

test("working-directory and plan-mode changes become notices", () => {
  const cwd = map("working-directory", { cwd: "/tmp/repo" });
  assert.equal(cwd[0]?.type, "notice");
  if (cwd[0]?.type === "notice") {
    assert.equal(cwd[0].notice.description, "/tmp/repo");
  }
  const plan = map("plan-mode", { active: true });
  assert.equal(plan[0]?.type, "notice");
  if (plan[0]?.type === "notice") {
    assert.match(plan[0].notice.description ?? "", /进入/);
  }
});

test("unknown and malformed events are ignored", () => {
  assert.equal(dshEventUpdates("session/update", {}, "s"), null);
  assert.equal(dshEventUpdates(DSH_EVENT_METHOD, null, "s"), null);
  assert.deepEqual(map("unknown", {}), []);
});
