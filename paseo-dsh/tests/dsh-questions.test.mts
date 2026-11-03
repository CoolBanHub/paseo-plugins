import test from "node:test";
import assert from "node:assert/strict";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import {
  cancelAllDshQuestions,
  cancelDshQuestion,
  registerDshQuestion,
  withDshQuestions,
} from "../server/dsh-questions.ts";

function harness() {
  let listener: ((event: ProviderEvent) => void) | undefined;
  const sent: ProviderInput[] = [];
  const connection: ProviderConnection = {
    version: 1,
    capabilities: ["permission"],
    onEvent(next) {
      listener = next;
      return () => { listener = undefined; };
    },
    async send(input) {
      sent.push(input);
    },
    async close() {},
  };
  const provider: ProviderRegistration = {
    id: "fake",
    label: "fake",
    async connect() {
      return connection;
    },
  };
  return {
    provider,
    sent,
    emit(event: ProviderEvent) {
      listener?.(event);
    },
  };
}

test("question permissions are marked for Paseo's question form", async () => {
  const fake = harness();
  const seen: ProviderEvent[] = [];
  const wrapped = withDshQuestions(fake.provider);
  const connection = await wrapped.connect({ versions: [1], capabilities: ["permission"] });
  connection.onEvent((event) => seen.push(event));

  let resolved: Record<string, string> | undefined;
  registerDshQuestion("paseo-question-q1", {
    requestId: "q1",
    resolve(answers) { resolved = answers; },
  });
  fake.emit({
    type: "session.permission",
    sessionId: "session-1",
    request: {
      id: "permission:paseo-question-q1",
      name: "ask_user_question",
      kind: "tool",
      input: { questions: [] },
      actions: [],
    },
  });
  assert.equal(seen.length, 1);
  const permission = seen[0]!;
  assert.equal(permission.type === "session.permission" && permission.request.kind, "question");

  await connection.send({
    type: "session.permission",
    sessionId: "session-1",
    permissionId: "permission:paseo-question-q1",
    response: { behavior: "allow", updatedInput: { answers: { Confirm: "Yes" } } },
  });
  assert.deepEqual(resolved, { Confirm: "Yes" });
  assert.deepEqual(fake.sent, [{
    type: "session.permission",
    sessionId: "session-1",
    permissionId: "permission:paseo-question-q1",
    response: { behavior: "allow", selectedActionId: "answer" },
  }], "the form answer itself never reaches the ACP adapter, but its permission is settled");
});

test("ordinary permissions pass through untouched", async () => {
  const fake = harness();
  const seen: ProviderEvent[] = [];
  const wrapped = withDshQuestions(fake.provider);
  const connection = await wrapped.connect({ versions: [1], capabilities: ["permission"] });
  connection.onEvent((event) => seen.push(event));

  fake.emit({
    type: "session.permission",
    sessionId: "session-1",
    request: {
      id: "permission:call-1",
      name: "write",
      kind: "tool",
      input: {},
      actions: [{ id: "allow", label: "Allow", behavior: "allow" }],
    },
  });
  assert.equal(seen[0]?.type === "session.permission" && seen[0].request.kind, "tool");

  const response = {
    type: "session.permission" as const,
    sessionId: "session-1",
    permissionId: "permission:call-1",
    response: { behavior: "allow" as const, selectedActionId: "allow" },
  };
  await connection.send(response);
  assert.deepEqual(fake.sent, [response], "ordinary permissions still reach the ACP adapter");
});

test("connector shutdown dismisses only its own pending questions", async () => {
  let first: Record<string, string> | undefined;
  let second: Record<string, string> | undefined;
  registerDshQuestion("paseo-question-q2", {
    requestId: "q2",
    scope: "connector-a",
    resolve(answers) { first = answers; },
  });
  registerDshQuestion("paseo-question-q3", {
    requestId: "q3",
    scope: "connector-b",
    resolve(answers) { second = answers; },
  });
  cancelAllDshQuestions("connector-a");
  assert.equal(first, undefined, "the closing connector settles its own form as dismissed");
  assert.equal(second, undefined, "another connector's form is left pending");
  cancelDshQuestion("paseo-question-q3");
});
