import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSessionRegistry,
  type SessionAgentHandle,
  type SessionPaseoApi,
  type SessionRunResult,
  type TurnOutcome,
} from "../server/sessions.ts";
import type { ChatBinding } from "../shared/settings.ts";

interface ReplyCall {
  chatId: string;
  messageId: string;
  outcome: TurnOutcome;
}

interface Harness {
  registry: ReturnType<typeof createSessionRegistry>;
  replies: ReplyCall[];
  notices: { chatId: string | null; messageId: string; text: string }[];
  created: { prompt?: string; provider: string; cwd: string; config: { thinkingOptionId?: string; featureValues?: Record<string, unknown> } }[];
  runCalls: { agentId: string; text: string }[];
  agentCounter: number;
  currentAgent: () => SessionAgentHandle;
  finishRun: (result: SessionRunResult) => void;
}

const binding: ChatBinding = {
  chatId: "oc_group",
  chatName: "测试群",
  provider: "claude",
  cwd: "/tmp/project",
  systemPrompt: "用中文回答",
  replyFormat: "markdown",
};

function makeHarness(options?: { idleMinutes?: number }): Harness {
  const replies: ReplyCall[] = [];
  const notices: Harness["notices"] = [];
  const created: Harness["created"] = [];
  const runCalls: Harness["runCalls"] = [];
  let agentCounter = 0;
  let current: SessionAgentHandle | null = null;
  let pendingRun: ((result: SessionRunResult) => void) | null = null;

  const paseo: SessionPaseoApi = {
    agents: {
      create: async (request) => {
        agentCounter += 1;
        created.push({ prompt: request.prompt, provider: request.config.provider, cwd: request.cwd, config: request.config });
        current = {
          id: `agent-${agentCounter}`,
          send: async () => {},
          run: (text) => {
            runCalls.push({ agentId: current!.id, text });
            return new Promise<SessionRunResult>((resolve) => {
              pendingRun = resolve;
            });
          },
        };
        return current;
      },
      ref: (id) => {
        if (!current || current.id !== id) throw new Error("unexpected ref " + id);
        return current;
      },
    },
  };

  const registry = createSessionRegistry({
    paseo,
    getIdleMs: () => (options?.idleMinutes ?? 30) * 60_000,
    callbacks: {
      onReply: (chatId, messageId, outcome) => replies.push({ chatId, messageId, outcome }),
      onNotice: (chatId, messageId, text) => notices.push({ chatId, messageId, text }),
    },
  });

  return {
    registry,
    replies,
    notices,
    created,
    runCalls,
    agentCounter,
    currentAgent: () => {
      assert.ok(current);
      return current;
    },
    finishRun: (result) => {
      assert.ok(pendingRun, "no run in flight");
      pendingRun(result);
      pendingRun = null;
    },
  };
}

const completed = (lastText: string): TurnOutcome => ({ outcome: "completed", lastText, lastError: null });

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("createSessionRegistry", () => {
  it("starts the first turn through agents.create(prompt) without run()", async () => {
    const h = makeHarness();
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    assert.equal(h.created.length, 1);
    assert.equal(h.created[0].prompt, "第一条");
    assert.equal(h.created[0].provider, "claude");
    assert.deepEqual(h.runCalls, []);
    assert.equal(h.registry.status()[0].busy, true);
  });

  it("replies via turn_ended and reuses the agent for the next message", async () => {
    const h = makeHarness();
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    const agent = h.currentAgent();

    h.registry.handleTurnEnded(agent.id, completed("第一轮答复"));
    await flush();
    assert.deepEqual(h.replies, [{ chatId: "oc_group", messageId: "om_1", outcome: completed("第一轮答复") }]);

    h.registry.enqueue("om_1", "oc_group", "om_2", "第二条", binding);
    await flush();
    assert.equal(h.created.length, 1, "agent should be reused");
    assert.deepEqual(h.runCalls, [{ agentId: agent.id, text: "第二条" }]);

    h.finishRun({ status: "idle", error: null, lastMessage: "第二轮答复" });
    h.registry.handleTurnEnded(agent.id, completed("第二轮答复"));
    await flush();
    assert.equal(h.replies[1]?.messageId, "om_2");
  });

  it("queues messages while a turn is running", async () => {
    const h = makeHarness();
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    const agent = h.currentAgent();

    h.registry.enqueue("om_1", "oc_group", "om_2", "第二条", binding);
    await flush();
    assert.equal(h.runCalls.length, 0, "second message must wait for the first turn");
    assert.equal(h.registry.status()[0].queued, 1);

    h.registry.handleTurnEnded(agent.id, completed("第一轮答复"));
    await flush();
    assert.deepEqual(h.runCalls.map((call) => call.text), ["第二条"]);
  });

  it("replies with failure and rebuilds when run() errors", async () => {
    const h = makeHarness();
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    const agent = h.currentAgent();
    h.registry.handleTurnEnded(agent.id, completed("第一轮答复"));
    await flush();

    h.registry.enqueue("om_1", "oc_group", "om_2", "第二条", binding);
    await flush();
    h.finishRun({ status: "error", error: "provider 崩溃", lastMessage: null });
    await flush();
    assert.equal(h.replies[h.replies.length - 1]?.outcome.outcome, "failed");
    assert.equal(h.registry.ownsAgent(agent.id), false, "broken agent is forgotten");

    h.registry.enqueue("om_1", "oc_group", "om_3", "第三条", binding);
    await flush();
    assert.equal(h.created.length, 2, "a fresh agent is created after the failure");
  });

  it("holds the queue on permission and timeout, then releases on turn_ended", async () => {
    const h = makeHarness();
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    const agent = h.currentAgent();
    h.registry.handleTurnEnded(agent.id, completed("第一轮答复"));
    await flush();

    h.registry.enqueue("om_1", "oc_group", "om_2", "需要权限的操作", binding);
    await flush();
    h.finishRun({ status: "permission", error: null, lastMessage: null });
    h.registry.enqueue("om_1", "oc_group", "om_3", "排队消息", binding);
    await flush();
    assert.deepEqual(h.runCalls.map((call) => call.text), ["需要权限的操作"]);
    assert.equal(h.registry.status()[0].busy, true);

    // The user approves in Paseo; the turn continues and finishes.
    h.registry.handleTurnEnded(agent.id, completed("批准后完成"));
    await flush();
    assert.equal(h.replies[h.replies.length - 1]?.messageId, "om_2");
    assert.deepEqual(h.runCalls.map((call) => call.text), ["需要权限的操作", "排队消息"]);
  });

  it("ignores turn_ended for agents it does not own", async () => {
    const h = makeHarness();
    h.registry.handleTurnEnded("agent-unknown", completed("无关轮次"));
    await flush();
    assert.deepEqual(h.replies, []);
  });

  it("rebuilds the session after the idle window", async () => {
    let clock = 0;
    const replies: ReplyCall[] = [];
    let created = 0;
    const paseo: SessionPaseoApi = {
      agents: {
        create: async () => {
          created += 1;
          const handle: SessionAgentHandle = {
            id: `agent-${created}`,
            send: async () => {},
            run: async () => ({ status: "idle", error: null, lastMessage: "ok" }),
          };
          return handle;
        },
        ref: () => {
          throw new Error("unused");
        },
      },
    };
    const registry = createSessionRegistry({
      paseo,
      now: () => clock,
      getIdleMs: () => 30 * 60_000,
      callbacks: {
        onReply: (chatId, messageId, outcome) => replies.push({ chatId, messageId, outcome }),
        onNotice: () => {},
      },
    });

    registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    registry.handleTurnEnded("agent-1", completed("第一轮答复"));
    await flush();

    clock += 31 * 60_000;
    registry.enqueue("om_1", "oc_group", "om_2", "第二天的问题", binding);
    await flush();
    assert.equal(created, 2, "idle expiry must start a new session");
  });

  it("runs independent topics in parallel with separate agents", async () => {
    const h = makeHarness();
    // Topic A starts a turn (create-driven, waiting for turn_ended).
    h.registry.enqueue("om_a", "oc_group", "om_a", "话题A的问题", binding);
    await flush();
    assert.equal(h.created.length, 1);

    // Topic B must not wait for topic A's turn.
    h.registry.enqueue("om_b", "oc_group", "om_b", "话题B的问题", binding);
    await flush();
    assert.equal(h.created.length, 2, "each topic gets its own agent");

    h.registry.handleTurnEnded("agent-1", completed("话题A答复"));
    h.registry.handleTurnEnded("agent-2", completed("话题B答复"));
    await flush();
    assert.deepEqual(
      h.replies.map((reply) => [reply.messageId, reply.outcome.lastText]),
      [
        ["om_a", "话题A答复"],
        ["om_b", "话题B答复"],
      ],
    );
  });

  it("reuses the topic agent for replies inside the same thread", async () => {
    const h = makeHarness();
    h.registry.enqueue("om_root", "oc_group", "om_root", "话题首条", binding);
    await flush();
    h.registry.handleTurnEnded("agent-1", completed("首条答复"));
    await flush();

    // A reply inside the thread carries root_id = om_root.
    h.registry.enqueue("om_root", "oc_group", "om_reply1", "继续刚才的", binding);
    await flush();
    assert.equal(h.created.length, 1, "thread replies reuse the topic agent");
    assert.deepEqual(h.runCalls.map((call) => call.text), ["继续刚才的"]);
  });

  it("falls back to the latest seen message when the target queue is empty", async () => {
    const h = makeHarness();
    h.registry.noteMessage("om_seen", "oc_group", "om_seen");
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    const agent = h.currentAgent();
    // A manual turn from the Paseo client: no pending target, latest is om_1.
    h.registry.handleTurnEnded(agent.id, completed("手动轮完成"));
    await flush();
    assert.equal(h.replies[0]?.messageId, "om_1");
  });

  it("does not release the queue when run() resolves idle without turn_ended", async () => {
    const h = makeHarness();
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    const agent = h.currentAgent();
    h.registry.handleTurnEnded(agent.id, completed("第一轮答复"));
    await flush();

    h.registry.enqueue("om_1", "oc_group", "om_2", "第二条", binding);
    await flush();
    h.finishRun({ status: "idle", error: null, lastMessage: "run 结果" });
    await flush();
    h.registry.enqueue("om_1", "oc_group", "om_3", "第三条", binding);
    await flush();
    assert.deepEqual(h.runCalls.map((call) => call.text), ["第二条"], "run() idle must not drain the queue");

    h.registry.handleTurnEnded(agent.id, completed("第二轮答复"));
    await flush();
    assert.deepEqual(h.runCalls.map((call) => call.text), ["第二条", "第三条"]);
  });

  it("ignores a stale run() idle after turn_ended already released the queue", async () => {
    const replies: ReplyCall[] = [];
    const runResolvers: ((result: SessionRunResult) => void)[] = [];
    let runCount = 0;
    const paseo: SessionPaseoApi = {
      agents: {
        create: async () => {
          const handle: SessionAgentHandle = {
            id: "agent-1",
            send: async () => {},
            run: () => {
              runCount += 1;
              return new Promise<SessionRunResult>((resolve) => runResolvers.push(resolve));
            },
          };
          return handle;
        },
        ref: () => {
          throw new Error("unused");
        },
      },
    };
    const registry = createSessionRegistry({
      paseo,
      getIdleMs: () => 30 * 60_000,
      callbacks: {
        onReply: (chatId, messageId, outcome) => replies.push({ chatId, messageId, outcome }),
        onNotice: () => {},
      },
    });
    registry.enqueue("om_1", "oc_group", "om_1", "A", binding);
    await flush();
    registry.handleTurnEnded("agent-1", completed("A"));
    await flush();

    registry.enqueue("om_1", "oc_group", "om_2", "B", binding);
    await flush();
    registry.enqueue("om_1", "oc_group", "om_3", "C", binding);
    await flush();
    registry.handleTurnEnded("agent-1", completed("B"));
    await flush();
    assert.equal(runCount, 2, "C should start after B's turn_ended");

    // B's run() resolves after turn_ended already moved on to C.
    runResolvers[0]?.({ status: "idle", error: null, lastMessage: "B late" });
    await flush();
    assert.equal(runCount, 2, "stale idle must not start another run");
    assert.equal(registry.status()[0]?.busy, true, "C is still running");
  });

  it("ignores a duplicate turn_ended for the same turn", async () => {
    const h = makeHarness();
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    const agent = h.currentAgent();
    h.registry.handleTurnEnded(agent.id, completed("第一轮答复"));
    await flush();
    h.registry.handleTurnEnded(agent.id, completed("重复的完成事件"));
    await flush();
    assert.equal(h.replies.length, 1, "duplicate completion must not reply twice");
  });

  it("creates dsh sessions with max thinking and full access", async () => {
    const h = makeHarness();
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", { ...binding, provider: "dsh/deepseek-v4.1-flash" });
    await flush();
    assert.equal(h.created.length, 1);
    assert.equal(h.created[0].config.thinkingOptionId, "max");
    assert.deepEqual(h.created[0].config.featureValues, {
      paseo_dsh_permission_preset: "danger-full-access",
    });
  });

  it("does not force dsh settings on other providers", async () => {
    const h = makeHarness();
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", { ...binding, provider: "claude" });
    await flush();
    assert.equal(h.created.length, 1);
    assert.equal(h.created[0].config.thinkingOptionId, undefined);
    assert.equal(h.created[0].config.featureValues, undefined);
  });

  it("expands a leading ~ in cwd", async () => {
    const h = makeHarness();
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", { ...binding, cwd: "~/project" });
    await flush();
    assert.equal(h.created.length, 1);
    assert.ok(!h.created[0].cwd.startsWith("~"), h.created[0].cwd);
    assert.ok(h.created[0].cwd.endsWith("/project"), h.created[0].cwd);
  });
});

describe("reply fallbacks", () => {
  it("uses run()'s lastMessage when the turn_ended timeline has no text", async () => {
    const h = makeHarness();
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    h.registry.handleTurnEnded("agent-1", completed("第一轮答复"));
    await flush();

    // Second turn: run resolves idle with a lastMessage the timeline lacks.
    h.registry.enqueue("om_1", "oc_group", "om_2", "第二条", binding);
    await flush();
    h.finishRun({ status: "idle", error: null, lastMessage: "run 拿到的答复" });
    await flush();
    h.registry.handleTurnEnded("agent-1", { outcome: "completed", lastText: null, lastError: null });
    await flush();
    assert.equal(h.replies[h.replies.length - 1]?.outcome.lastText, "run 拿到的答复");
    assert.equal(h.replies[h.replies.length - 1]?.messageId, "om_2");
  });

  it("refetches the timeline when both the event and run() lack text", async () => {
    const replies: ReplyCall[] = [];
    let fetched = false;
    const paseo: import("../server/sessions.ts").SessionPaseoApi = {
      agents: {
        create: async () => ({
          id: "agent-9",
          send: async () => {},
          run: async () => ({ status: "timeout", error: null, lastMessage: null }),
          timeline: {
            refetch: async () => {
              fetched = true;
              return { entries: [{ type: "assistant_message", text: "时间线兜底的答复" }] };
            },
          },
        }),
        ref: () => {
          throw new Error("unused");
        },
      },
    };
    const registry = createSessionRegistry({
      paseo,
      getIdleMs: () => 30 * 60_000,
      // Injected the way index.server.ts wires it; the registry only calls it.
      fetchLastReply: async () => {
        fetched = true;
        return "时间线兜底的答复";
      },
      callbacks: {
        onReply: (chatId, messageId, outcome) => replies.push({ chatId, messageId, outcome }),
        onNotice: () => {},
      },
    });
    // create-driven first turn, then the turn ends without any timeline text.
    registry.enqueue("om_t", "oc_group", "om_t", "看看结果", binding);
    await flush();
    registry.handleTurnEnded("agent-9", { outcome: "completed", lastText: null, lastError: null });
    await flush();
    assert.equal(fetched, true);
    assert.equal(replies[0]?.outcome.lastText, "时间线兜底的答复");
  });
});
