import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { QuestionForm } from "./question-card.ts";

/**
 * Pending ask_user_question cards survive plugin reloads and daemon restarts.
 * The store is deliberately small and bounded: the card message id, the form
 * definitions (needed to parse later clicks) and whatever answers have already
 * been collected. Maps are stored as string-keyed objects because JSON has no
 * map type.
 */
export interface PendingQuestion {
  requestId: string;
  agentId: string;
  chatId: string;
  topicKey: string | null;
  questions: QuestionForm[];
  answers: Map<number, string>;
  cardMessageId?: string;
  createdAt: number;
}

const storedQuestionSchema = z.object({
  requestId: z.string().min(1),
  agentId: z.string().min(1),
  chatId: z.string().min(1),
  topicKey: z.string().nullable().default(null),
  questions: z.array(
    z.object({
      header: z.string(),
      question: z.string(),
      options: z.array(
        z.object({
          label: z.string(),
          description: z.string().optional(),
        }),
      ),
      multiSelect: z.boolean(),
      allowOther: z.boolean(),
      allowEmpty: z.boolean(),
    }),
  ),
  answers: z.record(z.string(), z.string()).default({}),
  cardMessageId: z.string().optional(),
  createdAt: z.number(),
});

const pendingStoreSchema = z.object({
  version: z.number().default(1),
  pending: z.array(z.unknown()).default([]),
});

/**
 * Read the pending-question store. A corrupt file or a single malformed entry
 * never takes down the plugin; valid entries are preserved.
 */
export function readPendingQuestions(path: string | undefined): PendingQuestion[] {
  if (!path) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const envelope = pendingStoreSchema.safeParse(raw);
  if (!envelope.success || envelope.data.version !== 1) return [];

  const pending: PendingQuestion[] = [];
  for (const item of envelope.data.pending) {
    const parsed = storedQuestionSchema.safeParse(item);
    if (!parsed.success) continue;
    const record = parsed.data;
    const answers = new Map<number, string>();
    for (const [index, answer] of Object.entries(record.answers)) {
      const questionIndex = Number(index);
      if (Number.isInteger(questionIndex) && questionIndex >= 0) {
        answers.set(questionIndex, answer);
      }
    }
    pending.push({
      ...record,
      answers,
      ...(record.cardMessageId ? { cardMessageId: record.cardMessageId } : {}),
    });
  }
  return pending;
}

/** Atomically replace the pending-question store (tmp file + rename). */
export function writePendingQuestions(
  path: string | undefined,
  pending: Iterable<PendingQuestion>,
): void {
  if (!path) return;
  const entries = [...pending].map((entry) => ({
    ...entry,
    answers: Object.fromEntries(
      [...entry.answers].map(([index, answer]) => [String(index), answer]),
    ),
  }));
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, pending: entries }), { mode: 0o600 });
  renameSync(temporary, path);
}
