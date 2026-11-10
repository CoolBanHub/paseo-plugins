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
  replyFormat: "markdown",
  mentionOnReply: "off",
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
});
