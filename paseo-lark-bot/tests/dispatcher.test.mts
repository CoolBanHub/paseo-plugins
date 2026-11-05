import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDispatcher } from "../server/dispatcher.ts";
import type { LarkMessageEvent } from "../server/lark-events.ts";
import type { SessionAgentHandle, SessionPaseoApi } from "../server/sessions.ts";
import type { BotValues } from "../shared/settings.ts";

const BOT = "ou_bot";

interface ReplyCall {
  messageId: string;
  text: string;
  format: string;
  replyInThread: boolean;
}

function baseValues(overrides: Partial<BotValues> = {}): BotValues {
  return {
    appId: "",
    appSecret: "",
    larkCliPath: "",
    replyInThread: true,
    sessionIdleMinutes: 30,
    maxReplyChars: 4000,
    notifyUnmatched: false,
    ackOnReceive: false,
    notifyPermission: false,
    chats: [
      {
        chatId: "oc_group",
        chatName: "测试群",
        provider: "claude",
        cwd: "/tmp/project",
        systemPrompt: "",
        replyFormat: "markdown",
      },
    ],
    ...overrides,
  };
}

interface Harness {
  dispatch: ReturnType<typeof createDispatcher>;
  replies: ReplyCall[];
  created: { prompt?: string }[];
  runCalls: { agentId: string; text: string }[];
  agentId: string;
  paseoRef: import("../server/sessions.ts").SessionPaseoApi;
}

function makeHarness(values: BotValues = baseValues()): Harness {
  const replies: ReplyCall[] = [];
  const created: { prompt?: string; images?: unknown[] }[] = [];
  const runCalls: { agentId: string; text: string }[] = [];
  let current: SessionAgentHandle | null = null;

  const paseo: SessionPaseoApi = {
    agents: {
      create: async (request) => {
        created.push({ prompt: request.prompt, images: request.images });
        current = {
          id: `agent-${created.length}`,
          send: async () => {},
          run: async (text) => {
            runCalls.push({ agentId: current!.id, text });
            return { status: "idle", error: null, lastMessage: "ok" };
          },
        };
        return current;
      },
      ref: (id) => {
        if (!current || current.id !== id) throw new Error("unexpected ref");
        return current;
      },
    },
  };

  const dispatch = createDispatcher({
    paseo,
    readValues: async () => values,
    resolveCli: () => "/fake/lark-cli",
    readOpenId: async () => BOT,
    reply: async (options) => {
      replies.push({
        messageId: options.messageId,
        text: options.text,
        format: options.format,
        replyInThread: options.replyInThread,
      });
      return null;
    },
  });

  return { dispatch, replies, created, runCalls, agentId: "agent-1", paseoRef: paseo };
}

function groupEvent(overrides: Partial<LarkMessageEvent> = {}): LarkMessageEvent {
  return {
    chat_id: "oc_group",
    chat_type: "group",
    content: "@_user_1 帮我修个 bug",
    message_id: "om_1",
    message_type: "text",
    sender_id: "ou_user",
    sender_type: "user",
    mentions: [{ id: BOT, key: "@_user_1", name: "测试机器人" }],
    ...overrides,
  };
}

const turnEnded = (agentId: string, lastText: string) => ({
  agent: { id: agentId, workspaceId: null, parentAgentId: null, provider: "claude", cwd: "/tmp", title: null },
  turnId: "t1",
  outcome: { kind: "completed" as const },
  timeline: [{ type: "assistant_message" as const, text: lastText }],
});

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("createDispatcher", () => {
  it("runs an @-mention through a session and replies under the trigger message", async () => {
    const h = makeHarness();
    await h.dispatch.handleMessageEvent(groupEvent());
    await flush();
    assert.equal(h.created.length, 1);
    assert.equal(h.created[0].prompt, "帮我修个 bug");

    h.dispatch.handleTurnEnded(turnEnded(h.agentId, "已经修复，原因是空指针。"));
    await flush();
    assert.equal(h.replies.length, 1);
    assert.equal(h.replies[0].messageId, "om_1");
    assert.equal(h.replies[0].format, "markdown");
    assert.equal(h.replies[0].replyInThread, true);
    assert.ok(h.replies[0].text.includes("已经修复"));
  });

  it("records unmatched chats and stays silent unless configured", async () => {
    const h = makeHarness();
    await h.dispatch.handleMessageEvent(groupEvent({ chat_id: "oc_unknown" }));
    await flush();
    assert.deepEqual(h.replies, []);
    assert.deepEqual(
      h.dispatch.status().unmatched.map((entry) => entry.chatId),
      ["oc_unknown"],
    );
  });

  it("hints unmatched chats when notifyUnmatched is on", async () => {
    const h = makeHarness(baseValues({ notifyUnmatched: true }));
    await h.dispatch.handleMessageEvent(groupEvent({ chat_id: "oc_unknown" }));
    await flush();
    assert.equal(h.replies.length, 1);
    assert.ok(h.replies[0].text.includes("绑定"));
  });

  it("replies with a hint when the mention carries no text", async () => {
    const h = makeHarness();
    await h.dispatch.handleMessageEvent(groupEvent({ content: "@_user_1" }));
    await flush();
    assert.equal(h.replies.length, 1);
    assert.ok(h.replies[0].text.includes("没有读到文字内容"));
  });

  it("acks received messages when ackOnReceive is enabled", async () => {
    const h = makeHarness(baseValues({ ackOnReceive: true }));
    await h.dispatch.handleMessageEvent(groupEvent());
    await flush();
    assert.equal(h.replies.length >= 1, true);
    assert.ok(h.replies[0].text.includes("收到"), "first reply must be the ack");
    assert.equal(h.replies[0].messageId, "om_1");
    h.dispatch.handleTurnEnded(turnEnded(h.agentId, "处理结果答复"));
    await flush();
    const last = h.replies[h.replies.length - 1];
    assert.ok(last.text.includes("处理结果答复"));
  });

  it("notifies the chat about permission requests for its own agents only", async () => {
    const h = makeHarness(baseValues({ notifyPermission: true }));
    await h.dispatch.handleMessageEvent(groupEvent());
    await flush();

    h.dispatch.handlePermission({
      agent: { id: "agent-other", workspaceId: null, parentAgentId: null, provider: "claude", cwd: "/tmp", title: null },
      request: { id: "req-1", provider: "claude", name: "Bash", kind: "tool", title: "执行命令", description: "rm -rf build" },
    });
    await flush();
    assert.equal(h.replies.length, 0);

    h.dispatch.handlePermission({
      agent: { id: h.agentId, workspaceId: null, parentAgentId: null, provider: "claude", cwd: "/tmp", title: null },
      request: { id: "req-2", provider: "claude", name: "Bash", kind: "tool", title: "执行命令", description: "rm -rf build" },
    });
    await flush();
    assert.equal(h.replies.length, 1);
    assert.ok(h.replies[0].text.includes("需要确认"));
  });

  it("prepends the thread root as context for in-thread replies", async () => {
    const h = makeHarness();
    const dispatch = createDispatcher({
      paseo: h.paseoRef,
      readValues: async () => baseValues(),
      resolveCli: () => "/fake/lark-cli",
      readOpenId: async () => BOT,
      readThreadRootDetail: async (_cli, id) =>
        id === "om_root"
          ? { text: "现在的构建失败原因是什么", senderOpenId: "ou_user", senderName: "张三" }
          : null,
      reply: async (options) => {
        h.replies.push({ messageId: options.messageId, text: options.text, format: options.format, replyInThread: options.replyInThread });
        return null;
      },
    });
    await dispatch.handleMessageEvent(groupEvent({ message_id: "om_reply", root_id: "om_root", content: "@测试机器人 你查一下" }));
    await flush();
    assert.equal(h.created.length, 1);
    assert.equal(h.created[0].prompt, "【话题主题】现在的构建失败原因是什么\n\n【本次消息】你查一下");
  });

  it("labels members distinctly and marks media with placeholders", async () => {
    const h = makeHarness();
    // Two different humans chat in the topic, one drops an image.
    await h.dispatch.handleMessageEvent(
      groupEvent({ message_id: "om_root", sender_id: "ou_a", content: "看看这个报错", mentions: [] }),
    );
    await h.dispatch.handleMessageEvent(
      groupEvent({
        message_id: "om_img",
        root_id: "om_root",
        sender_id: "ou_b",
        message_type: "image",
        content: "",
        mentions: [],
      }),
    );
    await h.dispatch.handleMessageEvent(
      groupEvent({ message_id: "om_reply", root_id: "om_root", content: "@测试机器人 什么情况" }),
    );
    await flush();
    assert.equal(h.created.length, 1);
    const prompt = h.created[0].prompt ?? "";
    assert.ok(prompt.includes("成员A: 看看这个报错"), prompt);
    assert.ok(prompt.includes("成员B: [图片]"), prompt);
  });

  it("carries the whole thread conversation, mentioned or not", async () => {
    const h = makeHarness();
    // Root message without any mention — recorded but ignored for processing.
    await h.dispatch.handleMessageEvent(
      groupEvent({ message_id: "om_root", content: "现在的构建失败原因是什么", mentions: [] }),
    );
    // In-thread follow-up without a mention.
    await h.dispatch.handleMessageEvent(
      groupEvent({ message_id: "om_mid", root_id: "om_root", content: "只看最新一次构建", mentions: [] }),
    );
    await flush();
    assert.equal(h.created.length, 0, "unmentioned messages must not spawn agents");

    await h.dispatch.handleMessageEvent(
      groupEvent({ message_id: "om_reply", root_id: "om_root", content: "@测试机器人 你查一下" }),
    );
    await flush();
    assert.equal(h.created.length, 1);
    const prompt = h.created[0].prompt ?? "";
    assert.ok(prompt.includes("现在的构建失败原因"), "root text expected: " + prompt);
    assert.ok(prompt.includes("只看最新一次构建"), "in-thread context expected: " + prompt);
    assert.ok(prompt.includes("你查一下"));
  });

  it("downloads topic images and attaches them to the next mention", async () => {
    const h = makeHarness();
    const dispatch = createDispatcher({
      paseo: h.paseoRef,
      readValues: async () => baseValues(),
      resolveCli: () => "/fake/lark-cli",
      readOpenId: async () => BOT,
      readRaw: async (_cli, id) =>
        id === "om_img" ? { image_key: "img_v3_abc" } : null,
      download: async ({ fileKey }) => ({ bytes: Buffer.from("fake-jpeg-" + fileKey), extension: ".jpg" }),
      extractFrames: async () => [],
      reply: async () => null,
    });
    // Realistic order: root first, then the image reply inside the thread.
    await dispatch.handleMessageEvent(
      groupEvent({ message_id: "om_root", sender_id: "ou_a", content: "看看这个报错", mentions: [] }),
    );
    await dispatch.handleMessageEvent(
      groupEvent({ message_id: "om_img", root_id: "om_root", sender_id: "ou_b", message_type: "image", content: "", mentions: [] }),
    );
    await flush();
    await dispatch.handleMessageEvent(
      groupEvent({ message_id: "om_reply", root_id: "om_root", content: "@测试机器人 图里什么情况" }),
    );
    await flush();
    assert.equal(h.created.length, 1);
    const createdImages = (h.created[0] as { images?: unknown[] }).images;
    assert.equal(createdImages?.length, 1);
    const prompt = h.created[0].prompt ?? "";
    assert.ok(prompt.includes("【附图】"), prompt);
    assert.ok(prompt.includes("成员B: [图片]"), prompt);
  });

  it("turns videos into extracted frames", async () => {
    const h = makeHarness();
    const dispatch = createDispatcher({
      paseo: h.paseoRef,
      readValues: async () => baseValues(),
      resolveCli: () => "/fake/lark-cli",
      readOpenId: async () => BOT,
      readRaw: async (_cli, id) =>
        id === "om_vid" ? { file_key: "file_v3_def" } : null,
      download: async () => ({ bytes: Buffer.from("fake-mp4"), extension: ".mp4" }),
      extractFrames: async () => [Buffer.from("f1"), Buffer.from("f2")],
      reply: async () => null,
    });
    await dispatch.handleMessageEvent(
      groupEvent({ message_id: "om_root", sender_id: "ou_a", content: "看这个录屏", mentions: [] }),
    );
    await dispatch.handleMessageEvent(
      groupEvent({ message_id: "om_vid", root_id: "om_root", sender_id: "ou_b", message_type: "media", content: "", mentions: [] }),
    );
    await flush();
    await dispatch.handleMessageEvent(
      groupEvent({ message_id: "om_reply", root_id: "om_root", content: "@测试机器人 视频里什么操作" }),
    );
    await flush();
    const createdImages = (h.created[0] as { images?: unknown[] }).images;
    assert.equal(createdImages?.length, 2, "two extracted frames expected");
    const prompt = h.created[0].prompt ?? "";
    assert.ok(prompt.includes("【附图】"), prompt);
  });

  it("stays silent on permission requests unless notifyPermission is enabled", async () => {
    const h = makeHarness();
    await h.dispatch.handleMessageEvent(groupEvent());
    await flush();

    h.dispatch.handlePermission({
      agent: { id: h.agentId, workspaceId: null, parentAgentId: null, provider: "dsh", cwd: "/tmp", title: null },
      request: { id: "req-1", provider: "dsh", name: "Question", kind: "question", title: "确认查询对象" },
    });
    await flush();
    assert.equal(h.replies.length, 0, "default must not notify");

    const noisy = makeHarness(baseValues({ notifyPermission: true }));
    await noisy.dispatch.handleMessageEvent(groupEvent());
    await flush();
    noisy.dispatch.handlePermission({
      agent: { id: noisy.agentId, workspaceId: null, parentAgentId: null, provider: "dsh", cwd: "/tmp", title: null },
      request: { id: "req-2", provider: "dsh", name: "Question", kind: "question", title: "确认查询对象" },
    });
    await flush();
    assert.ok(noisy.replies.some((reply) => reply.text.includes("需要确认")));
  });

  it("ignores group messages that do not mention the bot", async () => {
    const h = makeHarness();
    await h.dispatch.handleMessageEvent(groupEvent({ content: "普通聊天", mentions: [] }));
    await flush();
    assert.deepEqual(h.created, []);
    assert.deepEqual(h.replies, []);
  });

  it("reports failures through the reply channel", async () => {
    const h = makeHarness();
    await h.dispatch.handleMessageEvent(groupEvent());
    await flush();
    h.dispatch.handleTurnEnded({
      ...turnEnded(h.agentId, ""),
      outcome: { kind: "failed", error: { message: "provider 超时" } },
    });
    await flush();
    assert.equal(h.replies.length, 1);
    assert.ok(h.replies[0].text.includes("provider 超时"));
  });
});

describe("bare mentions", () => {
  it("processes the thread context when the mention carries no text", async () => {
    const h = makeHarness(baseValues({ ackOnReceive: true }));
    const dispatch = createDispatcher({
      paseo: h.paseoRef,
      readValues: async () => baseValues({ ackOnReceive: true }),
      resolveCli: () => "/fake/lark-cli",
      readOpenId: async () => BOT,
      readRaw: async (_cli, id) => (id === "om_img" ? { image_key: "img_v3_abc" } : null),
      download: async () => ({ bytes: Buffer.from("fake-jpeg"), extension: ".jpg" }),
      extractFrames: async () => [],
      reply: async (options) => {
        h.replies.push({ messageId: options.messageId, text: options.text, format: options.format, replyInThread: options.replyInThread });
        return null;
      },
    });
    await dispatch.handleMessageEvent(
      groupEvent({ message_id: "om_root", sender_id: "ou_a", content: "看看这个报错", mentions: [] }),
    );
    await dispatch.handleMessageEvent(
      groupEvent({ message_id: "om_img", root_id: "om_root", sender_id: "ou_b", message_type: "image", content: "", mentions: [] }),
    );
    await flush();
    // Bare @ inside the thread must spawn an agent working on the context.
    await dispatch.handleMessageEvent(
      groupEvent({ message_id: "om_bare", root_id: "om_root", sender_id: "ou_a", content: "@测试机器人" }),
    );
    await flush();
    assert.equal(h.created.length, 1);
    const prompt = h.created[0].prompt ?? "";
    assert.ok(prompt.includes("请查看并处理上方话题内容"), prompt);
    assert.ok(prompt.includes("看看这个报错"), prompt);
    const images = (h.created[0] as { images?: unknown[] }).images;
    assert.equal(images?.length, 1, "thread image should be attached");
    assert.ok(h.replies.some((reply) => reply.text.startsWith("✅")), "ack expected");
  });

  it("still asks for text when a fresh topic has nothing to work on", async () => {
    const h = makeHarness(baseValues({ ackOnReceive: true }));
    await h.dispatch.handleMessageEvent(groupEvent({ message_id: "om_solo", content: "@测试机器人" }));
    await flush();
    assert.equal(h.created.length, 0);
    assert.equal(h.replies.length, 1);
    assert.ok(h.replies[0].text.includes("没有读到文字内容"));
  });
});

describe("p2p and delivery hygiene", () => {
  const p2pValues = baseValues({
    chats: [
      {
        chatId: "oc_p2p",
        chatName: "私聊",
        provider: "claude",
        cwd: "/tmp/project",
        systemPrompt: "",
        replyFormat: "markdown",
      },
    ],
  });
  const p2pEvent = (id: string, content: string) =>
    groupEvent({
      chat_id: "oc_p2p",
      chat_type: "p2p",
      content,
      message_id: id,
      mentions: [],
    });

  it("keeps one agent for a p2p conversation", async () => {
    const h = makeHarness(p2pValues);
    await h.dispatch.handleMessageEvent(p2pEvent("om_1", "第一条"));
    await flush();
    h.dispatch.handleTurnEnded(turnEnded(h.agentId, "答一"));
    await flush();
    await h.dispatch.handleMessageEvent(p2pEvent("om_2", "继续"));
    await flush();
    assert.equal(h.created.length, 1, "p2p must reuse the chat agent");
    const prompt = h.runCalls[0]?.text ?? "";
    assert.ok(prompt.includes("【最近对话】") || prompt.includes("第一条"), prompt);
  });

  it("ignores duplicate deliveries of the same message_id", async () => {
    const h = makeHarness();
    const event = groupEvent({ message_id: "om_same" });
    await h.dispatch.handleMessageEvent(event);
    await flush();
    await h.dispatch.handleMessageEvent(event);
    await flush();
    assert.equal(h.created.length, 1);
    assert.equal(h.dispatch.status().sessions[0]?.queued, 0);
  });

  it("waits for a slow image ingest before the next @ in the same topic", async () => {
    const h = makeHarness();
    const dispatch = createDispatcher({
      paseo: h.paseoRef,
      readValues: async () => baseValues(),
      resolveCli: () => "/fake/lark-cli",
      readOpenId: async () => BOT,
      readRaw: async () => ({ image_key: "img_slow" }),
      download: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { bytes: Buffer.from("late-jpeg"), extension: ".jpg" };
      },
      extractFrames: async () => [],
      reply: async () => null,
    });
    const image = dispatch.handleMessageEvent(
      groupEvent({ message_id: "om_img", root_id: "om_root", message_type: "image", content: "", mentions: [] }),
    );
    const mention = dispatch.handleMessageEvent(
      groupEvent({ message_id: "om_mention", root_id: "om_root", content: "@测试机器人 图里是什么" }),
    );
    await Promise.all([image, mention]);
    await flush();
    assert.equal(h.created.length, 1);
    const images = (h.created[0] as { images?: unknown[] }).images;
    assert.equal(images?.length, 1, "slow image must be attached to the next turn");
  });

  it("does not download media in unbound chats", async () => {
    let downloads = 0;
    const dispatch = createDispatcher({
      paseo: makeHarness().paseoRef,
      readValues: async () => baseValues({ chats: [] }),
      resolveCli: () => "/fake/lark-cli",
      readOpenId: async () => BOT,
      readRaw: async () => ({ image_key: "img_x" }),
      download: async () => {
        downloads += 1;
        return { bytes: Buffer.from("x"), extension: ".jpg" };
      },
      extractFrames: async () => [],
      reply: async () => null,
    });
    await dispatch.handleMessageEvent(
      groupEvent({ chat_id: "oc_unbound", message_type: "image", content: "", mentions: [] }),
    );
    await flush();
    assert.equal(downloads, 0);
  });

  it("routes permission notices to the agent's own topic", async () => {
    const h = makeHarness(baseValues({ notifyPermission: true }));
    await h.dispatch.handleMessageEvent(groupEvent({ message_id: "om_a", content: "@测试机器人 话题 A" }));
    await flush();
    await h.dispatch.handleMessageEvent(groupEvent({ message_id: "om_b", content: "话题 B", mentions: [] }));
    await flush();
    h.dispatch.handlePermission({
      agent: { id: h.agentId, workspaceId: null, parentAgentId: null, provider: "claude", cwd: "/tmp", title: null },
      request: { id: "req", provider: "claude", name: "Bash", kind: "tool", title: "执行命令" },
    });
    await flush();
    assert.equal(h.replies[h.replies.length - 1]?.messageId, "om_a");
  });
});
