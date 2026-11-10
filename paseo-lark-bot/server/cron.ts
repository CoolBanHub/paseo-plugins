import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * Scheduled prompts ("每天早上总结 GitHub trending"). Jobs live in a small
 * JSON store under plugin-data and fire as one-shot agents whose answer is
 * posted to the bound chat. The scheduler is intentionally simple: a 5-field
 * cron expression evaluated in the daemon's local timezone at minute
 * granularity, with missed runs skipped instead of replayed.
 */

export const cronJobSchema = z.object({
  id: z.string().min(1),
  chatId: z.string().min(1),
  /** Topic to post into; null means the chat's main stream. */
  topicKey: z.string().nullable().default(null),
  expression: z.string().min(1),
  prompt: z.string().min(1),
  enabled: z.boolean().default(true),
  /** Suppress the "no output" / success notice text. */
  silent: z.boolean().default(false),
  createdBy: z.string().default(""),
  createdAt: z.number(),
  lastRunAt: z.number().nullable().default(null),
  nextRunAt: z.number().nullable().default(null),
  lastError: z.string().nullable().default(null),
});

export type CronJob = z.output<typeof cronJobSchema>;

const storeSchema = z.object({
  version: z.number().default(1),
  jobs: z.array(z.unknown()).default([]),
});

const MAX_JOBS = 50;
const FIELD_RANGES: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 = Sunday)
];

export class CronField {
  private readonly values: Set<number>;

  constructor(text: string, min: number, max: number) {
    this.values = new Set();
    for (const part of text.split(",")) {
      const piece = part.trim();
      if (!piece) throw new Error("空的 cron 字段");
      const [rangeText, stepText] = piece.split("/");
      const step = stepText === undefined ? 1 : Number(stepText);
      if (!Number.isInteger(step) || step <= 0) throw new Error("cron 步长无效：" + piece);
      let start = min;
      let end = max;
      if (rangeText !== "*") {
        if (!rangeText) throw new Error("cron 字段无效：" + piece);
        if (rangeText.includes("-")) {
          const [left, right] = rangeText.split("-");
          start = Number(left);
          end = Number(right);
        } else {
          start = Number(rangeText);
          end = stepText === undefined ? start : max;
        }
      }
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
        throw new Error(`cron 字段超出范围（${min}-${max}）：${piece}`);
      }
      for (let value = start; value <= end; value += step) this.values.add(value);
    }
    if (this.values.size === 0) throw new Error("cron 字段为空");
  }

  has(value: number): boolean {
    return this.values.has(value);
  }
}

export interface ParsedCron {
  minutes: CronField;
  hours: CronField;
  days: CronField;
  months: CronField;
  weekdays: CronField;
}

/** Parse a standard 5-field cron expression (local time). */
export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron 需要 5 个字段：分 时 日 月 周");
  return {
    minutes: new CronField(fields[0]!, FIELD_RANGES[0]![0], FIELD_RANGES[0]![1]),
    hours: new CronField(fields[1]!, FIELD_RANGES[1]![0], FIELD_RANGES[1]![1]),
    days: new CronField(fields[2]!, FIELD_RANGES[2]![0], FIELD_RANGES[2]![1]),
    months: new CronField(fields[3]!, FIELD_RANGES[3]![0], FIELD_RANGES[3]![1]),
    weekdays: new CronField(fields[4]!, FIELD_RANGES[4]![0], FIELD_RANGES[4]![1]),
  };
}

export function validateCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

/**
 * Next matching minute strictly after `afterMs`. Both day-of-month and
 * day-of-week constraints are ANDed only when both are restricted, matching
 * common cron implementations closely enough for chat reminders.
 */
export function nextCronTime(expression: string, afterMs: number): number {
  const parsed = parseCron(expression);
  const date = new Date(afterMs + 60_000);
  date.setSeconds(0, 0);
  const limit = afterMs + 366 * 24 * 60 * 60_000;
  while (date.getTime() <= limit) {
    if (
      parsed.minutes.has(date.getMinutes()) &&
      parsed.hours.has(date.getHours()) &&
      parsed.months.has(date.getMonth() + 1) &&
      parsed.days.has(date.getDate()) &&
      parsed.weekdays.has(date.getDay())
    ) {
      return date.getTime();
    }
    date.setMinutes(date.getMinutes() + 1);
  }
  throw new Error("cron 在未来一年内没有匹配时间");
}

/** Human-readable local timestamp for notices and the status page. */
export function formatCronTime(ms: number | null): string {
  if (!ms) return "—";
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function readCronJobs(path: string | undefined): CronJob[] {
  if (!path) return [];
  try {
    const parsed = storeSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) return [];
    const jobs: CronJob[] = [];
    for (const item of parsed.data.jobs) {
      const job = cronJobSchema.safeParse(item);
      if (job.success) jobs.push(job.data);
    }
    return jobs.slice(-MAX_JOBS);
  } catch {
    return [];
  }
}

export interface CronSchedulerOptions {
  storePath?: string;
  /** Injected clock for tests. */
  now?: () => number;
  /** Runs one job; must resolve even on failure (the scheduler records it). */
  runJob: (job: CronJob) => Promise<void>;
  log?: (message: string, detail?: unknown) => void;
  /** Poll interval (default 30s). */
  intervalMs?: number;
  /** Write debounce (default 1s). */
  saveDebounceMs?: number;
}

export function createCronScheduler(options: CronSchedulerOptions) {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const jobs = new Map<string, CronJob>();
  for (const job of readCronJobs(options.storePath)) {
    // Recompute on load: the daemon may have been down across a due time.
    try {
      job.nextRunAt = job.enabled ? nextCronTime(job.expression, now()) : null;
    } catch (error) {
      job.enabled = false;
      job.lastError = error instanceof Error ? error.message : String(error);
      job.nextRunAt = null;
    }
    jobs.set(job.id, job);
  }
  const running = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function saveNow(): void {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!options.storePath) return;
    try {
      mkdirSync(dirname(options.storePath), { recursive: true });
      const temporary = `${options.storePath}.tmp`;
      writeFileSync(
        temporary,
        JSON.stringify({ version: 1, jobs: [...jobs.values()] }),
        { mode: 0o600 },
      );
      renameSync(temporary, options.storePath);
    } catch (error) {
      log("定时任务写入失败", error instanceof Error ? error.message : String(error));
    }
  }

  function scheduleSave(): void {
    if (!options.storePath || saveTimer || disposed) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveNow();
    }, options.saveDebounceMs ?? 1_000);
    saveTimer.unref?.();
  }

  function sorted(): CronJob[] {
    return [...jobs.values()].sort((left, right) => (left.nextRunAt ?? Infinity) - (right.nextRunAt ?? Infinity));
  }

  function resolveId(prefix: string): CronJob | null {
    const trimmed = prefix.trim();
    if (!trimmed) return null;
    const exact = jobs.get(trimmed);
    if (exact) return exact;
    const matches = [...jobs.values()].filter((job) => job.id.startsWith(trimmed));
    return matches.length === 1 ? matches[0]! : null;
  }

  function add(input: {
    chatId: string;
    topicKey: string | null;
    expression: string;
    prompt: string;
    silent?: boolean;
    createdBy?: string;
  }): CronJob {
    if (jobs.size >= MAX_JOBS) throw new Error(`定时任务最多 ${MAX_JOBS} 个`);
    const expression = input.expression.trim().replace(/\s+/g, " ");
    const nextRunAt = nextCronTime(expression, now());
    const id = createHash("sha256")
      .update(`${input.chatId}:${expression}:${input.prompt}:${now()}:${jobs.size}`)
      .digest("hex")
      .slice(0, 8);
    const job: CronJob = {
      id,
      chatId: input.chatId,
      topicKey: input.topicKey,
      expression,
      prompt: input.prompt.trim(),
      enabled: true,
      silent: input.silent === true,
      createdBy: input.createdBy ?? "",
      createdAt: now(),
      lastRunAt: null,
      nextRunAt,
      lastError: null,
    };
    jobs.set(id, job);
    scheduleSave();
    return job;
  }

  function remove(prefix: string): CronJob | null {
    const job = resolveId(prefix);
    if (!job) return null;
    jobs.delete(job.id);
    scheduleSave();
    return job;
  }

  function setEnabled(prefix: string, enabled: boolean): CronJob | null {
    const job = resolveId(prefix);
    if (!job) return null;
    job.enabled = enabled;
    try {
      job.nextRunAt = enabled ? nextCronTime(job.expression, now()) : null;
      job.lastError = null;
    } catch (error) {
      job.enabled = false;
      job.nextRunAt = null;
      job.lastError = error instanceof Error ? error.message : String(error);
    }
    scheduleSave();
    return job;
  }

  async function tick(at = now()): Promise<void> {
    if (disposed) return;
    for (const job of sorted()) {
      if (!job.enabled || job.nextRunAt === null || job.nextRunAt > at) continue;
      if (running.has(job.id)) continue;
      running.add(job.id);
      job.lastRunAt = at;
      try {
        // Skip missed runs instead of replaying a backlog after downtime.
        job.nextRunAt = nextCronTime(job.expression, at);
      } catch (error) {
        job.nextRunAt = null;
        job.enabled = false;
        job.lastError = error instanceof Error ? error.message : String(error);
      }
      scheduleSave();
      try {
        await options.runJob(job);
        job.lastError = null;
      } catch (error) {
        job.lastError = error instanceof Error ? error.message : String(error);
        log(`定时任务 ${job.id} 执行失败`, job.lastError);
      } finally {
        running.delete(job.id);
        scheduleSave();
      }
    }
  }

  function start(): void {
    if (timer || disposed) return;
    timer = setInterval(() => {
      void tick();
    }, options.intervalMs ?? 30_000);
    timer.unref?.();
  }

  function stop(): void {
    disposed = true;
    if (timer) clearInterval(timer);
    timer = null;
    saveNow();
  }

  return {
    start,
    stop,
    tick,
    add,
    remove,
    setEnabled,
    resolveId,
    list: sorted,
    runNow: async (prefix: string): Promise<CronJob | null> => {
      const job = resolveId(prefix);
      if (!job || running.has(job.id)) return null;
      running.add(job.id);
      try {
        await options.runJob(job);
        job.lastError = null;
        job.lastRunAt = now();
        return job;
      } catch (error) {
        job.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        running.delete(job.id);
        scheduleSave();
      }
    },
    flush: saveNow,
  };
}

export type CronScheduler = ReturnType<typeof createCronScheduler>;
