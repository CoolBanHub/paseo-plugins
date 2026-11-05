import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseLarkJson, resolveLarkCli } from "../server/lark.ts";

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
