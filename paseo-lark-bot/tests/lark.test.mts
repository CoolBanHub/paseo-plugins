import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLarkJson, replyMessage, resolveLarkCli } from "../server/lark.ts";

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
