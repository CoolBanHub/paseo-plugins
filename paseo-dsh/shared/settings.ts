import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const PERMISSION_MODES = [
  "default",
  "workspace-write",
  "read-only",
  "danger-full-access",
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const PERMISSION_MODE_OPTIONS: readonly { label: string; value: PermissionMode }[] = [
  { label: "跟随 dsh 默认", value: "default" },
  { label: "工作区写入", value: "workspace-write" },
  { label: "只读", value: "read-only" },
  { label: "完全权限", value: "danger-full-access" },
];

export const DSH_SETTINGS = defineSettings({
  id: "dsh",
  scope: "host",
  version: 1,
  schema: z.object({
    permissionMode: z
      .enum(PERMISSION_MODES)
      .default("default")
      .describe("权限预设，仅影响之后新建的 dsh 会话。"),
  }),
});
