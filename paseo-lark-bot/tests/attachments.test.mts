import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { installOutboxHelper, isInsideRoots, outboxRequestSchema } from "../server/attachments.ts";

const execFileAsync = promisify(execFile);

describe("attachment outbox helper", () => {
  it("writes one atomic request from CLI arguments", async () => {
    const root = mkdtempSync(join(tmpdir(), "lark-bot-attach-"));
    try {
      const helper = installOutboxHelper(root, process.execPath);
      const outbox = join(root, "outbox");
      await execFileAsync(helper, [
        "--image",
        "/tmp/chart.png",
        "--file",
        "/tmp/report.pdf",
        "--message",
        "结果见附件",
        "--chat",
        "oc_chat",
        "--topic",
        "om_topic",
        "--outbox",
        outbox,
      ]);
      const files = readdirSync(outbox).filter((name) => name.endsWith(".json"));
      assert.equal(files.length, 1);
      const parsed = outboxRequestSchema.parse(JSON.parse(readFileSync(join(outbox, files[0]!), "utf8")));
      assert.equal(parsed.chatId, "oc_chat");
      assert.equal(parsed.topicKey, "om_topic");
      assert.deepEqual(parsed.images, ["/tmp/chart.png"]);
      assert.deepEqual(parsed.files, ["/tmp/report.pdf"]);
      assert.equal(parsed.message, "结果见附件");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("defaults the outbox next to the helper", async () => {
    const root = mkdtempSync(join(tmpdir(), "lark-bot-attach-"));
    try {
      const helper = installOutboxHelper(root, process.execPath);
      await execFileAsync(helper, ["--message", "hi", "--chat", "oc_chat"]);
      const files = readdirSync(join(root, "outbox")).filter((name) => name.endsWith(".json"));
      assert.equal(files.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an empty request", async () => {
    const root = mkdtempSync(join(tmpdir(), "lark-bot-attach-"));
    try {
      const helper = installOutboxHelper(root, process.execPath);
      await assert.rejects(
        execFileAsync(helper, ["--chat", "oc_chat", "--outbox", join(root, "outbox")]),
        /nothing to send/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("isInsideRoots", () => {
  it("accepts descendants and rejects siblings", () => {
    assert.equal(isInsideRoots("/work/project/a.png", ["/work/project"]), true);
    assert.equal(isInsideRoots("/work/project", ["/work/project"]), true);
    assert.equal(isInsideRoots("/work/project2/a.png", ["/work/project"]), false);
    assert.equal(isInsideRoots("/tmp/a.png", ["/work/project", "/tmp"]), true);
  });
});
