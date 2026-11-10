/**
 * Long-reply splitting for Feishu. Feishu rejects very large messages, and
 * clipping silently loses the end of code answers. Split on line boundaries
 * instead, keep fenced code blocks valid by closing/reopening them, and cap
 * the number of parts so one answer cannot flood a topic.
 */

export interface SplitResult {
  chunks: string[];
  /** True when even the capped parts could not carry the whole text. */
  clipped: boolean;
}

const FENCE = /^\s*(```|~~~)/;
const CLOSING_FENCE = "\n```";
/** Leave room for the part label ("（3/4）") the dispatcher appends. */
const LABEL_RESERVE = 12;

/** Split one pathological line (long URL / minified code) into pieces. */
function breakLongLine(line: string, limit: number): string[] {
  const chars = Array.from(line);
  if (chars.length <= limit) return [line];
  const pieces: string[] = [];
  for (let index = 0; index < chars.length; index += limit) {
    pieces.push(chars.slice(index, index + limit).join(""));
  }
  return pieces;
}

/**
 * Split `text` into at most `maxChunks` parts, each at most `limit`
 * characters (except a merged tail when the cap is exceeded, which is
 * clipped and reported).
 */
export function splitReply(text: string, limit: number, maxChunks = 4): SplitResult {
  const trimmed = text.trim();
  if (!trimmed) return { chunks: [""], clipped: false };
  if (trimmed.length <= limit) return { chunks: [trimmed], clipped: false };
  const safeLimit = Math.max(80, limit - LABEL_RESERVE);

  const sourceLines = trimmed.split(/\r?\n/);
  const lines: string[] = [];
  for (const line of sourceLines) {
    if (line.length > safeLimit) lines.push(...breakLongLine(line, safeLimit));
    else lines.push(line);
  }

  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  /** Opening fence line while inside a code block, else null. */
  let openFence: string | null = null;

  const flush = (): void => {
    if (current.length === 0) return;
    const body = current.join("\n");
    chunks.push(openFence ? body + CLOSING_FENCE : body);
    // Re-open the same fence (including its language tag) in the next part.
    current = openFence ? [openFence] : [];
    currentLen = openFence ? openFence.length + 1 : 0;
  };

  for (const line of lines) {
    const fenceLine = FENCE.test(line);
    // A fence line toggles the block; it is a closing fence when one is open.
    const nextFence: string | null = fenceLine ? (openFence ? null : line.trim()) : openFence;
    const separator = current.length > 0 ? 1 : 0;
    const reserve = nextFence ? CLOSING_FENCE.length : 0;
    const needed = line.length + separator + reserve;

    if (currentLen + needed > safeLimit && current.length > 0) {
      flush();
      // The reopened fence may leave too little room for this line; a fence
      // line itself is tiny and still fits, content lines are emitted as-is.
    }
    const separatorAfterFlush = current.length > 0 ? 1 : 0;
    current.push(line);
    currentLen += line.length + separatorAfterFlush;
    openFence = nextFence;
  }
  if (current.length > 0) {
    const body = current.join("\n");
    chunks.push(openFence ? body + CLOSING_FENCE : body);
  }

  if (chunks.length <= maxChunks) return { chunks, clipped: false };

  const kept = chunks.slice(0, maxChunks - 1);
  const tail = chunks.slice(maxChunks - 1).join("\n");
  if (tail.length <= limit) {
    kept.push(tail);
    return { chunks: kept, clipped: false };
  }
  kept.push(tail.slice(0, limit - 1) + "…");
  return { chunks: kept, clipped: true };
}
