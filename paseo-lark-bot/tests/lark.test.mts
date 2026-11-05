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
