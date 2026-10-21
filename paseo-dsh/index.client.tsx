import {
  useSettings,
  type PluginClientContext,
  type PluginPopoverProps,
  type PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SettingsGroup, SettingsRow, SettingsSelect, SidebarRow } from "@getpaseo/plugin/client/ui";
import { DSH_SETTINGS, PERMISSION_MODE_OPTIONS, type PermissionMode } from "./shared/settings";

function PermissionModeControl() {
  const state = useSettings(DSH_SETTINGS);

  return (
    <>
      {state.status === "ready" ? (
        <SettingsSelect<PermissionMode>
          label="权限模式"
          hint="完全权限会跳过 dsh 的审批提示。"
          value={state.values.permissionMode}
          options={PERMISSION_MODE_OPTIONS}
          disabled={state.saving}
          onValueChange={(permissionMode) => {
            void state.save({ ...state.values, permissionMode }, state.revision);
          }}
        />
      ) : (
        <SettingsRow label="权限模式">
          {state.status === "error" || state.status === "invalid" ? state.error : "读取设置中…"}
        </SettingsRow>
      )}
    </>
  );
}

function DshSettingsScreen() {
  return (
    <SettingsGroup
      title="权限预设"
      info="权限预设会传给新启动的 dsh 进程。已打开的会话不受影响。"
    >
      <PermissionModeControl />
    </SettingsGroup>
  );
}

function DshPermissionPopover(_props: PluginPopoverProps) {
  return (
    <SettingsGroup
      title="dsh 权限"
      info="选择的预设会用于之后新建的 dsh 会话。"
    >
      <PermissionModeControl />
    </SettingsGroup>
  );
}

function DshPermissionSidebarItem({ openPopover }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Shield"
      label="dsh 权限"
      onPress={() => openPopover(DshPermissionPopover)}
    />
  );
}

// The dsh integration is a native provider: sessions appear alongside
// Claude Code, Codex and ZCode. The settings screen controls the host-level
// permission preset used by newly spawned dsh sessions.
export default function contribute(client: PluginClientContext) {
  const removeSettings = client.addSettingsScreen({
    id: "dsh",
    title: "dsh 权限",
    icon: "Shield",
    Component: DshSettingsScreen,
  });
  const removeSidebarItem = client.addSidebarFooterItem({
    id: "dsh-permission",
    title: "dsh 权限",
    Component: DshPermissionSidebarItem,
  });

  return () => {
    removeSidebarItem();
    removeSettings();
  };
}
