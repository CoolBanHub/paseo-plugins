import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDataDir, renderDoctorReport, runDoctorChecks, type DoctorDeps } from "../server/doctor.ts";

function deps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    cliPath: "/opt/homebrew/bin/lark-cli",
    cliVersion: "1.0.98",
    currentAppId: "cli_x",
    botOpenId: "ou_bot",
    consumerState: "ready",
    consumerError: null,
    cardConsumerState: "ready",
    cardConsumerError: null,
    bindingCount: 1,
    providerCount: 2,
    ffmpegPath: "/opt/homebrew/bin/ffmpeg",
    pluginDataDir: "/tmp/lark-bot-data",
    cronJobs: [],
    pendingQuestions: 0,
    ...overrides,
  };
}

describe("doctor", () => {
  it("passes a healthy setup", () => {
    const checks = runDoctorChecks(deps());
    assert.equal(checks.every((check) => check.level === "pass"), true, JSON.stringify(checks));
    assert.match(renderDoctorReport(checks), /全部检查通过/);
  });

  it("reports failures and warnings with actionable details", () => {
    const checks = runDoctorChecks(
      deps({
        cliPath: null,
        currentAppId: null,
        consumerState: "retrying",
        consumerError: "token expired",
        cardConsumerState: "stopped",
        bindingCount: 0,
        providerCount: 0,
        ffmpegPath: null,
      }),
    );
    const report = renderDoctorReport(checks);
    assert.match(report, /lark-cli/);
    assert.match(report, /token expired/);
    assert.match(report, /卡片回调/);
    assert.match(report, /还没有绑定/);
    assert.match(report, /ffmpeg/);
  });

  it("detects an unwritable data directory", () => {
    const root = mkdtempSync(join(tmpdir(), "lark-bot-doctor-"));
    try {
      const check = checkDataDir(join(root, "nested"));
      assert.equal(check.level, "pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    assert.equal(checkDataDir("/proc/nope").level, "fail");
  });
});
