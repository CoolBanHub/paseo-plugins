import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import {
  removeEmptyProbeSession,
  sweepEmptyProbeSessions,
} from "../server/probe-cleanup.ts";

const EMPTY_PROBE = [
  '{"type":"session","version":4,"id":"probe"}',
  '{"type":"permission/preset","seq":0,"data":{"preset":"workspace-write"}}',
  '{"type":"sandbox/mode","seq":1,"data":{"mode":"workspace-write"}}',
  '{"type":"approval/policy","seq":2,"data":{"policy":"ask"}}',
].join("\n") + "\n";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "dsh-probe-cleanup-"));
}

function writeSession(home: string, id: string, body: string): string {
  const dir = join(home, "sessions", "--tmp--", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.v4.jsonl.zstd"), zstdCompressSync(Buffer.from(body, "utf8")));
  return dir;
}

function writeWorkspace(home: string, archived: string[], members: string[] = []): void {
  const dir = join(home, "storages");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workspace.json"), JSON.stringify({
    global: { archivedSessionIds: archived },
    tables: { workspaces: { workspace: { sessionIds: members } } },
  }));
}

test("removes an empty probe session and its projection cache", () => {
  const home = tempHome();
  try {
    const id = "probe-empty";
    const dir = writeSession(home, id, EMPTY_PROBE);
    const cache = join(home, "storages", "session_projcache", "sessions", `${id}.json`);
    mkdirSync(join(cache, ".."), { recursive: true });
    writeFileSync(cache, "{}");

    assert.equal(removeEmptyProbeSession(id, { home }), true);
    assert.equal(existsSync(dir), false);
    assert.equal(existsSync(cache), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("keeps a session with a user event", () => {
  const home = tempHome();
  try {
    const id = "probe-used";
    const dir = writeSession(home, id, `${EMPTY_PROBE}{"type":"user/message","seq":4}\n`);
    assert.equal(removeEmptyProbeSession(id, { home }), false);
    assert.equal(existsSync(dir), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("keeps archived sessions and workspace members", () => {
  const home = tempHome();
  try {
    const archived = writeSession(home, "archived-probe", EMPTY_PROBE);
    const member = writeSession(home, "member-probe", EMPTY_PROBE);
    writeWorkspace(home, ["session-archived-probe"], ["session-member-probe"]);

    assert.equal(removeEmptyProbeSession("archived-probe", { home }), false);
    assert.equal(removeEmptyProbeSession("member-probe", { home }), false);
    assert.equal(existsSync(archived), true);
    assert.equal(existsSync(member), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("sweeps only stale empty probes", () => {
  const home = tempHome();
  try {
    const stale = writeSession(home, "stale-probe", EMPTY_PROBE);
    const recent = writeSession(home, "recent-probe", EMPTY_PROBE);
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(stale, old, old);
    utimesSync(join(stale, "session.v4.jsonl.zstd"), old, old);

    const removed = sweepEmptyProbeSessions(["stale-probe", "recent-probe"], {
      home,
      minAgeMs: 60 * 60_000,
    });

    assert.deepEqual(removed, ["stale-probe"]);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(recent), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
