import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { modelIdPattern } from "./model-id.ts";
import type { AuthHeader, ProviderProtocol } from "./presets.ts";

/**
 * RPC contracts between the settings screen and the daemon-side handler.
 * API keys travel only in saveProvider.input (never returned); the renderer
 * sees at most a masked hint — including in env values, which use the
 * "${API_KEY}" placeholder instead of the key itself.
 */

const protocolSchema = z.enum(["anthropic", "chat"]);
const authHeaderSchema = z.enum(["bearer", "x-api-key"]);

export const modelEntrySchema = z.object({
  id: z.string().regex(modelIdPattern, "模型 ID 含非法字符"),
  label: z.string().trim().max(64).default(""),
  description: z.string().trim().max(120).optional(),
  contextWindow: z.number().int().min(4_096).max(10_000_000).optional(),
});
export type ModelEntry = z.output<typeof modelEntrySchema>;

export const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** The bridge owns these; a provider env entry may not override them. */
export const RESERVED_ENV_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

/** Which of the provider's models an Anthropic alias maps to; unset = auto. */
export const aliasSelectionSchema = z.object({
  opus: z.string().max(128).optional(),
  sonnet: z.string().max(128).optional(),
  haiku: z.string().max(128).optional(),
});
export type AliasSelection = z.output<typeof aliasSelectionSchema>;

export const providerInputSchema = z.object({
  /** Present to edit an existing provider, absent to create one. */
  id: z.string().max(64).optional(),
  label: z.string().trim().min(1, "请填写名称").max(40, "名称过长"),
  baseUrl: z.string().trim().min(1, "请填写 API 地址"),
  protocol: protocolSchema,
  authHeader: authHeaderSchema,
  enabled: z.boolean().default(true),
  models: z.array(modelEntrySchema).min(1, "至少配置一个模型").max(50),
  /** Extra session env for this provider; "${API_KEY}" resolves to the stored key. */
  env: z.record(z.string().regex(envKeyPattern, "环境变量名不合法"), z.string().max(2_000)).default({}),
  aliasOverrides: aliasSelectionSchema.default({}),
  /** Written to the secret store; omitted keeps the stored key. */
  apiKey: z.string().max(512).optional(),
});
/** What callers may pass: env/aliases/enabled/apiKey may be omitted. */
export type ProviderInput = z.input<typeof providerInputSchema>;

export const providerViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  baseUrl: z.string(),
  protocol: protocolSchema,
  authHeader: authHeaderSchema,
  enabled: z.boolean(),
  models: z.array(modelEntrySchema),
  env: z.record(z.string(), z.string()),
  aliasOverrides: aliasSelectionSchema,
  keyConfigured: z.boolean(),
  keyHint: z.string().nullable(),
  updatedAt: z.string(),
});
export type ProviderView = z.output<typeof providerViewSchema>;

const providersResult = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  providers: z.array(providerViewSchema),
});

export const listProvidersRpc = defineRpc({
  name: "claude-models.providers.list",
  input: z.object({}),
  output: providersResult,
});

export const saveProviderRpc = defineRpc({
  name: "claude-models.providers.save",
  input: providerInputSchema,
  output: providersResult,
});

export const deleteProviderRpc = defineRpc({
  name: "claude-models.providers.delete",
  input: z.object({ id: z.string() }),
  output: providersResult,
});
