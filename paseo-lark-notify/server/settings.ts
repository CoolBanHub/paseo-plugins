import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Host-scoped settings. Every field has a default so the plugin works with no
 * configuration: the recipient comes from the lark-cli login and the binary is
 * discovered on PATH or under nvm.
 */
export const notifyValuesSchema = z.object({
  /** Recipient open_id; empty means "use the lark-cli login". */
  openId: z.string().default(""),
  /** Explicit lark-cli binary path; empty means auto-discovery. */
  larkCliPath: z.string().default(""),
  /** Bot messages need no send_as_user scope and never impersonate the user. */
  identity: z.enum(["bot", "user"]).default("bot"),
  notifyPermission: z.boolean().default(true),
  /** Retained as notifySessionEnd for compatibility with existing host settings. */
  notifySessionEnd: z.boolean().default(true),
  /** Child agents also emit turn-ended events; keep them quiet by default. */
  includeSubagents: z.boolean().default(false),
});

export type NotifyValues = z.output<typeof notifyValuesSchema>;

export const DEFAULT_NOTIFY_VALUES: NotifyValues = notifyValuesSchema.parse({});

export const larkNotifySettings = defineSettings({
  id: "lark_notify",
  scope: "host",
  version: 1,
  schema: notifyValuesSchema,
});
