import { useCallback, useEffect, useState } from "react";
import { ScrollView, Switch, Text, View, useWindowDimensions } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { listProvidersRpc, saveProviderRpc, type ProviderView } from "../shared/contracts";
import { PresetPicker, ProviderEditor } from "./ProviderEditor";
import {
  HoverPressable,
  ModelChip,
  MONO_FONT,
  applyTheme,
  colors,
} from "./widgets";

/**
 * Standalone management screen (sidebar entry "Claude 模型管理"): provider list on
 * the left, the selected provider's editor on the right. Narrow windows stack
 * the two panes and navigate between them with a back button. Toggling a
 * provider's switch saves immediately (models join/leave the Claude picker);
 * everything else is a draft until the editor's save action.
 */

type Selection =
  | { kind: "none" }
  | { kind: "picker" }
  | { kind: "new"; presetId: string }
  | { kind: "provider"; id: string };

/** Below this window width the panes stack and navigate instead of splitting. */
const WIDE_MIN_WIDTH = 960;

export function ModelsScreen(props: PluginSurfaceProps) {
  applyTheme(props.theme);
  const toast = useToast();
  const listRpc = useRpc(listProvidersRpc);
  const saveRpc = useRpc(saveProviderRpc);

  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [selection, setSelection] = useState<Selection>({ kind: "none" });
  const [editorDirty, setEditorDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Bumped to remount the editor after an out-of-band toggle of its provider. */
  const [editorNonce, setEditorNonce] = useState(0);
  const wide = useWindowDimensions().width >= WIDE_MIN_WIDTH;

  const reload = useCallback(async () => {
    try {
      const result = await listRpc({});
      if (result.ok) setProviders(result.providers);
      else toast.error(`读取 Provider 失败：${result.error ?? "未知错误"}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [listRpc, toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onDirtyChange = useCallback((dirty: boolean) => {
    setEditorDirty(dirty);
  }, []);

  /** Switching panes is blocked while the editor holds unsaved edits. */
  const guardUnsaved = useCallback(() => {
    if (!editorDirty) return true;
    toast.error("有未保存的修改，请先保存或放弃");
    return false;
  }, [editorDirty, toast]);

  const selectProvider = useCallback((id: string) => {
    if (!guardUnsaved()) return;
    setSelection({ kind: "provider", id });
  }, [guardUnsaved]);

  const startNew = useCallback(() => {
    if (!guardUnsaved()) return;
    setSelection({ kind: "picker" });
  }, [guardUnsaved]);

  const backToList = useCallback(() => {
    if (!guardUnsaved()) return;
    setSelection({ kind: "none" });
  }, [guardUnsaved]);

  /** The sidebar switch saves immediately: enabled providers feed the picker. */
  const toggle = useCallback(async (provider: ProviderView, enabled: boolean) => {
    if (busy) return;
    if (selection.kind === "provider" && selection.id === provider.id && editorDirty) {
      toast.error("这个 Provider 有未保存的修改，请先保存或放弃再启停");
      return;
    }
    setBusy(true);
    try {
      const result = await saveRpc({
        id: provider.id,
        label: provider.label,
        baseUrl: provider.baseUrl,
        protocol: provider.protocol,
        authHeader: provider.authHeader,
        enabled,
        models: provider.models,
        env: provider.env,
        aliasOverrides: provider.aliasOverrides,
      });
      if (result.ok) {
        setProviders(result.providers);
        toast.show(
          enabled
            ? `已启用 ${provider.label}，模型回到选择器`
            : `已停用 ${provider.label}，模型已从选择器移除`,
        );
        // Remount the editor of the same provider so its form reflects the toggle.
        if (selection.kind === "provider" && selection.id === provider.id) {
          setEditorNonce((nonce) => nonce + 1);
        }
      } else {
        toast.error(`操作失败：${result.error ?? "未知错误"}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, editorDirty, saveRpc, selection, toast]);

  /** After saving a new provider, switch the pane onto the created entry. */
  const onSaved = useCallback((saved: ProviderView[]) => {
    if (selection.kind === "new") {
      const known = new Set(providers.map((provider) => provider.id));
      const created = saved.find((provider) => !known.has(provider.id));
      setSelection(created ? { kind: "provider", id: created.id } : { kind: "none" });
    }
    setProviders(saved);
  }, [providers, selection.kind]);

  const onDeleted = useCallback((saved: ProviderView[]) => {
    setProviders(saved);
    setSelection({ kind: "none" });
  }, []);

  const selected = selection.kind === "provider"
    ? providers.find((provider) => provider.id === selection.id) ?? null
    : null;
  const enabledModelCount = providers
    .filter((provider) => provider.enabled)
    .reduce((count, provider) => count + provider.models.length, 0);

  const listPane = (
    <View
      style={{
        width: wide ? 280 : undefined,
        flex: wide ? undefined : 1,
        backgroundColor: colors().surface1,
        borderRightWidth: wide ? 1 : 0,
        borderRightColor: colors().border,
      }}
    >
      <View style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 10, gap: 4 }}>
        <Text style={{ fontSize: 18, fontWeight: "700", color: colors().foreground }}>Claude 模型管理</Text>
        <Text style={{ fontSize: 12, color: colors().foregroundMuted }}>
          把自有 API Key 的模型（DeepSeek、GLM、Kimi 等）加入 Claude 的模型选择器
        </Text>
        <Text style={{ fontSize: 12, color: colors().foregroundMuted, marginTop: 2 }}>
          {providers.length} 个 Provider · {enabledModelCount} 个模型在选择器
        </Text>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 16, gap: 6 }}>
        {providers.map((provider) => (
          <ProviderRow
            key={provider.id}
            provider={provider}
            selected={selection.kind === "provider" && selection.id === provider.id}
            busy={busy}
            onSelect={() => selectProvider(provider.id)}
            onToggle={(value) => { void toggle(provider, value); }}
          />
        ))}
        <HoverPressable
          accessibilityRole="button"
          accessibilityLabel="新建 Provider"
          disabled={busy}
          onPress={startNew}
          style={({ hovered }) => ({
            borderColor: hovered ? colors().accent : colors().border,
            borderWidth: 1,
            borderStyle: "dashed",
            borderRadius: 10,
            padding: 12,
            alignItems: "center",
            gap: 4,
          })}
        >
          <Text style={{ color: colors().accent, fontSize: 13, fontWeight: "600" }}>
            {providers.length === 0 ? "＋ 添加第一个 Provider" : "＋ 新建 Provider"}
          </Text>
          <Text style={{ color: colors().foregroundMuted, fontSize: 11 }}>
            {providers.length === 0 ? "DeepSeek / GLM / Kimi / 通义千问 / 自定义端点" : "预设一键预填，全部可改"}
          </Text>
        </HoverPressable>
      </ScrollView>
    </View>
  );

  let detailPane;
  if (selection.kind === "picker") {
    detailPane = <PresetPicker onPick={(presetId) => setSelection({ kind: "new", presetId })} />;
  } else if (selection.kind === "new" || selected !== null) {
    detailPane = (
      <ProviderEditor
        key={selection.kind === "new" ? `new-${selection.presetId}` : `provider-${selected?.id}-${editorNonce}`}
        initial={selection.kind === "new" ? null : selected}
        presetId={selection.kind === "new" ? selection.presetId : "custom"}
        wide={wide}
        showBack={!wide}
        onBack={backToList}
        onDirtyChange={onDirtyChange}
        onSaved={onSaved}
        onDeleted={onDeleted}
      />
    );
  } else {
    detailPane = (
      <View style={{ flex: 1, backgroundColor: colors().surface0, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 }}>
        <Text style={{ color: colors().foreground, fontSize: 15, fontWeight: "600" }}>
          {providers.length === 0 ? "还没有 Provider" : "选择一个 Provider 查看"}
        </Text>
        <Text style={{ color: colors().foregroundMuted, fontSize: 13, textAlign: "center" }}>
          {providers.length === 0
            ? "点左侧「＋ 添加第一个 Provider」，配置保存后其模型会出现在 Claude 的模型选择器（描述为「自定义模型 · …」）"
            : "从左侧选择一个 Provider 编辑，或新建一个；请求经本机代理按所选模型路由到对应厂商"}
        </Text>
      </View>
    );
  }

  if (wide) {
    return (
      <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors().surface0 }}>
        {listPane}
        <View style={{ flex: 1 }}>{detailPane}</View>
      </View>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: colors().surface0 }}>
      {selection.kind === "none" ? listPane : detailPane}
    </View>
  );
}

function ProviderRow({
  provider, selected, busy, onSelect, onToggle,
}: {
  provider: ProviderView;
  selected: boolean;
  busy: boolean;
  onSelect(): void;
  onToggle(enabled: boolean): void;
}) {
  const shown = provider.models.slice(0, 2);
  const hidden = provider.models.length - shown.length;
  return (
    <HoverPressable
      accessibilityRole="button"
      accessibilityLabel={`编辑 ${provider.label}`}
      disabled={busy}
      onPress={onSelect}
      style={({ hovered, pressed }) => ({
        backgroundColor: selected || pressed || hovered ? colors().surface2 : colors().surface1,
        borderLeftWidth: 3,
        borderLeftColor: selected ? colors().accent : "transparent",
        borderRadius: 8,
        padding: 12,
        gap: 6,
        opacity: provider.enabled ? 1 : 0.6,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View
          accessibilityLabel={provider.enabled ? "已启用" : "已停用"}
          style={{
            width: 8, height: 8, borderRadius: 4,
            backgroundColor: provider.enabled ? colors().statusSuccess : colors().foregroundMuted,
          }}
        />
        <Text numberOfLines={1} style={{ color: colors().foreground, fontSize: 14, fontWeight: "600", flexShrink: 1 }}>
          {provider.label}
        </Text>
        <View style={{ flex: 1 }} />
        <Switch
          accessibilityLabel={`${provider.enabled ? "停用" : "启用"} ${provider.label}`}
          value={provider.enabled}
          disabled={busy}
          onValueChange={onToggle}
          trackColor={{ true: colors().accent, false: colors().surface2 }}
          thumbColor={colors().foreground}
        />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text numberOfLines={1} style={{ color: colors().foregroundMuted, fontSize: 10, fontFamily: MONO_FONT, flexShrink: 1 }}>
          {provider.baseUrl}
        </Text>
        {!provider.keyConfigured ? (
          <Text style={{ color: colors().statusWarning, fontSize: 10 }}>未配 Key</Text>
        ) : null}
      </View>
      {provider.models.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
          {shown.map((model) => <ModelChip key={model.id} label={model.label || model.id} />)}
          {hidden > 0 ? (
            <Text style={{ color: colors().foregroundMuted, fontSize: 11 }}>+{hidden}</Text>
          ) : null}
        </View>
      ) : null}
    </HoverPressable>
  );
}
