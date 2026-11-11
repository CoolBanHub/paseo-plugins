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
  replyStyle: "default",
  replyStylePrompt: "",
  replyRewrite: "off",
  rewriteProvider: "",
  rewriteModel: "",
  replyFormat: "markdown",
  mentionOnReply: "off",
  allowAgentDelegation: false,
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
});
