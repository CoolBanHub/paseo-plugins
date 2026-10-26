import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { modelIdPattern } from "./model-id";
import type { AuthHeader, ProviderProtocol } from "./presets";

/**
 * RPC contracts between the settings screen and the daemon-side handler.
 * API keys travel only in saveProvider.input (never returned); the renderer
 * sees at most a masked hint.
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

export const providerInputSchema = z.object({
  /** Present to edit an existing provider, absent to create one. */
  id: z.string().max(64).optional(),
  label: z.string().trim().min(1, "请填写名称").max(40, "名称过长"),
  baseUrl: z.string().trim().min(1, "请填写 API 地址"),
  protocol: protocolSchema,
  authHeader: authHeaderSchema,
  enabled: z.boolean().default(true),
  models: z.array(modelEntrySchema).min(1, "至少配置一个模型").max(50),
  /** Written to the secret store; omitted keeps the stored key. */
  apiKey: z.string().max(512).optional(),
});
export type ProviderInput = z.output<typeof providerInputSchema>;

export const providerViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  baseUrl: z.string(),
  protocol: protocolSchema,
  authHeader: authHeaderSchema,
  enabled: z.boolean(),
  models: z.array(modelEntrySchema),
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
  name: "custom-models.providers.list",
  input: z.object({}),
  output: providersResult,
});

export const saveProviderRpc = defineRpc({
  name: "custom-models.providers.save",
  input: providerInputSchema,
  output: providersResult,
});

export const deleteProviderRpc = defineRpc({
  name: "custom-models.providers.delete",
  input: z.object({ id: z.string() }),
  output: providersResult,
});
