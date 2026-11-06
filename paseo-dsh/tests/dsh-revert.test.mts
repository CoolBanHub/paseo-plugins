import assert from "node:assert/strict";
import test from "node:test";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import {
  parseDshRevertToken,
  registerDshRevertHandler,
  unregisterDshRevertHandler,
  withDshRevert,
} from "../server/dsh-revert.ts";

function fakeProvider(): {
  provider: ProviderRegistration;
  inputs: ProviderInput[];
  emit(event: ProviderEvent): void;
  connection: ProviderConnection | undefined;
} {
  const state = {
    inputs: [] as ProviderInput[],
    listener: undefined as ((event: ProviderEvent) => void) | undefined,
    connection: undefined as ProviderConnection | undefined,
  };
  const provider: ProviderRegistration = {
    id: "mock",
    label: "mock",
    async connect() {
      const connection: ProviderConnection = {
        version: 1,
        capabilities: ["prompt.message"],
        onEvent(listener) {
          state.listener = listener;
          return () => {
            state.listener = undefined;
          };
        },
        async send(input) {
          state.inputs.push(input);
        },
        async close() {},
      };
      state.connection = connection;
      return connection;
    },
  };
  return {
    provider,
    get inputs() {
      return state.inputs;
    },
    emit(event) {
      state.listener?.(event);
    },
    get connection() {
      return state.connection;
    },
  };
}

test("revert tokens are validated before reaching a connector handler", () => {
  assert.deepEqual(
    parseDshRevertToken({ v: 1, kind: "dsh-rewind", messageId: "m1", seq: 7 }),
    { v: 1, kind: "dsh-rewind", messageId: "m1", seq: 7 },
  );
  assert.equal(parseDshRevertToken({ v: 1, kind: "dsh-rewind" }), undefined);
  assert.equal(parseDshRevertToken({ v: 1, kind: "other", messageId: "m1" }), undefined);
  assert.equal(parseDshRevertToken("junk"), undefined);
});

test("withDshRevert advertises the capability and routes session.revert", async () => {
  const base = fakeProvider();
  const provider = withDshRevert(base.provider);
  const connection = await provider.connect({ versions: [1], capabilities: [] });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));

  assert.deepEqual(connection.capabilities, ["prompt.message", "session.revert.both"]);

  base.emit({
    type: "session.opened",
    sessionId: "s1",
    capabilities: ["prompt.message"],
    restoration: "core",
    cwd: "/tmp",
  });
  const opened = events.find((event) => event.type === "session.opened");
  assert.ok(opened?.type === "session.opened" && opened.capabilities.includes("session.revert.both"));

  // Without a live connector handler the revert fails with guidance.
  events.length = 0;
  await connection.send({
    type: "session.revert",
    requestId: "r1",
    sessionId: "s1",
    token: { v: 1, kind: "dsh-rewind", messageId: "m1", seq: 3 },
    scope: "both",
  });
  assert.deepEqual(events[0]?.type, "request.failed");
  assert.equal(base.inputs.length, 0, "the revert never reaches the ACP adapter");

  registerDshRevertHandler("s1", async ({ token, scope }) => {
    assert.equal(token?.messageId, "m1");
    assert.equal(scope, "both");
    return { description: "对话已回退；已还原 1 个文件" };
  });
  events.length = 0;
  await connection.send({
    type: "session.revert",
    requestId: "r2",
    sessionId: "s1",
    token: { v: 1, kind: "dsh-rewind", messageId: "m1", seq: 3 },
    scope: "both",
  });
  assert.deepEqual(events.map((event) => event.type), ["request.completed", "timeline.item"]);
  const notice = events[1];
  assert.ok(notice?.type === "timeline.item" && notice.item.type === "notification" && notice.item.message.includes("已回退"));

  registerDshRevertHandler("s1", async () => {
    throw new Error("当前会话内容不支持在此处回退");
  });
  events.length = 0;
  await connection.send({
    type: "session.revert",
    requestId: "r3",
    sessionId: "s1",
    token: { v: 1, kind: "dsh-rewind", messageId: "m1", seq: 3 },
    scope: "conversation",
  });
  assert.equal(events[0]?.type, "request.failed");
  assert.ok(events[0]?.type === "request.failed" && events[0].error.message.includes("不支持在此处回退"));

  unregisterDshRevertHandler("s1");
  await connection.close();
});
