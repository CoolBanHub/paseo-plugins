/** One Server-Sent Event: its `event:` name (if any) and joined `data:` lines. */
export type SseEvent = { event: string | null; data: string };

/**
 * Splits SSE text into events across arbitrary chunk boundaries. Comment
 * lines (": keep-alive") are reported as events with data "" and event
 * ":comment" so a converter may keep the connection warm.
 */
export function createSseParser() {
  let pending = "";
  let event: string | null = null;
  let data: string[] = [];
  let comment = false;
  const take = (): SseEvent[] => {
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    const out: SseEvent[] = [];
    for (const line of lines) {
      if (line === "") {
        if (data.length || event) out.push({ event, data: data.join("\n") });
        else if (comment) out.push({ event: ":comment", data: "" });
        event = null; data = []; comment = false;
        continue;
      }
      if (line.startsWith(":")) { comment = true; continue; }
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    return out;
  };
  return {
    push(chunk: string): SseEvent[] {
      pending += chunk;
      return take();
    },
    /** Events left when the stream ends without a final blank line. */
    end(): SseEvent[] {
      if (pending) pending += "\n";
      const out = take();
      if (data.length || event) out.push({ event, data: data.join("\n") });
      event = null; data = []; pending = ""; comment = false;
      return out;
    },
  };
}

/** One SSE frame. Anthropic and Responses streams name every event. */
export function sseFrame(event: string | null, data: unknown) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  return `${event ? `event: ${event}\n` : ""}data: ${body}\n\n`;
}

export function parseJson(data: string): Record<string, any> | null {
  try {
    const value = JSON.parse(data);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

type WholeBodyStream = {
  push(chunk: string): string;
  end(): string;
  readonly usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
};

/**
 * A gateway may ignore stream:true and answer with one JSON document (a whole
 * completion or an error envelope). The bridge always streams to a client that
 * asked to stream, so this buffers such a body and replays it as the SSE the
 * converter expects; a real SSE body passes straight through.
 */
export function acceptWholeJsonBody<T extends WholeBodyStream>(inner: T, asSse: (body: Record<string, any>) => string): WholeBodyStream {
  let mode: "undecided" | "sse" | "json" = "undecided";
  let raw = "";
  return {
    push(chunk: string) {
      if (mode === "sse") return inner.push(chunk);
      raw += chunk;
      if (mode === "json") return "";
      const head = raw.replace(/^[\s﻿]+/, "");
      if (!head) return "";
      mode = head[0] === "{" ? "json" : "sse";
      if (mode === "json") return "";
      const text = raw;
      raw = "";
      return inner.push(text);
    },
    end() {
      if (mode !== "json") return inner.end();
      const body = parseJson(raw.replace(/^[\s﻿]+/, ""));
      raw = "";
      const replay = body ? asSse(body) : `data: ${JSON.stringify({ error: { message: "The model route answered with a body that is neither SSE nor a JSON object" } })}\n\n`;
      return inner.push(replay) + inner.end();
    },
    get usage() {
      return inner.usage;
    },
  };
}

/** A whole Chat Completions body (or error envelope) as the chunks a stream would have carried. */
export function chatCompletionAsSse(body: Record<string, any>): string {
  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
  if (body.error != null || !choice || typeof choice !== "object") {
    // vLLM's older top-level {"object":"error","message":…} has no `error` field.
    return `data: ${JSON.stringify({ error: body.error ?? body })}\n\n`;
  }
  const message = choice.message && typeof choice.message === "object" ? choice.message : {};
  const head = { id: body.id, model: body.model, created: body.created };
  const delta: Record<string, unknown> = { role: "assistant" };
  const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content
    : typeof message.reasoning === "string" ? message.reasoning : undefined;
  if (reasoning) delta.reasoning_content = reasoning;
  if (typeof message.content === "string" && message.content) delta.content = message.content;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    delta.tool_calls = message.tool_calls.map((call: any, index: number) => ({
      index,
      id: call?.id,
      type: "function",
      function: {
        name: call?.function?.name,
        arguments: typeof call?.function?.arguments === "string" ? call.function.arguments : JSON.stringify(call?.function?.arguments ?? {}),
      },
    }));
  }
  const finish = typeof choice.finish_reason === "string" && choice.finish_reason ? choice.finish_reason
    : delta.tool_calls ? "tool_calls" : "stop";
  return `data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta }] })}\n\n`
    + `data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: {}, finish_reason: finish }], ...(body.usage ? { usage: body.usage } : {}) })}\n\n`
    + "data: [DONE]\n\n";
}
