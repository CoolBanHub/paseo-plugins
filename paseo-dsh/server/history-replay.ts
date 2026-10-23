import type {
  ProviderConnection,
  ProviderConnectRequest,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import { dshPtcTimelineUpdates, DSH_PTC_CALL_METHOD, DSH_PTC_RESULT_METHOD, dshToolDetail, dshToolDetailWithOutput } from "./ptc-present.ts";
import { dshHomePath, readDshSessionEvents, type DshSessionEvent } from "./probe-cleanup.ts";

const MAX_REPLAY_ITEMS = 4_000;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function textContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((block): block is Record<string, unknown> => !!block && typeof block === "object")
    .map((block) => typeof block.text === "string" ? block.text
      : block.type === "image" ? "[图片]"
        : block.type === "file" ? "[文件]" : "")
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
  const detail = toolDetail(name, args, output);
  const resultText = typeof output === "string" ? output : textContent(output);
  return failed
    ? { type: "tool_call", id, callId: id, name, status: "failed", error: resultText || `${name} failed`, detail }
    : { type: "tool_call", id, callId: id, name, status: "completed", error: null, detail };
}

/** Translate the durable user-facing dsh transcript into stable Paseo timeline items. */
export function dshHistoryTimelineItems(
  sessionId: string,
  events: readonly DshSessionEvent[],
): ProviderTimelineItem[] {
  const ordered = [...events].sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
  const ptcRoots = new Set<string>();
  for (const event of ordered) {
    if (event.type !== "tool/ptc-dispatch-start") continue;
    const rootCallId = event.data?.rootCallId;
    if (typeof rootCallId === "string") ptcRoots.add(rootCallId);
  }

  const items: ProviderTimelineItem[] = [];
  const calls = new Map<string, { name: string; arguments?: Record<string, unknown> }>();
  for (const event of ordered) {
    const data = event.data ?? {};
    const identity = `dsh:history:${sessionId}:${event.seq ?? items.length}`;

    if (event.type === "user/message") {
      const message = object(data);
      const source = object(message?.source);
      if (source?.kind !== "user") continue;
      const text = textContent(message?.content);
      const id = typeof message?.id === "string" ? message.id : identity;
      if (text) items.push({ type: "user_message", id, messageId: id, text });
      continue;
    }

    if (event.type === "assistant/message") {
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
      const args = parseArguments(data.arguments);
      calls.set(callId, { name, arguments: args });
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
      const call = calls.get(callId);
      calls.delete(callId);
      if (ptcRoots.has(callId)) continue;
      const name = call?.name ?? (typeof message?.name === "string" ? message.name : "tool");
      items.push(settledToolItem(callId, name, call?.arguments ?? parseArguments(message?.arguments), message?.content, message?.isError === true));
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
                const events = readDshSessionEvents(dshSessionId, { home: dshHomePath() });
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
