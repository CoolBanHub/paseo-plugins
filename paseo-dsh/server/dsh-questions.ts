import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";

/**
 * dsh's ask_user_question is answered through Paseo's native question form.
 *
 * The ACP adapter hardcodes permission requests to `kind: "tool"` and does
 * not forward `updatedInput` back to the agent, which is exactly the field
 * Paseo's QuestionFormCard returns. This wrapper:
 *
 * - marks a synthetic request as `kind: "question"` so Paseo renders its
 *   form (options, multi-select and free-text "Other");
 * - intercepts the answer on its way to the ACP adapter, hands the answer
 *   map to the connector that asked, and does not forward it downstream.
 *
 * Both sides share the in-process registry below; no file round-trip is
 * needed for the answer itself.
 */

export interface DshQuestionFormQuestion {
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  allowOther?: boolean;
  allowEmpty?: boolean;
  placeholder?: string;
}

interface PendingQuestion {
  requestId: string;
  /** The connector that owns this form; only its shutdown cancels it. */
  scope?: string;
  resolve: (answers: Record<string, string> | undefined) => void;
}

const pending = new Map<string, PendingQuestion>();

/** Register the pending form keyed by the synthetic tool-call id. */
export function registerDshQuestion(toolCallId: string, entry: PendingQuestion): void {
  pending.set(toolCallId, entry);
}

/** Drop a pending form and settle it as dismissed. */
export function cancelDshQuestion(toolCallId: string): void {
  const entry = pending.get(toolCallId);
  if (!entry) return;
  pending.delete(toolCallId);
  entry.resolve(undefined);
}

export function cancelAllDshQuestions(scope?: string): void {
  for (const [key, entry] of [...pending]) {
    if (scope !== undefined && entry.scope !== scope) continue;
    cancelDshQuestion(key);
  }
}

/** Settle one pending form with Paseo's answer map. */
export function resolveDshQuestion(toolCallId: string, answers: Record<string, string> | undefined): boolean {
  const entry = pending.get(toolCallId);
  if (!entry) return false;
  pending.delete(toolCallId);
  entry.resolve(answers);
  return true;
}

function permissionToolCallId(permissionId: string): string | undefined {
  return permissionId.startsWith("permission:") ? permissionId.slice("permission:".length) : undefined;
}

function answerMap(response: unknown): Record<string, string> | undefined {
  if (!response || typeof response !== "object" || Array.isArray(response)) return undefined;
  const updated = (response as { updatedInput?: unknown }).updatedInput;
  if (!updated || typeof updated !== "object" || Array.isArray(updated)) return undefined;
  const answers = (updated as { answers?: unknown }).answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return undefined;
  return Object.fromEntries(
    Object.entries(answers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

/** Wrap the provider so synthetic question permissions render and settle. */
export function withDshQuestions(provider: ProviderRegistration): ProviderRegistration {
  return {
    ...provider,
    async connect(request) {
      const connection = await provider.connect(request);
      const listeners = new Set<(event: ProviderEvent) => void>();
      const unsubscribe = connection.onEvent((event) => {
        let next = event;
        if (event.type === "session.permission") {
          const toolCallId = permissionToolCallId(event.request.id);
          if (toolCallId && pending.has(toolCallId)) {
            next = {
              ...event,
              request: { ...event.request, kind: "question" },
            };
          }
        }
        for (const listener of listeners) listener(next);
      });
      const wrapped: ProviderConnection = {
        ...connection,
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async send(input: ProviderInput) {
          if (input.type === "session.permission") {
            const toolCallId = permissionToolCallId(input.permissionId);
            const entry = toolCallId ? pending.get(toolCallId) : undefined;
            if (entry && toolCallId) {
              // A dismissed form has no answers; the connector treats that as
              // a skipped batch, exactly like dsh's own empty selection.
              resolveDshQuestion(toolCallId, answerMap(input.response));
              // Settle the adapter's pending permission too: the real answer
              // was consumed above, but the ACP request still needs a reply.
              try {
                await connection.send({
                  type: "session.permission",
                  sessionId: input.sessionId,
                  permissionId: input.permissionId,
                  response: { behavior: "allow", selectedActionId: "answer" },
                });
              } catch {
                // The session already closed; its permission sweep handles it.
              }
              return;
            }
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
