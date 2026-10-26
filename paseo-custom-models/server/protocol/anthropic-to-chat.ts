/*
 * Claude Code (Anthropic Messages client) → an OpenAI Chat Completions route:
 * self-hosted and compatible models (vLLM, Ollama, LM Studio, company
 * gateways, qwen / llama / deepseek-r1 style models that may stream
 * `reasoning_content` or inline <think> blocks).
 *
 * Ported from cc-switch (https://github.com/farion1231/cc-switch,
 * src-tauri/src/proxy/providers/transform.rs, streaming.rs, inline_think.rs
 * and src-tauri/src/proxy/tool_media.rs, json_canonical.rs),
 * MIT License, Copyright (c) Jason Young.
 */

import { acceptWholeJsonBody, chatCompletionAsSse, createSseParser, parseJson, sseFrame } from "./sse.ts";
import type { ConvertOptions, Json, ProtocolBridge, StreamConverter } from "./types.ts";

type Any = Record<string, any>;

const isObject = (value: unknown): value is Any =>
  !!value && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

// ---------------------------------------------------------------------------
// Stable JSON (json_canonical.rs): sorted keys, so a tool call's arguments are
// byte-identical across turns and the upstream's prefix cache keeps hitting.
// ---------------------------------------------------------------------------

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.keys(value as Any).sort().filter((key) => (value as Any)[key] !== undefined);
    return `{${entries.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Any)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Request: Anthropic Messages → Chat Completions (transform.rs)
// ---------------------------------------------------------------------------

const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

/**
 * Claude Code may start `system` with a rotating attribution line; forwarding it
 * changes the prompt prefix every request and defeats prefix caching. Only a
 * leading occurrence is removed.
 */
export function stripLeadingBillingHeader(text: string): string {
  if (!text.startsWith(BILLING_HEADER_PREFIX)) return text;
  const match = /\r\n|\n|\r/.exec(text);
  if (!match) return "";
  const rest = text.slice(match.index + match[0].length);
  return rest.replace(/^(\r\n|\n|\r)/, "");
}

/** o1, o3, o4-mini…: these take `max_completion_tokens` instead of `max_tokens`. */
export function isOpenAiOSeries(model: string) {
  return model.length > 1 && model[0] === "o" && /[0-9]/.test(model[1]!);
}

export function supportsReasoningEffort(model: string) {
  const normalized = model.toLowerCase();
  if (isOpenAiOSeries(normalized)) return true;
  if (/^gpt-[5-9]/.test(normalized)) return true;
  const grok = /^grok-4\.(\d+)/.exec(normalized);
  if (grok && Number(grok[1]) >= 5) return true;
  return normalized.startsWith("grok-build-");
}

function supportsMaxReasoningEffort(model: string) {
  return ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]
    .includes(model.toLowerCase());
}

/** Anthropic `output_config.effort` / `thinking` → OpenAI `reasoning_effort`. */
export function resolveReasoningEffort(body: Any, model: string): string | null {
  const requested = ((): string | null => {
    const effort = str(body.output_config?.effort);
    if (effort !== null) {
      const mapped = ["low", "medium", "high", "xhigh"].includes(effort)
        ? effort
        : effort === "max" ? (supportsMaxReasoningEffort(model) ? "max" : "xhigh") : null;
      const thinkingType = str(body.thinking?.type);
      const thinkingOff = thinkingType === null || thinkingType === "disabled";
      return mapped && thinkingOff ? "low" : mapped;
    }
    const thinking = body.thinking;
    if (!isObject(thinking)) return null;
    if (thinking.type === "adaptive") return "xhigh";
    if (thinking.type === "enabled") {
      const budget = thinking.budget_tokens;
      if (typeof budget !== "number") return "high";
      return budget < 4000 ? "low" : budget < 16000 ? "medium" : "high";
    }
    return null;
  })();
  if (!requested) return null;
  const normalized = model.toLowerCase();
  if (normalized === "gpt-5-pro" || normalized.startsWith("gpt-5-pro-")) return "high";
  const isGptPro = normalized.startsWith("gpt-") && (normalized.endsWith("-pro") || normalized.includes("-pro-"));
  return isGptPro && requested === "low" ? "medium" : requested;
}

/**
 * DeepSeek / MiMo reject an assistant tool-call turn without
 * `reasoning_content`; other Chat servers may reject the unknown field, so it
 * is only sent to those vendors (claude.rs REASONING_VENDOR_HINTS).
 */
const REASONING_VENDOR_HINTS = ["deepseek", "mimo", "xiaomimimo"];
const preservesReasoningContent = (model: string) =>
  REASONING_VENDOR_HINTS.some((hint) => model.toLowerCase().includes(hint));

/** Cleans a tool's JSON schema; the root must be an object for OpenAI. */
export function cleanSchema(schema: unknown, isRoot = true): unknown {
  if (!isObject(schema)) return schema;
  const out: Any = { ...schema };
  const missingType = isRoot && !("type" in out);
  if (missingType) out.type = "object";
  if (missingType && !("properties" in out)) out.properties = {};
  if (out.format === "uri") delete out.format;
  if (isObject(out.properties)) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([key, value]) => [key, cleanSchema(value, false)]),
    );
  }
  if ("items" in out) out.items = cleanSchema(out.items, false);
  return out;
}

function mapToolChoice(choice: unknown): unknown {
  if (typeof choice === "string") return choice === "any" ? "required" : choice;
  if (isObject(choice)) {
    switch (choice.type) {
      case "any": return "required";
      case "auto": return "auto";
      case "none": return "none";
      case "tool": return { type: "function", function: { name: str(choice.name) ?? "" } };
    }
  }
  return choice;
}

// --- tool result media (tool_media.rs, the image subset an Anthropic client sends) ---

const MEDIA_MOVED_MARKER = "[cc-switch: tool result media moved to the following user message]";
const WHOLE_DATA_URL_MIN_BYTES = 8 * 1024;
const BASE64ISH_MIN_BYTES = 16 * 1024;
const MAX_MEDIA_DEPTH = 32;

const isImageMime = (value: string) => value.slice(0, 6).toLowerCase() === "image/";
function isImageBase64DataUrl(value: string) {
  const comma = value.indexOf(",");
  if (comma < 0) return false;
  const header = value.slice(0, comma).toLowerCase();
  return header.startsWith("data:image/") && header.endsWith(";base64");
}

function withDetail(part: Any, imageUrl: Any): Any {
  const out = { ...imageUrl };
  if (out.detail === undefined && part.detail !== undefined) out.detail = part.detail;
  if (out.detail === "original") out.detail = "auto";
  return out;
}

/** An Anthropic `image` block (or an OpenAI-style image part) → a Chat `image_url` part. */
export function chatImagePart(part: unknown): Any | null {
  if (!isObject(part)) return null;
  const type = part.type;
  if (type === "image_url" || type === "input_image" || (type === undefined && part.image_url !== undefined)) {
    const raw = part.image_url;
    const imageUrl = typeof raw === "string" && raw.trim() ? { url: raw }
      : isObject(raw) && typeof raw.url === "string" && raw.url.trim() ? raw : null;
    if (!imageUrl) return null;
    if (type === undefined && !/^data:/i.test(imageUrl.url)) return null;
    return { type: "image_url", image_url: withDetail(part, imageUrl) };
  }
  if (type !== "image") return null;
  const source = part.source;
  if (isObject(source)) {
    const media = str(source.media_type) ?? str(source.mime_type) ?? str(source.mimeType);
    if (media !== null && !isImageMime(media)) return null;
    const url = str(source.url);
    if (url && url.trim()) return { type: "image_url", image_url: withDetail(part, { url }) };
    const data = str(source.data);
    if (data) {
      const dataUrl = data.slice(0, 11).toLowerCase() === "data:image/" ? data : `data:${media ?? "image/png"};base64,${data}`;
      return { type: "image_url", image_url: withDetail(part, { url: dataUrl }) };
    }
    return null;
  }
  const data = str(part.data);
  const media = str(part.mimeType) ?? str(part.mime_type);
  if (data && media && isImageMime(media)) {
    return { type: "image_url", image_url: withDetail(part, { url: `data:${media};base64,${data}` }) };
  }
  return null;
}

function clampBase64ish(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const omit = (trimmed.length >= WHOLE_DATA_URL_MIN_BYTES && /^data:/i.test(trimmed))
      || (trimmed.length >= BASE64ISH_MIN_BYTES && /^[A-Za-z0-9+/=]+$/.test(trimmed));
    return omit ? `[cc-switch: omitted ${new TextEncoder().encode(value).length} bytes]` : value;
  }
  if (Array.isArray(value)) return value.map(clampBase64ish);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clampBase64ish(v)]));
  return value;
}

/** Replaces media inside a tool result with a marker, collecting the media as Chat parts. */
function stripToolMedia(value: unknown, media: Any[], depth = 0): { value: unknown; replaced: number } {
  if (depth > MAX_MEDIA_DEPTH) return { value, replaced: 0 };
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length >= WHOLE_DATA_URL_MIN_BYTES && isImageBase64DataUrl(trimmed)) {
      media.push({ type: "image_url", image_url: { url: trimmed } });
      return { value: MEDIA_MOVED_MARKER, replaced: 1 };
    }
    if (!trimmed || !/^[[{]/.test(trimmed)) return { value, replaced: 0 };
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { return { value, replaced: 0 }; }
    const inner = stripToolMedia(parsed, media, depth + 1);
    return inner.replaced ? { value: canonicalJson(clampBase64ish(inner.value)), replaced: inner.replaced } : { value, replaced: 0 };
  }
  if (Array.isArray(value)) {
    let replaced = 0;
    const out = value.map((item) => {
      const inner = stripToolMedia(item, media, depth + 1);
      replaced += inner.replaced;
      return inner.value;
    });
    return { value: out, replaced };
  }
  if (isObject(value)) {
    const part = chatImagePart(value);
    if (part) {
      media.push(part);
      return { value: { type: "text", text: MEDIA_MOVED_MARKER }, replaced: 1 };
    }
    if ("content" in value) {
      const inner = stripToolMedia(value.content, media, depth + 1);
      return inner.replaced ? { value: { ...value, content: inner.value }, replaced: inner.replaced } : { value, replaced: 0 };
    }
  }
  return { value, replaced: 0 };
}

/** Text of a tool_result's content when it is only text blocks; null otherwise. */
function plainToolText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    if (!isObject(block) || block.type !== "text" || typeof block.text !== "string") return null;
    texts.push(block.text);
  }
  return texts.join("\n");
}

function toolResultContent(content: unknown, callId: string, pendingMedia: Any[]): string {
  const media: Any[] = [];
  const stripped = content === undefined ? { value: content, replaced: 0 } : stripToolMedia(content, media);
  if (stripped.replaced) {
    pendingMedia.push({ type: "text", text: `[cc-switch: media output of tool call ${callId}]` }, ...media);
    const value = clampBase64ish(stripped.value);
    return typeof value === "string" ? value : plainToolText(value) ?? canonicalJson(value);
  }
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  return plainToolText(content) ?? canonicalJson(content);
}

function convertMessage(role: string, content: unknown, preserveReasoning: boolean): Any[] {
  if (content === undefined || content === null) return [{ role, content: null }];
  if (typeof content === "string") return [{ role, content }];
  if (!Array.isArray(content)) return [{ role, content }];

  const out: Any[] = [];
  const parts: Any[] = [];
  const toolCalls: Any[] = [];
  const pendingMedia: Any[] = [];
  const reasoning: string[] = [];

  for (const block of content) {
    if (!isObject(block)) continue;
    switch (block.type) {
      case "text":
        if (typeof block.text === "string") parts.push({ type: "text", text: block.text });
        break;
      case "image": {
        const image = chatImagePart(block);
        if (image) parts.push(image);
        break;
      }
      case "tool_use":
        toolCalls.push({
          id: str(block.id) ?? "",
          type: "function",
          function: { name: str(block.name) ?? "", arguments: canonicalJson(block.input ?? {}) },
        });
        break;
      case "tool_result": {
        const id = str(block.tool_use_id) ?? "";
        out.push({ role: "tool", tool_call_id: id, content: toolResultContent(block.content, id, pendingMedia) });
        break;
      }
      case "thinking":
        if (typeof block.thinking === "string" && block.thinking) reasoning.push(block.thinking);
        break;
      case "redacted_thinking":
        if (preserveReasoning) reasoning.push("[redacted thinking]");
        break;
    }
  }

  // Chat tool messages cannot carry images: keep parallel results adjacent,
  // then show all their media in one user turn before the turn's own content.
  if (pendingMedia.length) out.push({ role: "user", content: pendingMedia });

  if (parts.length || toolCalls.length) {
    const message: Any = { role };
    if (!parts.length) message.content = null;
    else if (parts.every((part) => part.type === "text")) message.content = parts.map((part) => part.text).join("\n");
    else message.content = parts;
    if (toolCalls.length) message.tool_calls = toolCalls;
    if (preserveReasoning && role === "assistant" && toolCalls.length) {
      message.reasoning_content = reasoning.length ? reasoning.join("\n") : "tool call";
    }
    out.push(message);
  }
  return out;
}

function systemText(system: unknown): string | null {
  if (typeof system === "string") return stripLeadingBillingHeader(system) || null;
  if (!Array.isArray(system)) return null;
  const parts = system
    .map((block) => (isObject(block) && typeof block.text === "string" ? stripLeadingBillingHeader(block.text) : ""))
    .filter(Boolean);
  return parts.length ? parts.join("\n") : null;
}

/** Anthropic server tools (web_search_…, code_execution_…) have no schema a Chat model can call. */
const isClientTool = (tool: Any) =>
  tool.type !== "BatchTool" && (tool.type === undefined || tool.type === "custom" || tool.input_schema !== undefined);

function convertRequest(body: Json, options: ConvertOptions): Json {
  const source = body as Any;
  const model = options.model;
  const preserveReasoning = preservesReasoningContent(model);
  const messages: Any[] = [];

  const system = systemText(source.system);
  if (system) messages.push({ role: "system", content: system });
  if (Array.isArray(source.messages)) {
    for (const message of source.messages) {
      if (!isObject(message)) continue;
      messages.push(...convertMessage(str(message.role) ?? "user", message.content, preserveReasoning));
    }
  }

  const out: Any = { model, messages };
  const maxTokens = source.max_tokens ?? options.defaultMaxOutputTokens;
  if (maxTokens !== undefined) out[isOpenAiOSeries(model) ? "max_completion_tokens" : "max_tokens"] = maxTokens;
  if (source.temperature !== undefined) out.temperature = source.temperature;
  if (source.top_p !== undefined) out.top_p = source.top_p;
  if (source.stop_sequences !== undefined) out.stop = source.stop_sequences;
  if (source.stream !== undefined) out.stream = source.stream;
  if (out.stream === true) out.stream_options = { include_usage: true };

  if (supportsReasoningEffort(model)) {
    const effort = resolveReasoningEffort(source, model);
    if (effort) out.reasoning_effort = effort;
  }

  const tools = Array.isArray(source.tools)
    ? source.tools.filter((tool: unknown) => isObject(tool) && isClientTool(tool)).map((tool: Any) => {
      const fn: Any = { name: str(tool.name) ?? "" };
      if (tool.description !== undefined && tool.description !== null) fn.description = tool.description;
      fn.parameters = cleanSchema(tool.input_schema ?? {});
      return { type: "function", function: fn };
    })
    : [];
  if (tools.length) out.tools = tools;
  if (tools.length && source.tool_choice !== undefined) {
    out.tool_choice = mapToolChoice(source.tool_choice);
    if (isObject(source.tool_choice) && source.tool_choice.disable_parallel_tool_use === true) {
      out.parallel_tool_calls = false;
    }
  }
  return out;
}

/**
 * A cheap estimate for `/v1/messages/count_tokens`, which a Chat route cannot
 * answer: about four ASCII characters per token, one token per other
 * character (CJK text), and a flat cost per image.
 */
export function estimateAnthropicInputTokens(body: Json): number {
  let tokens = 0;
  const countText = (text: string) => {
    let ascii = 0;
    let other = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) < 0x80) ascii++;
      else other++;
    }
    tokens += ascii / 4 + other;
  };
  const walk = (value: unknown, depth: number): void => {
    if (depth > 64) return;
    if (typeof value === "string") countText(value);
    else if (Array.isArray(value)) value.forEach((item) => walk(item, depth + 1));
    else if (isObject(value)) {
      if (value.type === "image" || value.type === "document") { tokens += 1600; return; }
      for (const [key, item] of Object.entries(value)) {
        if (key === "type" || key === "cache_control" || key === "id" || key === "tool_use_id") continue;
        walk(item, depth + 1);
      }
    }
  };
  const source = body as Any;
  walk(source.system, 0);
  walk(source.messages, 0);
  if (Array.isArray(source.tools)) countText(JSON.stringify(source.tools));
  tokens += 4 * (Array.isArray(source.messages) ? source.messages.length : 0);
  return Math.max(1, Math.ceil(tokens));
}

// ---------------------------------------------------------------------------
// Inline <think> splitting (inline_think.rs)
// ---------------------------------------------------------------------------

const THINK_TAGS: ReadonlyArray<readonly [string, string]> = [["<think>", "</think>"], ["<thinking>", "</thinking>"]];
const trimStartSeparators = (text: string) => text.replace(/^[\r\n]+/, "");
const trimEndSeparators = (text: string) => text.replace(/[\r\n]+$/, "");
const nonEmpty = (text: string) => (text ? text : null);

function stripLeadingOpenTag(text: string): string | null {
  const afterWs = text.trimStart();
  for (const [open] of THINK_TAGS) if (afterWs.startsWith(open)) return afterWs.slice(open.length);
  return null;
}

/** The earliest close tag; mismatched pairs (`<think>` … `</thinking>`) still close. */
function findCloseTag(text: string): { index: number; tag: string } | null {
  let best: { index: number; tag: string } | null = null;
  for (const [, close] of THINK_TAGS) {
    const index = text.indexOf(close);
    if (index >= 0 && (!best || index < best.index)) best = { index, tag: close };
  }
  return best;
}

/** Non-stream: a leading think block → [thinking, answer]; null when absent or unclosed. */
export function splitLeadingThinkBlock(text: string): [string, string] | null {
  const body = stripLeadingOpenTag(text);
  if (body === null) return null;
  const close = findCloseTag(body);
  if (!close) return null;
  const thinking = trimEndSeparators(trimStartSeparators(body.slice(0, close.index)));
  return [thinking, trimStartSeparators(body.slice(close.index + close.tag.length))];
}

/**
 * Stream: splits a think block at the start of the content across chunks.
 * Thinking is released as it arrives (holding back only what could be the
 * start of a close tag) so a long think never looks like a stalled stream.
 */
export class InlineThinkSplitter {
  private mode: "detecting" | "reasoning" | "text" = "detecting";
  private buffer = "";
  private stripSeparator = false;

  push(delta: string): [string | null, string | null] {
    if (this.mode === "text") return [null, this.pushText(delta)];
    this.buffer += delta;
    if (this.mode === "reasoning") return this.drainReasoning();
    const trimmed = this.buffer.trimStart();
    if (!trimmed) return [null, null];
    if (THINK_TAGS.some(([open]) => trimmed.startsWith(open))) {
      this.mode = "reasoning";
      this.stripSeparator = true;
      this.buffer = stripLeadingOpenTag(this.buffer) ?? "";
      return this.drainReasoning();
    }
    if (THINK_TAGS.some(([open]) => open.startsWith(trimmed))) return [null, null];
    this.mode = "text";
    const text = this.buffer;
    this.buffer = "";
    return [null, nonEmpty(text)];
  }

  private pushText(delta: string): string | null {
    if (!this.stripSeparator) return nonEmpty(delta);
    const rest = trimStartSeparators(delta);
    if (!rest) return null;
    this.stripSeparator = false;
    return rest;
  }

  private drainReasoning(): [string | null, string | null] {
    if (this.stripSeparator) {
      this.buffer = trimStartSeparators(this.buffer);
      if (!this.buffer) return [null, null];
      this.stripSeparator = false;
    }
    const close = findCloseTag(this.buffer);
    if (close) {
      const buffered = this.buffer;
      this.buffer = "";
      this.mode = "text";
      this.stripSeparator = true;
      const thinking = nonEmpty(trimEndSeparators(buffered.slice(0, close.index)));
      return [thinking, this.pushText(buffered.slice(close.index + close.tag.length))];
    }
    let partial = 0;
    for (const [, close] of THINK_TAGS) {
      for (let len = close.length - 1; len > 0; len--) {
        if (this.buffer.endsWith(close.slice(0, len))) { partial = Math.max(partial, len); break; }
      }
    }
    const body = this.buffer.slice(0, this.buffer.length - partial);
    const holdback = this.buffer.length - trimEndSeparators(body).length;
    const thinking = this.buffer.slice(0, this.buffer.length - holdback);
    this.buffer = this.buffer.slice(this.buffer.length - holdback);
    return [nonEmpty(thinking), null];
  }

  /** At a boundary: an unclosed think block is released as thinking, a detecting prefix as text. */
  flush(): [string | null, string | null] {
    const buffered = this.buffer;
    const wasReasoning = this.mode === "reasoning";
    this.buffer = "";
    this.mode = "text";
    this.stripSeparator = false;
    return wasReasoning ? [nonEmpty(buffered), null] : [null, nonEmpty(buffered)];
  }
}

// ---------------------------------------------------------------------------
// Usage and stop reasons
// ---------------------------------------------------------------------------

type ChatUsage = { prompt: number; completion: number; cacheRead: number; cacheWrite: number };

/** A positive count, treating an explicit 0 as unreported (some relays stub the first field). */
const positive = (value: unknown) => (typeof value === "number" && value > 0 ? value : 0);

function readChatUsage(usage: unknown): ChatUsage | null {
  if (!isObject(usage)) return null;
  const details = isObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const cacheRead = positive(usage.cache_read_input_tokens) || positive(details.cached_tokens)
    || positive(usage.prompt_cache_hit_tokens);
  const cacheWrite = typeof usage.cache_creation_input_tokens === "number"
    ? usage.cache_creation_input_tokens
    : positive(details.cache_write_tokens) || positive(usage.input_tokens_details?.cache_write_tokens);
  return { prompt: num(usage.prompt_tokens), completion: num(usage.completion_tokens), cacheRead, cacheWrite };
}

/** OpenAI `prompt_tokens` includes cached tokens; Anthropic `input_tokens` does not. */
function anthropicUsage(usage: ChatUsage | null): Any {
  if (!usage) return { input_tokens: 0, output_tokens: 0 };
  const out: Any = {
    input_tokens: Math.max(0, usage.prompt - usage.cacheRead - usage.cacheWrite),
    output_tokens: usage.completion,
  };
  if (usage.cacheRead > 0) out.cache_read_input_tokens = usage.cacheRead;
  if (usage.cacheWrite > 0) out.cache_creation_input_tokens = usage.cacheWrite;
  return out;
}

export function mapFinishReason(reason: string): string {
  switch (reason) {
    case "tool_calls":
    case "function_call": return "tool_use";
    case "length": return "max_tokens";
    default: return "end_turn"; // stop, content_filter, and anything unknown
  }
}

let idCounter = 0;
const generatedId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function parseArguments(value: unknown): unknown {
  if (isObject(value) || Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Non-stream response: Chat completion → Anthropic message (transform.rs)
// ---------------------------------------------------------------------------

function convertResponse(body: Json, options: ConvertOptions): Json {
  const source = body as Any;
  const choice = Array.isArray(source.choices) ? source.choices[0] : undefined;
  if (!isObject(choice) || !isObject(choice.message)) {
    throw new Error("The model route returned a Chat Completions response without a message");
  }
  const message = choice.message;
  const content: Any[] = [];

  const reasoning = str(message.reasoning_content) ?? str(message.reasoning);
  if (reasoning) content.push({ type: "thinking", thinking: reasoning, signature: "" });

  let leading = true;
  const pushText = (text: string) => {
    const split = leading ? splitLeadingThinkBlock(text) : null;
    leading = false;
    if (!split) { content.push({ type: "text", text }); return; }
    if (split[0]) content.push({ type: "thinking", thinking: split[0], signature: "" });
    if (split[1]) content.push({ type: "text", text: split[1] });
  };
  if (typeof message.content === "string") {
    if (message.content) pushText(message.content);
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!isObject(part)) continue;
      if ((part.type === "text" || part.type === "output_text") && typeof part.text === "string" && part.text) pushText(part.text);
      else if (part.type === "refusal" && typeof part.refusal === "string" && part.refusal) content.push({ type: "text", text: part.refusal });
    }
  }
  if (typeof message.refusal === "string" && message.refusal) content.push({ type: "text", text: message.refusal });

  let hasToolUse = false;
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((call: unknown, index: number) => {
      if (!isObject(call)) return;
      hasToolUse = true;
      const fn = isObject(call.function) ? call.function : {};
      content.push({
        type: "tool_use",
        id: str(call.id) || `tool_call_${index}`,
        name: str(fn.name) ?? "",
        input: parseArguments(fn.arguments),
      });
    });
  }
  if (!hasToolUse && isObject(message.function_call)) {
    const call = message.function_call;
    const name = str(call.name) ?? "";
    if (name || call.arguments !== undefined) {
      content.push({ type: "tool_use", id: str(call.id) || "tool_call_0", name, input: parseArguments(call.arguments) });
      hasToolUse = true;
    }
  }

  const finish = str(choice.finish_reason);
  return {
    id: str(source.id) || generatedId("msg"),
    type: "message",
    role: "assistant",
    content,
    model: str(source.model) || options.model,
    stop_reason: finish ? mapFinishReason(finish) : hasToolUse ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: anthropicUsage(readChatUsage(source.usage)),
  };
}

// ---------------------------------------------------------------------------
// Stream: Chat SSE → Anthropic SSE (streaming.rs)
// ---------------------------------------------------------------------------

/**
 * Consecutive whitespace between JSON tokens of one call's arguments that marks
 * the endless-newline bug (Copilot). Whitespace inside a JSON string is the
 * tool's own content (a Write of an indented file) and is never counted.
 */
const INFINITE_WHITESPACE_THRESHOLD = 500;

type ToolState = {
  index: number;
  id: string;
  name: string;
  started: boolean;
  pendingArgs: string;
  whitespace: number;
  inString: boolean;
  escaped: boolean;
  aborted: boolean;
};

function createStream(options: ConvertOptions): StreamConverter {
  const parser = createSseParser();
  const think = new InlineThinkSplitter();
  const tools = new Map<number, ToolState>();
  const openTools = new Set<number>();
  let messageId: string | null = null;
  let model: string | null = null;
  let started = false;
  let nextIndex = 0;
  let blockType: "thinking" | "text" | null = null;
  let blockIndex: number | null = null;
  let finishSeen = false;
  let pendingDelta: { stopReason: string; usage: ChatUsage | null } | null = null;
  let latestUsage: ChatUsage | null = null;
  let done = false;
  let out = "";

  const emit = (event: Any) => { out += sseFrame(String(event.type), event); };

  const ensureStart = () => {
    if (started) return;
    started = true;
    emit({
      type: "message_start",
      message: {
        id: messageId ?? generatedId("msg"),
        type: "message",
        role: "assistant",
        model: model ?? options.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...anthropicUsage(latestUsage), output_tokens: 0 },
      },
    });
  };

  const nonToolDelta = (type: "thinking" | "text", delta: string) => {
    ensureStart();
    if (blockType !== type) {
      if (blockIndex !== null) emit({ type: "content_block_stop", index: blockIndex });
      blockIndex = nextIndex++;
      blockType = type;
      emit({
        type: "content_block_start",
        index: blockIndex,
        content_block: type === "thinking" ? { type: "thinking", thinking: "", signature: "" } : { type: "text", text: "" },
      });
    }
    emit({
      type: "content_block_delta",
      index: blockIndex,
      delta: type === "thinking" ? { type: "thinking_delta", thinking: delta } : { type: "text_delta", text: delta },
    });
  };

  const emitSplit = ([thinking, text]: [string | null, string | null]) => {
    if (thinking) nonToolDelta("thinking", thinking);
    if (text) nonToolDelta("text", text);
  };

  const closeNonTool = () => {
    if (blockIndex !== null) emit({ type: "content_block_stop", index: blockIndex });
    blockIndex = null;
    blockType = null;
  };

  const closeOpenBlocks = () => {
    closeNonTool();
    for (const index of [...openTools].sort((a, b) => a - b)) emit({ type: "content_block_stop", index });
    openTools.clear();
  };

  const startTool = (state: ToolState, id: string, name: string) => {
    ensureStart();
    emit({ type: "content_block_start", index: state.index, content_block: { type: "tool_use", id, name, input: {} } });
    openTools.add(state.index);
  };
  const toolArgs = (index: number, partial: string) =>
    emit({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: partial } });

  const messageDelta = (stopReason: string, usage: ChatUsage | null) =>
    emit({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: anthropicUsage(usage) });

  const fail = (type: string, message: string) => {
    emitSplit(think.flush());
    emit({ type: "error", error: { type, message } });
    done = true;
  };

  const finishMessage = () => {
    emitSplit(think.flush());
    ensureStart();
    closeOpenBlocks();
    // A stream that ends with [DONE] but no finish_reason still needs a stop reason.
    const delta = pendingDelta ?? { stopReason: tools.size ? "tool_use" : "end_turn", usage: latestUsage };
    messageDelta(delta.stopReason, delta.usage ?? latestUsage);
    emit({ type: "message_stop" });
    done = true;
  };

  /**
   * Gateways that omit `index` (old Ollama, some relays): only a delta with a
   * new non-empty id starts a new call; anything else continues the last one.
   */
  const keyWithoutIndex = (call: Any): number => {
    const keys = [...tools.keys()];
    const last = keys.length ? Math.max(...keys) : undefined;
    const id = typeof call.id === "string" && call.id ? call.id : undefined;
    if (!id) return last ?? 0;
    for (const [key, state] of tools) if (state.id === id) return key;
    return last === undefined ? 0 : last + 1;
  };

  const handleToolCalls = (calls: unknown[]) => {
    // Release held content and close the text block before any tool block opens.
    emitSplit(think.flush());
    closeNonTool();
    for (const call of calls) {
      if (!isObject(call)) continue;
      const key = typeof call.index === "number" && call.index >= 0 ? call.index : keyWithoutIndex(call);
      let state = tools.get(key);
      if (!state) {
        state = { index: nextIndex++, id: "", name: "", started: false, pendingArgs: "", whitespace: 0, inString: false, escaped: false, aborted: false };
        tools.set(key, state);
      }
      if (state.aborted) continue;
      if (typeof call.id === "string" && call.id) state.id = call.id;
      const fn = isObject(call.function) ? call.function : {};
      if (typeof fn.name === "string" && fn.name) state.name = fn.name;

      const shouldStart = !state.started && !!state.id && !!state.name;
      if (shouldStart) {
        state.started = true;
        startTool(state, state.id, state.name);
        if (state.pendingArgs) {
          toolArgs(state.index, state.pendingArgs);
          state.pendingArgs = "";
        }
      }
      const args = typeof fn.arguments === "string" ? fn.arguments : null;
      if (args === null || args === "") continue;
      for (const ch of args) {
        if (state.inString) {
          if (state.escaped) state.escaped = false;
          else if (ch === "\\") state.escaped = true;
          else if (ch === '"') state.inString = false;
          continue;
        }
        if (ch === '"') state.inString = true;
        state.whitespace = /\s/.test(ch) ? state.whitespace + 1 : 0;
      }
      if (state.whitespace >= INFINITE_WHITESPACE_THRESHOLD) { state.aborted = true; continue; }
      if (state.started) toolArgs(state.index, args);
      else state.pendingArgs += args;
    }
  };

  const handleFinish = (reason: string, chunkUsage: ChatUsage | null) => {
    const usage = chunkUsage ?? latestUsage;
    if (finishSeen) {
      // Some providers repeat finish_reason; only the first one counts.
      if (pendingDelta && usage) pendingDelta.usage = usage;
      return;
    }
    finishSeen = true;
    emitSplit(think.flush());
    ensureStart();
    closeNonTool();
    // Late start for calls whose arguments arrived before their id/name.
    const late = [...tools.entries()]
      .filter(([, state]) => !state.started && (state.pendingArgs || state.id || state.name))
      .sort((a, b) => a[1].index - b[1].index);
    for (const [key, state] of late) {
      state.started = true;
      startTool(state, state.id || `tool_call_${key}`, state.name || "unknown_tool");
      if (state.pendingArgs) toolArgs(state.index, state.pendingArgs);
      state.pendingArgs = "";
    }
    for (const index of [...openTools].sort((a, b) => a - b)) emit({ type: "content_block_stop", index });
    openTools.clear();
    // Held until [DONE] so a trailing usage-only chunk is included, and only one message_delta goes out.
    // Ollama and some gateways send finish_reason "stop" after tool calls;
    // Claude Code only runs the tools when the turn stops for tool_use.
    const stopReason = reason === "stop" && [...tools.values()].some((state) => state.started) ? "tool_use" : mapFinishReason(reason);
    pendingDelta = { stopReason, usage };
  };

  const handleEvent = (event: string | null, data: string) => {
    if (done || event === ":comment") return;
    if (data.trim() === "[DONE]") { finishMessage(); return; }
    const chunk = parseJson(data);
    if (!chunk) return;
    if (event === "error" || (chunk.error !== undefined && !Array.isArray(chunk.choices))) {
      const error = isObject(chunk.error) ? chunk.error : chunk;
      const message = str(error.message) ?? str(chunk.error) ?? data;
      fail(isContextLengthMessage(message) ? "invalid_request_error" : "api_error",
        isContextLengthMessage(message) ? promptTooLongMessage(message) : message);
      return;
    }
    if (!messageId && typeof chunk.id === "string" && chunk.id) messageId = chunk.id;
    if (!model && typeof chunk.model === "string" && chunk.model) model = chunk.model;
    const chunkUsage = readChatUsage(chunk.usage);
    if (chunkUsage) {
      latestUsage = chunkUsage;
      if (pendingDelta) pendingDelta.usage = chunkUsage;
    }
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!isObject(choice)) return;
    ensureStart();
    const delta = isObject(choice.delta) ? choice.delta : {};
    // Some upstreams send reasoning_content: "" alongside content; ignore it or blocks fragment.
    const reasoning = str(delta.reasoning_content) || str(delta.reasoning);
    if (reasoning) nonToolDelta("thinking", reasoning);
    if (typeof delta.content === "string" && delta.content) emitSplit(think.push(delta.content));
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) handleToolCalls(delta.tool_calls);
    if (typeof choice.finish_reason === "string" && choice.finish_reason) handleFinish(choice.finish_reason, chunkUsage);
  };

  const drain = () => {
    const text = out;
    out = "";
    return text;
  };

  return {
    push(chunk: string) {
      for (const { event, data } of parser.push(chunk)) handleEvent(event, data);
      return drain();
    },
    end() {
      for (const { event, data } of parser.end()) handleEvent(event, data);
      if (!done) {
        // finish_reason without [DONE] is a complete answer; neither is a cut-off stream.
        if (pendingDelta) finishMessage();
        else fail("api_error", "The model route's stream ended before the response was complete");
      }
      return drain();
    },
    get usage() {
      return {
        inputTokens: latestUsage?.prompt ?? 0,
        outputTokens: latestUsage?.completion ?? 0,
        cachedTokens: latestUsage?.cacheRead ?? 0,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const CONTEXT_LENGTH_PATTERNS = [
  /context[_ ]length/i,
  /context window/i,
  /maximum context/i,
  /prompt is too long/i,
  /too many tokens/i,
  /input (?:is )?too long/i,
  /exceeds? the (?:model'?s? )?(?:maximum|max|context)/i,
  /reduce the length of the messages/i,
  /input_tokens.*exceed/i,
];

function isContextLengthMessage(message: string) {
  return CONTEXT_LENGTH_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Claude Code compacts the conversation when it sees "prompt is too long",
 * and reads "N tokens > M maximum" to size the gap when it can.
 */
function promptTooLongMessage(message: string) {
  const max = /maximum context length is (\d+)/i.exec(message)?.[1]
    ?? /context (?:length|window)[^0-9]{0,20}(\d+)/i.exec(message)?.[1];
  const used = /requested (?:about )?(\d+)/i.exec(message)?.[1]
    ?? /(?:resulted in|prompt (?:has|contains)|input has) (\d+)/i.exec(message)?.[1];
  if (max && used) return `prompt is too long: ${used} tokens > ${max} maximum (${message})`;
  return `prompt is too long: ${message}`;
}

function upstreamErrorMessage(body: unknown): string {
  if (typeof body === "string") {
    const parsed = parseJson(body);
    return parsed ? upstreamErrorMessage(parsed) : body.trim();
  }
  if (!isObject(body)) return "";
  const error = body.error;
  if (typeof error === "string") return error;
  if (isObject(error)) return str(error.message) ?? (typeof error.code === "string" ? error.code : JSON.stringify(error));
  return str(body.message) ?? str(body.detail) ?? JSON.stringify(body);
}

function convertError(status: number, raw: unknown): Json {
  const body = typeof raw === "string" ? parseJson(raw) ?? raw : raw;
  const message = upstreamErrorMessage(body) || `The model route answered HTTP ${status}`;
  const code = isObject(body) && isObject(body.error) ? `${body.error.code ?? ""} ${body.error.type ?? ""}` : "";
  if (isContextLengthMessage(message) || /context_length_exceeded/.test(code)) {
    return { type: "error", error: { type: "invalid_request_error", message: promptTooLongMessage(message) } };
  }
  const type = status === 401 ? "authentication_error"
    : status === 403 ? "permission_error"
    : status === 404 ? "not_found_error"
    : status === 413 ? "request_too_large"
    : status === 429 ? "rate_limit_error"
    : status === 529 ? "overloaded_error"
    : status >= 500 ? "api_error"
    : status >= 400 ? "invalid_request_error"
    : "api_error";
  return { type: "error", error: { type, message } };
}

// ---------------------------------------------------------------------------

function upstreamPath(clientPath: string): string | null {
  const [path] = clientPath.split("?");
  const slash = path!.startsWith("/") ? "/" : "";
  const normalized = path!.replace(/^\/+/, "").replace(/\/+$/, "");
  if (normalized === "v1/messages") return `${slash}v1/chat/completions`;
  return null; // count_tokens is answered locally with estimateAnthropicInputTokens
}

export const anthropicToChat: ProtocolBridge = {
  client: "anthropic",
  upstream: "chat",
  upstreamPath,
  request: convertRequest,
  response: convertResponse,
  stream: (options) => acceptWholeJsonBody(createStream(options), chatCompletionAsSse),
  error: convertError,
};
