import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  clip,
  condenseReply,
  displayPath,
  formatDuration,
  formatPermissionMessage,
  formatTurnEndMessage,
  projectName,
  summarizeTimeline,
} from "../server/format.ts";
import { resolveLarkCli } from "../server/lark.ts";
import { createNotifier } from "../server/notifier.ts";
import { DEFAULT_NOTIFY_VALUES } from "../server/settings.ts";

const agent = {
  id: "agent-1",
  workspaceId: "ws-1",
  parentAgentId: null,
  provider: "claude",
  cwd: "/Users/me/Workspace/github.com/CoolBanHub/paseo-plugins",
  title: "修复登录按钮",
};

const request = {
  id: "req-1",
  provider: "claude",
  name: "Bash",
  kind: "tool",
  title: "Claude 想运行命令",
  description: "需要执行测试命令",
  detail: { type: "shell", command: "npm test" },
  actions: [
    { label: "允许一次", behavior: "allow" },
    { label: "拒绝", behavior: "deny" },
  ],
};

const completedSession = {
  outcome: "completed" as const,
  turns: 3,
  durationMs: 125_000,
  lastText: "已修复登录按钮并补了测试",
  lastAction: "Bash · 执行命令：npm test",
  lastError: null,
};

interface Sent {
  openId: string;
  text: string;
  identity: string;
}

function fixture(values: Partial<typeof DEFAULT_NOTIFY_VALUES> = {}) {
  const sent: Sent[] = [];
  const notifier = createNotifier({
    readValues: async () => ({ ...DEFAULT_NOTIFY_VALUES, ...values }),
    resolveCli: () => "/tmp/lark-cli",
    readOpenId: async () => "ou_test",
    send: async (payload) => {
      sent.push({ openId: payload.openId, text: payload.text, identity: payload.identity });
      return "om_1";
    },
    log: () => {},
  });
  return { notifier, sent };
}

test("projectName keeps owner/repo for git host paths", () => {
  assert.equal(projectName("/Users/me/Workspace/github.com/CoolBanHub/paseo-plugins"), "CoolBanHub/paseo-plugins");
  assert.equal(projectName("/Users/me/work/paseo-plugins"), "paseo-plugins");
  assert.match(displayPath(join(homedir(), "Workspace/paseo-plugins")), /^~/);
});

test("formatDuration renders minutes and seconds", () => {
  assert.equal(formatDuration(125_000), "2 分 5 秒");
  assert.equal(formatDuration(9_000), "9 秒");
  assert.equal(formatDuration(3_900_000), "1 小时 5 分");
});

test("permission message explains project, session, detail and choices", () => {
  const text = formatPermissionMessage(agent, request);
  assert.match(text, /需要你确认/);
  assert.match(text, /\*\*项目\*\*：CoolBanHub\/paseo-plugins/);
  assert.match(text, /\*\*会话\*\*：修复登录按钮（claude）/);
  assert.match(text, /\*\*请求\*\*：Claude 想运行命令/);
  assert.match(text, /\*\*详情\*\*：执行命令：npm test/);
  assert.match(text, /\*\*说明\*\*：需要执行测试命令/);
  assert.match(text, /\*\*可选\*\*：允许一次 \/ 拒绝/);
});

test("permission message falls back to input keys", () => {
  const text = formatPermissionMessage(agent, {
    name: "Write",
    kind: "tool",
    input: { file_path: "/tmp/notes.md", content: "hello" },
  });
  assert.match(text, /\*\*请求\*\*：使用工具 Write/);
  assert.match(text, /\/tmp\/notes\.md/);
});

test("turn message reports project, outcome, reply and action", () => {
  const text = formatTurnEndMessage(agent, completedSession);
  assert.match(text, /本轮任务完成/);
  assert.match(text, /\*\*项目\*\*：CoolBanHub\/paseo-plugins/);
  assert.match(text, /\*\*会话\*\*：修复登录按钮（claude，第 3 轮）/);
  assert.match(text, /\*\*结果\*\*：已完成/);
  assert.match(text, /\*\*最后回复\*\*：已修复登录按钮并补了测试/);
  assert.match(text, /\*\*最后动作\*\*：Bash · 执行命令：npm test/);
  assert.match(text, /\*\*目录\*\*：/);
});

test("failed turns surface the error", () => {
  const text = formatTurnEndMessage(agent, {
    ...completedSession,
    outcome: "failed",
    lastError: "provider crashed",
  });
  assert.match(text, /\*\*结果\*\*：失败：provider crashed/);
});

test("summarizeTimeline picks the latest reply and tool action", () => {
  const summary = summarizeTimeline([
    { type: "user_message", text: "修一下" },
    { type: "assistant_message", text: "先跑测试" },
    { type: "tool_call", name: "Bash", detail: { type: "shell", command: "npm test" } },
    { type: "assistant_message", text: "改好了" },
  ]);
  assert.equal(summary.lastText, "改好了");
  assert.equal(summary.lastAction, "Bash · 执行命令：npm test");
});

test("summarizeTimeline ignores blank assistant messages", () => {
  const summary = summarizeTimeline([{ type: "assistant_message", text: "   " }]);
  assert.equal(summary.lastText, null);
});

test("condenseReply drops English reasoning around a Chinese answer", () => {
  const raw =
    'The user asks: reply only with this sentence: "已完成文案验证。" So I should just reply exactly that, no tools.已完成文案验证。';
  assert.equal(condenseReply(raw), "已完成文案验证。");
});

test("condenseReply keeps the last two Chinese sentences", () => {
  assert.equal(condenseReply("已修改 A。已补测试。测试通过。"), "已补测试。测试通过。");
});

test("condenseReply clips long English replies from the start", () => {
  const long = "word ".repeat(100);
  const result = condenseReply(long, 20);
  assert.ok(result.startsWith("word"));
  assert.ok(result.endsWith("…"));
});

test("clip flattens whitespace and truncates long values", () => {
  assert.equal(clip("a\n  b\tc"), "a b c");
  const long = "x".repeat(50);
  assert.equal(clip(long, 10), "x".repeat(9) + "…");
});

test("resolveLarkCli prefers explicit config, then PATH, then nvm", () => {
  const root = mkdtempSync(join(tmpdir(), "lark-notify-"));
  const explicit = join(root, "explicit-lark");
  writeFileSync(explicit, "#!/bin/sh\n");
  chmodSync(explicit, 0o755);
  assert.equal(resolveLarkCli(explicit, { PATH: "" }, root), explicit);

  const binDir = join(root, "bin");
  mkdirSync(binDir);
  const onPath = join(binDir, "lark-cli");
  writeFileSync(onPath, "#!/bin/sh\n");
  chmodSync(onPath, 0o755);
  assert.equal(resolveLarkCli("", { PATH: binDir }, root), onPath);

  const nvmBin = join(root, ".nvm", "versions", "node", "v22.0.0", "bin");
  mkdirSync(nvmBin, { recursive: true });
  const underNvm = join(nvmBin, "lark-cli");
  writeFileSync(underNvm, "#!/bin/sh\n");
  chmodSync(underNvm, 0o755);
  assert.equal(resolveLarkCli("", { PATH: "" }, root), underNvm);
});

test("sends one DM per permission request and dedupes repeats", async () => {
  const { notifier, sent } = fixture();
  await notifier.handlePermission({ agent, request } as never);
  await notifier.handlePermission({ agent, request } as never);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.openId, "ou_test");
  assert.equal(sent[0]?.identity, "bot");
  assert.match(sent[0]?.text || "", /\*\*详情\*\*：执行命令：npm test/);
});

test("honours the permission toggle", async () => {
  const { notifier, sent } = fixture({ notifyPermission: false });
  await notifier.handlePermission({ agent, request } as never);
  assert.equal(sent.length, 0);
});

test("sends one notification when a turn ends, while the agent stays available", async () => {
  const { notifier, sent } = fixture();
  notifier.handleCreated({ agent } as never);
  await notifier.handleTurnEnded({
    agent,
    outcome: { kind: "completed" },
    timeline: [{ type: "assistant_message", text: "已经修复并验证" }],
  } as never);
  assert.equal(sent.length, 1);
  assert.match(sent[0]?.text || "", /本轮任务完成/);
  assert.match(sent[0]?.text || "", /第 1 轮/);
  assert.match(sent[0]?.text || "", /\*\*结果\*\*：已完成/);
  assert.match(sent[0]?.text || "", /\*\*最后回复\*\*：已经修复并验证/);
  await notifier.handleTurnEnded({
    agent,
    outcome: { kind: "completed" },
    timeline: [{ type: "assistant_message", text: "第二轮也完成" }],
  } as never);
  assert.equal(sent.length, 2);
  assert.match(sent[1]?.text || "", /第 2 轮/);
  assert.match(sent[1]?.text || "", /第二轮也完成/);
});

test("skips child agents unless includeSubagents is set", async () => {
  const child = { ...agent, id: "agent-child", parentAgentId: "agent-1" };
  const quiet = fixture();
  quiet.notifier.handleCreated({ agent: child } as never);
  await quiet.notifier.handleTurnEnded({ agent: child, outcome: { kind: "completed" }, timeline: [] } as never);
  assert.equal(quiet.sent.length, 0);

  const loud = fixture({ includeSubagents: true });
  loud.notifier.handleCreated({ agent: child } as never);
  await loud.notifier.handleTurnEnded({ agent: child, outcome: { kind: "completed" }, timeline: [] } as never);
  assert.equal(loud.sent.length, 1);
});

test("honours the turn-completion notification toggle", async () => {
  const { notifier, sent } = fixture({ notifySessionEnd: false });
  await notifier.handleTurnEnded({ agent, outcome: { kind: "completed" }, timeline: [] } as never);
  assert.equal(sent.length, 0);
});

test("resolves the recipient from lark-cli when openId is empty", async () => {
  const { notifier, sent } = fixture({ openId: "" });
  await notifier.handlePermission({ agent, request } as never);
  assert.equal(sent[0]?.openId, "ou_test");
});
