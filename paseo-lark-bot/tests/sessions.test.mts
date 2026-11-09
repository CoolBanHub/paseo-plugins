import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  created: {
    prompt?: string;
    title?: string;
    labels?: Record<string, string>;
    autoArchive?: boolean;
    background?: boolean;
    provider: string;
    cwd: string;
    config: {
      systemPrompt?: string;
      modeId?: string;
      thinkingOptionId?: string;
      featureValues?: Record<string, unknown>;
    };
  }[];
  /** agents created through the shared-workspace handle (no cwd field). */
  wsAgentCreates: {
    prompt?: string;
    title?: string;
    labels?: Record<string, string>;
    provider: string;
  }[];
  /** workspaces.create requests issued by ensureSharedWorkspace. */
  wsCreated: { title?: string; source: { kind: string; path: string } }[];
  /** workspace ids handed back via workspaces.ref(). */
  wsRefs: string[];
  runCalls: { agentId: string; text: string }[];
  agentCounter: number;
  currentAgent: () => SessionAgentHandle;
  finishRun: (result: SessionRunResult) => void;
}

interface WorkspacesFakeOptions {
  entries: { id: string; name?: string | null; title?: string | null }[];
  failCreate?: boolean;
}

const binding: ChatBinding = {
  chatId: "oc_group",
  chatName: "测试群",
  provider: "claude",
  model: "",
  thinkingOptionId: "",
  permission: "",
  allowedUsers: [],
  cwd: "/tmp/project",
  systemPrompt: "用中文回答",
  replyFormat: "markdown",
};

function makeHarness(
  options?: {
    idleMinutes?: number;
    aiTitle?: boolean;
    workspaces?: WorkspacesFakeOptions;
    turnRetryDelaysMs?: number[];
    stuckBusyMs?: number;
  },
): Harness {
  const replies: ReplyCall[] = [];
  const notices: Harness["notices"] = [];
  const created: Harness["created"] = [];
  const wsAgentCreates: Harness["wsAgentCreates"] = [];
  const wsCreated: Harness["wsCreated"] = [];
  const wsRefs: string[] = [];
  const runCalls: Harness["runCalls"] = [];
  let agentCounter = 0;
  let current: SessionAgentHandle | null = null;
  let pendingRun: ((result: SessionRunResult) => void) | null = null;

  const spawnAgent = (): SessionAgentHandle => {
    agentCounter += 1;
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
  };

  const workspaceHandle = (id: string) => ({
    id,
    agents: {
      create: async (request: {
        prompt?: string;
        title?: string;
        labels?: Record<string, string>;
        config: { provider: string };
      }) => {
        wsAgentCreates.push({
          prompt: request.prompt,
          title: request.title,
          labels: request.labels,
          provider: request.config.provider,
        });
        return spawnAgent();
      },
    },
  });

  const paseo: SessionPaseoApi = {
    agents: {
      create: async (request) => {
        created.push({
          prompt: request.prompt,
          title: request.title,
          labels: request.labels,
          autoArchive: request.autoArchive,
          background: request.background,
          provider: request.config.provider,
          cwd: request.cwd,
          config: request.config,
        });
        return spawnAgent();
      },
      ref: (id) => {
        if (!current || current.id !== id) throw new Error("unexpected ref " + id);
        return current;
      },
    },
  };

  const registry = createSessionRegistry({
    paseo: options?.workspaces
      ? {
          ...paseo,
          workspaces: {
            list: async () => ({ entries: options.workspaces!.entries }),
            ref: (id: string) => {
              wsRefs.push(id);
              return workspaceHandle(id);
            },
            create: async (request: { title?: string; source: { kind: string; path: string } }) => {
              if (options.workspaces!.failCreate) throw new Error("workspace create failed");
              wsCreated.push(request);
              options.workspaces!.entries.push({ id: "ws-new", title: request.title ?? null });
              return workspaceHandle("ws-new");
            },
          },
        }
      : paseo,
    getIdleMs: () => (options?.idleMinutes ?? 30) * 60_000,
    getAiTitle: () => options?.aiTitle ?? false,
    turnRetryDelaysMs: options?.turnRetryDelaysMs,
    stuckBusyMs: options?.stuckBusyMs,
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
    wsAgentCreates,
    wsCreated,
    wsRefs,
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
      getAiTitle: () => false,
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
      getAiTitle: () => false,
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

  it("applies the selected model, thinking depth, and provider mode", async () => {
    const h = makeHarness();
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", {
      ...binding,
      provider: "claude",
      model: "claude-opus-4",
      thinkingOptionId: "high",
      permission: "plan",
    });
    await flush();
    assert.equal(h.created.length, 1);
    assert.equal(h.created[0].provider, "claude/claude-opus-4");
    assert.equal(h.created[0].config.modeId, "plan");
    assert.equal(h.created[0].config.thinkingOptionId, "high");
    assert.equal(h.created[0].config.featureValues, undefined);
  });

  it("lets dsh bindings override the default permission and thinking depth", async () => {
    const h = makeHarness();
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", {
      ...binding,
      provider: "dsh/deepseek-v4.1-flash",
      thinkingOptionId: "high",
      permission: "workspace-write",
    });
    await flush();
    assert.equal(h.created.length, 1);
    assert.equal(h.created[0].provider, "dsh/deepseek-v4.1-flash");
    assert.equal(h.created[0].config.thinkingOptionId, "high");
    assert.deepEqual(h.created[0].config.featureValues, {
      paseo_dsh_permission_preset: "workspace-write",
    });
  });

  it("passes the binding model to the provider resolver", async () => {
    const resolutions: { provider: string; model: string }[] = [];
    let createdProvider = "";
    const paseo: SessionPaseoApi = {
      agents: {
        create: async (request) => {
          createdProvider = request.config.provider;
          return {
            id: "agent-1",
            send: async () => {},
            run: async () => ({ status: "idle", error: null, lastMessage: null }),
          };
        },
        ref: () => {
          throw new Error("unused");
        },
      },
    };
    const registry = createSessionRegistry({
      paseo,
      getIdleMs: () => 30 * 60_000,
      resolveProvider: async (provider, model) => {
        resolutions.push({ provider, model });
        return provider + "/" + model;
      },
      callbacks: { onReply: () => {}, onNotice: () => {} },
    });
    registry.enqueue("om_1", "oc_group", "om_1", "第一条", { ...binding, model: "deepseek-v4.1-flash" });
    await flush();
    assert.deepEqual(resolutions, [{ provider: "claude", model: "deepseek-v4.1-flash" }]);
    assert.equal(createdProvider, "claude/deepseek-v4.1-flash");
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

describe("session titles", () => {
  it("names new sessions with the AI one-liner when enabled", async () => {
    const h = makeHarness({ aiTitle: true });
    h.registry.enqueue(
      "om_1",
      "oc_group",
      "om_1",
      "【话题主题】看图\n\n【本次消息】帮我分析",
      binding,
      undefined,
      "看图",
    );
    await flush();
    // The one-shot naming session is created first: no prompt, purpose label,
    // auto-archive, and out of the interactive workspace focus.
    assert.equal(h.created.length, 1);
    assert.equal(h.created[0].prompt, undefined);
    assert.deepEqual(h.created[0].labels, {
      "lark-bot-purpose": "title",
      "lark-bot-chat": "oc_group",
      "lark-bot-topic": "om_1",
    });
    assert.equal(h.created[0].autoArchive, true);
    assert.equal(h.created[0].background, true);
    assert.equal(h.runCalls.length, 1);
    assert.match(h.runCalls[0].text, /看图/);
    // Once the naming turn answers, the topic session carries the AI title.
    h.finishRun({ status: "idle", error: null, lastMessage: "“分析图片内容”" });
    await flush();
    assert.equal(h.created.length, 2);
    assert.equal(h.created[1].title, "飞书 · 测试群 · 分析图片内容");
    assert.equal(h.created[1].prompt, "【话题主题】看图\n\n【本次消息】帮我分析");
  });

  it("falls back to the sanitized topic text when the naming turn fails", async () => {
    const h = makeHarness({ aiTitle: true });
    h.registry.enqueue(
      "om_1",
      "oc_group",
      "om_1",
      "【话题主题】[图片]\n\n【本次消息】看下这张图",
      binding,
      undefined,
      "[图片]",
    );
    await flush();
    h.finishRun({ status: "error", error: "provider down", lastMessage: null });
    await flush();
    assert.equal(h.created.length, 2);
    assert.equal(h.created[1].title, "飞书 · 测试群 · [图片]");
  });

  it("skips the naming turn and clips the instruction when disabled", async () => {
    const h = makeHarness();
    h.registry.enqueue("om_1", "oc_group", "om_1", "【话题主题】闲聊\n\n【本次消息】帮我修这个 bug", binding);
    await flush();
    assert.equal(h.created.length, 1);
    assert.equal(h.runCalls.length, 0);
    assert.equal(h.created[0].title, "飞书 · 测试群 · 帮我修这个 bug");
  });
});

describe("shared workspace", () => {
  it("creates the shared 飞书任务 workspace and places topic agents inside it", async () => {
    const h = makeHarness({ workspaces: { entries: [] } });
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    // The workspace is created once with the binding cwd as its directory.
    assert.equal(h.wsCreated.length, 1);
    assert.equal(h.wsCreated[0].title, "飞书任务");
    assert.deepEqual(h.wsCreated[0].source, { kind: "directory", path: "/tmp/project" });
    // The agent goes through the workspace handle; no standalone create.
    assert.equal(h.wsAgentCreates.length, 1);
    assert.equal(h.wsAgentCreates[0].prompt, "第一条");
    assert.equal(h.wsAgentCreates[0].title, "飞书 · 测试群 · 第一条");
    assert.deepEqual(h.wsAgentCreates[0].labels, { "lark-bot-chat": "oc_group", "lark-bot-topic": "om_1" });
    assert.equal(h.created.length, 0);
  });

  it("reuses the shared workspace for a second topic", async () => {
    const h = makeHarness({ workspaces: { entries: [] } });
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    h.registry.handleTurnEnded("agent-1", completed("第一轮答复"));
    await flush();
    h.registry.enqueue("om_2", "oc_group", "om_2", "第二条", binding);
    await flush();
    assert.equal(h.wsCreated.length, 1, "workspace must be created exactly once");
    assert.equal(h.wsAgentCreates.length, 2);
    assert.deepEqual(h.wsAgentCreates[1].labels, { "lark-bot-chat": "oc_group", "lark-bot-topic": "om_2" });
  });

  it("reuses an existing same-named workspace instead of creating one", async () => {
    const byTitle = makeHarness({
      workspaces: { entries: [{ id: "ws-existing", name: "别的目录", title: "飞书任务" }] },
    });
    byTitle.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    assert.equal(byTitle.wsCreated.length, 0);
    assert.deepEqual(byTitle.wsRefs, ["ws-existing"]);
    assert.equal(byTitle.wsAgentCreates.length, 1);

    const byName = makeHarness({
      workspaces: { entries: [{ id: "ws-named", name: "飞书任务", title: null }] },
    });
    byName.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    assert.equal(byName.wsCreated.length, 0);
    assert.deepEqual(byName.wsRefs, ["ws-named"]);
    assert.equal(byName.wsAgentCreates.length, 1);
  });

  it("falls back to a standalone agents.create when the workspace create fails", async () => {
    const h = makeHarness({ workspaces: { entries: [], failCreate: true } });
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    assert.equal(h.wsAgentCreates.length, 0);
    assert.equal(h.created.length, 1);
    assert.equal(h.created[0].cwd, "/tmp/project");
    assert.equal(h.created[0].prompt, "第一条");
  });
});

describe("turn failure retries", () => {
  it("retries a transient failure on the same agent and answers afterwards", async () => {
    const h = makeHarness({ turnRetryDelaysMs: [10, 10] });
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    const agent = h.currentAgent();
    h.registry.handleTurnEnded(agent.id, completed("第一轮答复"));
    await flush();

    h.registry.enqueue("om_1", "oc_group", "om_2", "第二条", binding);
    await flush();
    h.finishRun({ status: "error", error: "HTTP 429", lastMessage: null });
    await flush();
    // No failure reply yet: the item sits at the queue head awaiting retry.
    assert.equal(h.replies.length, 1, "only the first turn has answered");
    assert.equal(h.registry.ownsAgent(agent.id), true, "transient failure keeps the agent");

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(h.runCalls.map((call) => call.text), ["第二条", "第二条"]);
    h.finishRun({ status: "idle", error: null, lastMessage: "重试后的答复" });
    h.registry.handleTurnEnded(agent.id, completed("重试后的答复"));
    await flush();
    assert.equal(h.replies[h.replies.length - 1]?.messageId, "om_2");
    assert.equal(h.replies[h.replies.length - 1]?.outcome.lastText, "重试后的答复");

    // The retried turn must not leave a stale pending target behind: the next
    // turn replies under its own trigger message.
    h.registry.enqueue("om_1", "oc_group", "om_3", "第三条", binding);
    await flush();
    h.finishRun({ status: "idle", error: null, lastMessage: "第三轮答复" });
    h.registry.handleTurnEnded(agent.id, completed("第三轮答复"));
    await flush();
    assert.equal(h.replies[h.replies.length - 1]?.messageId, "om_3");
  });

  it("gives up after the retry budget, replies once, and rebuilds", async () => {
    const h = makeHarness({ turnRetryDelaysMs: [10, 10] });
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    const agent = h.currentAgent();
    h.registry.handleTurnEnded(agent.id, completed("第一轮答复"));
    await flush();

    h.registry.enqueue("om_1", "oc_group", "om_2", "第二条", binding);
    await flush();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      h.finishRun({ status: "error", error: "HTTP 503 Service Unavailable", lastMessage: null });
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const failed = h.replies[h.replies.length - 1];
    assert.equal(failed?.outcome.outcome, "failed");
    assert.match(failed?.outcome.lastError ?? "", /已自动重试 2 次/);
    assert.equal(h.registry.ownsAgent(agent.id), false, "exhausted retries rebuild the session");
    assert.equal(h.runCalls.length, 3, "one initial attempt plus two retries");

    h.registry.enqueue("om_1", "oc_group", "om_3", "第三条", binding);
    await flush();
    assert.equal(h.created.length, 2, "a fresh agent is created after the bailout");
  });

  it("fails fast on fatal errors without retrying", async () => {
    const h = makeHarness({ turnRetryDelaysMs: [10, 10] });
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    const agent = h.currentAgent();
    h.registry.handleTurnEnded(agent.id, completed("第一轮答复"));
    await flush();

    h.registry.enqueue("om_1", "oc_group", "om_2", "第二条", binding);
    await flush();
    h.finishRun({ status: "error", error: "HTTP 401", lastMessage: null });
    await flush();
    assert.equal(h.replies[h.replies.length - 1]?.outcome.outcome, "failed");
    assert.equal(h.runCalls.length, 1, "auth errors are not retried");
    assert.equal(h.registry.ownsAgent(agent.id), false);
  });

  it("queues new messages behind a pending retry", async () => {
    const h = makeHarness({ turnRetryDelaysMs: [10, 10] });
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    const agent = h.currentAgent();
    h.registry.handleTurnEnded(agent.id, completed("第一轮答复"));
    await flush();

    h.registry.enqueue("om_1", "oc_group", "om_2", "第二条", binding);
    await flush();
    h.finishRun({ status: "error", error: "ETIMEDOUT", lastMessage: null });
    await flush();
    // A message arriving during the backoff must not bypass the retry.
    h.registry.enqueue("om_1", "oc_group", "om_3", "第三条", binding);
    await flush();
    assert.equal(h.runCalls.length, 1);

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(
      h.runCalls.map((call) => call.text),
      ["第二条", "第二条"],
      "the retried item stays ahead of the newer message",
    );
  });
});

describe("stuck-busy watchdog", () => {
  it("proactively rebuilds a hung turn without waiting for a new message", async () => {
    const h = makeHarness({ stuckBusyMs: 20 });
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    const agent = h.currentAgent();
    // The create-driven turn never ends; the queued message must still be served.
    h.registry.enqueue("om_1", "oc_group", "om_2", "第二条", binding);
    await flush();
    assert.equal(h.registry.status()[0]?.queued, 1);

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(h.notices.some((notice) => notice.text.includes("已重建会话")));
    assert.equal(h.registry.ownsAgent(agent.id), false);
    await flush();
    assert.equal(h.created.length, 2, "the queued message restarts on a fresh agent");
  });

  it("only reminds once while a turn waits on a permission decision", async () => {
    const h = makeHarness({ stuckBusyMs: 20 });
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    const agent = h.currentAgent();
    h.registry.handleTurnEnded(agent.id, completed("第一轮答复"));
    await flush();

    h.registry.enqueue("om_1", "oc_group", "om_2", "需要权限", binding);
    await flush();
    h.finishRun({ status: "permission", error: null, lastMessage: null });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(h.notices.some((notice) => notice.text.includes("权限确认")));
    assert.equal(h.registry.ownsAgent(agent.id), true, "permission waits are not stuck");
    assert.equal(h.registry.status()[0]?.busy, true);

    h.registry.handleTurnEnded(agent.id, completed("批准后完成"));
    await flush();
    assert.equal(h.replies[h.replies.length - 1]?.messageId, "om_2");
  });
});

describe("topic agent store", () => {
  it("persists topic→agent mappings and resumes them after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-sessions-"));
    const storePath = join(dir, "topic-agents.json");
    try {
      const handle: SessionAgentHandle = {
        id: "agent-1",
        send: async () => {},
        run: async () => ({ status: "idle", error: null, lastMessage: "ok" }),
      };
      const first = createSessionRegistry({
        paseo: {
          agents: {
            create: async () => handle,
            ref: () => {
              throw new Error("no ref");
            },
          },
        },
        getIdleMs: () => 0,
        getAiTitle: () => false,
        topicStorePath: storePath,
        topicStoreDebounceMs: 10,
        callbacks: { onReply: () => {}, onNotice: () => {} },
      });
      first.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
      await flush();
      first.handleTurnEnded("agent-1", completed("ok"));
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.ok(existsSync(storePath), "the mapping must be persisted");

      // A new registry (daemon restart) re-attaches via agents.ref, not create.
      const runCalls: string[] = [];
      let recreated = 0;
      const restarted = createSessionRegistry({
        paseo: {
          agents: {
            create: async () => {
              recreated += 1;
              return { ...handle, id: "agent-2" };
            },
            ref: (id) => {
              assert.equal(id, "agent-1");
              return {
                ...handle,
                run: async (text: string) => {
                  runCalls.push(text);
                  return { status: "idle", error: null, lastMessage: "ok" };
                },
              };
            },
          },
        },
        getIdleMs: () => 0,
        getAiTitle: () => false,
        topicStorePath: storePath,
        topicStoreDebounceMs: 10,
        callbacks: { onReply: () => {}, onNotice: () => {} },
      });
      assert.equal(restarted.ownsAgent("agent-1"), true, "the reverse mapping is restored too");
      restarted.enqueue("om_1", "oc_group", "om_2", "重启后的问题", binding);
      await flush();
      assert.equal(recreated, 0, "the stored agent is resumed, not recreated");
      assert.deepEqual(runCalls, ["重启后的问题"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to a fresh agent when the stored one is gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-sessions-"));
    const storePath = join(dir, "topic-agents.json");
    try {
      writeFileSync(storePath, JSON.stringify({
        version: 1,
        topics: [{ topicKey: "om_1", chatId: "oc_group", agentId: "agent-gone", lastActivityAt: 0 }],
      }));
      let created = 0;
      const registry = createSessionRegistry({
        paseo: {
          agents: {
            create: async () => {
              created += 1;
              return {
                id: "agent-new",
                send: async () => {},
                run: async () => ({ status: "idle", error: null, lastMessage: "ok" }),
              };
            },
            ref: () => {
              throw new Error("agent deleted");
            },
          },
        },
        getIdleMs: () => 0,
        getAiTitle: () => false,
        topicStorePath: storePath,
        topicStoreDebounceMs: 10,
        callbacks: { onReply: () => {}, onNotice: () => {} },
      });
      registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
      await flush();
      assert.equal(created, 1, "an unresolvable stored agent degrades to a fresh create");
      assert.equal(registry.ownsAgent("agent-new"), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("default system prompt", () => {
  it("marks transcript blocks as data when the binding sets none", async () => {
    const h = makeHarness();
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", { ...binding, systemPrompt: "" });
    await flush();
    assert.match(h.created[0].config.systemPrompt ?? "", /聊天记录/);
    assert.match(h.created[0].config.systemPrompt ?? "", /【本次消息】/);
  });

  it("keeps the binding's own system prompt verbatim", async () => {
    const h = makeHarness();
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    assert.equal(h.created[0].config.systemPrompt, "用中文回答");
  });
});
