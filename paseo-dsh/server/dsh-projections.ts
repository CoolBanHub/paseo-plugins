import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dshHomePath, dshSessionUpdatedAt } from "./probe-cleanup.ts";

/**
 * dsh keeps a durable per-session projection cache next to the session logs.
 * It carries the values its own web client lists: the generated title, the
 * last prompt time, plan mode, the current goal and the subagent catalog.
 * Reading it is much cheaper than replaying a whole session log, so Paseo's
 * session picker can show real titles instead of bare session ids.
 */

interface ProjectionRow {
  val?: unknown;
}

interface ProjectionCache {
  version?: unknown;
  record?: {
    rows?: Record<string, ProjectionRow | undefined>;
  };
}

function candidateIds(sessionId: string): string[] {
  const bare = sessionId.replace(/^session-/, "");
  return [...new Set([sessionId, bare, `session-${bare}`])];
}

/** Read one session's cached projection rows, or undefined when absent. */
export function readDshProjection(sessionId: string): Record<string, ProjectionRow | undefined> | undefined {
  const dir = join(dshHomePath(), "storages", "session_projcache", "sessions");
  for (const id of candidateIds(sessionId)) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as ProjectionCache;
      const rows = parsed?.record?.rows;
      if (rows && typeof rows === "object") return rows;
    } catch {
      // Missing or partially written cache entries fall through.
    }
  }
  return undefined;
}

function stringValue(row: ProjectionRow | undefined): string | undefined {
  return typeof row?.val === "string" ? row.val : undefined;
}

function booleanValue(row: ProjectionRow | undefined): boolean | undefined {
  return typeof row?.val === "boolean" ? row.val : undefined;
}

export function dshSessionTitle(sessionId: string): string | undefined {
  const title = stringValue(readDshProjection(sessionId)?.title)?.trim();
  return title ? title : undefined;
}

export function dshSessionPlanActive(sessionId: string): boolean | undefined {
  const plan = readDshProjection(sessionId)?.plan?.val;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return undefined;
  const active = (plan as Record<string, unknown>).active;
  return typeof active === "boolean" ? active : undefined;
}

/** Cached last-prompt time, falling back to the session log's mtime. */
export function dshSessionLastActivity(sessionId: string): string | undefined {
  const metadata = readDshProjection(sessionId)?.sessionListMetadata?.val;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const lastPromptAt = (metadata as Record<string, unknown>).lastPromptAt;
    if (typeof lastPromptAt === "number" && Number.isFinite(lastPromptAt)) {
      return new Date(lastPromptAt).toISOString();
    }
  }
  return dshSessionUpdatedAt(sessionId);
}

/** Direct child sessions recorded in a parent's catalog (for subagent cards). */
export function dshSubagentCatalog(sessionId: string): Array<{ childId: string; label?: string; mode?: string }> {
  const value = readDshProjection(sessionId)?.subagentCatalog?.val;
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const head = (value as Record<string, unknown>).head;
  if (!head || typeof head !== "object" || Array.isArray(head)) return [];
  const values = (head as Record<string, unknown>).values;
  if (!Array.isArray(values)) return [];
  return values
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => ({
      childId: typeof entry.childId === "string" ? entry.childId : "",
      label: typeof entry.label === "string" ? entry.label : undefined,
      mode: typeof entry.mode === "string" ? entry.mode : undefined,
    }))
    .filter((entry) => entry.childId.length > 0);
}
