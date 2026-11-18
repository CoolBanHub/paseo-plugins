import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandHelp, parseCommand, runCommand, type CommandContext } from "../server/commands.ts";
import { createCronScheduler } from "../server/cron.ts";
import { DEFAULT_BOT_VALUES, type ChatBinding } from "../shared/settings.ts";

const binding: ChatBinding = {
  chatId: "oc_group",
  chatName: "测试群",
  provider: "dsh",
  model: "",
  thinkingOptionId: "",
  permission: "",
  allowedUsers: [],
  cwd: "/tmp/project",
  systemPrompt: "",
  replyInstruction: "",
  replyRewrite: "off",
  rewriteProvider: "",
  rewriteModel: "",
  replyFormat: "markdown",
  mentionOnReply: "off",
  allowAgentDelegation: false,
  issueTracking: "off",
  issueAiClassify: true,
    issueAiStatusReview: true,
    issueAiProvider: "",
    issueAiModel: "",
  issueBaseToken: "",
  issueTableId: "",
  issueBaseUrl: "",
  issueReactionAccept: true,
  issueReactionEmojis: ["OK", "THUMBSUP", "THANKS", "DONE", "YES", "Yes", "CheckMark", "JIAYI"],
  issueAcceptRequester: true,
  issueAcceptUsers: [],
  issueActions: [],
  rewriteIgnoreStyle: false,
  rewriteInstruction: "",
};

function context(overrides: Partial<CommandContext> = {}) {
  const replies: string[] = [];
  const overridesPatch: Record<string, string>[] = [];
  const resets: boolean[] = [];
  const scheduler = createCronScheduler({ runJob: async () => undefined });
  const value: CommandContext = {
    command: { name: "help", args: "" },
    values: { ...DEFAULT_BOT_VALUES, chats: [binding] },
    binding,
    chatId: "oc_group",
    chatName: "测试群",
    topicKey: "om_root",
    senderId: "ou_user",
    overrides: {},
    session: {
      agentId: "agent-1",
      busy: false,
      queued: 2,
      provider: "dsh",
      model: "",
      permission: "",
      thinking: "",
      cwd: "/tmp/project",
      remaining: 19,
    },
    providers: {
      entries: [
        {
          provider: "dsh",
          models: [
            {
              id: "model-a",
              label: "A",
              isDefault: true,
              thinkingOptions: [{ id: "max", label: "最深" }],
            },
          ],
          modes: [],
        },
      ],
    },
    cron: scheduler,
    helperPath: "/tmp/lark-bot-send",
    attachmentMaxMb: 50,
    doctor: async () => "doctor ok",
    resetSession: ({ clearOverrides }) => resets.push(clearOverrides),
    stopQueue: () => 2,
    setOverrides: (patch) => overridesPatch.push(patch as Record<string, string>),
    reply: async (text) => {
      replies.push(text);
    },
    ...overrides,
  };
  return { value, replies, overridesPatch, resets, scheduler };
}

describe("command parsing", () => {
  it("maps Chinese aliases and keeps args", () => {
    assert.deepEqual(parseCommand("/模型 model-a"), { name: "model", args: "model-a" });
    assert.deepEqual(parseCommand("/cron add 0 6 * * * 总结"), {
      name: "cron",
      args: "add 0 6 * * * 总结",
    });
    assert.equal(parseCommand("hello"), null);
    assert.equal(parseCommand("/"), null);
  });

  it("documents the supported commands", () => {
    assert.match(commandHelp(), /\/status/);
    assert.match(commandHelp(), /\/cron add/);
  });
});

describe("command handlers", () => {
  it("reports status without consuming a turn", async () => {
    const h = context({ command: { name: "status", args: "" } });
    await runCommand(h.value);
    assert.match(h.replies[0] ?? "", /当前会话/);
    assert.match(h.replies[0] ?? "", /排队 2 条/);
    assert.match(h.replies[0] ?? "", /agent-1/);
  });

  it("sets a topic-level model and rebuilds the session", async () => {
    const h = context({ command: { name: "model", args: "model-a" } });
    await runCommand(h.value);
    assert.deepEqual(h.overridesPatch, [{ model: "model-a" }]);
    assert.deepEqual(h.resets, [false]);
    assert.match(h.replies[0] ?? "", /model-a/);
  });

  it("maps /mode to the dsh permission preset", async () => {
    const h = context({ command: { name: "mode", args: "workspace-write" } });
    await runCommand(h.value);
    assert.deepEqual(h.overridesPatch, [{ permission: "workspace-write" }]);
    assert.deepEqual(h.resets, [false]);
  });

  it("rejects an unknown model when a list is available", async () => {
    const h = context({ command: { name: "model", args: "nope" } });
    await runCommand(h.value);
    assert.deepEqual(h.overridesPatch, []);
    assert.match(h.replies[0] ?? "", /没有找到模型/);
  });

  it("creates and lists cron jobs", async () => {
    const h = context({ command: { name: "cron", args: "add 0 6 * * * 总结 GitHub" } });
    await runCommand(h.value);
    assert.equal(h.scheduler.list().length, 1);
    assert.match(h.replies[0] ?? "", /已创建定时任务/);

    const list = context({ command: { name: "cron", args: "list" }, cron: h.scheduler });
    await runCommand(list.value);
    assert.match(list.replies[0] ?? "", /总结 GitHub/);
  });

  it("clears the queue for /stop", async () => {
    const h = context({ command: { name: "stop", args: "" } });
    await runCommand(h.value);
    assert.match(h.replies[0] ?? "", /2 条排队消息/);
  });

  it("answers /doctor with the injected report", async () => {
    const h = context({ command: { name: "doctor", args: "" } });
    await runCommand(h.value);
    assert.equal(h.replies[0], "doctor ok");
  });

  it("lists group bots with an explicit bot marker and open_id", async () => {
    const h = context({
      command: { name: "bots", args: "" },
      listBots: async () => [{ openId: "ou_bot1", name: "OpsBot", appId: "cli_ops" }],
    });
    await runCommand(h.value);
    assert.match(h.replies[0] ?? "", /群内机器人（1）/);
    assert.match(h.replies[0] ?? "", /\[机器人\] OpsBot/);
    assert.match(h.replies[0] ?? "", /ou_bot1/);
    assert.match(h.replies[0] ?? "", /<at user_id/);
  });

  it("searches users and bots with /members", async () => {
    const h = context({
      command: { name: "members", args: "张" },
      listMembers: async () => [
        { openId: "ou_zhang", name: "张三", kind: "user" },
        { openId: "ou_bot1", name: "OpsBot", kind: "bot", appId: "cli_ops" },
      ],
    });
    await runCommand(h.value);
    assert.match(h.replies[0] ?? "", /群成员（2）/);
    assert.match(h.replies[0] ?? "", /\[成员\] 张三/);
    assert.match(h.replies[0] ?? "", /\[机器人\] OpsBot/);
    assert.match(h.replies[0] ?? "", /ou_zhang/);
    assert.match(h.replies[0] ?? "", /\[\[@名字\]\]/);
  });

  it("requires the binding toggle before listing or delegating agents", async () => {
    const h = context({ command: { name: "agents", args: "" } });
    await runCommand(h.value);
    assert.match(h.replies[0] ?? "", /未开启 Agent 委派/);

    const delegate = context({ command: { name: "delegate", args: "agent-2 做点事" } });
    await runCommand(delegate.value);
    assert.match(delegate.replies[0] ?? "", /未开启 Agent 委派/);
  });

  it("lists delegatable Paseo agents and resolves a short id", async () => {
    const agents = [
      { id: "aaaaaaaa-1111-2222", title: "修复登录", provider: "dsh", model: "m", status: "idle" },
      { id: "bbbbbbbb-3333-4444", title: "代码审查", provider: "codex", status: "running" },
    ];
    const h = context({
      command: { name: "agents", args: "" },
      binding: { ...binding, allowAgentDelegation: true },
      listAgents: async () => agents,
    });
    await runCommand(h.value);
    assert.match(h.replies[0] ?? "", /可委派的 Paseo Agent（2）/);
    assert.match(h.replies[0] ?? "", /aaaaaaaa/);
    assert.match(h.replies[0] ?? "", /修复登录/);

    let seen: { id: string; task: string } | null = null;
    const delegate = context({
      command: { name: "delegate", args: "aaaaaaaa 帮我跑测试" },
      binding: { ...binding, allowAgentDelegation: true },
      listAgents: async () => agents,
      delegateAgent: async (id, task) => {
        seen = { id, task };
        return { status: "idle", error: null, lastMessage: "测试全部通过" };
      },
    });
    await runCommand(delegate.value);
    assert.deepEqual(seen, { id: "aaaaaaaa-1111-2222", task: "帮我跑测试" });
    assert.match(delegate.replies[0] ?? "", /已把任务交给/);
    assert.match(delegate.replies.at(-1) ?? "", /测试全部通过/);
  });

  it("reports a delegated agent waiting for permission", async () => {
    const h = context({
      command: { name: "delegate", args: "agent-2 跑一下" },
      binding: { ...binding, allowAgentDelegation: true },
      listAgents: async () => [{ id: "agent-2", title: "Ops", provider: "dsh", status: "idle" }],
      delegateAgent: async () => ({ status: "permission", error: null, lastMessage: null }),
    });
    await runCommand(h.value);
    assert.match(h.replies.at(-1) ?? "", /等待权限确认/);
  });

  it("routes /issues filters and /issue actions to the ledger", async () => {
    const calls: string[] = [];
    const issue = {
      query: async (filter: string) => {
        calls.push(`query:${filter}`);
        return `list:${filter}`;
      },
      status: async () => "status",
      done: async (summary: string) => {
        calls.push(`done:${summary}`);
        return "done";
      },
      release: async () => "release",
      close: async (reason: string) => {
        calls.push(`close:${reason}`);
        return "close";
      },
      type: async (type: string) => {
        calls.push(`type:${type}`);
        return "type";
      },
      track: async () => {
        calls.push("track");
        return "track";
      },
    };
    const issues = context({ command: { name: "issues", args: "pending" }, issue });
    await runCommand(issues.value);
    assert.equal(issues.replies[0], "list:pending");

    const done = context({ command: { name: "issue", args: "done 已改完" }, issue });
    await runCommand(done.value);
    assert.equal(done.replies[0], "done");

    const close = context({ command: { name: "issue", args: "close 重复问题" }, issue });
    await runCommand(close.value);
    assert.equal(close.replies[0], "close");

    const type = context({ command: { name: "issue", args: "type 需求" }, issue });
    await runCommand(type.value);
    assert.equal(type.replies[0], "type");

    const track = context({ command: { name: "issue", args: "track" }, issue });
    await runCommand(track.value);
    assert.equal(track.replies[0], "track");
    assert.deepEqual(calls, ["query:pending", "done:已改完", "close:重复问题", "type:需求", "track"]);

    const missing = context({ command: { name: "issues", args: "" } });
    await runCommand(missing.value);
    assert.match(missing.replies[0] ?? "", /还没有启用问题跟踪/);
  });
});

describe("memory commands", () => {
  it("routes /remember, /memory and /forget to the store", async () => {
    const calls: string[] = [];
    const memory = {
      remember: (text: string) => {
        calls.push(`remember:${text}`);
        return "已记住 #1：先说结论";
      },
      list: () => {
        calls.push("list");
        return "**本会话记忆（1 条）**\n#1 · 2026-11-17 · 先说结论";
      },
      forget: (target: string) => {
        calls.push(`forget:${target}`);
        return "已删除 #1";
      },
    };

    const remember = context({
      command: { name: "remember", args: "先说结论" },
      memory,
    });
    await runCommand(remember.value);
    assert.match(remember.replies[0] ?? "", /已记住/);

    const list = context({ command: { name: "memory", args: "" }, memory });
    await runCommand(list.value);
    assert.match(list.replies[0] ?? "", /本会话记忆/);

    const forget = context({ command: { name: "forget", args: "1" }, memory });
    await runCommand(forget.value);
    assert.match(forget.replies[0] ?? "", /已删除/);

    assert.deepEqual(calls, ["remember:先说结论", "list", "forget:1"]);
  });

  it("explains when memory is unavailable or the rule is empty", async () => {
    const unavailable = context({ command: { name: "memory", args: "" } });
    await runCommand(unavailable.value);
    assert.match(unavailable.replies[0] ?? "", /没有配置会话记忆/);

    const empty = context({
      command: { name: "remember", args: "" },
      memory: {
        remember: () => "",
        list: () => "",
        forget: () => "",
      },
    });
    await runCommand(empty.value);
    assert.match(empty.replies[0] ?? "", /用法/);
  });
});

describe("collab commands", () => {
  const mentions = [{ openId: "ou_a", name: "张三" }];

  function collabActions(overrides: Partial<{
    enabled: boolean;
    isOwner: boolean;
    isGroup: boolean;
    status: () => string;
    open: (input: { guests: { openId: string; name: string }[]; hours: number; scope: string }) => Promise<string>;
    close: () => string;
  }> = {}) {
    return {
      enabled: true,
      isOwner: true,
      isGroup: true,
      status: () => "本话题没有进行中的协作。",
      open: async () => "已开启协作",
      close: () => "已关闭协作",
      ...overrides,
    };
  }

  it("parses guests, duration and scope and opens collaboration", async () => {
    const opened: { guests: { openId: string; name: string }[]; hours: number; scope: string }[] = [];
    const h = context({
      command: { name: "collab", args: "open 2d 只看本话题进度" },
      mentions,
      collab: collabActions({
        open: async (input) => {
          opened.push(input);
          return "已开启协作";
        },
      }),
    });
    await runCommand(h.value);
    assert.deepEqual(opened[0], {
      guests: [{ openId: "ou_a", name: "张三" }],
      hours: 48,
      scope: "只看本话题进度",
    });
    assert.match(h.replies[0] ?? "", /已开启协作/);
  });

  it("defaults to 24 hours and caps the duration at 72", async () => {
    const hours: number[] = [];
    const make = (args: string) =>
      context({
        command: { name: "collab", args },
        mentions,
        collab: collabActions({
          open: async (input) => {
            hours.push(input.hours);
            return "ok";
          },
        }),
      });
    await runCommand(make("open").value);
    await runCommand(make("open 9d").value);
    assert.deepEqual(hours, [24, 72]);
  });

  it("refuses when disabled, when not the owner, or without mentions", async () => {
    const disabled = context({
      command: { name: "collab", args: "open 1h" },
      mentions,
      collab: collabActions({ enabled: false }),
    });
    await runCommand(disabled.value);
    assert.match(disabled.replies[0] ?? "", /管理员未开启协作/);

    const notOwner = context({
      command: { name: "collab", args: "open 1h" },
      mentions,
      collab: collabActions({ isOwner: false }),
    });
    await runCommand(notOwner.value);
    assert.match(notOwner.replies[0] ?? "", /只有本话题的发起人/);

    const noMentions = context({
      command: { name: "collab", args: "open 1h" },
      collab: collabActions(),
    });
    await runCommand(noMentions.value);
    assert.match(noMentions.replies[0] ?? "", /@ 至少一位访客/);
  });

  it("reports status and closes for the owner", async () => {
    const status = context({
      command: { name: "collab", args: "" },
      collab: collabActions({ status: () => "协作进行中" }),
    });
    await runCommand(status.value);
    assert.equal(status.replies[0], "协作进行中");

    const close = context({
      command: { name: "collab", args: "close" },
      collab: collabActions(),
    });
    await runCommand(close.value);
    assert.equal(close.replies[0], "已关闭协作");
  });

  it("documents the new commands in /help", () => {
    assert.match(commandHelp(), /\/remember/);
    assert.match(commandHelp(), /\/collab/);
  });
});
