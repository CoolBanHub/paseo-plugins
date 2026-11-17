import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  clearBotIdentity,
  loadBotIdentity,
  saveBotIdentity,
} from "../server/bot-identity.ts";

describe("bot identity cache", () => {
  it("round-trips the bot open_id and app id", () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-bot-identity-"));
    const path = join(dir, "bot-identity.json");
    try {
      saveBotIdentity(path, { openId: "ou_bot", appId: "cli_app" });
      assert.deepEqual(loadBotIdentity(path), { openId: "ou_bot", appId: "cli_app" });
      assert.match(readFileSync(path, "utf8"), /ou_bot/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores malformed ids and missing files", () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-bot-identity-"));
    const path = join(dir, "bot-identity.json");
    try {
      writeFileSync(path, JSON.stringify({ version: 1, openId: "user", appId: "app" }));
      assert.deepEqual(loadBotIdentity(path), { openId: null, appId: null });
      assert.deepEqual(loadBotIdentity(join(dir, "missing.json")), {
        openId: null,
        appId: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes the file when the identity is cleared", () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-bot-identity-"));
    const path = join(dir, "bot-identity.json");
    try {
      saveBotIdentity(path, { openId: "ou_bot", appId: "cli_app" });
      clearBotIdentity(path);
      assert.deepEqual(loadBotIdentity(path), { openId: null, appId: null });
      saveBotIdentity(path, { openId: null, appId: null });
      assert.throws(() => readFileSync(path, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
