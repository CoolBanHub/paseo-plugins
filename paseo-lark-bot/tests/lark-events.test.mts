import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
  createEventConsumer,
  type LarkCardActionEvent,
  type LarkMessageEvent,
} from "../server/lark-events.ts";
import type { ChildProcess } from "node:child_process";

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdinEnded = false;
  kills: string[] = [];
  spawned: { command: string; args: string[] };

  constructor(command: string, args: string[]) {
    super();
    this.spawned = { command, args };
  }

  kill(signal?: string): boolean {
    this.kills.push(signal ?? "");
    return true;
  }

  stdin(): { end: () => void } {
    return {
      end: () => {
        this.stdinEnded = true;
      },
    };
  }

  emitExit(code: number | null, signal: string | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

interface FakeTimer {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
}

function asProcess(fake: FakeChildProcess): ChildProcess {
  const process = fake as unknown as ChildProcess;
  // The terminate() helper reads exitCode/signalCode and drives stdin/kill
  // through the duck-typed surface the fake provides.
  return new Proxy(process, {
    get(target, prop, receiver) {
      if (prop === "stdin") return (target as unknown as FakeChildProcess).stdin();
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ChildProcess;
}

interface Harness {
  consumer: ReturnType<typeof createEventConsumer>;
  processes: FakeChildProcess[];
  timers: FakeTimer[];
  events: LarkMessageEvent[];
}

function makeHarness(): Harness {
  const processes: FakeChildProcess[] = [];
  const timers: FakeTimer[] = [];
  const events: LarkMessageEvent[] = [];

  const consumer = createEventConsumer({
    cliPath: "/fake/lark-cli",
    onEvent: (event) => events.push(event),
    deps: {
      spawn: (command, args) => {
        const fake = new FakeChildProcess(command, args);
        processes.push(fake);
        return asProcess(fake);
      },
      schedule: (callback, delayMs) => {
        const timer: FakeTimer = { callback, delayMs, cleared: false };
        timers.push(timer);
        return {
          clear: () => {
            timer.cleared = true;
          },
        };
      },
      log: () => {},
    },
  });

  return { consumer, processes, timers, events };
}

function feedStdout(fake: FakeChildProcess, chunk: string): void {
  fake.stdout.emit("data", Buffer.from(chunk, "utf8"));
}

function markReady(fake: FakeChildProcess): void {
  fake.stderr.emit("data", Buffer.from("[event] ready event_key=im.message.receive_v1\n", "utf8"));
}

const sampleEvent = {
  chat_id: "oc_group",
  chat_type: "group",
  content: "@_user_1 你好",
  message_id: "om_1",
  message_type: "text",
  sender_id: "ou_user",
  sender_type: "user",
};

describe("createEventConsumer", () => {
  it("spawns lark-cli event consume and emits NDJSON lines", () => {
    const h = makeHarness();
    h.consumer.start();
    assert.equal(h.processes.length, 1);
    assert.deepEqual(h.processes[0].spawned.args, ["event", "consume", "im.message.receive_v1", "--as", "bot"]);

    markReady(h.processes[0]);
    assert.equal(h.consumer.status().state, "ready");

    feedStdout(h.processes[0], JSON.stringify(sampleEvent) + "\n");
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].message_id, "om_1");
  });

  it("consumes a custom event key and forwards card action payloads", () => {
    const events: LarkCardActionEvent[] = [];
    const processes: FakeChildProcess[] = [];
    const consumer = createEventConsumer<LarkCardActionEvent>({
      cliPath: "/fake/lark-cli",
      eventKey: "card.action.trigger",
      onEvent: (event) => events.push(event),
      deps: {
        spawn: (command, args) => {
          const fake = new FakeChildProcess(command, args);
          processes.push(fake);
          return asProcess(fake);
        },
        schedule: () => ({ clear: () => {} }),
      },
    });
    consumer.start();
    assert.deepEqual(processes[0]?.spawned.args, [
      "event",
      "consume",
      "card.action.trigger",
      "--as",
      "bot",
    ]);
    markReady(processes[0]!);
    feedStdout(
      processes[0]!,
      JSON.stringify({
        type: "card.action.trigger",
        chat_id: "oc_group",
        message_id: "om_card",
        operator_id: "ou_user",
        action_tag: "button",
        action_value: '{"requestId":"r"}',
      }) + "\n",
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]?.action_value, '{"requestId":"r"}');
  });

  it("stops on a fatal subscription error instead of retrying", () => {
    const processes: FakeChildProcess[] = [];
    const timers: FakeTimer[] = [];
    const consumer = createEventConsumer({
      cliPath: "/fake/lark-cli",
      eventKey: "card.action.trigger",
      fatalErrorPattern: /requires callbacks not subscribed|failed_precondition/i,
      onEvent: () => {},
      deps: {
        spawn: (command, args) => {
          const fake = new FakeChildProcess(command, args);
          processes.push(fake);
          return asProcess(fake);
        },
        schedule: (callback, delayMs) => {
          const timer: FakeTimer = { callback, delayMs, cleared: false };
          timers.push(timer);
          return {
            clear: () => {
              timer.cleared = true;
            },
          };
        },
      },
    });
    consumer.start();
    feedStdout(
      processes[0]!,
      '{\n  "ok": false,\n  "error": {\n    "message": "EventKey card.action.trigger requires callbacks not subscribed in console: card.action.trigger"\n  }\n}\n',
    );
    processes[0]!.emitExit(2, null);
    assert.equal(consumer.status().state, "stopped");
    assert.match(consumer.status().lastError ?? "", /requires callbacks/);
    assert.equal(timers.length, 0, "fatal errors must not schedule a retry");
    assert.equal(processes.length, 1, "fatal errors must not respawn the child");
  });

  it("parses events split across chunk boundaries and skips bad lines", () => {
    const h = makeHarness();
    h.consumer.start();
    markReady(h.processes[0]);

    const line = JSON.stringify(sampleEvent);
    feedStdout(h.processes[0], line.slice(0, 20));
    feedStdout(h.processes[0], line.slice(20) + "\nnot json\n" + line + "\n");
    assert.equal(h.events.length, 2);
  });

  it("retries when spawn fails without an exit event", () => {
    const h = makeHarness();
    h.consumer.start();
    h.processes[0].emit("error", new Error("spawn lark-cli ENOENT"));
    assert.equal(h.consumer.status().state, "retrying");
    assert.equal(h.timers.length, 1);
    assert.ok(h.consumer.status().lastError?.includes("ENOENT"));
  });

  it("restarts with backoff after an unexpected exit", async () => {
    const h = makeHarness();
    h.consumer.start();
    markReady(h.processes[0]);
    h.processes[0].emitExit(1, null);

    assert.equal(h.consumer.status().state, "retrying");
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].delayMs, 1_000);

    h.timers[0].callback();
    assert.equal(h.processes.length, 2);
    markReady(h.processes[1]);
    h.processes[1].emitExit(1, null);
    // attempt was reset by the successful ready marker.
    assert.equal(h.timers[1].delayMs, 1_000);
  });

  it("caps the backoff delay", () => {
    const h = makeHarness();
    h.consumer.start();
    // Crash repeatedly without ever reaching ready.
    for (let round = 0; round < 8; round += 1) {
      h.processes[h.processes.length - 1].emitExit(1, null);
      h.timers[h.timers.length - 1].callback();
    }
    const delays = h.timers.map((timer) => timer.delayMs);
    assert.ok(delays.every((delay) => delay <= 60_000));
    assert.ok(delays[delays.length - 1] === 60_000);
  });

  it("stops cleanly and never restarts", async () => {
    const h = makeHarness();
    h.consumer.start();
    markReady(h.processes[0]);
    h.processes[0].emitExit(1, null);
    await h.consumer.stop();

    assert.equal(h.consumer.status().state, "stopped");
    assert.equal(h.timers[0].cleared, true);
    for (const timer of h.timers) timer.callback();
    assert.equal(h.processes.length, 1, "no respawn after stop");
  });

  it("closes stdin and sends SIGTERM on stop", async () => {
    const h = makeHarness();
    h.consumer.start();
    markReady(h.processes[0]);
    const stopping = h.consumer.stop();
    // terminate() waits for the exit event; deliver it asynchronously.
    setImmediate(() => h.processes[0].emitExit(null, "SIGTERM"));
    await stopping;
    assert.equal(h.processes[0].stdinEnded, true);
    assert.deepEqual(h.processes[0].kills, ["SIGTERM"]);
  });
});
