import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";

/**
 * dsh persists every ACP `session/new` as a real Session. Catalog discovery
 * opens throwaway sessions that only contain initialization events; they are
 * hidden from Paseo's own session list, but the dsh Web GUI has no such
 * filter and shows them as untitled "Ungrouped" rows. Remove those logs after
 * the probe process is done.
 *
 * Cleanup is deliberately conservative: a Session is only removed when its
 * log has no conversation event (user, assistant or tool) and the Session is
 * not archived or attached to a Workspace. Anything uncertain is left on
 * disk.
 */

const SESSION_LOG_PATTERN = /^session\..*\.jsonl(?:\.zstd)?$/;
const MAX_PROBE_LOG_BYTES = 512 * 1024;
const MAX_PROBE_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_LOG_BYTES = 32 * 1024 * 1024;
const MAX_HISTORY_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_HISTORY_EVENTS = 50_000;

export interface DshSessionEvent {
  type: string;
  seq?: number;
  time?: number;
  data?: Record<string, unknown>;
  /**
   * Surface operation of a message-producing event. dsh's ordered surface is
   * defined by these ops (`append`, or `replace` shadowing an earlier seq
   * range); history replay keeps only events still on the surface, which is
   * what makes rewind markers and compaction checkpoints disappear correctly.
   */
  surfaceOp?: { op?: unknown; startSeq?: unknown; endSeq?: unknown };
}

export interface ProbeCleanupOptions {
  /** dsh home; defaults to `DSH_HOME` or `~/.dsh`. */
  home?: string;
  /** Workspace members and archived Sessions that must never be removed. */
  protectedIds?: ReadonlySet<string>;
  /** Skip Sessions modified more recently than this many milliseconds. */
  minAgeMs?: number;
}

/** Resolve the dsh home used by the ACP process this plugin spawns. */
export function dshHomePath(): string {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

function normalizeSessionId(sessionId: string): string {
  return sessionId.replace(/^session-/, "");
}

function sessionLogPath(sessionDir: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(sessionDir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (!SESSION_LOG_PATTERN.test(name)) continue;
    const path = join(sessionDir, name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/**
 * dsh appends one zstd frame per durable flush, and Node's zstd APIs (both
 * `zstdDecompressSync` and `createZstdDecompress`) decode only the first
 * frame of a multi-frame file. Scan for frame magics and decode each frame
 * from its own offset — `zstdDecompressSync` ignores trailing bytes after a
 * frame, so no boundary arithmetic is needed. False-positive magics inside a
 * frame's compressed payload either fail to decode (skipped) or produce text
 * that line-level JSON validation drops.
 */
function decodeZstdFrames(data: Buffer, maxTotalOutput: number): string | undefined {
  const decompress = (zlib as typeof zlib & {
    zstdDecompressSync?: (buffer: Buffer, options?: { maxOutputLength?: number }) => Buffer;
  }).zstdDecompressSync;
  if (typeof decompress !== "function") return undefined;
  const parts: Buffer[] = [];
  let total = 0;
  for (let offset = 0; offset + 4 <= data.length; offset += 1) {
    if (data[offset] !== 0x28 || data[offset + 1] !== 0xb5 || data[offset + 2] !== 0x2f || data[offset + 3] !== 0xfd) {
      continue;
    }
    try {
      const out = decompress(data.subarray(offset), { maxOutputLength: maxTotalOutput });
      parts.push(out);
      total += out.length;
      if (total > maxTotalOutput) return undefined;
    } catch {
      // Not a real frame start; keep scanning.
    }
  }
  return parts.length ? Buffer.concat(parts).toString("utf8") : undefined;
}

function readSessionLog(sessionDir: string, maxBytes = MAX_PROBE_LOG_BYTES): string | undefined {
  const path = sessionLogPath(sessionDir);
  if (!path) return undefined;
  try {
    if (statSync(path).size > maxBytes) return undefined;
    const data = readFileSync(path);
    if (!path.endsWith(".zstd")) return data.toString("utf8");
    const maxOutputLength = maxBytes === MAX_PROBE_LOG_BYTES
      ? MAX_PROBE_OUTPUT_BYTES
      : MAX_HISTORY_OUTPUT_BYTES;
    return decodeZstdFrames(data, maxOutputLength);
  } catch {
    return undefined;
  }
}

/** Read a bounded, validated copy of one durable dsh session log for UI replay. */
export function readDshSessionEvents(
  sessionId: string,
  options: Pick<ProbeCleanupOptions, "home"> = {},
): DshSessionEvent[] | undefined {
  const log = readHistoryLogText(sessionId, options);
  if (log === undefined) return undefined;
  return parseSessionEvents(log);
}

/**
 * Tail-bounded variant used by history replay. Oversized logs no longer
 * disable replay: the newest `MAX_HISTORY_EVENTS` events are kept instead of
 * failing the whole session, matching the timeline's own newest-4,000-item
 * window. Reading is async because the zstd path streams through Node's
 * decompressor with a bounded ring buffer rather than materializing the
 * full (potentially >128 MiB) output.
 */
export async function readDshSessionEventsTail(
  sessionId: string,
  options: Pick<ProbeCleanupOptions, "home"> = {},
): Promise<DshSessionEvent[] | undefined> {
  const log = await readHistoryLogTextTail(sessionId, options);
  if (log === undefined) return undefined;
  return parseSessionEvents(log);
}

function parseSessionEvents(log: string): DshSessionEvent[] | undefined {
  const events: DshSessionEvent[] = [];
  try {
    for (const line of log.split("\n")) {
      if (!line) continue;
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const event = parsed as Record<string, unknown>;
      if (event.type === "session") continue;
      if (typeof event.type !== "string") continue;
      events.push({
        type: event.type,
        ...(typeof event.seq === "number" ? { seq: event.seq } : {}),
        ...(typeof event.time === "number" ? { time: event.time } : {}),
        ...(event.data && typeof event.data === "object" && !Array.isArray(event.data)
          ? { data: event.data as Record<string, unknown> }
          : {}),
        ...(event.surfaceOp && typeof event.surfaceOp === "object" && !Array.isArray(event.surfaceOp)
          ? { surfaceOp: event.surfaceOp as DshSessionEvent["surfaceOp"] }
          : {}),
      });
    }
  } catch {
    return undefined;
  }
  return events.length > MAX_HISTORY_EVENTS ? events.slice(-MAX_HISTORY_EVENTS) : events;
}

function readHistoryLogText(
  sessionId: string,
  options: Pick<ProbeCleanupOptions, "home">,
): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId)) return undefined;
  const sessionDir = findSessionDirectory(sessionId, options.home ?? dshHomePath());
  if (!sessionDir) return undefined;
  return readSessionLog(sessionDir, MAX_HISTORY_LOG_BYTES);
}

/**
 * Oversized plain logs are tail-read directly; every zstd log is streamed
 * through the decompressor with a bounded ring buffer so the newest lines
 * survive whatever the total decompressed size is.
 */
async function readHistoryLogTextTail(
  sessionId: string,
  options: Pick<ProbeCleanupOptions, "home">,
): Promise<string | undefined> {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId)) return undefined;
  const sessionDir = findSessionDirectory(sessionId, options.home ?? dshHomePath());
  if (!sessionDir) return undefined;
  const path = sessionLogPath(sessionDir);
  if (!path) return undefined;
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return undefined;
  }
  if (!path.endsWith(".zstd")) {
    if (size <= MAX_HISTORY_LOG_BYTES) {
      try {
        return readFileSync(path).toString("utf8");
      } catch {
        return undefined;
      }
    }
    // Read only the newest capped window, aligned to the first full line.
    const buffer = Buffer.alloc(MAX_HISTORY_LOG_BYTES);
    const fd = openSync(path, "r");
    try {
      let read = 0;
      const start = size - MAX_HISTORY_LOG_BYTES;
      while (read < MAX_HISTORY_LOG_BYTES) {
        const bytes = readSync(fd, buffer, read, MAX_HISTORY_LOG_BYTES - read, start + read);
        if (bytes <= 0) break;
        read += bytes;
      }
    } finally {
      closeSync(fd);
    }
    const text = buffer.toString("utf8");
    const firstNewline = text.indexOf("\n");
    return firstNewline === -1 ? text : text.slice(firstNewline + 1);
  }
  return streamZstdTail(path);
}

const ZSTD_STREAM_TIMEOUT_MS = 30_000;
/** Ring-buffer budget for one streamed session log, in decompressed bytes. */
const ZSTD_TAIL_BUDGET_BYTES = 96 * 1024 * 1024;
/** Compressed session logs beyond this size are not read whole. */
const ZSTD_MAX_FILE_BYTES = 128 * 1024 * 1024;

/**
 * Tail of a (multi-frame) zstd log, decoded frame by frame with a bounded
 * ring buffer over complete lines.
 */
function streamZstdTail(path: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let data: Buffer;
    try {
      if (statSync(path).size > ZSTD_MAX_FILE_BYTES) {
        resolve(undefined);
        return;
      }
      data = readFileSync(path);
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => resolve(undefined), ZSTD_STREAM_TIMEOUT_MS);
    timer.unref();
    try {
      const text = decodeZstdFrames(data, ZSTD_TAIL_BUDGET_BYTES) ?? "";
      const lines: string[] = [];
      let total = 0;
      for (const line of text.split("\n")) {
        lines.push(line);
        total += line.length + 1;
        while (total > ZSTD_TAIL_BUDGET_BYTES || lines.length > MAX_HISTORY_EVENTS) {
          const dropped = lines.shift();
          if (dropped === undefined) break;
          total -= dropped.length + 1;
        }
      }
      while (lines.length && !lines[0].trim()) lines.shift();
      clearTimeout(timer);
      resolve(lines.join("\n"));
    } catch {
      clearTimeout(timer);
      resolve(undefined);
    }
  });
}

/** Last modification time of a session log, for Paseo's session list. */
export function dshSessionUpdatedAt(
  sessionId: string,
  options: Pick<ProbeCleanupOptions, "home"> = {},
): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId)) return undefined;
  const sessionDir = findSessionDirectory(sessionId, options.home ?? dshHomePath());
  if (!sessionDir) return undefined;
  const path = sessionLogPath(sessionDir);
  if (!path) return undefined;
  try {
    return new Date(statSync(path).mtimeMs).toISOString();
  } catch {
    return undefined;
  }
}

function hasConversationEvent(log: string): boolean {
  // Catalog probes only carry initialization records. Any user, assistant or
  // tool event means the session was actually used and must be preserved.
  // A literal prompt containing one of these markers can only make cleanup
  // more conservative.
  return (
    log.includes('"type":"user/') ||
    log.includes('"type":"assistant/') ||
    log.includes('"type":"tool/')
  );
}

function findSessionDirectory(sessionId: string, home: string): string | undefined {
  const root = join(home, "sessions");
  let cwdDirs: string[];
  try {
    cwdDirs = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const cwdDir of cwdDirs) {
    const candidate = join(root, cwdDir, sessionId);
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Not this cwd bucket.
    }
  }
  return undefined;
}

function indexSessionDirectories(home: string): Map<string, string> {
  const index = new Map<string, string>();
  const root = join(home, "sessions");
  let cwdDirs: string[];
  try {
    cwdDirs = readdirSync(root);
  } catch {
    return index;
  }
  for (const cwdDir of cwdDirs) {
    const parent = join(root, cwdDir);
    let entries: string[];
    try {
      entries = readdirSync(parent);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = join(parent, entry);
      try {
        if (statSync(candidate).isDirectory()) index.set(entry, candidate);
      } catch {
        // Vanished or not a directory.
      }
    }
  }
  return index;
}

function sessionMtimeMs(sessionDir: string): number {
  let latest = 0;
  try {
    for (const name of readdirSync(sessionDir)) {
      try {
        latest = Math.max(latest, statSync(join(sessionDir, name)).mtimeMs);
      } catch {
        // File vanished while scanning.
      }
    }
  } catch {
    // Directory unreadable; callers fall back to not deleting.
  }
  return latest;
}

function removeProjectionCache(sessionId: string, home: string): void {
  const cacheDir = join(home, "storages", "session_projcache", "sessions");
  for (const name of [
    `${sessionId}.json`,
    `session-${sessionId}.json`,
    `.${sessionId}.tmp`,
  ]) {
    try {
      rmSync(join(cacheDir, name), { force: true });
    } catch {
      // A stale cache entry is regenerated or ignored; never fail cleanup.
    }
  }
}

/** Read the Workspace registry once and return the IDs cleanup must preserve. */
export function loadProtectedSessionIds(home = dshHomePath()): ReadonlySet<string> {
  const ids = new Set<string>();
  try {
    const parsed = JSON.parse(
      readFileSync(join(home, "storages", "workspace.json"), "utf8"),
    ) as {
      global?: { archivedSessionIds?: unknown };
      tables?: { workspaces?: Record<string, { sessionIds?: unknown }> };
    };
    const add = (value: unknown): void => {
      if (typeof value === "string") ids.add(normalizeSessionId(value));
    };
    if (Array.isArray(parsed.global?.archivedSessionIds)) {
      for (const id of parsed.global.archivedSessionIds) add(id);
    }
    for (const workspace of Object.values(parsed.tables?.workspaces ?? {})) {
      if (Array.isArray(workspace?.sessionIds)) {
        for (const id of workspace.sessionIds) add(id);
      }
    }
  } catch {
    // No Workspace registry yet; nothing is protected.
  }
  return ids;
}

/**
 * Remove one Session directory when it is an empty catalog probe.
 *
 * @returns true only when the directory was actually removed.
 */
export function removeEmptyProbeSession(
  sessionId: string,
  options: ProbeCleanupOptions = {},
): boolean {
  const home = options.home ?? dshHomePath();
  const protectedIds = options.protectedIds ?? loadProtectedSessionIds(home);
  if (protectedIds.has(normalizeSessionId(sessionId))) return false;

  const sessionDir = findSessionDirectory(sessionId, home);
  if (!sessionDir) return false;

  if (options.minAgeMs !== undefined) {
    const mtime = sessionMtimeMs(sessionDir);
    if (mtime > 0 && Date.now() - mtime < options.minAgeMs) return false;
  }

  const log = readSessionLog(sessionDir);
  if (log === undefined || hasConversationEvent(log)) return false;

  try {
    rmSync(sessionDir, { recursive: true, force: true });
  } catch {
    return false;
  }
  removeProjectionCache(sessionId, home);
  return true;
}

/**
 * Remove stale empty probes left behind by a crash or plugin reload.
 *
 * @returns the Session ids whose directories were removed.
 */
export function sweepEmptyProbeSessions(
  sessionIds: Iterable<string>,
  options: ProbeCleanupOptions = {},
): string[] {
  const home = options.home ?? dshHomePath();
  const protectedIds = options.protectedIds ?? loadProtectedSessionIds(home);
  const index = indexSessionDirectories(home);
  const removed: string[] = [];

  for (const sessionId of sessionIds) {
    if (protectedIds.has(normalizeSessionId(sessionId))) continue;
    const sessionDir = index.get(sessionId);
    if (!sessionDir) continue;
    if (options.minAgeMs !== undefined) {
      const mtime = sessionMtimeMs(sessionDir);
      if (mtime > 0 && Date.now() - mtime < options.minAgeMs) continue;
    }
    const log = readSessionLog(sessionDir);
    if (log === undefined || hasConversationEvent(log)) continue;
    try {
      rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      continue;
    }
    removeProjectionCache(sessionId, home);
    removed.push(sessionId);
  }
  return removed;
}
