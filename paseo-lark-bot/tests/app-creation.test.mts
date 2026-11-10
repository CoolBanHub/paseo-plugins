import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { ChildProcess } from "node:child_process";
import {
  createAppCreationController,
  extractVerificationUrl,
  lastMeaningfulLine,
  type AppCreationDeps,
} from "../server/app-creation.ts";

const URL =
  "https://open.feishu.cn/page/cli?user_code=ABCD-EFGH&lpv=1.0.98&ocv=1.0.98&from=cli";

class FakeProcess extends EventEmitter {
  stdout = { resume() {} };
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills: string[] = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal ?? "");
    return true;
  }

  emitStderr(text: string): void {
    this.stderr.emit("data", Buffer.from(text));
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

function asChild(fake: FakeProcess): ChildProcess {
  return fake as unknown as ChildProcess;
}

interface Timer {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
}

function makeHarness(overrides: Partial<AppCreationDeps> = {}) {
  const processes: FakeProcess[] = [];
  const timers: Timer[] = [];
  const spawned: { command: string; args: string[] }[] = [];
  const successes: { appId: string; cliPath: string }[] = [];
  const logs: string[] = [];

  const deps: AppCreationDeps = {
    spawn: (command, args) => {
      const fake = new FakeProcess();
      processes.push(fake);
      spawned.push({ command, args });
      return asChild(fake);
    },
    kill: (proc, signal) => {
      proc.kill(signal);
    },
    qrDataUrl: async () => "data:image/png;base64,dGVzdA==",
    readAppId: async () => "cli_new",
    onSuccess: async (appId, cliPath) => {
      successes.push({ appId, cliPath });
    },
    schedule: (callback, delayMs) => {
      const timer: Timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return {
        clear: () => {
          timer.cleared = true;
        },
      };
    },
    log: (message) => {
      logs.push(message);
    },
    ...overrides,
  };

  return {
    controller: createAppCreationController(deps),
    processes,
    timers,
    spawned,
    successes,
    logs,
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("extractVerificationUrl", () => {
  it("finds the CLI verification link in noisy stderr", () => {
    const text = [
      "\u001b[32m使用飞书 / Lark 扫码配置应用：\u001b[0m",
      "",
      "  " + URL,
      "",
      "等待配置应用...",
    ].join("\n");
    assert.equal(extractVerificationUrl(text), URL);
  });

  it("accepts the SDK landing page and trims trailing punctuation", () => {
    const url = "https://open.feishu.cn/page/launcher?user_code=WXYZ&from=sdk";
    assert.equal(extractVerificationUrl(`open (${url}).`), url);
  });

  it("returns null for unrelated output", () => {
    assert.equal(extractVerificationUrl("app registration denied by user"), null);
    assert.equal(extractVerificationUrl(""), null);
  });
});

describe("lastMeaningfulLine", () => {
  it("skips the ASCII QR block and the verification URL", () => {
    const text = [
      "▀▄▀▄▀▄",
      "█ █ █ ",
      "  " + URL,
      "app registration denied by user",
    ].join("\n");
    assert.equal(lastMeaningfulLine(text), "app registration denied by user");
  });

  it("extracts a JSON error message and hint", () => {
    const line = JSON.stringify({
      ok: false,
      error: { message: "app secret is empty", hint: "check config" },
    });
    assert.equal(lastMeaningfulLine(line), "app secret is empty — check config");
  });

  it("returns null when there is no meaningful line", () => {
    assert.equal(lastMeaningfulLine("▀▄▀▄\n" + URL), null);
  });
});

describe("createAppCreationController", () => {
  it("spawns lark-cli and exposes the verification URL", async () => {
    const { controller, processes, spawned, timers } = makeHarness();
    const started = controller.start("/fake/lark-cli");
    assert.equal(started.state, "starting");
    assert.equal(processes.length, 1);
    assert.deepEqual(spawned[0], {
      command: "/fake/lark-cli",
      args: ["config", "init", "--new", "--brand", "feishu"],
    });
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delayMs, 11 * 60 * 1_000);

    processes[0].emitStderr("使用飞书扫码：\n  " + URL + "\n");
    await tick();
    const waiting = controller.status();
    assert.equal(waiting.state, "waiting");
    assert.equal(waiting.url, URL);
    assert.equal(waiting.qrDataUrl, "data:image/png;base64,dGVzdA==");
  });

  it("reads the created App ID and reports success", async () => {
    const { controller, processes, successes } = makeHarness();
    controller.start("/fake/lark-cli");
    processes[0].emitStderr(URL);
    processes[0].emitExit(0);
    await tick();
    const status = controller.status();
    assert.equal(status.state, "success");
    assert.equal(status.appId, "cli_new");
    assert.deepEqual(successes, [{ appId: "cli_new", cliPath: "/fake/lark-cli" }]);
  });

  it("does not spawn a second process while one is waiting", () => {
    const { controller, processes } = makeHarness();
    controller.start("/fake/lark-cli");
    processes[0].emitStderr(URL);
    const second = controller.start("/fake/lark-cli");
    assert.equal(second.state, "waiting");
    assert.equal(processes.length, 1);
  });

  it("maps a denied confirmation to an actionable error", async () => {
    const { controller, processes } = makeHarness();
    controller.start("/fake/lark-cli");
    processes[0].emitStderr("app registration denied by user\n");
    processes[0].emitExit(1);
    await tick();
    const status = controller.status();
    assert.equal(status.state, "error");
    assert.ok(status.error?.includes("取消了授权"), status.error ?? undefined);
    assert.equal(status.url, null);
  });

  it("ignores a late exit after cancel", async () => {
    const { controller, processes } = makeHarness();
    controller.start("/fake/lark-cli");
    processes[0].emitStderr(URL);
    const cancelled = controller.cancel();
    assert.equal(cancelled.state, "idle");
    assert.equal(processes[0].kills[0], "SIGTERM");
    processes[0].emitExit(0);
    await tick();
    assert.equal(controller.status().state, "idle");
  });

  it("force-kills the process when disposed", () => {
    const { controller, processes } = makeHarness();
    controller.start("/fake/lark-cli");
    controller.dispose();
    assert.deepEqual(processes[0].kills, ["SIGKILL"]);
    assert.equal(controller.status().state, "idle");
  });

  it("times out an unconfirmed QR and kills the process", () => {
    const { controller, processes, timers } = makeHarness();
    controller.start("/fake/lark-cli");
    processes[0].emitStderr(URL);
    timers[0].callback();
    const status = controller.status();
    assert.equal(status.state, "error");
    assert.ok(status.error?.includes("过期"), status.error ?? undefined);
    assert.equal(processes[0].kills[0], "SIGTERM");
  });

  it("fails when the created App ID cannot be read", async () => {
    const { controller, processes } = makeHarness({ readAppId: async () => null });
    controller.start("/fake/lark-cli");
    processes[0].emitExit(0);
    await tick();
    const status = controller.status();
    assert.equal(status.state, "error");
    assert.ok(status.error?.includes("App ID"), status.error ?? undefined);
  });

  it("keeps the success state when the post-create switch fails", async () => {
    const logs: string[] = [];
    const { controller, processes } = makeHarness({
      log: (message) => logs.push(message),
      onSuccess: async () => {
        throw new Error("switch failed");
      },
    });
    controller.start("/fake/lark-cli");
    processes[0].emitExit(0);
    await tick();
    assert.equal(controller.status().state, "success");
    assert.ok(logs.some((line) => line.includes("切换失败")), logs.join("\n"));
  });
});
