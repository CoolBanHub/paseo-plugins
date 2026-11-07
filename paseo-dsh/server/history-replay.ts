import type {
  ProviderConnection,
  ProviderConnectRequest,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import { dshPtcTimelineUpdates, DSH_PTC_CALL_METHOD, DSH_PTC_RESULT_METHOD } from "./ptc-present.ts";
import { dshTodoItem, dshToolDetail, dshToolDetailWithOutput } from "./tool-present.ts";
import { DSH_EVENT_METHOD, dshEventUpdates } from "./dsh-events.ts";
import { dshHomePath, readDshSessionEventsTail, type DshSessionEvent } from "./probe-cleanup.ts";

const MAX_REPLAY_ITEMS = 4_000;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function attachmentPlaceholder(block: Record<string, unknown>): string {
  const attachment = object(block.attachment);
  if (block.type === "image") {
    const mediaType = typeof attachment?.mediaType === "string" ? attachment.mediaType : undefined;
    const bytes = typeof attachment?.bytes === "number" ? attachment.bytes : undefined;
    const size = bytes !== undefined
      ? bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`
      : undefined;
    const parts = [mediaType, size].filter(Boolean);
    return parts.length ? `[图片 ${parts.join(" · ")}]` : "[图片]";
  }
  if (block.type === "file") {
    const name = typeof attachment?.name === "string" ? attachment.name : undefined;
    const bytes = typeof attachment?.bytes === "number" ? attachment.bytes : undefined;
    const size = bytes !== undefined
      ? bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`
      : undefined;
    const parts = [name, size].filter(Boolean);
    return parts.length ? `[文件 ${parts.join(" · ")}]` : "[文件]";
  }
  return "";
}

function textContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((block): block is Record<string, unknown> => !!block && typeof block === "object")
    .map((block) => typeof block.text === "string" ? block.text : attachmentPlaceholder(block))
    .filter(Boolean)
    .join("\n");
}

function parseArguments(value: unknown): Record<string, unknown> | undefined {
  if (object(value)) return object(value);
  if (typeof value !== "string") return undefined;
  try {
    return object(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function toolDetail(name: string, args: Record<string, unknown> | undefined, output: unknown): ProviderToolCallDetail {
  const base = dshToolDetail(name, args);
  const result = typeof output === "string" ? output : textContent(output);
  return result ? dshToolDetailWithOutput(base, result.slice(0, 8_000)) : base;
}

function settledToolItem(
  id: string,
  name: string,
  args: Record<string, unknown> | undefined,
  output: unknown,
  failed: boolean,
): ProviderTimelineItem {
  let detail = toolDetail(name, args, output);
  const resultText = typeof output === "string" ? output : textContent(output);
  if ((name === "subagent" || name === "subagent_fork") && detail.type === "sub_agent") {
    // dsh answers a delegation with "started subagent <childId>"; link the
    // child session so the restored card can show its identity.
    const match = /started subagent ([A-Za-z0-9_-]+)/.exec(resultText);
    if (match) detail = { ...detail, childSessionId: match[1] };
  }
  return failed
    ? { type: "tool_call", id, callId: id, name, status: "failed", error: resultText || `${name} failed`, detail }
    : { type: "tool_call", id, callId: id, name, status: "completed", error: null, detail };
}

/**
 * Seqs shadowed by `replace` surface ops (rewind markers, compaction
 * checkpoints). Shadowed events stay raw in the log but must not render.
 * Plain appends carry no op in the durable log (only replaces and a few
 * message kinds do), so absence of `surfaceOp` means "visible as usual";
 * the replace range is the only thing that hides content.
 */
function shadowedSeqs(ordered: readonly DshSessionEvent[]): Set<number> | undefined {
  let sawReplace = false;
  const shadowed = new Set<number>();
  for (const event of ordered) {
    if (typeof event.seq !== "number" || !event.surfaceOp) continue;
    if (
      event.surfaceOp.op === "replace" &&
      typeof event.surfaceOp.startSeq === "number" &&
      typeof event.surfaceOp.endSeq === "number"
    ) {
      sawReplace = true;
      for (let seq = event.surfaceOp.startSeq; seq <= event.surfaceOp.endSeq; seq += 1) shadowed.add(seq);
      shadowed.delete(event.seq); // the marker itself stays visible
    }
  }
  return sawReplace ? shadowed : undefined;
}

/** Translate the durable user-facing dsh transcript into stable Paseo timeline items. */
export function dshHistoryTimelineItems(
  sessionId: string,
  events: readonly DshSessionEvent[],
): ProviderTimelineItem[] {
  const ordered = [...events].sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
  const shadowed = shadowedSeqs(ordered);
  const isVisible = (event: DshSessionEvent): boolean =>
    shadowed === undefined || typeof event.seq !== "number" || !shadowed.has(event.seq);

  // A tool call whose settled result was shadowed (rewind) must not render as
  // a dangling running row; map callId -> its latest result's visibility.
  const resultSettled = new Map<string, boolean>();
  for (const event of ordered) {
    if (event.type !== "tool/result") continue;
    const callId = typeof object(event.data?.message)?.toolCallId === "string"
      ? (object(event.data?.message) as { toolCallId: string }).toolCallId
      : undefined;
    if (callId) resultSettled.set(callId, isVisible(event));
  }

  const ptcRoots = new Set<string>();
  for (const event of ordered) {
    if (event.type !== "tool/ptc-dispatch-start") continue;
    const rootCallId = event.data?.rootCallId;
    if (typeof rootCallId === "string") ptcRoots.add(rootCallId);
  }

  const items: ProviderTimelineItem[] = [];
  const calls = new Map<string, { name: string; arguments?: Record<string, unknown> }>();
  // Calls are removed from `calls` when their result settles, but later job
  // events still need the originating command.
  const knownCalls = new Map<string, { name: string; arguments?: Record<string, unknown> }>();
  for (const event of ordered) {
    const data = event.data ?? {};
    const identity = `dsh:history:${sessionId}:${event.seq ?? items.length}`;

    if (event.type === "user/message") {
      const message = object(data);
      const source = object(message?.source);
      if (source?.kind === "paseo-rewind") {
        if (isVisible(event)) {
          items.push({
            type: "notification",
            id: `dsh:rewound:${sessionId}:${event.seq ?? identity}`,
            level: "info",
            message: "会话已回退到此处",
          });
        }
        continue;
      }
      if (source?.kind !== "user") continue;
      if (!isVisible(event)) continue;
      const text = textContent(message?.content);
      const id = typeof message?.id === "string" ? message.id : identity;
      if (text) items.push({ type: "user_message", id, messageId: id, text });
      continue;
    }

    if (event.type === "assistant/message") {
      if (!isVisible(event)) continue;
      const message = object(data.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      let partIndex = 0;
      for (const block of content) {
        const part = object(block);
        if (typeof part?.text !== "string" || !part.text) continue;
        if (part.type === "reasoning") {
          items.push({ type: "reasoning", id: `${identity}:reasoning:${partIndex++}`, text: part.text });
        } else if (part.type === "text") {
          items.push({
            type: "assistant_message",
            id: `${identity}:text:${partIndex++}`,
            messageId: `${identity}:text:${partIndex - 1}`,
            text: part.text,
          });
        }
      }
      continue;
    }

    if (event.type === "tool/call") {
      const callId = typeof data.callId === "string" ? data.callId : undefined;
      const name = typeof data.name === "string" ? data.name : "tool";
      if (!callId) continue;
      if (resultSettled.get(callId) === false) continue;
      const args = parseArguments(data.arguments);
      calls.set(callId, { name, arguments: args });
      knownCalls.set(callId, { name, arguments: args });
      if (name === "run_code" && ptcRoots.has(callId)) continue;
      items.push({
        type: "tool_call",
        id: callId,
        callId,
        name,
        status: "running",
        error: null,
        detail: dshToolDetail(name, args),
      });
      continue;
    }

    if (event.type === "tool/result") {
      const message = object(data.message);
      const callId = typeof message?.toolCallId === "string" ? message.toolCallId : undefined;
      if (!callId) continue;
      if (!isVisible(event)) continue;
      const call = calls.get(callId);
      calls.delete(callId);
      if (ptcRoots.has(callId)) continue;
      const name = call?.name ?? (typeof message?.name === "string" ? message.name : "tool");
      items.push(settledToolItem(callId, name, call?.arguments ?? parseArguments(message?.arguments), message?.content, message?.isError === true));
      continue;
    }

    if (event.type === "todo/write") {
      // The durable todo event is the authoritative list; the tool call that
      // produced it only carries the same arguments.
      const todo = dshTodoItem(object(data), sessionId);
      if (todo) items.push(todo);
      continue;
    }

    const replayKind = event.type === "job/registered" ? "job-registered"
      : event.type === "job/settled" ? "job-settled"
        : event.type === "compaction/start" ? "compaction-start"
          : event.type === "compaction/summary" ? "compaction-summary"
            : event.type === "compaction/end" ? "compaction-end"
              : event.type === "goal/change" ? "goal-change"
                : undefined;
    if (replayKind) {
      const replayData = { ...data };
      if (event.type === "job/registered" || event.type === "job/settled") {
        const toolCall = object(data.toolCall);
        const call = typeof toolCall?.callId === "string" ? knownCalls.get(toolCall.callId) : undefined;
        const command = call?.arguments && typeof call.arguments.command === "string"
          ? call.arguments.command
          : undefined;
        if (command) replayData.command = command;
      }
      const updates = dshEventUpdates(DSH_EVENT_METHOD, { kind: replayKind, data: replayData }, sessionId) ?? [];
      for (const update of updates) {
        if (update.type === "timeline") items.push(update.item);
      }
      continue;
    }

    if (event.type === "tool/ptc-dispatch-start" || event.type === "tool/ptc-dispatch") {
      const updates = dshPtcTimelineUpdates(
        event.type === "tool/ptc-dispatch-start" ? DSH_PTC_CALL_METHOD : DSH_PTC_RESULT_METHOD,
        {
          subCallId: data.subCallId,
          rootCallId: data.rootCallId,
          name: data.name,
          arguments: data.arguments,
          isError: data.isError,
          output: textContent(data.content),
        },
        sessionId,
      );
      for (const update of updates ?? []) {
        if (update.type === "timeline") items.push(update.item);
      }
    }
  }

  return items.length > MAX_REPLAY_ITEMS ? items.slice(-MAX_REPLAY_ITEMS) : items;
}

function persistedDshSessionId(input: ProviderInput): string | undefined {
  if (input.type !== "session.open" || input.history !== "replay") return undefined;
  const persistence = object(input.persistence?.data);
  const sessionId = persistence?.sessionId;
  return typeof sessionId === "string" ? sessionId : undefined;
}

/** Replay stored dsh history before Paseo sees the restored session as ready. */
export function withDshHistoryReplay(provider: ProviderRegistration): ProviderRegistration {
  return {
    ...provider,
    async connect(request: ProviderConnectRequest): Promise<ProviderConnection> {
      const connection = await provider.connect(request);
      const listeners = new Set<(event: ProviderEvent) => void>();
      const pendingHistory = new Map<string, ProviderTimelineItem[]>();
      const unsubscribe = connection.onEvent((event) => {
        if (event.type === "session.ready") {
          const items = pendingHistory.get(event.sessionId) ?? [];
          pendingHistory.delete(event.sessionId);
          for (const item of items) {
            const replay: ProviderEvent = { type: "timeline.item", sessionId: event.sessionId, item };
            for (const listener of listeners) listener(replay);
          }
        } else if (event.type === "session.runtime_failed" || event.type === "session.closed") {
          pendingHistory.delete(event.sessionId);
        }
        for (const listener of listeners) listener(event);
      });
      return {
        get version() {
          return connection.version;
        },
        get capabilities() {
          return connection.capabilities;
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async send(input) {
          if (input.type === "session.open") {
            const dshSessionId = persistedDshSessionId(input);
            if (dshSessionId) {
              try {
                const events = await readDshSessionEventsTail(dshSessionId, { home: dshHomePath() });
                if (events) pendingHistory.set(input.sessionId, dshHistoryTimelineItems(dshSessionId, events));
                else pendingHistory.delete(input.sessionId);
              } catch {
                pendingHistory.delete(input.sessionId);
              }
            } else {
              pendingHistory.delete(input.sessionId);
            }
          }
          await connection.send(input);
        },
        async close() {
          unsubscribe();
          listeners.clear();
          pendingHistory.clear();
          await connection.close();
        },
      };
    },
  };
}
