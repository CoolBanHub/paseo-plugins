const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  module._compile(compiled.outputText, filename);
};

const store = require("../server/turn-usage-store.ts");

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-turn-usage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("recorded turn usages read back in append order", () => {
  const dir = tmpDir(test);
  store.recordTurnUsage(dir, "sess_a", { turnId: "turn-1", recordedAt: 1, inputTokens: 100, outputTokens: 5, speedTokPerSec: 12.3 });
  store.recordTurnUsage(dir, "sess_a", { turnId: "turn-2", recordedAt: 2, inputTokens: 200, outputTokens: 6, cacheReadTokens: 40 });

  const entries = store.readTurnUsages(dir, "sess_a");
  assert.deepEqual(entries.map((entry) => entry.turnId), ["turn-1", "turn-2"]);
  assert.equal(entries[0].speedTokPerSec, 12.3);
  assert.equal(entries[0].inputTokens, 100);
  assert.equal(entries[1].cacheReadTokens, 40);
  assert.equal(entries[1].speedTokPerSec, undefined);
});

test("sessions get separate files and missing ones read as empty", () => {
  const dir = tmpDir(test);
  store.recordTurnUsage(dir, "sess_a", { turnId: "turn-1", recordedAt: 1, outputTokens: 1, speedTokPerSec: 1 });

  assert.equal(store.readTurnUsages(dir, "sess_b").length, 0);
  assert.equal(store.readTurnUsages(dir, "sess_a").length, 1);
  assert.deepEqual(fs.readdirSync(dir), ["sess_a.jsonl"]);
});

test("session ids with path characters stay inside the directory", () => {
  const dir = tmpDir(test);
  store.recordTurnUsage(dir, "../escape", { turnId: "turn-1", recordedAt: 1, outputTokens: 1, speedTokPerSec: 1 });

  assert.equal(fs.readdirSync(dir).length, 1);
  assert.ok(fs.readdirSync(dir)[0].endsWith(".jsonl"));
  assert.equal(store.readTurnUsages(dir, "../escape").length, 1);
});

test("torn and malformed lines are skipped without losing newer entries", () => {
  const dir = tmpDir(test);
  store.recordTurnUsage(dir, "sess_a", { turnId: "turn-1", recordedAt: 1, outputTokens: 1, speedTokPerSec: 1 });
  fs.appendFileSync(path.join(dir, "sess_a.jsonl"), '{"turnId":"turn-broken"\n');
  fs.appendFileSync(path.join(dir, "sess_a.jsonl"), 'not json\n');
  fs.appendFileSync(path.join(dir, "sess_a.jsonl"), JSON.stringify({ noTurnId: true }) + "\n");
  store.recordTurnUsage(dir, "sess_a", { turnId: "turn-2", recordedAt: 2, outputTokens: 2, speedTokPerSec: 2 });

  assert.deepEqual(store.readTurnUsages(dir, "sess_a").map((entry) => entry.turnId), ["turn-1", "turn-2"]);
});

test("append beyond the cap trims to the newest tail", () => {
  const dir = tmpDir(test);
  // MAX_ENTRIES is 400 and trimming starts past double that.
  const total = 830;
  for (let i = 0; i < total; i++) {
    store.recordTurnUsage(dir, "sess_a", { turnId: `turn-${i}`, recordedAt: i, outputTokens: i, speedTokPerSec: 1 });
  }
  const entries = store.readTurnUsages(dir, "sess_a");
  assert.equal(entries.length, 400);
  assert.equal(entries[0].turnId, `turn-${total - 400}`);
  assert.equal(entries.at(-1).turnId, `turn-${total - 1}`);
  // Trimming starts past double the cap, so the file holds the newest rows
  // but never more than that ceiling.
  const onDisk = fs.readFileSync(path.join(dir, "sess_a.jsonl"), "utf8").trim().split("\n").length;
  assert.ok(onDisk >= 400 && onDisk <= 800, `on-disk rows within the trim ceiling: ${onDisk}`);
});

test("parseTurnUsageEntry rejects entries without identity", () => {
  assert.equal(store.parseTurnUsageEntry(undefined), undefined);
  assert.equal(store.parseTurnUsageEntry("x"), undefined);
  assert.equal(store.parseTurnUsageEntry({ turnId: "t", recordedAt: "not-a-number" }), undefined);
  assert.deepEqual(
    store.parseTurnUsageEntry({ turnId: "t", recordedAt: 5, inputTokens: "ignored", outputTokens: 3 }),
    { turnId: "t", recordedAt: 5, outputTokens: 3 },
  );
});
