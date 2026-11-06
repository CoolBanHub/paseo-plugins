import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";

/**
 * Native Paseo session revert for dsh.
 *
 * Paseo's timeline shows revert affordances on items that carry a
 * `revertToken`, and sends `session.revert` inputs with `{token, scope}`.
 * The replay path and the live revert-point marker rows both attach tokens
 * of the shape `{v:1, kind:"dsh-rewind", messageId, seq}`; the connector
 * registers one handler per live dsh session that resolves them (see
 * dsh-acp.ts: conversation rewind appends a native replace marker through
 * the in-dsh bridge, file revert restores checkpointed bytes).
 *
 * The wrapper only routes the request and augments the advertised
 * capabilities; the semantics live with the connector that owns the bridge.
 */

export interface DshRevertToken {
  v: 1;
  kind: "dsh-rewind";
  /** Native dsh user-message id to rewind the conversation to. */
  messageId: string;
  /** Event seq of that message; file receipts after it are undone. */
  seq?: number;
}

export interface DshRevertResult {
  /** Short Chinese summary shown in the timeline notice. */
  description: string;
}

type DshRevertHandler = (input: {
  token: DshRevertToken | undefined;
  scope: "conversation" | "files" | "both";
}) => Promise<DshRevertResult>;

const handlers = new Map<string, DshRevertHandler>();

export function registerDshRevertHandler(sessionId: string, handler: DshRevertHandler): void {
  handlers.set(sessionId, handler);
}

export function unregisterDshRevertHandler(sessionId: string): void {
  handlers.delete(sessionId);
}

/** Parse and validate a revert token carried by a timeline item. */
export function parseDshRevertToken(value: unknown): DshRevertToken | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const token = value as Record<string, unknown>;
  if (token.kind !== "dsh-rewind" || typeof token.messageId !== "string" || !token.messageId) {
    return undefined;
  }
  const seq = typeof token.seq === "number" && Number.isFinite(token.seq) ? token.seq : undefined;
  return { v: 1, kind: "dsh-rewind", messageId: token.messageId, ...(seq !== undefined ? { seq } : {}) };
}

function withRevertCapability(capabilities: readonly string[]): string[] {
  return capabilities.includes("session.revert.both") ? [...capabilities] : [...capabilities, "session.revert.both"];
}

/** Wrap the provider so `session.revert` reaches the connector's handler. */
export function withDshRevert(provider: ProviderRegistration): ProviderRegistration {
  return {
    ...provider,
    async connect(request) {
      const connection = await provider.connect(request);
      const listeners = new Set<(event: ProviderEvent) => void>();
      const unsubscribe = connection.onEvent((event) => {
        let next = event;
        if (event.type === "session.opened") {
          next = { ...event, capabilities: withRevertCapability(event.capabilities) };
        }
        for (const listener of listeners) listener(next);
      });
      const emit = (event: ProviderEvent): void => {
        for (const listener of listeners) listener(event);
      };
      const wrapped: ProviderConnection = {
        get version() {
          return connection.version;
        },
        get capabilities() {
          return withRevertCapability(connection.capabilities);
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async send(input: ProviderInput) {
          if (input.type === "session.revert") {
            const handler = handlers.get(input.sessionId);
            if (!handler) {
              emit({
                type: "request.failed",
                requestId: input.requestId,
                error: { message: "会话当前未连接 dsh 进程，无法回退；请先打开该会话后重试" },
              });
              return;
            }
            try {
              const result = await handler({
                token: parseDshRevertToken(input.token),
                scope: input.scope,
              });
              emit({ type: "request.completed", requestId: input.requestId });
              if (result.description) {
                emit({
                  type: "timeline.item",
                  sessionId: input.sessionId,
                  item: { type: "notification", id: `dsh:revert:${input.requestId}`, level: "info", message: result.description },
                });
              }
            } catch (error) {
              emit({
                type: "request.failed",
                requestId: input.requestId,
                error: { message: error instanceof Error ? error.message : String(error) },
              });
            }
            return;
          }
          return connection.send(input);
        },
        async close() {
          unsubscribe();
          await connection.close();
        },
      };
      return wrapped;
    },
  };
}
