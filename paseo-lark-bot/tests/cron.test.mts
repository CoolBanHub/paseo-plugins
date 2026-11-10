import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCronScheduler,
  nextCronTime,
  parseCron,
  readCronJobs,
  validateCron,
} from "../server/cron.ts";

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lark-bot-cron-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("cron parsing", () => {
  it("validates five-field expressions", () => {
    assert.equal(validateCron("0 6 * * *"), true);
    assert.equal(validateCron("*/15 9-18 * * 1-5"), true);
    assert.equal(validateCron("0 6 * *"), false);
    assert.equal(validateCron("60 6 * * *"), false);
    assert.equal(validateCron("0 6 32 * *"), false);
    assert.equal(parseCron("0 6 * * *").hours.has(6), true);
  });

  it("finds the next matching minute", () => {
    const base = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const next = nextCronTime("*/15 * * * *", base);
    assert.equal(new Date(next).getMinutes(), 15);
    assert.equal(new Date(next).getHours(), 10);
  });
});

describe("cron scheduler", () => {
  it("adds, persists and removes jobs", () => {
    const { dir, cleanup } = tempDir();
    try {
      let now = new Date(2026, 0, 1, 10, 0, 0).getTime();
      const path = join(dir, "cron-jobs.json");
      const scheduler = createCronScheduler({
        storePath: path,
        now: () => now,
        runJob: async () => undefined,
      });
      const job = scheduler.add({
        chatId: "oc_group",
        topicKey: "om_root",
        expression: "0 6 * * *",
        prompt: "总结",
      });
      assert.equal(scheduler.list().length, 1);
      assert.equal(job.enabled, true);
      scheduler.flush();
      assert.equal(readCronJobs(path).length, 1);

      const loaded = createCronScheduler({
        storePath: path,
        now: () => now,
        runJob: async () => undefined,
      });
      assert.equal(loaded.list()[0]?.prompt, "总结");
      assert.equal(loaded.setEnabled(job.id, false)?.enabled, false);
      assert.equal(loaded.remove(job.id)?.id, job.id);
      assert.equal(loaded.list().length, 0);
    } finally {
      cleanup();
    }
  });

  it("runs due jobs once and advances the next run", async () => {
    const { dir, cleanup } = tempDir();
    try {
      let now = new Date(2026, 0, 1, 5, 59, 0).getTime();
      const runs: string[] = [];
      const scheduler = createCronScheduler({
        storePath: join(dir, "cron.json"),
        now: () => now,
        runJob: async (job) => {
          runs.push(job.prompt);
        },
      });
      const job = scheduler.add({
        chatId: "oc_group",
        topicKey: null,
        expression: "0 6 * * *",
        prompt: "早上好",
      });
      assert.equal(job.nextRunAt, new Date(2026, 0, 1, 6, 0, 0).getTime());

      await scheduler.tick(now);
      assert.deepEqual(runs, []);

      now = new Date(2026, 0, 1, 6, 0, 0).getTime();
      await scheduler.tick(now);
      assert.deepEqual(runs, ["早上好"]);
      assert.equal(scheduler.list()[0]?.nextRunAt, new Date(2026, 0, 2, 6, 0, 0).getTime());

      // A second tick at the same minute must not run it again.
      await scheduler.tick(now);
      assert.deepEqual(runs, ["早上好"]);
      scheduler.stop();
    } finally {
      cleanup();
    }
  });

  it("disables jobs with an impossible expression on load", () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "cron.json");
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          jobs: [
            {
              id: "bad",
              chatId: "oc_group",
              topicKey: null,
              expression: "0 0 31 2 *",
              prompt: "never",
              enabled: true,
              silent: false,
              createdBy: "",
              createdAt: 0,
              lastRunAt: null,
              nextRunAt: null,
              lastError: null,
            },
          ],
        }),
      );
      const scheduler = createCronScheduler({ storePath: path, runJob: async () => undefined });
      const job = scheduler.list()[0];
      assert.ok(job);
      assert.equal(job.enabled, false);
      assert.equal(job.nextRunAt, null);
      assert.ok(job.lastError);
    } finally {
      cleanup();
    }
  });
});
