import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clip, formatPermissionMessage, formatSessionEndMessage } from "../server/format.ts";
import { resolveLarkCli } from "../server/lark.ts";
import { createNotifier } from "../server/notifier.ts";
import { DEFAULT_NOTIFY_VALUES } from "../server/settings.ts";

const agent = {
  id: "agent-1",
  workspaceId: "ws-1",
  parentAgentId: null,
  provider: "claude",
  cwd: "/Users/me/Workspace/paseo-plugins",
  title: "修复登录按钮",
};

const request = {
  id: "req-1",
  provider: "claude",
  name: "Bash",
  kind: "tool",
  title: "运行 npm test",
  description: "需要执行测试命令",
};

interface Sent {
  openId: string;
  text: string;
  identity: string;
}

function fixture(
  values: Partial<typeof DEFAULT_NOTIFY_VALUES> = {},
  options: { now?: () => number; warmupMs?: number } = {},
) {
  const sent: Sent[] = [];
  const notifier = createNotifier({
    readValues: async () => ({ ...DEFAULT_NOTIFY_VALUES, ...values }),
    resolveCli: () => "/tmp/lark-cli",
    readOpenId: async () => "ou_test",
    send: async (payload) => {
      sent.push({ openId: payload.openId, text: payload.text, identity: payload.identity });
      return "om_1";
    },
    now: options.now || (() => 1000),
    warmupMs: options.warmupMs === undefined ? 0 : options.warmupMs,
    log: () => {},
  });
  return { notifier, sent };
}

test("formats a permission message with project, provider, title and description", () => {
  const text = formatPermissionMessage(agent, request);
  assert.match(text, /需要你确认/);
  assert.match(text, /paseo-plugins/);
  assert.match(text, /claude/);
  assert.match(text, /运行 npm test/);
  assert.match(text, /需要执行测试命令/);
});

test("falls back to the request input when there is no description", () => {
  const text = formatPermissionMessage(agent, {
    name: "Bash",
    kind: "tool",
    input: { command: "npm test" },
  });
  assert.match(text, /npm test/);
});

test("formats a session-end message", () => {
  const text = formatSessionEndMessage(agent);
  assert.match(text, /会话结束/);
  assert.match(text, /paseo-plugins/);
  assert.match(text, /修复登录按钮/);
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
  assert.match(sent[0]?.text || "", /运行 npm test/);
});

test("honours the permission toggle", async () => {
  const { notifier, sent } = fixture({ notifyPermission: false });
  await notifier.handlePermission({ agent, request } as never);
  assert.equal(sent.length, 0);
});

test("notifies when a session closes", async () => {
  const { notifier, sent } = fixture();
  await notifier.handleClosed({ agent } as never);
  assert.equal(sent.length, 1);
  assert.match(sent[0]?.text || "", /会话结束/);
});

test("skips child agents unless includeSubagents is set", async () => {
  const child = { ...agent, id: "agent-child", parentAgentId: "agent-1" };
  const quiet = fixture();
  await quiet.notifier.handleClosed({ agent: child } as never);
  assert.equal(quiet.sent.length, 0);

  const loud = fixture({ includeSubagents: true });
  await loud.notifier.handleClosed({ agent: child } as never);
  assert.equal(loud.sent.length, 1);
});

test("stays quiet during the startup warmup window", async () => {
  let clock = 1000;
  const { notifier, sent } = fixture({}, { now: () => clock, warmupMs: 60_000 });
  await notifier.handleClosed({ agent } as never);
  assert.equal(sent.length, 0);

  clock += 60_000;
  await notifier.handleClosed({ agent } as never);
  assert.equal(sent.length, 1);
});

test("resolves the recipient from lark-cli when openId is empty", async () => {
  const { notifier, sent } = fixture({ openId: "" });
  await notifier.handlePermission({ agent, request } as never);
  assert.equal(sent[0]?.openId, "ou_test");
});
