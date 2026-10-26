import { createHash, randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { Readable } from "node:stream";
import { join } from "node:path";
import { vendorModelId } from "../shared/model-id.ts";
import { anthropicToChat } from "./protocol/anthropic-to-chat.ts";
import type { ProtocolBridge } from "./protocol/types.ts";
import { estimateAnthropicInputTokens } from "./protocol/estimate.ts";
import { claudeModelFor, sessionModels } from "./session.ts";
import type { ModelRegistry, StoredProvider } from "./store.ts";

/**
 * The loopback bridge: sessions get `http://127.0.0.1:<port>/<prefix>` as
 * their Anthropic endpoint, and each request is routed by its model to the
 * provider that model belongs to — straight to the vendor with the person's
 * own key. Anthropic-protocol providers pass through untouched; OpenAI Chat
 * providers go through the protocol converter.
 *
 * The port and each live session's route hash persist across plugin
 * reloads, so running sessions keep working once the bridge rebinds the
 * same port. Only capability hashes are stored, never the tokens.
 */

const MAX_BODY = 20 * 1024 * 1024;
const SAVED_ROUTE_LIMIT = 2_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
const BETA = new Set(["prompt-caching-2024-07-31", "interleaved-thinking-2025-05-14"]);
const PUBLIC_ERROR = "自定义模型暂不可用，请检查 Provider 配置或稍后重试";

type ActiveRequest = { controller: AbortController; response: ServerResponse };

type Route = {
  agentId: string;
  prefix: string;
  capabilityHash: Buffer;
  home: string;
  model: string | null;
  active: Set<ActiveRequest>;
};

type SavedRoute = { prefix: string; capabilityHash: string; home: string; model: string | null };
type SavedState = { port: number; routes: Map<string, SavedRoute> };

function parseSavedState(value: unknown): SavedState {
  const routes = new Map<string, SavedRoute>();
  const port = value && typeof value === "object" && !Array.isArray(value)
    && Number.isInteger((value as Record<string, unknown>).port)
    && (value as Record<string, unknown>).port as number > 0
    && (value as Record<string, unknown>).port as number < 65_536
    ? (value as Record<string, unknown>).port as number : 0;
  const saved = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).routes : null;
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    for (const [agentId, entry] of Object.entries(saved as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.prefix !== "string" || !/^[a-f0-9]{64}$/.test(record.prefix)) continue;
      if (typeof record.capabilityHash !== "string" || !/^[a-f0-9]{64}$/.test(record.capabilityHash)) continue;
      if (typeof record.home !== "string") continue;
      routes.set(agentId, {
        prefix: record.prefix,
        capabilityHash: record.capabilityHash,
        home: record.home,
        model: typeof record.model === "string" ? record.model : null,
      });
    }
  }
  return { port, routes };
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const capabilityDigest = (capability: string) => createHash("sha256").update(capability).digest();
const sameDigest = (left: Buffer, right: Buffer) => left.length === right.length && left.equals(right);

class LocalFailure extends Error {
  readonly status: number;
  readonly type: string;
  constructor(status: number, message: string = PUBLIC_ERROR, type: string = "api_error") {
    super(message);
    this.status = status;
    this.type = type;
  }
}

function localError(response: ServerResponse, status: number, message: string = PUBLIC_ERROR, type = "api_error"): void {
  if (response.headersSent) { response.destroy(); return; }
  const body = JSON.stringify({ type: "error", error: { type, message } });
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(body);
}

function readBody(request: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      if (signal.aborted) { request.destroy(); reject(new LocalFailure(499, "请求已取消", "api_error")); return; }
      size += chunk.length;
      if (size > MAX_BODY) { request.destroy(); reject(new LocalFailure(413, "请求体过大", "invalid_request_error")); return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", (error) => reject(error instanceof LocalFailure ? error : new LocalFailure(400, "请求内容无效", "invalid_request_error")));
  });
}

/**
 * Node's fetch gives up when response headers take over 300 s. A
 * non-streaming request on a reasoning model can outrun that, so plain
 * http(s) is used instead; the caller's AbortSignal still bounds it.
 */
export function fetchWithoutHeaderDeadline(url: string, init: { method: string; headers: Record<string, string>; body: Uint8Array; signal: AbortSignal; redirect?: "error" }): Promise<Response> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === "https:" ? httpsRequest : target.protocol === "http:" ? httpRequest : null;
    if (!send) { reject(new Error("unsupported protocol")); return; }
    const outgoing = send(target.href, {
      method: init.method, signal: init.signal,
      headers: { ...init.headers, "content-length": String(init.body.byteLength) },
    }, (incoming) => {
      const status = incoming.statusCode ?? 502;
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
          try { headers.append(name, entry); } catch { /* a header fetch would refuse too */ }
        }
      }
      const body = status === 204 || status === 304 ? null : Readable.toWeb(incoming) as unknown as BodyInit_;
      try { resolve(new Response(body, { status: status >= 200 && status <= 599 ? status : 502, headers })); }
      catch (error) { incoming.destroy(); reject(error); }
    });
    outgoing.once("error", reject);
    outgoing.end(Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength));
  });
}

export type BridgeOptions = {
  registry: ModelRegistry;
  directory?: string;
  requestTimeoutMs?: number;
  fetch?: typeof fetchWithoutHeaderDeadline;
};

export type OpenedRoute = { address: string; capability: string };

export type Bridge = ReturnType<typeof createBridge>;

export function createBridge(options: BridgeOptions) {
  const { registry } = options;
  const root = options.directory ?? registry.root;
  const statePath = join(root, "bridge-state.json");
  const timeoutMs = Math.max(1, Math.min(600_000, options.requestTimeoutMs ?? 600_000));
  const fetchUpstream = options.fetch ?? fetchWithoutHeaderDeadline;

  const routes = new Map<string, Route>();
  const agentRoutes = new Map<string, Route>();
  let port = 0;
  let listener: ReturnType<typeof createServer> | null = null;
  let listening: Promise<number> | null = null;
  let closed = false;

  // -- State kept across a plugin reload -----------------------------------
  let stateWrites: Promise<unknown> = Promise.resolve();
  const savedState: Promise<SavedState> = readFile(statePath, "utf8")
    .then((content) => parseSavedState(JSON.parse(content)), () => parseSavedState(null));
  const updateSaved = (change: (state: SavedState) => void) => {
    const task = stateWrites.then(async () => {
      const state = await savedState;
      change(state);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const serialized: Record<string, unknown> = {};
      for (const [agentId, route] of state.routes) serialized[agentId] = route;
      const content = `${JSON.stringify({ version: 1, port: state.port, routes: serialized })}\n`;
      const temporary = `${statePath}.${process.pid}.tmp`;
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, statePath);
    });
    stateWrites = task.catch(() => undefined);
    return task;
  };

  const rememberRoute = (route: Route, listenerPort: number) => updateSaved((state) => {
    state.port = listenerPort;
    state.routes.delete(route.agentId);
    state.routes.set(route.agentId, {
      prefix: route.prefix, capabilityHash: route.capabilityHash.toString("hex"),
      home: route.home, model: route.model,
    });
    while (state.routes.size > SAVED_ROUTE_LIMIT) state.routes.delete(state.routes.keys().next().value!);
  });
  const forgetRoute = (agentId: string, prefix: string) => updateSaved((state) => {
    if (state.routes.get(agentId)?.prefix === prefix) state.routes.delete(agentId);
  });

  const revoke = (route: Route) => {
    routes.delete(route.prefix);
    for (const [id, current] of agentRoutes) if (current === route) agentRoutes.delete(id);
    if (!closed) void forgetRoute(route.agentId, route.prefix);
    for (const active of route.active) {
      active.controller.abort();
      localError(active.response, 503);
    }
  };

  const providerById = (id: string): StoredProvider | null => registry.providerById(id) ?? null;
  const enabledProvider = (provider: StoredProvider | null): StoredProvider | null =>
    provider && provider.enabled && registry.apiKey(provider.id) !== null ? provider : null;

  /** The provider a request's model belongs to, or the session's home provider. */
  const targetProvider = (route: Route, model: unknown): StoredProvider | null => {
    if (typeof model === "string" && model) {
      const provider = registry.providerForModel(model);
      if (provider) return provider;
    }
    return enabledProvider(providerById(route.home));
  };

  const forward = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let route: Route | undefined;
    let active: ActiveRequest | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let disconnected: (() => void) | undefined;
    try {
      if (closed || request.headers.host !== `127.0.0.1:${port}` || request.headers.origin !== undefined) throw new LocalFailure(403);
      // Claude Code: /v1/messages and /v1/messages/count_tokens (the SDK may
      // append a fixed ?beta=true). Query strings are never forwarded.
      const match = /^\/([a-f0-9]{64})\/v1\/(messages(?:\/count_tokens)?)(?:\?beta=true)?$/.exec(request.url ?? "");
      route = match ? routes.get(match[1]!) : undefined;
      const authorization = request.headers.authorization ?? "";
      if (!route || !authorization.startsWith("Bearer ") || !sameDigest(capabilityDigest(authorization.slice(7)), route.capabilityHash)) throw new LocalFailure(403);
      if (request.method !== "POST") throw new LocalFailure(405);
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")
        || (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity")
        || (request.headers["anthropic-version"] && request.headers["anthropic-version"] !== "2023-06-01")) throw new LocalFailure(400);
      active = { controller: new AbortController(), response };
      route.active.add(active);
      const controller = active.controller;
      disconnected = () => { if (!response.writableEnded) controller.abort(); };
      request.once("aborted", disconnected);
      response.once("close", disconnected);
      timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref();
      const raw = await readBody(request, controller.signal);
      let body: Record<string, any>;
      try { body = JSON.parse(raw.toString("utf8")); } catch { throw new LocalFailure(400, "请求内容无效", "invalid_request_error"); }
      if (!isRecord(body)) throw new LocalFailure(400, "请求内容无效", "invalid_request_error");
      const path = match![2]!;
      const provider = targetProvider(route, body.model);
      if (!provider) throw new LocalFailure(503, "模型所属 Provider 未启用或 Key 缺失", "api_error");
      const key = registry.apiKey(provider.id)!;
      const models = sessionModels(provider.models);
      const listed = claudeModelFor(body.model, models, route.model) ?? models[0]!.id;
      const model = vendorModelId(listed);
      body = { ...body, model };

      const bridge: ProtocolBridge | null = provider.protocol === "chat" ? anthropicToChat : null;
      const countTokens = path === "messages/count_tokens";
      const upstreamPath = bridge ? bridge.upstreamPath(`v1/${path}`) : `v1/${path}`;
      if (!upstreamPath) {
        // count_tokens toward a chat route: answer locally with an estimate.
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ input_tokens: estimateAnthropicInputTokens(body) }));
        return;
      }

      const convertOptions = { model, defaultMaxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS, clientRequest: body };
      const outgoing = bridge ? bridge.request(body, convertOptions) : body;
      const streaming = outgoing.stream === true;
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: streaming ? "text/event-stream" : "application/json",
        ...(provider.authHeader === "x-api-key" ? { "x-api-key": key } : { authorization: `Bearer ${key}` }),
      };
      if (provider.protocol === "anthropic") {
        headers["anthropic-version"] = "2023-06-01";
        const betaHeader = request.headers["anthropic-beta"];
        const beta = typeof betaHeader === "string" && betaHeader.length <= 512
          ? [...new Set(betaHeader.split(",").map((value) => value.trim()).filter((value) => BETA.has(value)))] : [];
        if (beta.length) headers["anthropic-beta"] = beta.join(",");
      }
      const upstreamUrl = `${provider.baseUrl}/${upstreamPath}`;
      const upstream = await fetchUpstream(upstreamUrl, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers, body: new Uint8Array(Buffer.from(JSON.stringify(outgoing))),
      });
      if (controller.signal.aborted) throw new LocalFailure(503);
      // A count_tokens the vendor does not implement is answered with the
      // local estimate rather than an error Claude Code cannot use.
      if (countTokens && !bridge && (upstream.status === 404 || upstream.status === 405)) {
        await upstream.body?.cancel().catch(() => undefined);
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ input_tokens: estimateAnthropicInputTokens(body) }));
        return;
      }
      if (!upstream.ok) throw await upstreamFailure(upstream, bridge);

      // A client that asked to stream gets a stream, even from a route that
      // answered with one JSON body: the converter turns either into events.
      const upstreamStreams = upstream.headers.get("content-type")?.startsWith("text/event-stream") === true || (!!bridge && streaming);
      response.writeHead(upstream.status, { "content-type": upstreamStreams ? "text/event-stream" : "application/json", "cache-control": "no-store" });
      reader = upstream.body?.getReader();
      const write = async (data: string | Uint8Array) => {
        if (!data.length) return;
        if (!response.write(data)) await once(response, "drain", { signal: controller.signal });
      };
      if (!bridge) {
        if (reader) {
          while (true) {
            const chunk = await reader.read();
            if (controller.signal.aborted) throw new LocalFailure(503);
            if (chunk.done) break;
            await write(chunk.value);
          }
        }
      } else if (upstreamStreams) {
        const converter = bridge.stream(convertOptions);
        const decoder = new StringDecoder("utf8");
        if (reader) {
          while (true) {
            const chunk = await reader.read();
            if (controller.signal.aborted) throw new LocalFailure(503);
            if (chunk.done) break;
            await write(converter.push(decoder.write(Buffer.from(chunk.value))));
          }
        }
        await write(converter.push(decoder.end()) + converter.end());
      } else {
        const chunks: Buffer[] = [];
        let size = 0;
        if (reader) {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > 32 * 1024 * 1024) throw new LocalFailure(502);
            chunks.push(Buffer.from(chunk.value));
          }
        }
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new LocalFailure(502); }
        if (!isRecord(parsed)) throw new LocalFailure(502);
        const converted = bridge.response(parsed, convertOptions);
        // A failure the upstream reported inside a 200 converts to an error body.
        if (converted.type === "error" || (isRecord(converted.error) && !("output" in converted))) {
          const detail = isRecord(converted.error) && typeof converted.error.message === "string" ? converted.error.message : PUBLIC_ERROR;
          throw new LocalFailure(502, detail.slice(0, 600));
        }
        await write(JSON.stringify(converted));
      }
      response.end();
    } catch (error) {
      const refusedStatus = error instanceof Error && !(error instanceof LocalFailure)
        ? (error as Error & { status?: unknown }).status : undefined;
      const failure = error instanceof LocalFailure ? error
        : typeof refusedStatus === "number" && refusedStatus >= 400 && refusedStatus < 500
          ? new LocalFailure(refusedStatus, (error as Error).message.slice(0, 600) || "请求内容无效", "invalid_request_error")
          : new LocalFailure(502);
      // Claude Code compacts on an invalid_request_error saying "prompt is too long".
      const type = failure.type === "context_length_exceeded" ? "invalid_request_error" : failure.type;
      const message = failure.type === "context_length_exceeded" && !/^prompt is too long/i.test(failure.message)
        ? `prompt is too long: ${failure.message}` : failure.message;
      localError(response, failure.status, message, type);
      request.resume();
    } finally {
      if (timer) clearTimeout(timer);
      if (disconnected) { request.off("aborted", disconnected); response.off("close", disconnected); }
      if (reader) await reader.cancel().catch(() => undefined);
      if (active) { active.controller.abort(); route?.active.delete(active); }
    }
  };

  async function upstreamFailure(upstream: Response, bridge: ProtocolBridge | null): Promise<LocalFailure> {
    const text = await upstream.text().catch(() => "");
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (bridge && isRecord(parsed)) {
      const converted = bridge.error(upstream.status, parsed);
      const error = isRecord(converted.error)
        ? { type: typeof converted.error.type === "string" ? converted.error.type : "api_error", message: typeof converted.error.message === "string" ? converted.error.message : PUBLIC_ERROR }
        : { type: "api_error", message: PUBLIC_ERROR };
      return new LocalFailure(upstream.status, error.message.slice(0, 600), error.type);
    }
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const type = typeof parsed.error.type === "string" ? parsed.error.type : "api_error";
      const message = typeof parsed.error.message === "string" ? parsed.error.message : PUBLIC_ERROR;
      return new LocalFailure(upstream.status, message.slice(0, 600), type);
    }
    return new LocalFailure(upstream.status, PUBLIC_ERROR);
  }

  /**
   * Listens on loopback, preferring the port of the previous plugin
   * instance so live sessions keep their address across a reload.
   */
  const ensureListener = (preferred = 0): Promise<number> => {
    if (listening) return listening;
    if (closed) return Promise.reject(new Error(PUBLIC_ERROR));
    const server = createServer((request, response) => { void forward(request, response); });
    listener = server;
    server.requestTimeout = timeoutMs;
    server.headersTimeout = Math.min(timeoutMs, 15_000);
    server.maxHeadersCount = 40;
    server.on("clientError", (_error, socket) => { socket.destroy(); });
    const listen = (wanted: number) => new Promise<number>((resolvePort, reject) => {
      server.once("error", reject);
      server.listen(wanted, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") { reject(new Error(PUBLIC_ERROR)); return; }
        port = address.port;
        resolvePort(port);
      });
    });
    const attempt = async (left: number): Promise<number> => {
      try {
        return await listen(preferred);
      } catch (error) {
        if (!preferred || (error as NodeJS.ErrnoException).code !== "EADDRINUSE" || closed) throw error;
        if (left <= 0) return listen(0);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
        return attempt(left - 1);
      }
    };
    const started = attempt(10);
    listening = started;
    started.catch(() => { if (listening === started) { listening = null; listener = null; } });
    return started;
  };

  /** Puts back the routes the previous plugin instance gave live sessions. */
  const restore = async (): Promise<void> => {
    const state = await savedState;
    if (closed || !state.routes.size) return;
    let listenerPort = 0;
    try { listenerPort = await ensureListener(state.port); } catch { listenerPort = 0; }
    if (!listenerPort || listenerPort !== state.port) {
      if (listenerPort) {
        console.warn(`[custom-models] 本地代理没能在原端口（${state.port}）恢复，已改用端口 ${listenerPort}；已开的自定义模型会话需重新打开`);
      }
      return;
    }
    for (const [agentId, entry] of state.routes) {
      if (closed) return;
      if (routes.has(entry.prefix)) continue;
      const route: Route = {
        agentId, prefix: entry.prefix, capabilityHash: Buffer.from(entry.capabilityHash, "hex"),
        home: entry.home, model: entry.model, active: new Set(),
      };
      routes.set(route.prefix, route);
      agentRoutes.set(agentId, route);
    }
  };
  void restore().catch(() => undefined);

  return {
    /** Opens (or reopens) the bridge route for a session on one of our models. */
    async openRoute(agentId: string, model: string): Promise<OpenedRoute> {
      const provider = registry.providerForModel(model);
      if (!provider) throw new Error("模型不属于任何已启用的 Provider");
      const state = await savedState;
      const listenerPort = await ensureListener(state.port);
      const capability = randomBytes(32).toString("hex");
      const route: Route = {
        agentId, prefix: randomBytes(32).toString("hex"), capabilityHash: capabilityDigest(capability),
        home: provider.id, model, active: new Set(),
      };
      const previous = agentRoutes.get(agentId);
      if (previous) revoke(previous);
      routes.set(route.prefix, route);
      agentRoutes.set(agentId, route);
      await rememberRoute(route, listenerPort);
      return { address: `http://127.0.0.1:${listenerPort}/${route.prefix}`, capability };
    },

    /** Ends a session's route (agent closed, or it left our models). */
    release(agentId: string): void {
      const route = agentRoutes.get(agentId);
      if (!route) return;
      agentRoutes.delete(agentId);
      revoke(route);
    },

    /** Whether a session currently holds a route. */
    routed: (agentId: string): boolean => agentRoutes.has(agentId),

    /** The bridge's listening port, once bound (mainly for tests). */
    port: (): number => port,

    /** Resolves when routes saved by the previous instance are back (or lost). */
    restored: (): Promise<void> => savedState.then(() => undefined),

    async close(): Promise<void> {
      closed = true;
      for (const route of [...routes.values()]) {
        for (const active of route.active) { active.controller.abort(); }
      }
      await stateWrites.catch(() => undefined);
      await listening?.catch(() => undefined);
      if (listener) {
        listener.closeAllConnections();
        await new Promise<void>((resolveClose) => listener!.close(() => resolveClose()));
      }
    },
  };
}
