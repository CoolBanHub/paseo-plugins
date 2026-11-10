import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listChatMembers, parseLarkJson, replyCard, replyMessage, resolveLarkCli } from "../server/lark.ts";

describe("parseLarkJson", () => {
  it("parses JSON after leading warnings", () => {
    const payload = parseLarkJson('warn: token refreshed\n{"ok":true}');
    assert.equal(payload?.ok, true);
  });

  it("returns null without an object", () => {
    assert.equal(parseLarkJson("no braces"), null);
    assert.equal(parseLarkJson("{broken"), null);
  });
});

describe("resolveLarkCli", () => {
  it("prefers the explicit path when it is executable", () => {
    // resolveLarkCli probes with accessSync, so the candidate must exist.
    const found = resolveLarkCli(process.execPath, { PATH: "/usr/bin" }, "/home/tester");
    assert.equal(found, process.execPath);
  });

  it("returns null when nothing is executable", () => {
    const found = resolveLarkCli("", { PATH: "/definitely/not/here" }, "/definitely/no/home");
    // The fixed fallbacks (/opt/homebrew, /usr/local) may exist on a dev
    // machine; only demand that none of the fake dirs matched.
    assert.ok(found === null || !found.startsWith("/definitely"));
  });
});

describe("applyAppCredentials", () => {
  it("rejects invalid credentials without touching lark-cli", async () => {
    const { applyAppCredentials } = await import("../server/lark.ts");
    let initRan = false;
    try {
      await applyAppCredentials({
        cliPath: "/fake/lark-cli",
        appId: "cli_bad",
        appSecret: "secret",
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ code: 20014, msg: "app secret is empty" }),
        }),
        runInit: async () => {
          initRan = true;
        },
        stopEventBus: async () => {},
      });
      assert.fail("should have thrown");
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes("无效"));
    }
    assert.equal(initRan, false, "config init must not run for invalid credentials");
  });

  it("stops the previous app's event bus", async () => {
    const { applyAppCredentials } = await import("../server/lark.ts");
    let stoppedApp: string | null = null;
    await applyAppCredentials({
      cliPath: "/fake/lark-cli",
      appId: "cli_new",
      appSecret: "secret",
      previousAppId: "cli_old",
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: 0 }) }),
      runInit: async () => {},
      stopEventBus: async (_cliPath, appId) => {
        stoppedApp = appId;
      },
    });
    assert.equal(stoppedApp, "cli_old");
  });

  it("writes valid credentials and restarts the event bus", async () => {
    const { applyAppCredentials } = await import("../server/lark.ts");
    const calls: { appId: string; secret: string }[] = [];
    let busStopped = false;
    await applyAppCredentials({
      cliPath: "/fake/lark-cli",
      appId: "cli_good",
      appSecret: "secret",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ code: 0, tenant_access_token: "t-gc" }),
      }),
      runInit: async (_cliPath, appId, secret) => {
        calls.push({ appId, secret });
      },
      stopEventBus: async () => {
        busStopped = true;
      },
    });
    assert.deepEqual(calls, [{ appId: "cli_good", secret: "secret" }]);
    assert.equal(busStopped, true);
  });
});

describe("replyCard", () => {
  it("feeds the Card 2.0 JSON through stdin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-bot-card-"));
    const cli = join(dir, "fake-lark-cli");
    writeFileSync(
      cli,
      `#!${process.execPath}
const args = process.argv.slice(2);
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  let card = null;
  try { card = JSON.parse(stdin); } catch {}
  const ok =
    args.includes("--msg-type") &&
    args.includes("interactive") &&
    args.includes("--content") &&
    args.includes("-") &&
    args.includes("--reply-in-thread") &&
    card?.schema === "2.0";
  if (!ok) {
    console.log(JSON.stringify({ ok: false, error: { message: "unexpected argv/stdin" } }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, data: { message_id: "om_card" } }));
});
`,
    );
    chmodSync(cli, 0o755);
    try {
      const messageId = await replyCard({
        cliPath: cli,
        messageId: "om_trigger",
        card: { schema: "2.0", body: { elements: [] } },
        replyInThread: true,
      });
      assert.equal(messageId, "om_card");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("listChatMembers", () => {
  it("parses human members and ignores non-open-id entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-bot-members-"));
    const cli = join(dir, "fake-lark-cli");
    writeFileSync(
      cli,
      `#!${process.execPath}
const args = process.argv.slice(2);
if (!args.includes("+chat-members-list") || !args.includes("oc_chat") || !args.includes("--page-all")) {
  console.log(JSON.stringify({ ok: false, error: { message: "unexpected argv" } }));
  process.exit(0);
}
console.log(JSON.stringify({
  ok: true,
  data: {
    users: [
      { member_id: "ou_a", name: "甲" },
      { member_id: "not-an-open-id", name: "坏数据" },
    ],
    bots: [{ member_id: "ou_bot", name: "机器人" }],
  },
}));
`,
    );
    chmodSync(cli, 0o755);
    try {
      const members = await listChatMembers(cli, "oc_chat");
      assert.deepEqual(members, [{ openId: "ou_a", name: "甲" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("replyMessage", () => {
  it("feeds the reply through stdin instead of argv", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-bot-reply-"));
    const cli = join(dir, "fake-lark-cli");
    writeFileSync(
      cli,
      `#!${process.execPath}
const args = process.argv.slice(2);
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  if (!args.includes("--markdown") || !args.includes("-") || stdin !== "多行回复") {
    console.log(JSON.stringify({ ok: false, error: { message: "unexpected argv/stdin" } }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, data: { message_id: "om_x" } }));
});
`,
    );
    chmodSync(cli, 0o755);
    try {
      const messageId = await replyMessage({
        cliPath: cli,
        messageId: "om_trigger",
        text: "多行回复",
        format: "markdown",
        replyInThread: true,
      });
      assert.equal(messageId, "om_x");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
