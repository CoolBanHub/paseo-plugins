/**
 * Live progress card for a running turn. The card is sent once and patched in
 * place while the agent works; Feishu does not notify on a card update, so the
 * DONE reaction (added by the dispatcher) is what tells the room the answer is
 * ready.
 *
 * Updates are throttled: Feishu rate-limits card PATCHes and a busy coding
 * turn can emit dozens of tool events per second.
 */

export type ProgressPhase = "running" | "completed" | "failed" | "canceled";

export interface ProgressStep {
  icon: string;
  text: string;
}

export interface ProgressState {
  phase: ProgressPhase;
  elapsedMs: number;
  queue: number;
  steps: ProgressStep[];
  detail: string | null;
}

const MAX_STEPS = 8;
const MAX_STEP_CHARS = 160;
const MAX_DETAIL_CHARS = 600;
const PHASE_TITLES: Record<ProgressPhase, string> = {
  running: "⏳ 正在处理",
  completed: "✅ 已完成",
  failed: "❌ 处理失败",
  canceled: "⏹ 已取消",
};
const PHASE_TEMPLATES: Record<ProgressPhase, string> = {
  running: "blue",
  completed: "green",
  failed: "red",
  canceled: "grey",
};

function clip(value: string, limit: number): string {
  const flat = value.replace(/\r/g, "").trim();
  return flat.length > limit ? flat.slice(0, limit - 1) + "…" : flat;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest > 0 ? `${minutes}m${rest}s` : `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export function renderProgressCard(state: ProgressState): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];
  const meta = [
    `已用时 **${formatElapsed(state.elapsedMs)}**`,
    state.queue > 0 ? `排队 **${state.queue}** 条` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  elements.push({ tag: "markdown", content: meta });
  if (state.steps.length > 0) {
    const lines = state.steps.map((step) => `${step.icon} ${clip(step.text, MAX_STEP_CHARS)}`);
    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: lines.join("\n") });
  }
  if (state.detail) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: clip(state.detail, MAX_DETAIL_CHARS) });
  }
  const hint =
    state.phase === "running"
      ? "完成后结果会回到本话题；发送 /status 查看状态，/stop 清空排队。"
      : "详细过程可在 Paseo 时间线查看。";
  elements.push({ tag: "markdown", content: `<font color='grey'>${hint}</font>` });

  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "default" },
    header: {
      title: { tag: "plain_text", content: PHASE_TITLES[state.phase] },
      template: PHASE_TEMPLATES[state.phase],
    },
    body: { direction: "vertical", padding: "12px 12px 16px 12px", elements },
  };
}

export interface ProgressTrackerOptions {
  /** Injected interactive-card sender; returns the card message id. */
  sendCard: (card: Record<string, unknown>) => Promise<string | null>;
  /** Injected card patcher for an existing card message. */
  updateCard: (messageId: string, card: Record<string, unknown>) => Promise<void>;
  now?: () => number;
  /** Minimum gap between PATCH calls (default 2.5s). */
  intervalMs?: number;
  log?: (message: string, detail?: unknown) => void;
}

export interface ProgressTracker {
  readonly messageId: string | null;
  /** Start the card; resolves false when sending failed or was skipped. */
  start(): Promise<boolean>;
  setQueue(count: number): void;
  step(icon: string, text: string): void;
  detail(text: string): void;
  /** Flush immediately with a final phase. Safe to call more than once. */
  finish(phase: Exclude<ProgressPhase, "running">, detail?: string | null): Promise<void>;
  /** Stop timers without sending another update (plugin unload). */
  dispose(): void;
}

/**
 * Create a tracker. `start()` is explicit so the caller can decide after a
 * successful enqueue (and so tests can inspect the card payload).
 */
export function createProgressTracker(options: ProgressTrackerOptions): ProgressTracker {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const intervalMs = options.intervalMs ?? 2_500;
  const startedAt = now();
  let messageId: string | null = null;
  let phase: ProgressPhase = "running";
  let queue = 0;
  let steps: ProgressStep[] = [];
  let detailText: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastPatchAt = 0;
  let closed = false;
  let patching = false;
  let pendingPatch = false;

  function snapshot(): ProgressState {
    return {
      phase,
      elapsedMs: now() - startedAt,
      queue,
      steps,
      detail: detailText,
    };
  }

  async function patch(): Promise<void> {
    if (!messageId || closed) return;
    if (patching) {
      pendingPatch = true;
      return;
    }
    patching = true;
    try {
      lastPatchAt = now();
      await options.updateCard(messageId, renderProgressCard(snapshot()));
    } catch (error) {
      log("更新进度卡片失败", error instanceof Error ? error.message : String(error));
    } finally {
      patching = false;
      if (pendingPatch && !closed) {
        pendingPatch = false;
        schedule();
      }
    }
  }

  function schedule(): void {
    if (!messageId || closed || timer) return;
    const wait = Math.max(0, intervalMs - (now() - lastPatchAt));
    timer = setTimeout(() => {
      timer = null;
      void patch();
    }, wait);
    timer.unref?.();
  }

  return {
    get messageId() {
      return messageId;
    },
    async start() {
      if (messageId) return true;
      try {
        messageId = await options.sendCard(renderProgressCard(snapshot()));
      } catch (error) {
        log("发送进度卡片失败", error instanceof Error ? error.message : String(error));
        messageId = null;
      }
      lastPatchAt = now();
      return messageId !== null;
    },
    setQueue(count) {
      queue = Math.max(0, count);
      schedule();
    },
    step(icon, text) {
      steps = [...steps, { icon, text }].slice(-MAX_STEPS);
      schedule();
    },
    detail(text) {
      detailText = text;
      schedule();
    },
    async finish(finalPhase, finalDetail = null) {
      if (closed) return;
      closed = true;
      phase = finalPhase;
      detailText = finalDetail;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!messageId) return;
      try {
        await options.updateCard(messageId, renderProgressCard(snapshot()));
      } catch (error) {
        log("收尾进度卡片失败", error instanceof Error ? error.message : String(error));
      }
    },
    dispose() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
