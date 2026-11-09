import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-turn token accounting appended as the turn settles, so a replayed
 * session can rebuild its "Token 用量" rows exactly as the live stream showed
 * them. One JSONL file per ZCode session under the plugin's data directory.
 */

export interface TurnUsageEntry {
  turnId: string;
  recordedAt: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  speedTokPerSec?: number;
}

/** Keep replay bounded: appended rows beyond this count are trimmed away. */
const MAX_ENTRIES = 400;

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseTurnUsageEntry(value: unknown): TurnUsageEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.turnId !== "string" || !raw.turnId) return undefined;
  if (typeof raw.recordedAt !== "number") return undefined;
  return {
    turnId: raw.turnId,
    recordedAt: raw.recordedAt,
    ...numberField(raw.inputTokens) !== undefined ? { inputTokens: raw.inputTokens as number } : {},
    ...numberField(raw.outputTokens) !== undefined ? { outputTokens: raw.outputTokens as number } : {},
    ...numberField(raw.cacheReadTokens) !== undefined ? { cacheReadTokens: raw.cacheReadTokens as number } : {},
    ...numberField(raw.cacheWriteTokens) !== undefined ? { cacheWriteTokens: raw.cacheWriteTokens as number } : {},
    ...numberField(raw.speedTokPerSec) !== undefined ? { speedTokPerSec: raw.speedTokPerSec as number } : {},
  };
}

function usageFile(directory: string, zcodeSessionId: string): string {
  // Session ids are plain slugs today; encode defensively so a hostile value
  // can never escape the directory.
  return join(directory, `${encodeURIComponent(zcodeSessionId)}.jsonl`);
}

/** Append one settled turn's usage. Best-effort: failures never disturb the turn. */
export function recordTurnUsage(directory: string, zcodeSessionId: string, entry: TurnUsageEntry): void {
  try {
    mkdirSync(directory, { recursive: true });
    const file = usageFile(directory, zcodeSessionId);
    appendFileSync(file, JSON.stringify(entry) + "\n");
    // Trim in the same step so the file cannot grow unbounded across turns.
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n").filter(Boolean);
    if (lines.length > MAX_ENTRIES * 2) {
      writeFileSync(file, lines.slice(-MAX_ENTRIES).join("\n") + "\n");
    }
  } catch {
    // Usage persistence is a replay nicety; keep the agent running regardless.
  }
}

/** Read settled turn usages in append order, bounded to the newest entries. */
export function readTurnUsages(
  directory: string,
  zcodeSessionId: string,
  maxEntries = MAX_ENTRIES,
): TurnUsageEntry[] {
  try {
    const lines = readFileSync(usageFile(directory, zcodeSessionId), "utf8").split("\n").filter(Boolean);
    const entries: TurnUsageEntry[] = [];
    for (const line of lines) {
      try {
        const entry = parseTurnUsageEntry(JSON.parse(line));
        if (entry) entries.push(entry);
      } catch {
        // Skip a torn line; append order of the rest is unaffected.
      }
    }
    return entries.length > maxEntries ? entries.slice(-maxEntries) : entries;
  } catch {
    return [];
  }
}
