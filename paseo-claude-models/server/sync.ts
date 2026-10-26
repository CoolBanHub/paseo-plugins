import { isOwnModelEntry } from "../shared/model-id.ts";
import type { MenuModel } from "./store.ts";

/**
 * Menu injection: our models are placed in the built-in Claude provider's
 * additionalModels, next to the official ones, keeping entries the person
 * added themselves. Entries are marked through their description, so a sync
 * replaces only its own.
 */

export type ProviderApi = {
  config: {
    get(requestId?: string): Promise<{ config: { providers?: Record<string, unknown> } }>;
    patch(config: unknown, requestId?: string): Promise<unknown>;
  };
  providers: { refresh(options?: { providers?: string[] }): Promise<unknown> };
};

/** Paseo reorders keys when storing config; compare a canonical form. */
function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item)
    ? item.map(sort)
    : item && typeof item === "object"
      ? Object.fromEntries(Object.keys(item as Record<string, unknown>).sort().map((key) => [key, sort((item as Record<string, unknown>)[key])]))
      : item;
  return JSON.stringify(sort(value));
}

export function ownMenuEntries(models: readonly MenuModel[]): Array<Record<string, string>> {
  return models.map((model) => ({ id: model.id, label: model.label, description: model.description }));
}

/**
 * Puts exactly our models into the Claude provider's additionalModels list.
 * Idempotent: nothing is written (nor the provider re-read) when the stored
 * list already matches.
 */
export async function syncClaudeModels(paseo: ProviderApi, models: readonly MenuModel[]): Promise<void> {
  const snapshot = await paseo.config.get();
  const providers = snapshot.config.providers ?? {};
  const entry = providers["claude"] as Record<string, unknown> | undefined;
  const current = Array.isArray(entry?.additionalModels) ? entry!.additionalModels as Array<Record<string, unknown>> : [];
  // The person's own entries stay, even one whose id collides with ours (theirs wins).
  const kept = current.filter((model) => !isOwnModelEntry(model));
  const theirs = new Set(kept.map((model) => String(model?.id)));
  const next = [...kept, ...ownMenuEntries(models).filter((model) => !theirs.has(model.id))];
  if (canonicalJson(current) === canonicalJson(next)) return;
  if (!entry && !next.length) return;
  await paseo.config.patch({ providers: { claude: { additionalModels: next } } });
  await paseo.providers.refresh({ providers: ["claude"] }).catch(() => undefined);
}
