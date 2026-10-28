import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Platform, Pressable, Switch, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import {
  deleteProviderRpc,
  fetchModelsRpc,
  listProvidersRpc,
  saveProviderRpc,
  testModelRpc,
  type FetchedModel,
  type ProviderView,
} from "../shared/contracts";
import { modelIdPattern } from "../shared/model-id";
import { PROVIDER_PRESETS, type AuthHeader, type ProviderProtocol } from "../shared/presets";

/**
 * Host-level settings screen: providers as cards (endpoint, model chips, key
 * hint, enable switch; tap a card to edit), plus an add card. API keys are
 * stored on the daemon side and never leave it — the screen only sees a
 * masked hint.
 */

type Theme = PluginSurfaceProps["theme"];

const MONO_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  macos: "SF Mono",
  default: "ui-monospace, monospace",
});

/** Pressable plus a typed hover state (RN's style callback only reports pressed). */
function HoverPressable({
  onPress, style, children, ...rest
}: {
  onPress?: () => void;
  style?: (state: { hovered: boolean; pressed: boolean }) => StyleProp<ViewStyle>;
  children?: ReactNode | ((state: { hovered: boolean; pressed: boolean }) => ReactNode);
} & Omit<React.ComponentProps<typeof Pressable>, "onPress" | "style" | "children">) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      {...rest}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={style === undefined ? undefined : ({ pressed }) => style({ hovered, pressed })}
    >
      {typeof children === "function"
        ? (state: { pressed: boolean }) => children({ hovered, pressed: state.pressed })
        : children}
    </Pressable>
  );
}

function ModelChip({ label, theme }: { label: string; theme: Theme }) {
  return (
    <View style={{ backgroundColor: theme.colors.surface2, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 }}>
      <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 11, fontFamily: MONO_FONT }}>
        {label}
      </Text>
    </View>
  );
}

function ProviderCard({
  provider, busy, theme, onEdit, onToggle,
}: {
  provider: ProviderView;
  busy: boolean;
  theme: Theme;
  onEdit(): void;
  onToggle(enabled: boolean): void;
}) {
  const shown = provider.models.slice(0, 3);
  const hidden = provider.models.length - shown.length;
  return (
    <HoverPressable
      accessibilityRole="button"
      accessibilityLabel={`编辑 ${provider.label}`}
      disabled={busy}
      onPress={onEdit}
      style={({ hovered, pressed }) => ({
        backgroundColor: pressed || hovered ? theme.colors.surface1 : theme.colors.surface0,
        borderColor: hovered ? theme.colors.accent : theme.colors.border,
        borderWidth: 1,
        borderRadius: 10,
        padding: 12,
        opacity: provider.enabled ? 1 : 0.55,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View
          accessibilityLabel={provider.enabled ? "已启用" : "已停用"}
          style={{
            width: 8, height: 8, borderRadius: 4,
            backgroundColor: provider.enabled ? theme.colors.statusSuccess : theme.colors.foregroundMuted,
          }}
        />
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600", flexShrink: 1 }}>
          {provider.label}
        </Text>
        <View style={{ flex: 1 }} />
        <Switch
          accessibilityLabel={`${provider.enabled ? "停用" : "启用"} ${provider.label}`}
          value={provider.enabled}
          disabled={busy}
          onValueChange={onToggle}
          trackColor={{ true: theme.colors.accent, false: theme.colors.surface2 }}
          thumbColor={theme.colors.foreground}
        />
      </View>
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: MONO_FONT, marginTop: 6 }}>
        {provider.baseUrl}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4, marginTop: 8 }}>
        {shown.map((model) => <ModelChip key={model.id} label={model.label} theme={theme} />)}
        {hidden > 0 ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>+{hidden}</Text>
        ) : null}
        <View style={{ flex: 1 }} />
        <Text numberOfLines={1} style={{
          color: provider.keyConfigured ? theme.colors.foregroundMuted : theme.colors.statusWarning,
          fontSize: 11,
        }}>
          {provider.keyHint ?? "未配置 Key"}
        </Text>
      </View>
    </HoverPressable>
  );
}

type ModelDraft = { id: string; label: string; contextWindow: string };
type EnvDraft = { key: string; value: string };
type AliasDraft = { opus: string; sonnet: string; haiku: string };

type FormState = {
  presetId: string;
  label: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  authHeader: AuthHeader;
  apiKey: string;
  models: ModelDraft[];
  env: EnvDraft[];
  aliases: AliasDraft;
};

const presetForm = (presetId: string): FormState => {
  const preset = PROVIDER_PRESETS.find((entry) => entry.id === presetId);
  if (!preset) return presetForm("deepseek");
  return {
    presetId,
    label: preset.id === "custom" ? "" : preset.label,
    baseUrl: preset.baseUrl,
    protocol: preset.protocol,
    authHeader: preset.authHeader,
    apiKey: "",
    models: preset.models.map((model) => ({
      id: model.id,
      label: model.label,
      contextWindow: model.contextWindow ? String(model.contextWindow) : "",
    })),
    env: Object.entries(preset.env ?? {}).map(([key, value]) => ({ key, value })),
    aliases: { opus: "", sonnet: "", haiku: "" },
  };
};

const formFromView = (provider: ProviderView): FormState => ({
  presetId: "custom",
  label: provider.label,
  baseUrl: provider.baseUrl,
  protocol: provider.protocol,
  authHeader: provider.authHeader,
  apiKey: "",
  models: provider.models.map((model) => ({
    id: model.id,
    label: model.label,
    contextWindow: model.contextWindow ? String(model.contextWindow) : "",
  })),
  env: Object.entries(provider.env ?? {}).map(([key, value]) => ({ key, value })),
  aliases: {
    opus: provider.aliasOverrides?.opus ?? "",
    sonnet: provider.aliasOverrides?.sonnet ?? "",
    haiku: provider.aliasOverrides?.haiku ?? "",
  },
});

export function ProviderSettingsScreen({ theme }: PluginSurfaceProps) {
  const toast = useToast();
  const listRpc = useRpc(listProvidersRpc);
  const saveRpc = useRpc(saveProviderRpc);

  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [busy, setBusy] = useState(false);
  /** null: the list; "new": blank form; a provider: its edit form. */
  const [editing, setEditing] = useState<"new" | ProviderView | null>(null);

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

  const toggle = useCallback(async (provider: ProviderView, enabled: boolean) => {
    if (busy) return;
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
        toast.show(enabled ? `已启用 ${provider.label}，模型回到选择器` : `已停用 ${provider.label}，模型已从选择器移除`);
      } else {
        toast.error(`操作失败：${result.error ?? "未知错误"}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, saveRpc, toast]);

  if (editing !== null) {
    return (
      <ProviderForm
        initial={editing === "new" ? null : editing}
        theme={theme}
        onDone={() => {
          setEditing(null);
          void reload();
        }}
      />
    );
  }

  return (
    <SettingsSection
      title="Claude 自定义模型"
      info="把自有 API Key 的模型（DeepSeek、GLM、Kimi 等）加入 Claude 的模型选择器；请求经本机代理按所选模型路由到对应厂商"
    >
      <View style={{ gap: 8, marginTop: 4 }}>
        {providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            busy={busy}
            theme={theme}
            onEdit={() => setEditing(provider)}
            onToggle={(value) => { void toggle(provider, value); }}
          />
        ))}
        <HoverPressable
          accessibilityRole="button"
          accessibilityLabel="添加 Provider"
          disabled={busy}
          onPress={() => setEditing("new")}
          style={({ hovered }) => ({
            borderColor: hovered ? theme.colors.accent : theme.colors.border,
            borderWidth: 1,
            borderStyle: "dashed",
            borderRadius: 10,
            padding: 12,
            alignItems: "center",
            gap: 4,
          })}
        >
          <Text style={{ color: theme.colors.accent, fontSize: 13, fontWeight: "600" }}>
            {providers.length === 0 ? "＋ 添加第一个 Provider" : "＋ 添加 Provider"}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            {providers.length === 0
              ? "添加后其模型会出现在 Claude 的模型选择器（描述为「自定义模型 · …」）"
              : "DeepSeek / GLM / Kimi / 通义千问 / 自定义端点"}
          </Text>
        </HoverPressable>
      </View>
    </SettingsSection>
  );
}

function ProviderForm({ initial, theme, onDone }: { initial: ProviderView | null; theme: Theme; onDone(): void }) {
  const toast = useToast();
  const saveRpc = useRpc(saveProviderRpc);
  const deleteRpc = useRpc(deleteProviderRpc);
  const modelsRpc = useRpc(fetchModelsRpc);
  const [deleting, setDeleting] = useState(false);

  const [form, setForm] = useState<FormState>(() => (initial ? formFromView(initial) : presetForm("deepseek")));
  // Inputs are uncontrolled; bumping this remounts them with fresh values.
  const [formVersion, setFormVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  /** null: the provider form; "new" or a model index: that model's editor. */
  const [editingModel, setEditingModel] = useState<number | "new" | null>(null);
  /** Non-null while picking models from the vendor's /v1/models. */
  const [picking, setPicking] = useState<{ models: FetchedModel[]; selected: Set<string> } | null>(null);
  const [fetching, setFetching] = useState(false);

  const applyForm = useCallback((next: FormState) => {
    setForm(next);
    setFormVersion((version) => version + 1);
  }, []);

  const key = (field: string) => `${field}-${formVersion}`;

  /** Discovers the vendor's models; the typed key wins over the stored one. */
  const discover = useCallback(async () => {
    if (fetching) return;
    setFetching(true);
    try {
      const result = await modelsRpc({
        ...(initial ? { providerId: initial.id } : {}),
        baseUrl: form.baseUrl.trim(),
        authHeader: form.authHeader,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      });
      if (result.ok) {
        if (!result.models.length) {
          toast.error("端点未返回模型");
          return;
        }
        setPicking({ models: result.models, selected: new Set() });
      } else {
        toast.error(`获取失败：${result.error ?? "未知错误"}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setFetching(false);
    }
  }, [fetching, form.apiKey, form.authHeader, form.baseUrl, initial, modelsRpc, toast]);

  const addPicked = useCallback((picked: readonly FetchedModel[]) => {
    setForm((current) => {
      const existing = new Set(current.models.map((model) => model.id.trim()));
      const additions = picked
        .filter((model) => !existing.has(model.id))
        .map((model) => ({
          id: model.id,
          label: model.label ?? "",
          contextWindow: model.contextWindow ? String(model.contextWindow) : "",
        }));
      return { ...current, models: [...current.models, ...additions] };
    });
    setPicking(null);
  }, []);

  const saveModel = useCallback((index: number | "new", draft: ModelDraft) => {
    setForm((current) => ({
      ...current,
      models: index === "new"
        ? [...current.models, draft]
        : current.models.map((model, position) => (position === index ? draft : model)),
    }));
    setEditingModel(null);
  }, []);

  /** Removing a model also clears aliases that pointed at it. */
  const deleteModel = useCallback((index: number) => {
    setForm((current) => {
      const removed = current.models[index];
      const aliases = { ...current.aliases };
      if (removed) {
        for (const alias of ["opus", "sonnet", "haiku"] as const) {
          if (current.aliases[alias] === removed.id) aliases[alias] = "";
        }
      }
      return { ...current, models: current.models.filter((_, position) => position !== index), aliases };
    });
    setEditingModel(null);
  }, []);

  const save = useCallback(async () => {
    if (saving) return;
    if (!form.label.trim() || !form.baseUrl.trim()) {
      toast.error("请先填写名称和 API 地址");
      return;
    }
    const models = form.models
      .map((model) => ({
        id: model.id.trim(),
        label: model.label.trim(),
        contextWindow: Number.parseInt(model.contextWindow.trim(), 10),
      }))
      .filter((model) => model.id)
      .map((model) => ({
        id: model.id,
        label: model.label || model.id,
        ...(Number.isFinite(model.contextWindow) && model.contextWindow >= 4096 ? { contextWindow: model.contextWindow } : {}),
      }));
    if (!models.length) {
      toast.error("至少配置一个模型");
      return;
    }
    const env: Record<string, string> = {};
    for (const entry of form.env) {
      const key = entry.key.trim();
      if (!key) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) {
        toast.error(`环境变量名不合法：${key}`);
        return;
      }
      env[key] = entry.value;
    }
    const aliasModelIds = new Set(models.map((model) => model.id));
    const aliasOverrides: Record<string, string> = {};
    for (const [alias, chosen] of Object.entries(form.aliases)) {
      const target = chosen.trim();
      if (!target) continue;
      if (!aliasModelIds.has(target)) {
        toast.error(`别名 ${alias} 指向的模型不在列表里：${target}`);
        return;
      }
      aliasOverrides[alias] = target;
    }
    setSaving(true);
    try {
      const result = await saveRpc({
        ...(initial ? { id: initial.id } : {}),
        label: form.label.trim(),
        baseUrl: form.baseUrl.trim(),
        protocol: form.protocol,
        authHeader: form.authHeader,
        enabled: true,
        models,
        env,
        aliasOverrides,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      });
      if (result.ok) {
        toast.show(`已保存 ${form.label.trim()}，其模型已加入 Claude 的模型选择器`);
        onDone();
      } else {
        toast.error(`保存失败：${result.error ?? "未知错误"}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [form, initial, onDone, saveRpc, saving, toast]);

  const remove = useCallback(async () => {
    if (!initial || saving || deleting) return;
    setDeleting(true);
    try {
      const result = await deleteRpc({ id: initial.id });
      if (result.ok) {
        toast.show(`已删除 ${initial.label}`);
        onDone();
      } else {
        toast.error(`删除失败：${result.error ?? "未知错误"}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }, [deleteRpc, deleting, initial, onDone, saving, toast]);

  if (picking) {
    const selectedModels = picking.models.filter((model) => picking.selected.has(model.id));
    const togglePick = (id: string) => setPicking((current) => {
      if (!current) return current;
      const selected = new Set(current.selected);
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      return { ...current, selected };
    });
    return (
      <ModelPicker
        models={picking.models}
        selected={picking.selected}
        theme={theme}
        onToggle={togglePick}
        onConfirm={() => addPicked(selectedModels)}
        onCancel={() => setPicking(null)}
      />
    );
  }

  if (editingModel !== null) {
    return (
      <ModelForm
        key={editingModel === "new" ? "new" : `edit-${formVersion}-${editingModel}`}
        initial={editingModel === "new" ? null : form.models[editingModel] ?? null}
        theme={theme}
        connection={{
          baseUrl: form.baseUrl,
          protocol: form.protocol,
          authHeader: form.authHeader,
          apiKey: form.apiKey.trim(),
          ...(initial ? { providerId: initial.id } : {}),
        }}
        onSave={(draft) => saveModel(editingModel, draft)}
        onDelete={editingModel === "new" ? undefined : () => deleteModel(editingModel)}
        onCancel={() => setEditingModel(null)}
      />
    );
  }

  return (
    <SettingsSection
      title={initial ? `编辑 ${initial.label}` : "新建 Provider"}
      info="保存后模型立即进入 Claude 的模型选择器"
    >
      <SettingsSection title="基本信息">
        <SettingsSelect
          label="从预设开始"
          value={form.presetId}
          options={PROVIDER_PRESETS.map((preset) => ({ label: preset.label, value: preset.id }))}
          onValueChange={(value) => applyForm(presetForm(value))}
          hint={PROVIDER_PRESETS.find((preset) => preset.id === form.presetId)?.keyHint}
          disabled={!!initial}
        />
        <SettingsInput
          key={key("label")}
          label="名称"
          placeholder="DeepSeek"
          initialValue={form.label}
          onChangeText={(text) => setForm((current) => ({ ...current, label: text }))}
        />
        <SettingsInput
          key={key("baseUrl")}
          label="API 地址"
          placeholder="https://api.deepseek.com/anthropic"
          initialValue={form.baseUrl}
          onChangeText={(text) => setForm((current) => ({ ...current, baseUrl: text }))}
          hint="Anthropic 兼容端点填根地址；OpenAI 兼容端点填到 /v1 之前"
        />
        <SettingsSelect
          label="协议"
          value={form.protocol}
          options={[
            { label: "Anthropic Messages（/v1/messages）", value: "anthropic" },
            { label: "OpenAI Chat Completions（/v1/chat/completions）", value: "chat" },
          ]}
          onValueChange={(value) => setForm((current) => ({ ...current, protocol: value }))}
        />
        <SettingsSelect
          label="鉴权头"
          value={form.authHeader}
          options={[
            { label: "Authorization: Bearer", value: "bearer" },
            { label: "x-api-key", value: "x-api-key" },
          ]}
          onValueChange={(value) => setForm((current) => ({ ...current, authHeader: value }))}
        />
        <SettingsInput
          key={key("apiKey")}
          label="API Key"
          placeholder={initial?.keyHint ? `已保存 ${initial.keyHint}，留空保持不变` : "粘贴 API Key"}
          initialValue=""
          secureTextEntry
          onChangeText={(text) => setForm((current) => ({ ...current, apiKey: text }))}
        />
      </SettingsSection>

      <SettingsSection
        title="模型列表"
        info="可从端点自动获取（显示名 / 窗口自动套用）；点卡片编辑，[1m] 结尾为 1M 窗口标识"
      >
        <SettingsAction
          label="从端点获取模型列表"
          hint="用已填写的 API Key 请求 /v1/models，勾选后批量加入"
          actionLabel={fetching ? "获取中…" : "获取"}
          onPress={() => { void discover(); }}
          disabled={fetching}
        />
        <View style={{ gap: 8, marginTop: 4 }}>
          {form.models.map((model, index) => (
            <ModelCard
              key={`model-${formVersion}-${index}`}
              model={model}
              theme={theme}
              onEdit={() => setEditingModel(index)}
              onDelete={() => deleteModel(index)}
            />
          ))}
          <HoverPressable
            accessibilityRole="button"
            accessibilityLabel="添加模型"
            onPress={() => setEditingModel("new")}
            style={({ hovered }) => ({
              borderColor: hovered ? theme.colors.accent : theme.colors.border,
              borderWidth: 1,
              borderStyle: "dashed",
              borderRadius: 10,
              padding: 10,
              alignItems: "center",
            })}
          >
            <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>
              {form.models.length === 0 ? "＋ 添加第一个模型" : "＋ 添加模型"}
            </Text>
          </HoverPressable>
        </View>
      </SettingsSection>

      <SettingsSection
        title="别名映射（可选）"
        info="Claude Code 内部的 Opus / Sonnet / Haiku 别名用哪个模型；留「自动」时：Opus / Sonnet 跟随会话所选模型（缺省取旗舰），Haiku 与子代理取快速模型"
      >
        {(["opus", "sonnet", "haiku"] as const).map((alias) => (
          <SettingsSelect
            key={alias}
            label={alias === "opus" ? "Opus（深度任务）" : alias === "sonnet" ? "Sonnet（主力）" : "Haiku（后台 / 子代理）"}
            value={form.aliases[alias]}
            options={[
              { label: "自动", value: "" },
              ...form.models.filter((model) => model.id.trim()).map((model) => ({ label: model.id.trim(), value: model.id.trim() })),
            ]}
            onValueChange={(value) => setForm((current) => ({ ...current, aliases: { ...current.aliases, [alias]: value } }))}
          />
        ))}
      </SettingsSection>

      <SettingsSection
        title="会话环境变量（可选）"
        info="注入到该 Provider 会话的额外变量；值里可用 ${API_KEY} 引用已保存的 Key（推荐），如 Z_AI_API_KEY"
      >
        {form.env.map((entry, index) => (
          <SettingsSection key={`env-${formVersion}-${index}`} title={`变量 ${index + 1}`}>
            <SettingsInput
              key={key(`e${index}-key`)}
              label="变量名"
              placeholder="Z_AI_API_KEY"
              initialValue={entry.key}
              onChangeText={(text) => setForm((current) => ({
                ...current,
                env: current.env.map((item, position) => (position === index ? { ...item, key: text } : item)),
              }))}
            />
            <SettingsInput
              key={key(`e${index}-value`)}
              label="值"
              placeholder="${API_KEY}"
              initialValue={entry.value}
              onChangeText={(text) => setForm((current) => ({
                ...current,
                env: current.env.map((item, position) => (position === index ? { ...item, value: text } : item)),
              }))}
              hint="ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY 由插件接管，不可配置"
            />
            <SettingsAction
              label="移除这个变量"
              actionLabel="移除"
              onPress={() => setForm((current) => ({ ...current, env: current.env.filter((_, position) => position !== index) }))}
            />
          </SettingsSection>
        ))}
        <SettingsAction
          label="添加环境变量"
          actionLabel="添加"
          onPress={() => setForm((current) => ({ ...current, env: [...current.env, { key: "", value: "" }] }))}
        />
      </SettingsSection>

      <SettingsSection title="保存">
        <SettingsAction
          label={initial ? `保存对 ${initial.label} 的修改` : "保存为新 Provider"}
          actionLabel={saving ? "保存中…" : "保存"}
          onPress={() => { void save(); }}
          disabled={saving}
        />
        <SettingsAction
          label="放弃更改"
          actionLabel="取消"
          onPress={onDone}
          disabled={saving}
        />
        {initial ? (
          <HoverPressable
            accessibilityRole="button"
            accessibilityLabel={`删除 ${initial.label}`}
            disabled={saving || deleting}
            onPress={() => { void remove(); }}
            style={({ hovered }) => ({
              borderColor: hovered ? theme.colors.statusDanger : theme.colors.border,
              borderWidth: 1,
              borderRadius: 10,
              padding: 10,
              alignItems: "center",
              marginTop: 4,
              opacity: deleting ? 0.55 : 1,
            })}
          >
            <Text style={{ color: theme.colors.statusDanger, fontSize: 12, fontWeight: "600" }}>
              {deleting ? "删除中…" : `删除 ${initial.label}（配置与 Key 一并删除）`}
            </Text>
          </HoverPressable>
        ) : null}
      </SettingsSection>
    </SettingsSection>
  );
}

/** "1000000" → "1M 窗口", "204800" → "200k 窗口"; raw when nothing divides. */
function formatWindow(window: number): string {
  if (window % 1_000_000 === 0) return `${window / 1_000_000}M 窗口`;
  if (window % 1024 === 0) return `${window / 1024}k 窗口`;
  if (window % 1_000 === 0) return `${window / 1_000}k 窗口`;
  return `${window} 窗口`;
}

function ModelCard({ model, theme, onEdit, onDelete }: { model: ModelDraft; theme: Theme; onEdit(): void; onDelete?(): void }) {
  const id = model.id.trim();
  const label = model.label.trim() || id || "未命名模型";
  const window = Number.parseInt(model.contextWindow.trim(), 10);
  return (
    <HoverPressable
      accessibilityRole="button"
      accessibilityLabel={`编辑模型 ${label}`}
      onPress={onEdit}
      style={({ hovered, pressed }) => ({
        backgroundColor: pressed || hovered ? theme.colors.surface1 : theme.colors.surface0,
        borderColor: hovered ? theme.colors.accent : theme.colors.border,
        borderWidth: 1,
        borderRadius: 10,
        padding: 10,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flexShrink: 1 }}>
          {label}
        </Text>
        <View style={{ flex: 1 }} />
        <View style={{ backgroundColor: theme.colors.surface2, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: MONO_FONT }}>
            {Number.isFinite(window) && window >= 4096 ? formatWindow(window) : "默认 200k"}
          </Text>
        </View>
        {onDelete ? (
          // A nested pressable is its own responder, so ✕ never opens the editor.
          <HoverPressable
            accessibilityRole="button"
            accessibilityLabel={`删除模型 ${label}`}
            onPress={onDelete}
            style={({ hovered }) => ({
              width: 24,
              height: 24,
              borderRadius: 6,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: hovered ? theme.colors.surface2 : "transparent",
            })}
          >
            {({ hovered }) => (
              <Text style={{ color: hovered ? theme.colors.statusDanger : theme.colors.foregroundMuted, fontSize: 13, lineHeight: 15 }}>
                ✕
              </Text>
            )}
          </HoverPressable>
        ) : null}
      </View>
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: MONO_FONT, marginTop: 6 }}>
        {id || "（未填写 ID）"}
      </Text>
    </HoverPressable>
  );
}

/** One model's editor: opened from the provider form's model list. */
function ModelForm({ initial, theme, connection, onSave, onDelete, onCancel }: {
  initial: ModelDraft | null;
  theme: Theme;
  /** The provider form's live connection fields, for the live test. */
  connection: { baseUrl: string; protocol: ProviderProtocol; authHeader: AuthHeader; apiKey: string; providerId?: string };
  onSave(draft: ModelDraft): void;
  onDelete?(): void;
  onCancel(): void;
}) {
  const toast = useToast();
  const testRpc = useRpc(testModelRpc);
  const [id, setId] = useState(initial?.id ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [contextWindow, setContextWindow] = useState(initial?.contextWindow ?? "");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  /** One minimal live request: key, endpoint and model id all verified. */
  const runTest = useCallback(async () => {
    const trimmedId = id.trim();
    if (!trimmedId) {
      toast.error("请先填写模型 ID");
      return;
    }
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testRpc({
        ...(connection.providerId ? { providerId: connection.providerId } : {}),
        baseUrl: connection.baseUrl.trim(),
        protocol: connection.protocol,
        authHeader: connection.authHeader,
        ...(connection.apiKey ? { apiKey: connection.apiKey } : {}),
        model: trimmedId,
      });
      if (result.ok) {
        setTestResult({
          ok: true,
          text: `连通正常 · ${result.latencyMs ?? "?"} ms${result.reply ? ` · 回复「${result.reply}」` : ""}`,
        });
      } else {
        setTestResult({ ok: false, text: result.error ?? "未知错误" });
      }
    } catch (err) {
      setTestResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }, [connection, id, testRpc, testing, toast]);

  const save = useCallback(() => {
    const trimmedId = id.trim();
    if (!trimmedId) {
      toast.error("请填写模型 ID");
      return;
    }
    if (!modelIdPattern.test(trimmedId)) {
      toast.error("模型 ID 含非法字符（1M 窗口标识只能用小写 [1m] 结尾）");
      return;
    }
    const trimmedWindow = contextWindow.trim();
    const window = Number.parseInt(trimmedWindow, 10);
    if (trimmedWindow && (!Number.isFinite(window) || window < 4096)) {
      toast.error("上下文窗口需为不小于 4096 的数字");
      return;
    }
    onSave({ id: trimmedId, label: label.trim(), contextWindow: trimmedWindow });
  }, [contextWindow, id, label, onSave, toast]);

  return (
    <SettingsSection
      title={initial ? `编辑模型 ${initial.label.trim() || initial.id.trim()}` : "添加模型"}
      info="模型 ID 必须与厂商一致；保存后回到 Provider 表单"
    >
      <SettingsInput
        label="模型 ID"
        placeholder="glm-5.3 或 glm-5.3[1m]"
        initialValue={id}
        onChangeText={setId}
        hint="要 1M 长上下文在末尾加 [1m]（转发时自动剥掉）"
      />
      <SettingsInput
        label="显示名（可选）"
        placeholder="GLM-5.3"
        initialValue={label}
        onChangeText={setLabel}
        hint="只用于模型选择器，留空用 ID"
      />
      <SettingsInput
        label="上下文窗口（可选）"
        placeholder="200000"
        initialValue={contextWindow}
        onChangeText={setContextWindow}
        hint="留空按 Claude Code 默认的 200k 处理自动压缩"
      />
      <SettingsAction
        label="测试连通性"
        hint="向端点发一条最小请求，验证 Key、地址与模型 ID；测试新模型可先不保存"
        actionLabel={testing ? "测试中…" : "测试"}
        onPress={() => { void runTest(); }}
        disabled={testing}
      />
      {testResult ? (
        <View style={{
          borderColor: testResult.ok ? theme.colors.statusSuccess : theme.colors.statusDanger,
          borderWidth: 1,
          borderRadius: 10,
          padding: 10,
        }}>
          <Text style={{
            color: testResult.ok ? theme.colors.statusSuccess : theme.colors.statusDanger,
            fontSize: 12,
          }}>
            {testResult.ok ? "✓ " : "✗ "}{testResult.text}
          </Text>
        </View>
      ) : null}
      <SettingsAction
        label={initial ? "保存修改" : "添加这个模型"}
        actionLabel="保存"
        onPress={save}
      />
      <SettingsAction
        label="放弃更改"
        actionLabel="取消"
        onPress={onCancel}
      />
      {initial && onDelete ? (
        <HoverPressable
          accessibilityRole="button"
          accessibilityLabel={`删除模型 ${initial.id.trim()}`}
          onPress={onDelete}
          style={({ hovered }) => ({
            borderColor: hovered ? theme.colors.statusDanger : theme.colors.border,
            borderWidth: 1,
            borderRadius: 10,
            padding: 10,
            alignItems: "center",
            marginTop: 4,
          })}
        >
          <Text style={{ color: theme.colors.statusDanger, fontSize: 12, fontWeight: "600" }}>
            删除 {initial.label.trim() || initial.id.trim()}
          </Text>
        </HoverPressable>
      ) : null}
    </SettingsSection>
  );
}

/** Checkable list of the vendor's discovered models, added on confirm. */
function ModelPicker({ models, selected, theme, onToggle, onConfirm, onCancel }: {
  models: readonly FetchedModel[];
  selected: ReadonlySet<string>;
  theme: Theme;
  onToggle(id: string): void;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <SettingsSection
      title="选择要添加的模型"
      info="来自端点的模型列表；显示名与上下文窗口已按预设知识自动填好，[1m] 条目为 1M 窗口变体"
    >
      <View style={{ gap: 8, marginTop: 4 }}>
        {models.map((model) => {
          const picked = selected.has(model.id);
          return (
            <HoverPressable
              key={model.id}
              accessibilityRole="button"
              accessibilityLabel={`${picked ? "取消选择" : "选择"} ${model.id}`}
              onPress={() => onToggle(model.id)}
              style={({ hovered, pressed }) => ({
                backgroundColor: pressed || hovered ? theme.colors.surface1 : theme.colors.surface0,
                borderColor: picked ? theme.colors.accent : hovered ? theme.colors.accent : theme.colors.border,
                borderWidth: 1,
                borderRadius: 10,
                padding: 10,
              })}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View style={{
                  width: 18, height: 18, borderRadius: 5,
                  borderWidth: 1,
                  borderColor: picked ? theme.colors.accent : theme.colors.border,
                  backgroundColor: picked ? theme.colors.accent : "transparent",
                  alignItems: "center",
                  justifyContent: "center",
                }}>
                  {picked ? <Text style={{ color: theme.colors.accentForeground, fontSize: 12, lineHeight: 14, fontWeight: "700" }}>✓</Text> : null}
                </View>
                <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12, fontFamily: MONO_FONT, flexShrink: 1 }}>
                  {model.id}
                </Text>
                <View style={{ flex: 1 }} />
                {model.contextWindow ? (
                  <View style={{ backgroundColor: theme.colors.surface2, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 }}>
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: MONO_FONT }}>
                      {formatWindow(model.contextWindow)}
                    </Text>
                  </View>
                ) : null}
              </View>
            </HoverPressable>
          );
        })}
      </View>
      <SettingsAction
        label={`添加所选（${selected.size}）`}
        hint="已存在的模型 ID 会跳过"
        actionLabel="添加"
        onPress={onConfirm}
        disabled={selected.size === 0}
      />
      <SettingsAction
        label="放弃选择"
        actionLabel="取消"
        onPress={onCancel}
      />
    </SettingsSection>
  );
}
