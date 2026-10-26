import { menuModelId } from "../shared/model-id.ts";

/**
 * The environment a Claude Code session needs to run on one of our models:
 * the bridge's address as the Anthropic endpoint, a per-session capability
 * as the bearer, and the aliases (Opus/Haiku/subagents) mapped onto the
 * provider's strong and fast models.
 */

/** Set by the agent.create hook; read (and removed) by the session_open hook. */
export const MODEL_SELECTED_ENV = "CLAUDE_MODELS_SELECTED";

export type SessionModel = { id: string; contextWindow?: number };

export function modelFamilies(models: SessionModel[], preferred?: string | null) {
  const family = (names: string) => models.find((model) => new RegExp(`(?:^|[-_.:])(?:${names})(?:$|[-_.:\\[])`, "i").test(model.id));
  const chosen = preferred ? models.find((model) => model.id === preferred) : undefined;
  // The person's chosen model takes the main aliases even next to a "-pro".
  const strong = chosen ?? family("pro|max|ultra|flagship") ?? models[0]!;
  return { strong: strong.id, fast: (family("flash|fast|mini|lite|air|highspeed|turbo") ?? chosen ?? strong).id };
}

/**
 * A name the provider does not list (a Claude alias, an older session's
 * model) becomes the provider's model of the same kind instead of a refused
 * request: background/"haiku"-like names take the fast model, everything
 * else the strong one.
 */
export function claudeModelFor(requested: unknown, models: SessionModel[], preferred?: string | null): string | null {
  if (typeof requested !== "string" || !models.length) return null;
  if (models.some((model) => model.id === requested)) return requested;
  const { strong, fast } = modelFamilies(models, preferred);
  return /haiku|flash|fast|small|mini|lite|air/i.test(requested) ? fast : strong;
}

export function claudeDefaults(models: SessionModel[], preferred?: string | null): Record<string, string> {
  const { strong, fast } = modelFamilies(models, preferred);
  const window = models.find((model) => model.id === (preferred ?? strong))?.contextWindow;
  return {
    ANTHROPIC_DEFAULT_OPUS_MODEL: strong,
    ANTHROPIC_DEFAULT_SONNET_MODEL: strong,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: fast,
    ANTHROPIC_DEFAULT_FABLE_MODEL: strong,
    CLAUDE_CODE_SUBAGENT_MODEL: fast,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // Claude Code assumes 200k for a model it does not know; compact at the
    // window this model really has.
    ...(window ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window), CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(window) } : {}),
  };
}

/**
 * Clears inherited credentials so they cannot leak past the bridge: session
 * env overlays the daemon's, so an empty string also unsets a process value.
 */
export function cleanEnvironment(current: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...current };
  for (const key of Object.keys({ ...process.env, ...env })) {
    if (/^(?:ANTHROPIC_|DEEPSEEK_|MOONSHOT_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_USE_|AWS_|GOOGLE_|GOOGLE_APPLICATION_CREDENTIALS$|CLOUD_ML_|AZURE_)/.test(key)) env[key] = "";
  }
  return {
    ...env,
    ANTHROPIC_MODEL: "", ANTHROPIC_API_KEY: "", DEEPSEEK_API_KEY: "", MOONSHOT_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "",
    ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_BASE_URL: "", ANTHROPIC_CUSTOM_HEADERS: "", CLAUDE_CODE_USE_BEDROCK: "", CLAUDE_CODE_USE_VERTEX: "", CLAUDE_CODE_USE_FOUNDRY: "",
  };
}

export type ClaudeRouteEnv = {
  address: string;
  capability: string;
  models: SessionModel[];
  preferred: string | null;
};

/** The full env overlay for a Claude session on one of our providers. */
export function claudeSessionEnv(route: ClaudeRouteEnv, current: Record<string, string>): Record<string, string> {
  return {
    ...cleanEnvironment(current),
    ...claudeDefaults(route.models, route.preferred),
    ANTHROPIC_BASE_URL: route.address,
    ANTHROPIC_AUTH_TOKEN: route.capability,
  };
}

/** Splits our selection marker out of a session env. */
export function takeSelectedMarker(env: Record<string, string>): { env: Record<string, string>; selected: string | undefined } {
  const { [MODEL_SELECTED_ENV]: selected, ...rest } = env;
  return { env: rest, selected: typeof selected === "string" && selected ? selected : undefined };
}

/** Menu model ids for one provider's models, as the session env names them. */
export function sessionModels(models: ReadonlyArray<{ id: string; contextWindow?: number }>): SessionModel[] {
  return models.map((model) => ({
    id: menuModelId(model.id),
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
  }));
}
