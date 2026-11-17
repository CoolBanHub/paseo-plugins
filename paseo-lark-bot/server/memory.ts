import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Per-chat correction memory, written from chat with `/remember` and injected
 * into every later turn of that chat (see the dispatcher's prompt assembly).
 *
 * Scope is the chat binding rather than a topic: a correction like "don't use
 * internal codenames" applies to every future topic in that group. Entries are
 * plain text; the store owns ids, ordering, de-duplication and the prompt
 * budget. The file is written atomically (tmp + rename) and never contains
 * anything the user did not type.
 */
export interface MemoryEntry {
  id: number;
  text: string;
  createdAt: number;
  createdBy: string;
}

export interface MemoryStore {
  /** Store one rule; an identical rule refreshes its timestamp instead of duplicating. */
  remember(chatId: string, text: string, createdBy: string): MemoryEntry | null;
  list(chatId: string): MemoryEntry[];
  /** Delete by id (`3`) or `#3`; returns the removed entry, or null. */
  forget(chatId: string, target: string): MemoryEntry | null;
  /** Prompt block for the next turn, or null when this chat has no memory. */
  promptFor(chatId: string): string | null;
  /** Serialized form for the settings/status surfaces. */
  stats(chatId: string): { count: number };
}

export interface MemoryStoreOptions {
  now?: () => number;
  /** Called when the store cannot be persisted (the in-memory copy still works). */
  log?: (message: string) => void;
  /** Entries kept per chat (oldest dropped). Default 50. */
  maxEntries?: number;
  /** Entries injected per turn. Default 20. */
  maxPromptEntries?: number;
  /** Character budget for the injected block. Default 3000. */
  maxPromptChars?: number;
}

interface StoredMemory {
  version: 1;
  chats: Record<string, MemoryEntry[]>;
}

export const MEMORY_MAX_ENTRIES = 50;
export const MEMORY_PROMPT_ENTRIES = 20;
export const MEMORY_PROMPT_CHARS = 3000;

function sanitizeText(value: string): string {
  // One entry stays one prompt line: collapse newlines but keep the wording.
  return value.replace(/\s+/g, " ").trim();
}

function dateOf(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function load(path: string | null): Record<string, MemoryEntry[]> {
  if (!path) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredMemory>;
    const chats = parsed?.chats;
    if (!chats || typeof chats !== "object") return {};
    const output: Record<string, MemoryEntry[]> = {};
    for (const [chatId, entries] of Object.entries(chats)) {
      if (!Array.isArray(entries)) continue;
      output[chatId] = entries
        .filter((entry): entry is MemoryEntry =>
          Boolean(entry) &&
          typeof entry === "object" &&
          typeof entry.id === "number" &&
          typeof entry.text === "string" &&
          typeof entry.createdAt === "number" &&
          typeof entry.createdBy === "string",
        )
        .map((entry) => ({ ...entry, text: sanitizeText(entry.text) }))
        .filter((entry) => entry.text.length > 0)
        .sort((a, b) => a.id - b.id);
    }
    return output;
  } catch {
    // Absent or unreadable store; start empty rather than breaking chat.
    return {};
  }
}

function save(
  path: string | null,
  chats: Record<string, MemoryEntry[]>,
  log?: (message: string) => void,
): void {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    const payload: StoredMemory = { version: 1, chats };
    writeFileSync(temporary, JSON.stringify(payload), { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    // Best effort: the in-memory copy keeps this plugin lifetime usable, but
    // say so in the plugin log instead of pretending the rule was persisted.
    log?.(`memory store write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Format the entries for `/memory`; ids are stable and used by `/forget`. */
export function formatMemoryList(entries: MemoryEntry[]): string {
  if (entries.length === 0) {
    return "本会话还没有记忆。发 `/remember <规则>` 记下需要长期遵守的纠正。";
  }
  const lines = [`**本会话记忆（${entries.length} 条）**`];
  for (const entry of entries) {
    lines.push(`#${entry.id} · ${dateOf(entry.createdAt)} · ${entry.text}`);
  }
  lines.push("", "用 `/forget <编号>` 删除；记忆会进入后续每条消息的提示词。");
  return lines.join("\n");
}

export function createMemoryStore(path: string | null, options: MemoryStoreOptions = {}): MemoryStore {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? MEMORY_MAX_ENTRIES;
  const maxPromptEntries = options.maxPromptEntries ?? MEMORY_PROMPT_ENTRIES;
  const maxPromptChars = options.maxPromptChars ?? MEMORY_PROMPT_CHARS;
  const log = options.log;
  const chats = load(path);

  const nextId = (entries: MemoryEntry[]): number =>
    entries.reduce((max, entry) => Math.max(max, entry.id), 0) + 1;

  function remember(chatId: string, text: string, createdBy: string): MemoryEntry | null {
    const rule = sanitizeText(text);
    if (!rule) return null;
    const entries = chats[chatId] ?? [];
    const existing = entries.find((entry) => entry.text === rule);
    const timestamp = now();
    if (existing) {
      existing.createdAt = timestamp;
      existing.createdBy = createdBy;
      chats[chatId] = entries;
      save(path, chats, log);
      return existing;
    }
    const entry: MemoryEntry = {
      id: nextId(entries),
      text: rule,
      createdAt: timestamp,
      createdBy,
    };
    entries.push(entry);
    // Keep the newest N; ids stay monotonic so `/forget` references remain clear.
    chats[chatId] = entries.slice(-maxEntries);
    save(path, chats);
    return entry;
  }

  function list(chatId: string): MemoryEntry[] {
    return [...(chats[chatId] ?? [])];
  }

  function forget(chatId: string, target: string): MemoryEntry | null {
    const id = Number(target.replace(/^#/, "").trim());
    if (!Number.isInteger(id) || id <= 0) return null;
    const entries = chats[chatId] ?? [];
    const index = entries.findIndex((entry) => entry.id === id);
    if (index < 0) return null;
    const [removed] = entries.splice(index, 1);
    chats[chatId] = entries;
    save(path, chats);
    return removed ?? null;
  }

  function promptFor(chatId: string): string | null {
    const entries = chats[chatId] ?? [];
    if (entries.length === 0) return null;
    const selected: string[] = [];
    let budget = maxPromptChars;
    // Recency comes from the timestamp (a refreshed rule keeps its id/position
    // but counts as the newest), then the last N are rendered chronologically.
    const byRecency = [...entries].sort(
      (a, b) => a.createdAt - b.createdAt || a.id - b.id,
    );
    for (const entry of byRecency.reverse()) {
      const line = `- ${dateOf(entry.createdAt)}：${entry.text}`;
      if (selected.length >= maxPromptEntries) break;
      if (line.length > budget && selected.length > 0) break;
      selected.unshift(line);
      budget -= line.length + 1;
    }
    const omitted = entries.length - selected.length;
    return [
      "### 会话记忆（长期有效）",
      ...selected,
      ...(omitted > 0 ? [`（另有 ${omitted} 条较早记忆未展开，可发 /memory 查看）`] : []),
      "以上是该会话管理员明确要求你遵守的纠正，适用于后续所有回答；与当前消息冲突时以当前消息为准并说明。",
    ].join("\n");
  }

  return {
    remember,
    list,
    forget,
    promptFor,
    stats: (chatId) => ({ count: (chats[chatId] ?? []).length }),
  };
}
