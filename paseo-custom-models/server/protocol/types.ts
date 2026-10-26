/*
 * Protocol conversion between the clients Team Work runs (Claude Code speaks
 * Anthropic Messages, Codex speaks OpenAI Responses) and the model routes a
 * company configures (Anthropic Messages, OpenAI Responses, OpenAI Chat
 * Completions). The conversion runs in the plugin's loopback bridge on the
 * employee's computer, the way cc-switch's local routing does.
 *
 * Portions of the conversion logic are adapted from cc-switch
 * (https://github.com/farion1231/cc-switch, src-tauri/src/proxy/providers),
 * MIT License, Copyright (c) Jason Young.
 */

export type Json = Record<string, unknown>;
export type Protocol = "anthropic" | "responses" | "chat";

export type ConvertOptions = {
  /** The model id the upstream receives (the client's choice, already resolved to the route's id). */
  model: string;
  /** Output budget when the target protocol requires one and the client sent none. */
  defaultMaxOutputTokens?: number;
  /**
   * The client's original request. A converter reads it when turning the
   * answer back (which tools were freeform or namespaced). Pass the same
   * options object to request() and then to response()/stream().
   */
  clientRequest?: Json;
};

/**
 * An incremental converter of one streamed response. `push` takes raw
 * upstream SSE text in any chunking and returns client SSE text ready to
 * write; `end` flushes and returns whatever closing events the client needs
 * (a stream that ended without its terminal event is closed as an error).
 */
export interface StreamConverter {
  push(chunk: string): string;
  end(): string;
  /** Usage seen so far, in the upstream's terms, for logs. */
  readonly usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
}

/** One direction: client protocol → upstream protocol and back. */
export interface ProtocolBridge {
  client: Protocol;
  upstream: Protocol;
  /** The upstream path (after the route's base) for a client request path, or null when not served. */
  upstreamPath(clientPath: string): string | null;
  request(body: Json, options: ConvertOptions): Json;
  /** A complete (non-streamed) upstream response body → the client's. */
  response(body: Json, options: ConvertOptions): Json;
  stream(options: ConvertOptions): StreamConverter;
  /** An upstream error body and status → the client's error body. */
  error(status: number, body: unknown): Json;
}
