import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    autoArchive?: boolean;
    provider: string;
  }[];
  /** workspaces.create requests issued by ensureSharedWorkspace. */
  wsCreated: { title?: string; source: { kind: string; path: string } }[];
  /** workspace ids handed back via workspaces.ref(). */
  wsRefs: string[];
  runCalls: { agentId: string; text: string }[];
  activities: { agentId: string; topicKey: string; activity: { kind: string; text: string; tool?: string; status?: string } }[];
  emitTimeline: (event: unknown) => void;
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
  replyStyle: "default",
  replyStylePrompt: "",
  replyRewrite: "off",
  rewriteProvider: "",
  rewriteModel: "",
  replyFormat: "markdown",
  mentionOnReply: "off",
  allowAgentDelegation: false,
  issueTracking: "off",
  issueAiClassify: true,
    issueAiStatusReview: true,
  issueBaseToken: "",
  issueTableId: "",
  issueBaseUrl: "",
  issueReactionAccept: true,
  issueReactionEmojis: ["OK", "THUMBSUP", "THANKS", "DONE", "YES", "Yes", "CheckMark", "JIAYI"],
  issueAcceptRequester: true,
  issueAcceptUsers: [],
  rewriteIgnoreStyle: false,
};

function makeHarness(
  options?: {
    idleMinutes?: number;
    aiTitle?: boolean;
    workspaces?: WorkspacesFakeOptions;
    turnRetryDelaysMs?: number[];
    stuckBusyMs?: number;
    workspacePerBinding?: boolean;
    getMemberDirectory?: (chatId: string, replyFormat: string) => Promise<string | null>;
    getLarkCliPath?: () => string | null;
  },
): Harness {
  const replies: ReplyCall[] = [];
  const notices: Harness["notices"] = [];
  const created: Harness["created"] = [];
  const wsAgentCreates: Harness["wsAgentCreates"] = [];
  const wsCreated: Harness["wsCreated"] = [];
  const wsRefs: string[] = [];
  const runCalls: Harness["runCalls"] = [];
  const activities: Harness["activities"] = [];
  let timelineHandler: ((event: unknown) => void) | null = null;
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
      timeline: {
        refetch: async () => ({ entries: [] }),
        subscribe: (handler: (event: unknown) => void) => {
          timelineHandler = handler;
          return { unsubscribe: () => undefined };
        },
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
        autoArchive?: boolean;
        config: { provider: string };
      }) => {
        wsAgentCreates.push({
          prompt: request.prompt,
          title: request.title,
          labels: request.labels,
          autoArchive: request.autoArchive,
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
    getWorkspacePerBinding: () => options?.workspacePerBinding ?? false,
    getMemberDirectory: options?.getMemberDirectory,
    getLarkCliPath: options?.getLarkCliPath,
    turnRetryDelaysMs: options?.turnRetryDelaysMs,
    stuckBusyMs: options?.stuckBusyMs,
    callbacks: {
      onReply: (chatId, messageId, outcome) => replies.push({ chatId, messageId, outcome }),
      onNotice: (chatId, messageId, text) => notices.push({ chatId, messageId, text }),
      onAgentActivity: (agentId, topicKey, activity) => activities.push({ agentId, topicKey, activity }),
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
    activities,
    emitTimeline: (event) => timelineHandler?.(event),
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
    assert.equal(h.replies.length, 1);
    assert.equal(h.replies[0]?.chatId, "oc_group");
    assert.equal(h.replies[0]?.messageId, "om_1");
    assert.equal(h.replies[0]?.outcome.outcome, "completed");
    assert.equal(h.replies[0]?.outcome.lastText, "第一轮答复");

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
              return { entries: [{ item: { type: "assistant_message", text: "时间线兜底的答复" } }] };
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
    assert.equal(h.created[1].title, "分析图片内容");
    assert.equal(h.created[1].prompt, "【话题主题】看图\n\n【本次消息】帮我分析");
  });

  it("runs the naming turn inside the topic workspace instead of minting one", async () => {
    const h = makeHarness({ aiTitle: true, workspaces: { entries: [] } });
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
    // Only the shared 飞书任务 workspace exists; the naming session rides in it.
    assert.equal(h.wsCreated.length, 1);
    assert.equal(h.wsCreated[0].title, "飞书任务");
    assert.equal(h.wsAgentCreates.length, 1);
    assert.equal(h.wsAgentCreates[0].title, "飞书话题命名");
    assert.equal(h.wsAgentCreates[0].autoArchive, true);
    assert.deepEqual(h.wsAgentCreates[0].labels, {
      "lark-bot-purpose": "title",
      "lark-bot-chat": "oc_group",
      "lark-bot-topic": "om_1",
    });
    assert.equal(h.created.length, 0);

    h.finishRun({ status: "idle", error: null, lastMessage: "“分析图片内容”" });
    await flush();
    assert.equal(h.wsAgentCreates.length, 2);
    assert.equal(h.wsAgentCreates[1].title, "分析图片内容");
    assert.equal(h.wsAgentCreates[1].prompt, "【话题主题】看图\n\n【本次消息】帮我分析");
    assert.equal(h.registry.workspaceForTopic("om_1")?.id, "ws-new");
  });

  it("skips the naming helper when its workspace is unavailable", async () => {
    const h = makeHarness({ aiTitle: true, workspaces: { entries: [], failCreate: true } });
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
    // No standalone naming create: that would mint an extra workspace on 0.15+.
    assert.equal(h.wsAgentCreates.length, 0);
    assert.equal(h.created.length, 1);
    assert.equal(h.created[0].title, "看图");
    assert.equal(h.created[0].background, undefined);
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
    assert.equal(h.created[1].title, "[图片]");
  });

  it("skips the naming turn and clips the instruction when disabled", async () => {
    const h = makeHarness();
    h.registry.enqueue("om_1", "oc_group", "om_1", "【话题主题】闲聊\n\n【本次消息】帮我修这个 bug", binding);
    await flush();
    assert.equal(h.created.length, 1);
    assert.equal(h.runCalls.length, 0);
    assert.equal(h.created[0].title, "帮我修这个 bug");
  });

  it("leaves the chat name out of the title so the task description gets full width", async () => {
    const h = makeHarness({ aiTitle: true });
    const longNameBinding: ChatBinding = { ...binding, chatName: "电竞需求对接专用讨论群" };
    h.registry.enqueue(
      "om_1",
      "oc_group",
      "om_1",
      "【话题主题】算账\n\n【本次消息】计算 1-100 求和",
      longNameBinding,
      undefined,
      "算账",
    );
    await flush();
    h.finishRun({ status: "idle", error: null, lastMessage: "计算 1-100 求和并输出汇总" });
    await flush();
    assert.equal(h.created.length, 2);
    assert.equal(h.created[1].title, "计算 1-100 求和并输出汇总");
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
    assert.equal(h.wsAgentCreates[0].title, "第一条");
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

  it("uses one workspace per binding when enabled", async () => {
    const h = makeHarness({ workspaces: { entries: [] }, workspacePerBinding: true });
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    assert.equal(h.wsCreated.length, 1);
    assert.match(String(h.wsCreated[0].title), /^飞书 · 测试群/);
    assert.deepEqual(h.wsCreated[0].source, { kind: "directory", path: "/tmp/project" });
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
    assert.equal(failed?.outcome.retries, 2, "the retry count travels with the outcome");
    assert.doesNotMatch(failed?.outcome.lastError ?? "", /已自动重试/);
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

  it("retries a failed turn_ended instead of replying immediately", async () => {
    const h = makeHarness({ turnRetryDelaysMs: [10, 10] });
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    const agent = h.currentAgent();
    h.registry.handleTurnEnded(agent.id, completed("第一轮答复"));
    await flush();

    h.registry.enqueue("om_1", "oc_group", "om_2", "第二条", binding);
    await flush();
    // The daemon reports provider failures through turn_ended, which usually
    // arrives before run() resolves; it must still take the retry path.
    h.registry.handleTurnEnded(agent.id, { outcome: "failed", lastText: null, lastError: "HTTP 429" });
    await flush();
    assert.equal(h.replies.length, 1, "no failure reply yet");
    assert.equal(h.registry.ownsAgent(agent.id), true, "transient failure keeps the agent");

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(h.runCalls.length, 2, "the same turn was retried");
    h.finishRun({ status: "idle", error: null, lastMessage: "重试后的答复" });
    h.registry.handleTurnEnded(agent.id, completed("重试后的答复"));
    await flush();
    assert.equal(h.replies[h.replies.length - 1]?.messageId, "om_2");
    assert.equal(h.replies[h.replies.length - 1]?.outcome.retries, undefined);
  });

  it("retries a transient failure of the create-driven first turn", async () => {
    const h = makeHarness({ turnRetryDelaysMs: [10, 10] });
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    const agent = h.currentAgent();
    h.registry.handleTurnEnded(agent.id, {
      outcome: "failed",
      lastText: null,
      lastError: "HTTP 503 Service Unavailable",
    });
    await flush();
    assert.equal(h.replies.length, 0, "the first failure is retried, not reported");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(h.created.length, 1, "the existing agent is reused");
    assert.deepEqual(h.runCalls.map((call) => call.text), ["第一条"], "the prompt is rerun");
    h.finishRun({ status: "idle", error: null, lastMessage: "重试成功" });
    h.registry.handleTurnEnded(agent.id, completed("重试成功"));
    await flush();
    assert.equal(h.replies[h.replies.length - 1]?.messageId, "om_1");
  });
});

describe("stuck-busy watchdog", () => {
  it("requeues the hung request once and continues the queue on a fresh agent", async () => {
    const h = makeHarness({ stuckBusyMs: 40 });
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    const agent = h.currentAgent();
    // The create-driven turn never ends; the queued message must still be served.
    h.registry.enqueue("om_1", "oc_group", "om_2", "第二条", binding);
    await flush();
    assert.equal(h.registry.status()[0]?.queued, 1);

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(h.notices.some((notice) => notice.text.includes("重试一次")));
    assert.equal(h.registry.ownsAgent(agent.id), false);
    await flush();
    assert.equal(h.created.length, 2, "a fresh agent is created for the requeued request");
    assert.equal(h.created[1]?.prompt, "第一条", "the timed-out request is rerun, not dropped");

    // Finishing the rerun lets the queued message proceed on the same agent.
    const fresh = h.currentAgent();
    h.registry.handleTurnEnded(fresh.id, completed("第一条答复"));
    await flush();
    assert.deepEqual(h.runCalls.map((call) => call.text), ["第二条"]);
    assert.equal(h.created.length, 2);
  });

  it("does not rebuild a permission wait on a new message", async () => {
    const h = makeHarness({ stuckBusyMs: 20 });
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    const agent = h.currentAgent();
    h.registry.handleTurnEnded(agent.id, completed("第一轮答复"));
    await flush();

    h.registry.enqueue("om_1", "oc_group", "om_2", "需要权限", binding);
    await flush();
    h.finishRun({ status: "permission", error: null, lastMessage: null });
    await new Promise((resolve) => setTimeout(resolve, 40));

    // Past the stuck threshold the watchdog only reminds; a new message must
    // not kill the pending permission request.
    h.registry.enqueue("om_1", "oc_group", "om_3", "顺手再问一句", binding);
    await flush();
    assert.equal(h.registry.ownsAgent(agent.id), true, "permission waits are not rebuilt");
    assert.equal(h.registry.status()[0]?.busy, true);
    assert.equal(h.registry.status()[0]?.queued, 1);

    h.registry.handleTurnEnded(agent.id, completed("批准后完成"));
    await flush();
    assert.equal(h.replies[h.replies.length - 1]?.messageId, "om_2");
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

  it("validates a restored agent via refresh and creates when it is gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-sessions-"));
    const storePath = join(dir, "topic-agents.json");
    try {
      writeFileSync(storePath, JSON.stringify({
        version: 1,
        topics: [{
          topicKey: "om_1",
          chatId: "oc_group",
          agentId: "agent-gone",
          lastActivityAt: Date.now(),
          lastSeenMessageId: "om_prev",
        }],
      }));
      let created = 0;
      let refreshed = 0;
      const prompts: (string | undefined)[] = [];
      const registry = createSessionRegistry({
        paseo: {
          agents: {
            create: async (request) => {
              created += 1;
              prompts.push(request.prompt);
              return {
                id: "agent-new",
                send: async () => {},
                run: async () => ({ status: "idle", error: null, lastMessage: "ok" }),
              };
            },
            ref: () => ({
              id: "agent-gone",
              send: async () => {},
              run: async () => ({ status: "idle", error: null, lastMessage: "stale" }),
              refresh: async () => {
                refreshed += 1;
                return null;
              },
            }),
          },
        },
        getIdleMs: () => 0,
        getAiTitle: () => false,
        topicStorePath: storePath,
        topicStoreDebounceMs: 10,
        callbacks: { onReply: () => {}, onNotice: () => {} },
      });
      assert.equal(registry.status().length, 0, "restored topics are not live status rows");
      assert.equal(registry.targetForAgent("agent-gone"), "om_prev", "permission notices keep a reply target");
      registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
      await flush();
      assert.equal(refreshed, 1, "the stored handle is validated before use");
      assert.equal(created, 1, "a missing agent is replaced for the current message");
      assert.equal(prompts[0], "第一条", "the current request is rerun on the new agent");
      assert.equal(registry.ownsAgent("agent-new"), true);
      assert.equal(registry.status().length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reruns the request when a restored agent disappears at run time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-sessions-"));
    const storePath = join(dir, "topic-agents.json");
    try {
      writeFileSync(storePath, JSON.stringify({
        version: 1,
        topics: [{ topicKey: "om_1", chatId: "oc_group", agentId: "agent-gone", lastActivityAt: Date.now() }],
      }));
      const prompts: (string | undefined)[] = [];
      const replies: { messageId: string; outcome: TurnOutcome }[] = [];
      const registry = createSessionRegistry({
        paseo: {
          agents: {
            create: async (request) => {
              prompts.push(request.prompt);
              return {
                id: "agent-new",
                send: async () => {},
                run: async () => ({ status: "idle", error: null, lastMessage: "ok" }),
              };
            },
            ref: () => ({
              id: "agent-gone",
              send: async () => {},
              run: async () => {
                throw new Error("Agent not found: agent-gone");
              },
            }),
          },
        },
        getIdleMs: () => 0,
        getAiTitle: () => false,
        topicStorePath: storePath,
        topicStoreDebounceMs: 10,
        callbacks: {
          onReply: (_chatId, messageId, outcome) => replies.push({ messageId, outcome }),
          onNotice: () => {},
        },
      });
      registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(prompts.length, 1, "the request is rerun once on a fresh agent");
      assert.equal(prompts[0], "第一条");
      assert.equal(registry.ownsAgent("agent-new"), true);

      registry.handleTurnEnded("agent-new", completed("新会话答复"));
      await flush();
      assert.equal(replies[replies.length - 1]?.messageId, "om_1");
      assert.equal(replies[replies.length - 1]?.outcome.lastText, "新会话答复");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dispose flushes the topic store and stops the watchdog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-sessions-"));
    const storePath = join(dir, "topic-agents.json");
    try {
      const notices: string[] = [];
      const registry = createSessionRegistry({
        paseo: {
          agents: {
            create: async () => ({
              id: "agent-1",
              send: async () => {},
              run: async () => ({ status: "idle", error: null, lastMessage: "ok" }),
            }),
            ref: () => {
              throw new Error("unexpected ref");
            },
          },
        },
        getIdleMs: () => 0,
        getAiTitle: () => false,
        stuckBusyMs: 20,
        topicStorePath: storePath,
        topicStoreDebounceMs: 10_000,
        callbacks: {
          onReply: () => {},
          onNotice: (_chatId, _messageId, text) => notices.push(text),
        },
      });
      registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
      await flush();
      registry.dispose();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(notices.length, 0, "the watchdog must not fire after dispose");
      assert.ok(existsSync(storePath), "dispose flushes the debounced store");
      const saved = JSON.parse(readFileSync(storePath, "utf8")) as { topics?: unknown[] };
      assert.equal(saved.topics?.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("restart recovery", () => {
  const startedAt = 1_800_000_000_000;

  function writePendingStore(dir: string): string {
    const storePath = join(dir, "topic-agents.json");
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        topics: [
          {
            topicKey: "om_1",
            chatId: "oc_group",
            agentId: "agent-1",
            lastActivityAt: startedAt + 1_000,
            lastSeenMessageId: "om_1",
            pendingTurn: { target: "om_1", startedAt },
          },
        ],
      }),
    );
    return storePath;
  }

  const handle: SessionAgentHandle = {
    id: "agent-1",
    send: async () => {},
    run: async () => ({ status: "idle", error: null, lastMessage: null }),
  };

  it("persists an in-flight turn and clears it on turn_ended", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-recovery-"));
    const storePath = join(dir, "topic-agents.json");
    try {
      const registry = createSessionRegistry({
        paseo: {
          agents: {
            create: async () => handle,
            ref: () => handle,
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

      const saved = JSON.parse(readFileSync(storePath, "utf8")) as {
        topics?: { pendingTurn?: { target?: string | null; startedAt?: number } }[];
      };
      assert.equal(saved.topics?.[0]?.pendingTurn?.target, "om_1");

      registry.handleTurnEnded("agent-1", completed("done"));
      await new Promise((resolve) => setTimeout(resolve, 40));
      const after = JSON.parse(readFileSync(storePath, "utf8")) as {
        topics?: { pendingTurn?: unknown }[];
      };
      assert.equal(after.topics?.[0]?.pendingTurn, undefined);
      registry.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the pending marker when the plugin unloads mid-turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-recovery-"));
    const storePath = join(dir, "topic-agents.json");
    try {
      const registry = createSessionRegistry({
        paseo: {
          agents: {
            create: async () => handle,
            ref: () => handle,
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
      registry.dispose();

      const saved = JSON.parse(readFileSync(storePath, "utf8")) as {
        topics?: { pendingTurn?: { target?: string | null } }[];
      };
      assert.equal(saved.topics?.[0]?.pendingTurn?.target, "om_1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores a running turn and replies when it finishes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-recovery-"));
    const storePath = writePendingStore(dir);
    const replies: { messageId: string; outcome: TurnOutcome }[] = [];
    const notices: string[] = [];
    try {
      const registry = createSessionRegistry({
        paseo: {
          agents: {
            list: async () => ({ entries: [{ agent: { id: "agent-1", status: "running" } }] }),
            create: async () => {
              throw new Error("a running turn must not create a new agent");
            },
            ref: () => ({ ...handle, refresh: async () => ({ lastStatus: "running" }) }),
          },
        },
        getIdleMs: () => 0,
        getAiTitle: () => false,
        topicStorePath: storePath,
        topicStoreDebounceMs: 10,
        callbacks: {
          onReply: (_chatId, messageId, outcome) => replies.push({ messageId, outcome }),
          onNotice: (_chatId, _messageId, text) => notices.push(text),
        },
      });

      await registry.recoverPendingTurns();
      assert.equal(registry.sessionInfo("om_1", "oc_group").busy, true);
      assert.equal(replies.length, 0);
      assert.equal(notices.length, 0);

      registry.handleTurnEnded("agent-1", completed("final answer"));
      await flush();
      assert.equal(replies[0]?.messageId, "om_1");
      assert.equal(replies[0]?.outcome.lastText, "final answer");
      assert.equal(registry.sessionInfo("om_1", "oc_group").busy, false);
      registry.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resends a finished turn from the timeline after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-recovery-"));
    const storePath = writePendingStore(dir);
    const recovered: { text: string; topicKey: string }[] = [];
    const notices: string[] = [];
    try {
      const registry = createSessionRegistry({
        paseo: {
          agents: {
            list: async () => ({ entries: [{ agent: { id: "agent-1", status: "idle" } }] }),
            create: async () => {
              throw new Error("a finished turn must not create a new agent");
            },
            ref: () => handle,
          },
        },
        getIdleMs: () => 0,
        getAiTitle: () => false,
        topicStorePath: storePath,
        topicStoreDebounceMs: 10,
        fetchLastReply: async () => "recovered answer",
        callbacks: {
          onReply: () => {},
          onRecoveredReply: (_chatId, _messageId, text, topicKey) => recovered.push({ text, topicKey }),
          onNotice: (_chatId, _messageId, text) => notices.push(text),
        },
      });

      await registry.recoverPendingTurns();
      assert.deepEqual(recovered, [{ text: "recovered answer", topicKey: "om_1" }]);
      assert.equal(notices.length, 0);
      assert.equal(registry.sessionInfo("om_1", "oc_group").busy, false);
      await new Promise((resolve) => setTimeout(resolve, 40));
      const after = JSON.parse(readFileSync(storePath, "utf8")) as {
        topics?: { pendingTurn?: unknown }[];
      };
      assert.equal(after.topics?.[0]?.pendingTurn, undefined);
      registry.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("notifies the topic when the restored agent is gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-recovery-"));
    const storePath = writePendingStore(dir);
    const notices: string[] = [];
    try {
      const registry = createSessionRegistry({
        paseo: {
          agents: {
            list: async () => ({ entries: [] }),
            create: async () => {
              throw new Error("must not create");
            },
            ref: () => ({ ...handle, refresh: async () => null }),
          },
        },
        getIdleMs: () => 0,
        getAiTitle: () => false,
        topicStorePath: storePath,
        topicStoreDebounceMs: 10,
        callbacks: {
          onReply: () => {},
          onNotice: (_chatId, _messageId, text) => notices.push(text),
        },
      });

      await registry.recoverPendingTurns();
      assert.equal(notices.length, 1);
      assert.match(notices[0] ?? "", /重启中断/);
      assert.equal(registry.sessionInfo("om_1", "oc_group").busy, false);
      registry.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not resend an assistant message from before the turn started", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-recovery-"));
    const storePath = writePendingStore(dir);
    const notices: string[] = [];
    try {
      const registry = createSessionRegistry({
        paseo: {
          agents: {
            list: async () => ({ entries: [{ agent: { id: "agent-1", status: "idle" } }] }),
            create: async () => {
              throw new Error("must not create");
            },
            ref: () => ({
              ...handle,
              refresh: async () => ({ lastStatus: "idle", lastActivityAt: startedAt - 1_000 }),
            }),
          },
        },
        getIdleMs: () => 0,
        getAiTitle: () => false,
        topicStorePath: storePath,
        topicStoreDebounceMs: 10,
        fetchLastReply: async () => "old answer from a previous turn",
        callbacks: {
          onReply: () => {},
          onNotice: (_chatId, _messageId, text) => notices.push(text),
        },
      });

      await registry.recoverPendingTurns();
      assert.equal(notices.length, 1);
      assert.match(notices[0] ?? "", /重启中断/);
      assert.doesNotMatch(notices[0] ?? "", /old answer/);
      registry.dispose();
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

  it("appends the lark-cli capability pointer to the default prompt", async () => {
    const h = makeHarness({ getLarkCliPath: () => "/opt/homebrew/bin/lark-cli" });
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", { ...binding, systemPrompt: "" });
    await flush();
    const prompt = h.created[0].config.systemPrompt ?? "";
    assert.match(prompt, /### 飞书能力（lark-cli）/);
    assert.match(prompt, /\/opt\/homebrew\/bin\/lark-cli skills list/);
    assert.match(prompt, /skills read lark-im/);
    assert.match(prompt, /chat-id oc_group/);
    assert.match(prompt, /\+chat-messages-list/);
    assert.match(prompt, /\+threads-messages-list --thread om_1/);
    assert.match(prompt, /写操作必须先向用户确认/);
  });

  it("omits the lark-cli pointer when lark-cli is unavailable", async () => {
    const h = makeHarness();
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", { ...binding, systemPrompt: "" });
    await flush();
    assert.doesNotMatch(h.created[0].config.systemPrompt ?? "", /### 飞书能力/);
  });

  it("skips the thread command for p2p chats", async () => {
    const h = makeHarness({ getLarkCliPath: () => "/opt/homebrew/bin/lark-cli" });
    h.registry.enqueue("oc_dm", "oc_dm", "om_1", "第一条", { ...binding, systemPrompt: "" });
    await flush();
    const prompt = h.created[0].config.systemPrompt ?? "";
    assert.match(prompt, /\+chat-messages-list/);
    assert.doesNotMatch(prompt, /\+threads-messages-list/);
  });

  it("keeps the binding's own system prompt verbatim", async () => {
    const h = makeHarness({ getLarkCliPath: () => "/opt/homebrew/bin/lark-cli" });
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", binding);
    await flush();
    assert.equal(h.created[0].config.systemPrompt, "用中文回答");
  });

  it("appends a preset reply-style instruction after the system prompt", async () => {
    const h = makeHarness();
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", {
      ...binding,
      replyStyle: "concise",
    });
    await flush();
    const prompt = h.created[0].config.systemPrompt ?? "";
    assert.match(prompt, /^用中文回答/);
    assert.match(prompt, /### 回复风格/);
    assert.match(prompt, /3-5 句/);
  });

  it("appends a custom reply-style prompt", async () => {
    const h = makeHarness();
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", {
      ...binding,
      replyStyle: "custom",
      replyStylePrompt: "  用三句话回答  ",
      replyRewrite: "off",
      rewriteProvider: "",
      rewriteModel: "",
    });
    await flush();
    assert.match(h.created[0].config.systemPrompt ?? "", /用三句话回答/);
  });

  it("appends the group member directory to new post sessions", async () => {
    const h = makeHarness({
      getMemberDirectory: async () => "### 群成员目录（仅用于 @）\n- [机器人] OpsBot · open_id: `ou_bot`\n- [成员] 张三 · open_id: `ou_zhang`",
    });
    h.registry.enqueue("om_1", "oc_group", "om_1", "第一条", {
      ...binding,
      replyFormat: "post",
    });
    await flush();
    const prompt = h.created[0].config.systemPrompt ?? "";
    assert.match(prompt, /群成员目录/);
    assert.match(prompt, /OpsBot/);
    assert.match(prompt, /张三/);
    assert.match(prompt, /ou_zhang/);
  });
});

describe("live activity forwarding", () => {
  it("normalizes tool calls and assistant text from the agent stream", async () => {
    const h = makeHarness();
    h.registry.enqueue("om_1", "oc_group", "om_1", "跑测试", binding);
    await flush();

    h.emitTimeline({
      type: "agent_stream",
      payload: {
        event: {
          type: "timeline",
          item: { type: "tool_call", name: "bash", detail: { command: "npm test" }, status: "running" },
        },
      },
    });
    h.emitTimeline({
      type: "agent_stream",
      payload: { event: { type: "timeline", item: { type: "assistant_message", text: "第一行\n最后一行" } } },
    });
    assert.equal(h.activities.length, 2);
    assert.equal(h.activities[0]?.activity.kind, "tool");
    assert.equal(h.activities[0]?.activity.tool, "bash");
    assert.equal(h.activities[0]?.activity.text, "npm test");
    assert.equal(h.activities[1]?.activity.kind, "text");
    assert.equal(h.activities[1]?.activity.text, "最后一行");
  });
});
