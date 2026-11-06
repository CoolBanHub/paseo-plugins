import { closeSync, openSync, readSync, statSync } from "node:fs";

/**
 * Incremental reader for the JSONL sidecars the in-dsh bridge appends to.
 *
 * The previous implementation re-read the whole file on every poll and kept
 * only a character offset, which made long sessions quadratic in both CPU and
 * allocations while the file itself grew without bound. This reader:
 *
 * - skips the read entirely when `stat` reports no growth;
 * - reads only the newly appended bytes from the last consumed offset;
 * - tolerates the bridge's on-the-spot compaction (the file is rewritten with
 *   only its recent tail): a shrink resets the byte offset while the highest
 *   seen record number survives, so re-read records are skipped instead of
 *   being re-emitted as duplicate timeline rows.
 */

export interface SidecarTailRecord {
  n?: unknown;
  [key: string]: unknown;
}

export class SidecarTail {
  private offset = 0;
  private lastRecord = 0;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /**
   * Consume newly appended complete lines. The handler returns false to stop
   * (its consumer went away); remaining records are retried on the next call
   * because the offset only advances past the whole consumed chunk.
   */
  drain(handler: (record: SidecarTailRecord) => boolean): void {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return;
    }
    if (size === this.offset) return;
    if (size < this.offset) this.offset = 0; // the bridge compacted the file
    if (size === this.offset) return;

    const length = size - this.offset;
    const buffer = Buffer.allocUnsafe(length);
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return;
    }
    try {
      let read = 0;
      while (read < length) {
        const bytes = readSync(fd, buffer, read, length - read, this.offset + read);
        if (bytes <= 0) break;
        read += bytes;
      }
      if (read < length) return; // shrank mid-read; retry on the next poll
      const text = buffer.toString("utf8");
      // Only consume up to the last complete line: a read racing the bridge's
      // append can observe a partially written record.
      const lastNewline = text.lastIndexOf("\n");
      if (lastNewline === -1) return;
      const chunk = text.slice(0, lastNewline);
      this.offset += lastNewline + 1;
      let alive = true;
      for (const line of chunk.split("\n")) {
        if (!alive) break;
        if (!line.trim()) continue;
        let record: SidecarTailRecord;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
          record = parsed as SidecarTailRecord;
        } catch {
          continue;
        }
        if (typeof record.n === "number" && Number.isFinite(record.n)) {
          if (record.n <= this.lastRecord) continue; // already emitted pre-compaction
          this.lastRecord = record.n;
        }
        alive = handler(record);
      }
    } finally {
      closeSync(fd);
    }
  }
}
