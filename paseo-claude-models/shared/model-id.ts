/**
 * Menu model ids this plugin contributes to Paseo's Claude provider: the
 * vendor's model id behind a reserved prefix and the owning provider's id,
 * so ours never collide with an official Claude name, one the person added
 * themselves, or the same model id listed by another provider. Both are
 * stripped before the request reaches the vendor. Ids from before the
 * provider scope (plain "cm:<vendor id>") keep resolving.
 */

export const MENU_MODEL_PREFIX = "cm:";

/**
 * Claude Code's switch for the 1M context window: a suffix on the model id
 * (e.g. "glm-5.3-flash[1m]") it reads itself. The vendor never sees it, so
 * the bridge strips it before forwarding.
 */
export const WINDOW_SUFFIX_PATTERN = /\[1m\]$/i;

/** A model id a provider may list: vendor ids like "deepseek-chat", gateway
 * ids like "openai/gpt-4o", optionally with the "[1m]" window switch (lower
 * case only — that is the form Claude Code reads). No "..", no "//", no
 * leading slash. */
export const modelIdPattern = /^(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}(?:\[1m\])?$/;

export function menuModelId(providerId: string, vendorModelId: string): string {
  return `${MENU_MODEL_PREFIX}${providerId}/${vendorModelId}`;
}

/** A menu id split for resolution: the provider scope (the first "/"
 *  segment — provider ids are slugs and never contain one, gateway vendor
 *  ids like "openai/gpt-4o" keep their inner slashes in the remainder),
 *  or null when the id has none. The "[1m]" switch stays intact. */
export type MenuModelIdParts = { scope: string | null; remainder: string; whole: string };

export function parseMenuModelId(model: string): MenuModelIdParts {
  const body = model.startsWith(MENU_MODEL_PREFIX) ? model.slice(MENU_MODEL_PREFIX.length) : model;
  const slash = body.indexOf("/");
  return slash === -1
    ? { scope: null, remainder: body, whole: body }
    : { scope: body.slice(0, slash), remainder: body.slice(slash + 1), whole: body };
}

/** The vendor's own model id: strips our prefix and the "[1m]" switch. */
export function vendorModelId(model: string): string {
  const withoutPrefix = model.startsWith(MENU_MODEL_PREFIX) ? model.slice(MENU_MODEL_PREFIX.length) : model;
  return withoutPrefix.replace(WINDOW_SUFFIX_PATTERN, "");
}

/** Whether one of our menu ids names the 1M window variant. */
export function isWindowVariant(model: string): boolean {
  return WINDOW_SUFFIX_PATTERN.test(model);
}

export function isMenuModel(model: unknown): model is string {
  return typeof model === "string" && model.startsWith(MENU_MODEL_PREFIX);
}

/** Marks an additionalModels entry as ours, for idempotent menu syncing. */
export const OWN_MODEL_DESCRIPTION_PREFIX = "自定义模型 · ";

export function ownModelDescription(providerLabel: string): string {
  return `${OWN_MODEL_DESCRIPTION_PREFIX}${providerLabel}`;
}

export function isOwnModelEntry(entry: unknown): boolean {
  return Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
    && typeof (entry as Record<string, unknown>).description === "string"
    && ((entry as Record<string, unknown>).description as string).startsWith(OWN_MODEL_DESCRIPTION_PREFIX);
}
