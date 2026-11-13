/**
 * Presentation tables this plugin hardcodes into discovery results: the
 * Agent mode list and the permission preset setting. Labels mirror the dsh
 * desktop app's zh-CN strings; the accompanying values are dsh-protocol
 * level and are forwarded to dsh verbatim, never parsed back from labels.
 */

export const DSH_MODES = [
  { id: "standard", name: "标准模式", description: "日常编码任务的标准工具组合。" },
  { id: "ptc", name: "PTC 模式", description: "使用 dsh 的 PTC 工具呈现处理批量工具任务。" },
  { id: "minimal", name: "极简模式", description: "使用 dsh 的精简工具组合。" },
  { id: "cordis", name: "创造模式", description: "使用 dsh 的创造者工具组合。" },
] as const;

export type DshModeId = (typeof DSH_MODES)[number]["id"];

export const PERMISSION_SETTING_ID = "paseo_dsh_permission_preset";
export const PERMISSION_SETTING_NAME = "权限";
export const PERMISSION_SETTING_DESCRIPTION = "选择此项目会话的 dsh 权限模式。";

// Permission labels mirror the dsh desktop app's zh-CN strings
// (preset.readOnly / preset.workspaceWrite / preset.fullAccess); values stay
// dsh-protocol-level and are passed to dsh's permissionPresets verbatim.
// dsh's zh locale keeps "auto" in English, so it is not translated here.
export const DEFAULT_PERMISSION_OPTIONS = [
  { value: "read-only", name: "仅可查看" },
  { value: "workspace-write", name: "工作区内修改" },
  { value: "danger-full-access", name: "完全权限" },
];
export const PERMISSION_LABELS: Record<string, string> = {
  "read-only": "仅可查看",
  "workspace-write": "工作区内修改",
  "danger-full-access": "完全权限",
  auto: "Auto review",
};

/**
 * Everything from this file that surfaces through catalog discovery. dsh
 * Catalog cache keys hash this fingerprint, so editing any label here (or
 * adding a mode/preset) invalidates Paseo's cached provider catalog —
 * equal keys share discovery, and hashing profile files alone would keep
 * serving the stale labels after a plugin update.
 */
export const dshCatalogShape = JSON.stringify({
  modes: DSH_MODES,
  permissionSetting: {
    id: PERMISSION_SETTING_ID,
    name: PERMISSION_SETTING_NAME,
    description: PERMISSION_SETTING_DESCRIPTION,
  },
  permissionOptions: DEFAULT_PERMISSION_OPTIONS,
  permissionLabels: PERMISSION_LABELS,
});
