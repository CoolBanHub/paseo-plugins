import { statSync } from "node:fs";
import type { AcpTransformer } from "@getpaseo/plugin/server/acp";
import type {
  ProviderConnection,
  ProviderConnectRequest,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { dshSubagentTurnState, DSH_EVENT_METHOD } from "./dsh-events.ts";
import { dshHistoryTimelineItems, shadowedSeqs } from "./history-replay.ts";
import {
  dshHomePath,
  dshSessionLogPath,
  readDshSessionEventsTail,
  type DshSessionEvent,
} from "./probe-cleanup.ts";

/**
 * dsh subagents as nested Paseo sessions.
 *
 * Paseo lists a provider's subagents — the track above the composer, each
 * one opening the child's own transcript — only for child sessions the
 * provider announces with `session.opened { parentSessionId, toolCallId }`,
 * and only under a parent that negotiated `session.subsession`. The ACP
 * adapter negotiates no such capability and its wire carries nothing but the
 * parent's session, so this wrapper sits around the registered provider:
 *
 * - the connection and every root session gain `session.subsession` when the
 *   host offers it;
 * - each `subagent-start` the bridge mirrors opens the dsh child session
 *   under its delegating tool call (the tool card itself is dsh-events.ts);
 * - the child's transcript is tailed from its own durable dsh session log,
 *   which is also what decides whether the child is still working;
 * - a reopened parent adopts the children its log records, and a closing
 *   parent closes them.
 *
 * Without the offered capability nothing changes: subagents stay tool cards.
 */

export const DSH_SUBSESSION_CAPABILITY = "session.subsession";

export type DshSubagentTurnState = "completed" | "canceled" | "failed";

/** One delegation: the dsh child session a `subagent` call started. */
export interface DshSubagentRun {
  childId: string;
  callId: string;
  label?: string;
}

/** Turn state of a dsh child session's own log. */
export type DshSubagentLogState =
  /** The log has no turn yet. */
  | { kind: "empty" }
  /** The latest turn never ended: the child works, or died mid-turn. */
  | { kind: "running"; turnStartSeq: number; turnEndSeq: number }
  | { kind: "ended"; reason: unknown; turnStartSeq: number; turnEndSeq: number };

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function bySeq(left: DshSessionEvent, right: DshSessionEvent): number {
  return (left.seq ?? 0) - (right.seq ?? 0);
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((block): block is Record<string, unknown> => !!block && typeof block === "object")
    .map((block) => typeof block.text === "string" ? block.text : "")
    .filter(Boolean)
    .join("\n");
}

/** Events are immutable once appended, so a seq delivered twice keeps its first copy. */
export function uniqueDshSessionEvents(events: readonly DshSessionEvent[]): DshSessionEvent[] {
  const seen = new Set<number>();
  const unique: DshSessionEvent[] = [];
  for (const event of events) {
    if (typeof event.seq === "number") {
      if (seen.has(event.seq)) continue;
      seen.add(event.seq);
    }
    unique.push(event);
  }
  return unique.sort(bySeq);
}

/** A dsh tool call's arguments, which the log stores as a JSON string or an object. */
function argumentsOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return object(value);
  try {
    return object(JSON.parse(value));
  } catch {
    return undefined;
  }
}

const STARTED_SUBAGENT = /started subagent ([A-Za-z0-9_-]+)/;

/**
 * Delegations a dsh session log records: every `subagent` / `subagent_fork`
 * call it answered with "started subagent <childId>", in log order. Standard
 * presets log them as `tool/call` + `tool/result`, PTC presets as program
 * dispatches. A rewound delegation is skipped, so a parent does not advertise
 * a child whose tool card its timeline no longer shows.
 */
export function dshSubagentRuns(events: readonly DshSessionEvent[]): DshSubagentRun[] {
  const ordered = uniqueDshSessionEvents(events);
  const shadowed = shadowedSeqs(ordered);
  const isVisible = (event: DshSessionEvent): boolean =>
    shadowed === undefined || typeof event.seq !== "number" || !shadowed.has(event.seq);

  const calls = new Map<string, { name: string; label?: string }>();
  const remember = (callId: unknown, name: unknown, args: unknown): void => {
    if (typeof callId !== "string" || !callId || typeof name !== "string") return;
    const label = text(argumentsOf(args)?.description);
    calls.set(callId, { name, ...(label ? { label } : {}) });
  };
  const runs: DshSubagentRun[] = [];
  const record = (
    event: DshSessionEvent,
    callId: string,
    call: { name: string; label?: string },
    content: unknown,
  ): void => {
    if (call.name !== "subagent" && call.name !== "subagent_fork") return;
    const match = STARTED_SUBAGENT.exec(contentText(content));
    if (!match || !isVisible(event)) return;
    runs.push({ childId: match[1]!, callId, ...(call.label ? { label: call.label } : {}) });
  };

  for (const event of ordered) {
    const data = event.data ?? {};
    if (event.type === "tool/call" || event.type === "tool/ptc-dispatch-start") {
      remember(data.callId ?? data.subCallId, data.name, data.arguments);
      continue;
    }
    if (event.type === "tool/result") {
      const message = object(data.message);
      const callId = text(message?.toolCallId);
      const call = callId ? calls.get(callId) : undefined;
      if (callId && call) record(event, callId, call, message?.content);
      continue;
    }
    if (event.type === "tool/ptc-dispatch") {
      const callId = text(data.subCallId);
      const call = callId ? calls.get(callId) : undefined;
      if (callId && call) record(event, callId, call, data.content);
    }
  }
  return runs;
}

/**
 * Turn state of a child's own log. dsh runs one turn per activation, so a
 * `turn/start` no `turn/end` follows is a child still working — or one whose
 * process died before the end was flushed.
 */
export function dshSubagentLogState(events: readonly DshSessionEvent[]): DshSubagentLogState {
  let turnStartSeq = -1;
  let turnEndSeq = -1;
  let reason: unknown;
  for (const event of uniqueDshSessionEvents(events)) {
    if (event.type === "turn/start") {
      turnStartSeq = event.seq ?? turnStartSeq;
    } else if (event.type === "turn/end") {
      turnEndSeq = event.seq ?? turnEndSeq;
      reason = object(event.data?.reason)?.kind;
    }
  }
  if (turnStartSeq === -1 && turnEndSeq === -1) return { kind: "empty" };
  return turnStartSeq > turnEndSeq
    ? { kind: "running", turnStartSeq, turnEndSeq }
    : { kind: "ended", reason, turnStartSeq, turnEndSeq };
}

/**
 * Change signature of a replayed row. Events being immutable, a row only
 * changes when a tool call settles or the todo list is rewritten, so the
 * status (and the todo payload) tells a new row from one already announced.
 */
function itemSignature(item: ProviderTimelineItem): string {
  switch (item.type) {
    case "tool_call":
      return `${item.status}:${JSON.stringify(item.error)}`;
    case "compaction":
      return item.status;
    case "todo":
      return JSON.stringify(item.items);
    default:
      return item.type;
  }
}

function logStamp(path: string): string | undefined {
  try {
    const stats = statSync(path);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return undefined;
  }
}

interface ChildSession {
  readonly childId: string;
  closed: boolean;
  /** The last announced turn state is `started`. */
  running: boolean;
  /** The last announced settled state. */
  state?: DshSubagentTurnState;
  /** Latest turn boundary seq already reflected in `running` / `state`. */
  settledThrough: number;
  /** Latest `turn/start` seq seen in the log. */
  turnStartSeq: number;
  turns: number;
  /** Size and mtime of the log at the last read; an unchanged log is not re-read. */
  stamp?: string;
  logPath?: string;
  /** Latest announced row per timeline item id. */
  readonly emitted: Map<string, string>;
  timer?: ReturnType<typeof setTimeout>;
  /** Bumped on every reschedule; a tick of an older generation stops. */
  generation: number;
  /** Reads of one child are serialized. */
  reading?: Promise<DshSubagentLogState | undefined>;
  /** A `subagent-start` of this connection announced the child. */
  startedHere: boolean;
  /** The bridge reported the running epoch's end; see SubagentTracker.expire. */
  endDeadline?: number;
  endReason?: unknown;
}

interface RootSession {
  /** Paseo session id. */
  sessionId: string;
  cwd: string;
  /** dsh session id, once the root has opened. */
  dshId?: string;
  /** `session.opened` went out with the subsession capability. */
  announced: boolean;
  readonly children: Map<string, ChildSession>;
}

interface TrackerOptions {
  pollMs: number;
  idlePollMs: number;
  endGraceMs: number;
  home: () => string;
  log: (message: string, detail?: unknown) => void;
}

class SubagentTracker {
  private readonly roots = new Map<string, RootSession>();
  private readonly emit: (event: ProviderEvent) => void;
  private readonly options: TrackerOptions;

  constructor(emit: (event: ProviderEvent) => void, options: TrackerOptions) {
    this.emit = emit;
    this.options = options;
  }

  capabilities(base: readonly string[]): readonly string[] {
    return base.includes(DSH_SUBSESSION_CAPABILITY) ? base : [...base, DSH_SUBSESSION_CAPABILITY];
  }

  /** A root `session.open` is on its way: know the Paseo id before any event names it. */
  prepare(sessionId: string, cwd: string | undefined): void {
    if (this.roots.has(sessionId)) return;
    this.roots.set(sessionId, { sessionId, cwd: cwd ?? "", announced: false, children: new Map() });
    trackers.set(sessionId, this);
  }

  opened(sessionId: string, event: ProviderEvent & { type: "session.opened" }): ProviderEvent {
    const root = this.roots.get(sessionId);
    if (!root) return event;
    const dshId = text(object(event.persistence?.data)?.sessionId);
    if (dshId) root.dshId = dshId;
    if (event.cwd) root.cwd = event.cwd;
    if (root.announced) return event;
    root.announced = true;
    if (event.capabilities.includes(DSH_SUBSESSION_CAPABILITY)) return event;
    return { ...event, capabilities: [...event.capabilities, DSH_SUBSESSION_CAPABILITY] };
  }

  ready(sessionId: string): void {
    const root = this.roots.get(sessionId);
    if (!root) return;
    void this.restore(root).catch((error) =>
      this.options.log("subagent restore failed", { sessionId, error: String(error) }));
  }

  /** A root is gone. Paseo drops its children without telling the plugin, so close them. */
  closed(sessionId: string): void {
    const root = this.roots.get(sessionId);
    if (!root) return;
    this.roots.delete(sessionId);
    if (trackers.get(sessionId) === this) trackers.delete(sessionId);
    for (const child of root.children.values()) this.close(child);
  }

  dispose(): void {
    for (const sessionId of [...this.roots.keys()]) this.closed(sessionId);
  }

  /** `subagent-start` / `subagent-end` the bridge mirrored for a root session. */
  bridge(sessionId: string, kind: string, params: Record<string, unknown>): void {
    const root = this.roots.get(sessionId);
    const data = object(params.data);
    const childId = text(data?.childId);
    const callId = text(data?.callId);
    if (!root || !root.announced || !childId || !callId) return;
    const child = root.children.get(childId)
      ?? this.openChild(root, { childId, callId, label: text(data?.label) });
    if (kind === "subagent-start") {
      child.startedHere = true;
      this.activate(child);
    } else {
      child.endReason = text(data?.stopReason);
      child.endDeadline = Date.now() + this.options.endGraceMs;
    }
    this.schedule(child, 0);
  }

  /** Adopt the children a reopened parent's log records. */
  private async restore(root: RootSession): Promise<void> {
    if (!root.dshId) return;
    const events = await readDshSessionEventsTail(root.dshId, { home: this.options.home() });
    if (this.roots.get(root.sessionId) !== root) return;
    for (const run of dshSubagentRuns(events ?? [])) {
      if (root.children.has(run.childId)) continue;
      const child = this.openChild(root, run);
      const state = await this.read(child);
      if (child.closed) return;
      // This connection's dsh process is new, so a turn the log never ended
      // belongs to a child that died with the previous one. A child this
      // connection itself started is never restored.
      if (!child.startedHere && state?.kind !== "ended") this.settle(child, "canceled");
      this.schedule(child, this.options.idlePollMs);
    }
  }

  private openChild(root: RootSession, run: DshSubagentRun): ChildSession {
    const child: ChildSession = {
      childId: run.childId,
      closed: false,
      running: true,
      settledThrough: -1,
      turnStartSeq: -1,
      turns: 0,
      emitted: new Map(),
      generation: 0,
      startedHere: false,
    };
    root.children.set(run.childId, child);
    this.emit({
      type: "session.opened",
      sessionId: run.childId,
      parentSessionId: root.sessionId,
      toolCallId: run.callId,
      capabilities: [],
      restoration: "parent",
      cwd: root.cwd,
      title: run.label ?? `子代理 ${run.childId.slice(0, 8)}`,
    });
    return child;
  }

  private close(child: ChildSession): void {
    if (child.closed) return;
    if (child.timer) clearTimeout(child.timer);
    child.timer = undefined;
    child.generation += 1;
    child.closed = true;
    if (child.running) this.announce(child, "canceled");
    this.emit({ type: "session.closed", sessionId: child.childId });
  }

  /** A turn is open: a child that just started, or one the parent resumed. */
  private activate(child: ChildSession): void {
    if (child.running) return;
    child.running = true;
    child.state = undefined;
    child.endDeadline = undefined;
    this.announce(child, "started");
  }

  private settle(child: ChildSession, state: DshSubagentTurnState): void {
    child.endDeadline = undefined;
    if (!child.running && child.state === state) return;
    child.running = false;
    child.state = state;
    this.announce(child, state);
  }

  /**
   * The bridge reported the running epoch's end. Its `turn/end` is usually
   * flushed within a poll or two, but a process killed at that moment never
   * writes it: the bridge's own reason settles the child once the grace
   * period passes.
   */
  private expire(child: ChildSession): void {
    if (!child.running || child.endDeadline === undefined || Date.now() < child.endDeadline) return;
    this.settle(child, dshSubagentTurnState(child.endReason));
    // The unflushed turn must not read as a fresh activation.
    child.settledThrough = Math.max(child.settledThrough, child.turnStartSeq);
  }

  private schedule(child: ChildSession, delayMs: number): void {
    if (child.closed) return;
    if (child.timer) clearTimeout(child.timer);
    const generation = ++child.generation;
    child.timer = setTimeout(() => {
      child.timer = undefined;
      void this.tick(child, generation);
    }, delayMs);
    child.timer.unref?.();
  }

  private async tick(child: ChildSession, generation: number): Promise<void> {
    try {
      await this.read(child);
    } catch (error) {
      this.options.log("subagent transcript unavailable", { childId: child.childId, error: String(error) });
    }
    if (child.closed || child.generation !== generation) return;
    this.schedule(child, child.running ? this.options.pollMs : this.options.idlePollMs);
  }

  /** Announce what the child's log gained since the last read, then its turn state. */
  private read(child: ChildSession): Promise<DshSubagentLogState | undefined> {
    const pending = (child.reading ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.readLog(child));
    child.reading = pending;
    void pending.catch(() => undefined).then(() => {
      if (child.reading === pending) child.reading = undefined;
    });
    return pending;
  }

  private async readLog(child: ChildSession): Promise<DshSubagentLogState | undefined> {
    if (child.closed) return undefined;
    this.expire(child);
    const home = this.options.home();
    child.logPath ??= dshSessionLogPath(child.childId, { home });
    if (!child.logPath) return undefined;
    const stamp = logStamp(child.logPath);
    if (stamp === undefined) {
      // Not written yet; look it up again on the next poll.
      child.logPath = undefined;
      return undefined;
    }
    if (stamp === child.stamp) return undefined;
    const events = await readDshSessionEventsTail(child.childId, { home });
    if (child.closed) return undefined;
    // Stamped after the read, so growth during it is picked up next poll.
    child.stamp = logStamp(child.logPath) ?? stamp;
    if (!events) return undefined;
    const unique = uniqueDshSessionEvents(events);
    const latest = new Map<string, ProviderTimelineItem>();
    for (const item of dshHistoryTimelineItems(child.childId, unique)) latest.set(item.id ?? "", item);
    for (const [id, item] of latest) {
      const signature = itemSignature(item);
      if (!id || child.emitted.get(id) === signature) continue;
      child.emitted.set(id, signature);
      this.emit({ type: "timeline.item", sessionId: child.childId, item });
    }
    const state = dshSubagentLogState(unique);
    if (state.kind === "empty") return state;
    if (state.kind === "running") {
      child.turnStartSeq = Math.max(child.turnStartSeq, state.turnStartSeq);
      // A turn opened past the last settled one is a new activation: dsh
      // resumes a continuable child under the same session id.
      if (state.turnStartSeq > child.settledThrough) this.activate(child);
      return state;
    }
    if (state.turnEndSeq > child.settledThrough) {
      child.settledThrough = state.turnEndSeq;
      this.settle(child, dshSubagentTurnState(state.reason));
    }
    return state;
  }

  private announce(child: ChildSession, state: "started" | DshSubagentTurnState): void {
    child.turns += 1;
    this.emit({
      type: "session.turn",
      sessionId: child.childId,
      turnId: `dsh:subagent:${child.childId}:${child.turns}`,
      state,
    });
  }
}

// The ACP transformer is one static object shared by every connection, so
// each connection's tracker registers here under its root Paseo session ids.
const trackers = new Map<string, SubagentTracker>();

/**
 * Routes one mirrored `dsh/event` notification to the connection that owns
 * the session. Nesting emits provider events, never vendor updates, so this
 * always yields nothing for the timeline: the tool card stays dsh-events.ts.
 */
export function dshSubagentNotification(method: string, params: unknown, sessionId: string): null {
  if (method !== DSH_EVENT_METHOD) return null;
  const record = object(params);
  const kind = text(record?.kind);
  if (kind !== "subagent-start" && kind !== "subagent-end") return null;
  try {
    trackers.get(sessionId)?.bridge(sessionId, kind, record ?? {});
  } catch (error) {
    console.error("Error handling dsh subagent event", error);
  }
  return null;
}

/** ACP transformer registered by the provider; see dshSubagentNotification. */
export const dshSubagentTransformer: AcpTransformer = {
  notification(notification, context) {
    return dshSubagentNotification(notification.method, notification.params, context.sessionId);
  },
};

export interface DshSubagentOptions {
  /** Poll interval while a child is working. */
  pollMs?: number;
  /** Poll interval once a child settled, which is how a resumed child is noticed. */
  idlePollMs?: number;
  /** How long a bridge-reported end waits for the log's `turn/end`. */
  endGraceMs?: number;
  /** dsh home; defaults to `DSH_HOME` or `~/.dsh`. */
  home?: () => string;
  log?: (message: string, detail?: unknown) => void;
}

/** Announce dsh subagents as nested child sessions when the host supports them. */
export function withDshSubagents(
  provider: ProviderRegistration,
  options: DshSubagentOptions = {},
): ProviderRegistration {
  return {
    ...provider,
    async connect(request: ProviderConnectRequest): Promise<ProviderConnection> {
      const connection = await provider.connect(request);
      const listeners = new Set<(event: ProviderEvent) => void>();
      const tracker = new SubagentTracker(
        (event) => {
          for (const listener of listeners) listener(event);
        },
        {
          pollMs: options.pollMs ?? 1_000,
          idlePollMs: options.idlePollMs ?? 4_000,
          endGraceMs: options.endGraceMs ?? 8_000,
          home: options.home ?? dshHomePath,
          log: options.log ?? (() => undefined),
        },
      );
      // A host that offers no subsessions must see today's behavior: the
      // tracker then never learns a root and every hook below is a no-op.
      const enabled = request.capabilities.includes(DSH_SUBSESSION_CAPABILITY);
      const unsubscribe = connection.onEvent((event) => {
        let next = event;
        if (event.type === "session.opened" && event.parentSessionId === undefined) {
          next = tracker.opened(event.sessionId, event);
        } else if (event.type === "session.ready") {
          tracker.ready(event.sessionId);
        } else if (event.type === "session.closed" || event.type === "session.runtime_failed") {
          tracker.closed(event.sessionId);
        }
        for (const listener of listeners) listener(next);
      });
      return {
        get version() {
          return connection.version;
        },
        get capabilities() {
          return enabled ? tracker.capabilities(connection.capabilities) : connection.capabilities;
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async send(input: ProviderInput) {
          if (input.type === "session.open") {
            if (enabled) tracker.prepare(input.sessionId, input.config.cwd);
          } else if (input.type === "session.close") {
            tracker.closed(input.sessionId);
          }
          try {
            await connection.send(input);
          } catch (error) {
            if (input.type === "session.open") tracker.closed(input.sessionId);
            throw error;
          }
        },
        async close() {
          unsubscribe();
          tracker.dispose();
          listeners.clear();
          await connection.close();
        },
      };
    },
  };
}
