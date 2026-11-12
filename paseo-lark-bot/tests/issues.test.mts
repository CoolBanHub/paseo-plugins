import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  classifyIssueType,
  createIssueTracker,
  formatIssueList,
  ISSUE_FIELD_NAMES,
  issueRecordUrl,
} from "../server/issues.ts";
import { buildIssueCard, parseIssueAction } from "../server/issue-card.ts";
import type { LarkMessageEvent } from "../server/lark-events.ts";
import { DEFAULT_BOT_VALUES, type BotValues, type ChatBinding } from "../shared/settings.ts";
import type { LarkPayload } from "../server/lark.ts";

const BOT = "ou_bot";
const USER = "ou_user";
const CHAT = "oc_group";
const THREAD = "omt_topic_1";
const ROOT = "om_root_1";

function binding(overrides: Partial<ChatBinding> = {}): ChatBinding {
  return {
    chatId: CHAT,
    chatName: "电竞需求",
    provider: "dsh",
    model: "",
    thinkingOptionId: "",
    permission: "",
    allowedUsers: [],
    cwd: "/tmp",
    systemPrompt: "",
    replyStyle: "default",
    replyStylePrompt: "",
    replyRewrite: "off",
    rewriteProvider: "",
    rewriteModel: "",
    replyFormat: "markdown",
    mentionOnReply: "off",
    allowAgentDelegation: false,
    rewriteIgnoreStyle: false,
    issueTracking: "auto",
    issueBaseToken: "bascnTest",
    issueTableId: "tblTest",
    issueBaseUrl: "https://example.feishu.cn/base/bascnTest",
    issueReactionAccept: true,
    issueReactionEmojis: ["OK", "THUMBSUP", "THANKS", "DONE", "YES", "Yes", "CheckMark", "JIAYI"],
    issueAcceptRequester: true,
  issueAcceptUsers: [],
    ...overrides,
  };
}

function values(overrides: Partial<BotValues> = {}): BotValues {
  return {
    ...DEFAULT_BOT_VALUES,
    chats: [binding()],
    ...overrides,
  };
}

function rootEvent(overrides: Partial<LarkMessageEvent> = {}): LarkMessageEvent {
  return {
    chat_id: CHAT,
    chat_type: "group",
    content: "登录后偶发闪退，麻烦看下",
    message_id: ROOT,
    message_type: "text",
    sender_id: USER,
    sender_type: "user",
    thread_id: THREAD,
    ...overrides,
  };
}

function replyEvent(overrides: Partial<LarkMessageEvent> = {}): LarkMessageEvent {
  return {
    chat_id: CHAT,
    chat_type: "group",
    content: "补充：只在安卓上出现",
    message_id: "om_reply_1",
    message_type: "text",
    sender_id: USER,
    sender_type: "user",
    root_id: ROOT,
    thread_id: THREAD,
    ...overrides,
  };
}

function fakeRun(handler?: (args: string[]) => LarkPayload): {
  run: (cliPath: string, args: string[], label: string) => Promise<LarkPayload>;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    run: async (_cliPath, args) => {
      calls.push(args);
      return handler?.(args) ?? { ok: true, data: {} };
    },
  };
}

function updates(calls: string[][]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const args of calls) {
    if (!args.includes("+record-batch-update")) continue;
    const index = args.indexOf("--json");
    const raw = index >= 0 ? args[index + 1] : undefined;
    if (!raw) continue;
    const parsed = JSON.parse(raw) as { update_records?: Record<string, Record<string, unknown>> };
    for (const fields of Object.values(parsed.update_records ?? {})) result.push(fields);
  }
  return result;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timeout waiting for async issue work");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("issue type classifier", () => {
  it("separates problems, requirements and questions", () => {
    assert.equal(classifyIssueType("登录后偶发闪退"), "问题");
    assert.equal(classifyIssueType("减少余额100元显示余额不足"), "问题");
    assert.equal(classifyIssueType("组队单群聊老板信息后面加个老板提示"), "需求");
    assert.equal(classifyIssueType("客服页面新增【发送】按钮"), "需求");
    assert.equal(classifyIssueType("这个功能怎么用？"), "咨询");
  });
});

describe("issue tracker", () => {
  it("records a new topic root without starting an agent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lark-issue-"));
    try {
      const fake = fakeRun((args) => {
        if (args.includes("+record-list")) {
          return { ok: true, data: { fields: [], data: [], record_id_list: [] } };
        }
        if (args.includes("+record-batch-create")) {
          return { ok: true, data: { record_id_list: ["rec_1"] } };
        }
        return { ok: true, data: {} };
      });
      const tracker = createIssueTracker({
        readValues: async () => values(),
        storePath: join(dir, "records.json"),
        baseStorePath: join(dir, "base.json"),
        run: fake.run,
      });
      tracker.observe(rootEvent(), binding(), values());
      await waitFor(() => tracker.recordForTopic(CHAT, THREAD) !== null);
      const record = tracker.recordForTopic(CHAT, THREAD);
      assert.equal(record?.recordId, "rec_1");
      assert.equal(record?.status, "待处理");
      assert.equal(record?.requesterOpenId, USER);
      const create = fake.calls.find((args) => args.includes("+record-batch-create"));
      assert.ok(create);
      const raw = create[create.indexOf("--json") + 1]!;
      assert.match(raw, /登录后偶发闪退/);
      assert.match(raw, /"话题ID":"omt_topic_1"/);
      assert.match(raw, /"类型":\["问题"\]/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not duplicate a record when the topic root is delivered twice", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lark-issue-"));
    try {
      const fake = fakeRun((args) => {
        if (args.includes("+record-list")) {
          return { ok: true, data: { fields: [], data: [], record_id_list: [] } };
        }
        if (args.includes("+record-batch-create")) {
          return { ok: true, data: { record_id_list: ["rec_1"] } };
        }
        return { ok: true, data: {} };
      });
      const tracker = createIssueTracker({
        readValues: async () => values(),
        storePath: join(dir, "records.json"),
        baseStorePath: join(dir, "base.json"),
        run: fake.run,
      });
      tracker.observe(rootEvent(), binding(), values());
      await waitFor(() => tracker.recordForTopic(CHAT, THREAD) !== null);
      tracker.observe(rootEvent(), binding(), values());
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(fake.calls.filter((args) => args.includes("+record-batch-create")).length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts from the Base status even when the local mapping is stale", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lark-issue-"));
    try {
      const fake = fakeRun((args) => {
        if (args.includes("+record-list")) {
          return { ok: true, data: { fields: [], data: [], record_id_list: [] } };
        }
        if (args.includes("+record-batch-create")) {
          return { ok: true, data: { record_id_list: ["rec_1"] } };
        }
        if (args.includes("+record-get")) {
          return { ok: true, data: { fields: ["状态"], data: [["待验收"]], record_id_list: ["rec_1"] } };
        }
        return { ok: true, data: {} };
      });
      const tracker = createIssueTracker({
        readValues: async () => values(),
        storePath: join(dir, "records.json"),
        baseStorePath: join(dir, "base.json"),
        run: fake.run,
      });
      tracker.observe(rootEvent(), binding(), values());
      await waitFor(() => tracker.recordForTopic(CHAT, THREAD) !== null);
      // Local mapping is still 待处理; the Base already says 待验收.
      const accepted = await tracker.accept("rec_1", USER, values());
      assert.equal(accepted?.status, "已修复");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("moves 待处理 → 处理中 → 待验收 → 已修复 → 已发布", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lark-issue-"));
    try {
      const fake = fakeRun((args) => {
        if (args.includes("+record-list")) {
          return { ok: true, data: { fields: [], data: [], record_id_list: [] } };
        }
        if (args.includes("+record-batch-create")) {
          return { ok: true, data: { record_id_list: ["rec_1"] } };
        }
        if (args.includes("+record-get")) {
          return { ok: true, data: { fields: ["状态"], data: [["待验收"]], record_id_list: ["rec_1"] } };
        }
        return { ok: true, data: {} };
      });
      const tracker = createIssueTracker({
        readValues: async () => values(),
        storePath: join(dir, "records.json"),
        baseStorePath: join(dir, "base.json"),
        run: fake.run,
      });
      tracker.observe(rootEvent(), binding(), values());
      await waitFor(() => tracker.recordForTopic(CHAT, THREAD) !== null);

      tracker.markWorking(rootEvent(), binding(), values());
      await waitFor(() => tracker.recordForTopic(CHAT, THREAD)?.status === "处理中");

      const done = await tracker.markDone({
        chatId: CHAT,
        topicKey: THREAD,
        summary: "已修复会话恢复逻辑",
        values: values(),
      });
      assert.equal(done?.status, "待验收");

      const accepted = await tracker.accept("rec_1", USER, values());
      assert.equal(accepted?.status, "已修复");

      const released = await tracker.release("rec_1", USER, values());
      assert.equal(released?.status, "已发布");

      const statuses = updates(fake.calls).map((fields) => fields["状态"]);
      assert.deepEqual(statuses, [["处理中"], ["待验收"], ["已修复"], ["已发布"]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("moves a 待验收 record back to 处理中 when the topic is asked again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lark-issue-"));
    try {
      const fake = fakeRun((args) => {
        if (args.includes("+record-list")) {
          return { ok: true, data: { fields: [], data: [], record_id_list: [] } };
        }
        if (args.includes("+record-batch-create")) {
          return { ok: true, data: { record_id_list: ["rec_1"] } };
        }
        return { ok: true, data: {} };
      });
      const tracker = createIssueTracker({
        readValues: async () => values(),
        storePath: join(dir, "records.json"),
        baseStorePath: join(dir, "base.json"),
        run: fake.run,
      });
      tracker.observe(rootEvent(), binding(), values());
      await waitFor(() => tracker.recordForTopic(CHAT, THREAD) !== null);
      await tracker.markDone({
        chatId: CHAT,
        topicKey: THREAD,
        summary: "已改完",
        values: values(),
      });
      assert.equal(tracker.recordForTopic(CHAT, THREAD)?.status, "待验收");

      tracker.markWorking(rootEvent(), binding(), values());
      await waitFor(() => tracker.recordForTopic(CHAT, THREAD)?.status === "处理中");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not reopen a closed record when someone @s again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lark-issue-"));
    try {
      const fake = fakeRun((args) => {
        if (args.includes("+record-list")) {
          return { ok: true, data: { fields: [], data: [], record_id_list: [] } };
        }
        if (args.includes("+record-batch-create")) {
          return { ok: true, data: { record_id_list: ["rec_1"] } };
        }
        return { ok: true, data: {} };
      });
      const tracker = createIssueTracker({
        readValues: async () => values(),
        storePath: join(dir, "records.json"),
        baseStorePath: join(dir, "base.json"),
        run: fake.run,
      });
      tracker.observe(rootEvent(), binding(), values());
      await waitFor(() => tracker.recordForTopic(CHAT, THREAD) !== null);
      await tracker.close("rec_1", USER, "重复问题", values());
      tracker.markWorking(rootEvent(), binding(), values());
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(tracker.recordForTopic(CHAT, THREAD)?.status, "已关闭");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("parses a record list for /issues and builds a record URL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lark-issue-"));
    try {
      const fake = fakeRun((args) => {
        if (args.includes("+record-list")) {
          return {
            ok: true,
            data: {
              fields: ["标题", "状态", "类型", "最近进展", "最后活跃"],
              data: [["登录后偶发闪退", ["待验收"], ["问题"], "已修复，等待验收", "2026-11-11 15:40"]],
              record_id_list: ["rec_1"],
              has_more: false,
            },
          };
        }
        return { ok: true, data: {} };
      });
      const tracker = createIssueTracker({
        readValues: async () => values(),
        storePath: join(dir, "records.json"),
        baseStorePath: join(dir, "base.json"),
        run: fake.run,
      });
      const result = await tracker.query(CHAT, "pending", USER, values());
      assert.equal(result.error, null);
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0]?.status, "待验收");
      assert.match(formatIssueList(result, "pending"), /登录后偶发闪退/);
      assert.match(
        issueRecordUrl(
          { version: 1, baseToken: "bascnTest", tableId: "tblTest", baseUrl: "https://example.feishu.cn/base/bascnTest", name: "问题跟踪", createdAt: 0 },
          "rec_1",
        ),
        /record=rec_1/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates the ledger with the fixed schema and grants group access", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lark-issue-"));
    try {
      const fake = fakeRun((args) => {
        if (args.includes("+base-create")) {
          return {
            ok: true,
            data: {
              base: { base_token: "bascnNew", url: "https://example.feishu.cn/base/bascnNew" },
              table: { id: "tblNew" },
            },
          };
        }
        return { ok: true, data: {} };
      });
      const tracker = createIssueTracker({
        readValues: async () =>
          values({
            chats: [binding({ issueBaseToken: "", issueTableId: "", issueBaseUrl: "" })],
          }),
        storePath: join(dir, "records.json"),
        baseStorePath: join(dir, "base.json"),
        run: fake.run,
      });
      const config = await tracker.createBase(values(), [CHAT]);
      assert.equal(config.baseToken, "bascnNew");
      assert.equal(config.tableId, "tblNew");
      const create = fake.calls.find((args) => args.includes("+base-create"));
      assert.ok(create);
      const fields = create[create.indexOf("--fields") + 1]!;
      for (const name of ISSUE_FIELD_NAMES) assert.match(fields, new RegExp(name));
      assert.match(fields, /已发布/);
      assert.ok(fake.calls.some((args) => args.includes("+member-add") && args.includes(CHAT)));

      const empty = values({
        chats: [binding({ issueBaseToken: "", issueTableId: "", issueBaseUrl: "" })],
      });
      assert.equal((await tracker.config(CHAT, empty))?.baseToken, "bascnNew");
      tracker.forgetBase(CHAT);
      assert.equal(await tracker.config(CHAT, empty), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("backfills only empty types and leaves manual ones alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lark-issue-"));
    try {
      let update: Record<string, Record<string, unknown>> | null = null;
      const fake = fakeRun((args) => {
        if (args.includes("+record-list")) {
          return {
            ok: true,
            data: {
              fields: ["标题", "类型"],
              data: [
                ["登录后偶发闪退", []],
                ["加个导出按钮", ["需求"]],
                ["余额不足无法支付", []],
              ],
              record_id_list: ["rec_1", "rec_2", "rec_3"],
              has_more: false,
            },
          };
        }
        if (args.includes("+record-batch-update")) {
          const raw = args[args.indexOf("--json") + 1]!;
          update = (JSON.parse(raw) as { update_records: Record<string, Record<string, unknown>> })
            .update_records;
          return { ok: true, data: {} };
        }
        return { ok: true, data: {} };
      });
      const tracker = createIssueTracker({
        readValues: async () => values(),
        storePath: join(dir, "records.json"),
        baseStorePath: join(dir, "bases.json"),
        run: fake.run,
      });
      const count = await tracker.backfillTypes(values(), CHAT);
      assert.equal(count, 2);
      assert.deepEqual(update, {
        rec_1: { 类型: ["问题"] },
        rec_3: { 类型: ["问题"] },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses each chat's own Base and keeps old records on their original Base", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lark-issue-"));
    try {
      const fake = fakeRun((args) => {
        if (args.includes("+record-list")) {
          return { ok: true, data: { fields: [], data: [], record_id_list: [] } };
        }
        if (args.includes("+record-batch-create")) {
          return { ok: true, data: { record_id_list: ["rec_1"] } };
        }
        return { ok: true, data: {} };
      });
      const tracker = createIssueTracker({
        readValues: async () => values(),
        storePath: join(dir, "records.json"),
        baseStorePath: join(dir, "bases.json"),
        run: fake.run,
      });
      tracker.observe(rootEvent(), binding(), values());
      await waitFor(() => tracker.recordForTopic(CHAT, THREAD) !== null);

      const other = values({
        chats: [
          binding({
            issueBaseToken: "bascnOther",
            issueTableId: "tblOther",
            issueBaseUrl: "https://example.feishu.cn/base/bascnOther",
            issueReactionAccept: true,
            issueReactionEmojis: ["OK", "THUMBSUP", "THANKS", "DONE", "YES", "Yes", "CheckMark", "JIAYI"],
            issueAcceptRequester: true,
  issueAcceptUsers: [],
          }),
        ],
      });
      const config = await tracker.config(CHAT, other);
      assert.equal(config?.baseToken, "bascnOther");

      await tracker.markDone({
        chatId: CHAT,
        topicKey: THREAD,
        summary: "已改完",
        values: other,
      });
      const update = fake.calls.find((args) => args.includes("+record-batch-update"));
      assert.ok(update);
      assert.ok(update.includes("bascnTest"));
      assert.ok(!update.includes("bascnOther"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("issue card", () => {
  it("builds accept/reject callbacks and parses them", () => {
    const record = {
      recordId: "rec_1",
      chatId: CHAT,
      rootMessageId: ROOT,
      threadId: THREAD,
      requesterOpenId: USER,
      title: "登录后偶发闪退",
      status: "待验收" as const,
      baseToken: "bascnTest",
      tableId: "tblTest",
      lastActiveAt: 1,
      messageCount: 1,
      updatedAt: 1,
    };
    const card = buildIssueCard({ record, summary: "已修复", topicKey: THREAD });
    const body = card.body as { elements: Array<Record<string, unknown>> };
    const actions = body.elements.find((element) => element.tag === "action") as {
      actions: Array<{ behaviors: Array<{ value: unknown }> }>;
    };
    const values = actions.actions.map((action) => action.behaviors[0]?.value);
    assert.equal(values.length, 2);
    const accept = parseIssueAction(JSON.stringify(values[0]));
    assert.equal(accept?.action, "accept");
    assert.equal(accept?.recordId, "rec_1");
    assert.equal(accept?.topicKey, THREAD);
    assert.equal(parseIssueAction("not-json"), null);
    assert.equal(parseIssueAction(JSON.stringify({ kind: "issue", action: "release" })), null);
  });
});
