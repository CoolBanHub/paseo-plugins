import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dshSessionLastActivity,
  dshSessionPlanActive,
  dshSessionTitle,
  dshSubagentCatalog,
} from "../server/dsh-projections.ts";

function homeWithProjection(sessionId: string, rows: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "dsh-projection-"));
  const dir = join(home, "storages", "session_projcache", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify({ version: 99, record: { rows } }));
  return home;
}

test("projection cache supplies session titles, activity, plan and subagents", (t) => {
  const sessionId = "session-abc";
  const home = homeWithProjection("session-abc", {
    title: { val: "Fix the login flow" },
    plan: { val: { active: true } },
    sessionListMetadata: { val: { lastPromptAt: 1_700_000_000_000 } },
    subagentCatalog: { val: { head: { values: [
      { childId: "child-1", label: "Review memory", mode: "continuable" },
    ] } } },
  });
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });

  assert.equal(dshSessionTitle(sessionId), "Fix the login flow");
  assert.equal(dshSessionPlanActive(sessionId), true);
  assert.equal(dshSessionLastActivity(sessionId), new Date(1_700_000_000_000).toISOString());
  assert.deepEqual(dshSubagentCatalog(sessionId), [
    { childId: "child-1", label: "Review memory", mode: "continuable" },
  ]);
});

test("missing or malformed projections degrade to undefined/empty", (t) => {
  const home = mkdtempSync(join(tmpdir(), "dsh-projection-empty-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  assert.equal(dshSessionTitle("missing"), undefined);
  assert.equal(dshSessionPlanActive("missing"), undefined);
  assert.equal(dshSessionLastActivity("missing"), undefined);
  assert.deepEqual(dshSubagentCatalog("missing"), []);
});
