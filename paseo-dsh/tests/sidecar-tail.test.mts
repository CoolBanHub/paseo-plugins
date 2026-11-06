import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SidecarTail } from "../server/sidecar-tail.ts";

const home = mkdtempSync(join(tmpdir(), "dsh-sidecar-tail-"));
test.after(() => rmSync(home, { recursive: true, force: true }));

function record(n: number, kind: string): string {
  return `${JSON.stringify({ n, kind })}\n`;
}

test("consumes only newly appended complete lines", () => {
  const path = join(home, "incremental.jsonl");
  writeFileSync(path, record(1, "one") + record(2, "two"));
  const tail = new SidecarTail(path);
  const seen: number[] = [];
  tail.drain((entry) => {
    seen.push(entry.n as number);
    return true;
  });
  assert.deepEqual(seen, [1, 2]);

  appendFileSync(path, record(3, "three"));
  appendFileSync(path, JSON.stringify({ n: 4, kind: "partial" })); // no trailing newline
  const next: number[] = [];
  tail.drain((entry) => {
    next.push(entry.n as number);
    return true;
  });
  assert.deepEqual(next, [3], "an unterminated trailing record waits for its newline");

  appendFileSync(path, "\n");
  const rest: number[] = [];
  tail.drain((entry) => {
    rest.push(entry.n as number);
    return true;
  });
  assert.deepEqual(rest, [4]);
});

test("skips the read entirely when the file has not grown", () => {
  const path = join(home, "quiet.jsonl");
  writeFileSync(path, record(1, "one"));
  const tail = new SidecarTail(path);
  let reads = 0;
  tail.drain(() => {
    reads += 1;
    return true;
  });
  assert.equal(reads, 1);
  tail.drain(() => {
    reads += 1;
    return true;
  });
  assert.equal(reads, 1, "a second drain with no growth emits nothing");
});

test("compaction keeps the record counter so re-read tails do not duplicate", () => {
  const path = join(home, "rotated.jsonl");
  writeFileSync(path, record(1, "one") + record(2, "two") + record(3, "three"));
  const tail = new SidecarTail(path);
  const first: number[] = [];
  tail.drain((entry) => {
    first.push(entry.n as number);
    return true;
  });
  assert.deepEqual(first, [1, 2, 3]);

  // The bridge compacts in place: old lines dropped, recent lines kept with
  // their original counter values, then new records continue the sequence.
  writeFileSync(path, record(3, "three") + record(4, "four"));
  const second: number[] = [];
  tail.drain((entry) => {
    second.push(entry.n as number);
    return true;
  });
  assert.deepEqual(second, [4], "records already emitted before compaction are deduped");
});

test("a vanished or unreadable sidecar is tolerated", () => {
  const tail = new SidecarTail(join(home, "missing.jsonl"));
  let reached = false;
  tail.drain(() => {
    reached = true;
    return true;
  });
  assert.equal(reached, false);
});

test("records without a counter pass through unmolested", () => {
  const path = join(home, "legacy.jsonl");
  writeFileSync(path, `${JSON.stringify({ kind: "legacy" })}\n`);
  const tail = new SidecarTail(path);
  const kinds: string[] = [];
  tail.drain((entry) => {
    kinds.push(String(entry.kind));
    return true;
  });
  assert.deepEqual(kinds, ["legacy"]);
});
