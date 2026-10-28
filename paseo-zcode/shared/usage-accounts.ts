import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * RPC contracts between the usage settings screen and the daemon-side
 * handler. Account keys are the hashed usage-source keys, never credentials.
 */

export const usageAccountViewSchema = z.object({
  /** Hashed account key, as the usage source reports it. */
  key: z.string(),
  label: z.string(),
  kind: z.enum(["account", "apikey"]),
  /** Whether the account is reported to Paseo's usage view. */
  reported: z.boolean(),
});
export type UsageAccountView = z.output<typeof usageAccountViewSchema>;

const accountsResult = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  accounts: z.array(usageAccountViewSchema),
});

/** Every coding-plan account found on this machine, with its display state. */
export const listUsageAccountsRpc = defineRpc({
  name: "zcode.usage.accounts.list",
  input: z.object({}),
  output: accountsResult,
});

/**
 * Saves which accounts the usage source reports: every discovered key not in
 * the list is hidden from Paseo's usage view.
 */
export const saveUsageAccountsRpc = defineRpc({
  name: "zcode.usage.accounts.save",
  input: z.object({
    reportedKeys: z.array(z.string().min(1).max(128)).max(50),
  }),
  output: accountsResult,
});
