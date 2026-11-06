import { useCallback, useEffect, useState } from "react";
import { ScrollView, Switch, Text, TextInput, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import {
  deleteProviderRpc,
  fetchModelsRpc,
  saveProviderRpc,
  testModelRpc,
  type FetchedModel,
  type ProviderView,
} from "../shared/contracts";
import { modelIdPattern } from "../shared/model-id";
import { PROVIDER_PRESETS, type AuthHeader, type ProviderProtocol } from "../shared/presets";
import {
  Card,
  CardTitle,
  ChoicePill,
  FieldLabel,
  HoverPressable,
  MONO_FONT,
  Pill,
  PrimaryButton,
  TextField,
  colors,
  formatWindow,
  inputStyle,
} from "./widgets";

/**
 * The right-hand pane of the models screen: provider edit form, the new-provider
 * preset picker, and the two drill-down views (one model's editor, the vendor
 * model picker). Wide panes lay the cards out side by side; narrow panes stack
 * them. API keys still travel only in save requests — the form keeps whatever
 * was typed until then, and a stored key is only shown as a masked hint.
 */

type ModelDraft = { id: string; label: string; contextWindow: string };
type EnvDraft = { key: string; value: string };
type AliasDraft = { opus: string; sonnet: string; haiku: string };

type FormState = {
  label: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  authHeader: AuthHeader;
  enabled: boolean;
  apiKey: string;
  models: ModelDraft[];
  env: EnvDraft[];
  aliases: AliasDraft;
};

const presetForm = (presetId: string): FormState => {
  const preset = PROVIDER_PRESETS.find((entry) => entry.id === presetId);
  if (!preset) return presetForm("custom");
  return {
    label: preset.id === "custom" ? "" : preset.label,
    baseUrl: preset.baseUrl,
    protocol: preset.protocol,
    authHeader: preset.authHeader,
    enabled: true,
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
  label: provider.label,
  baseUrl: provider.baseUrl,
  protocol: provider.protocol,
  authHeader: provider.authHeader,
  enabled: provider.enabled,
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

/** Trimmed copy for dirty comparison, so cosmetic edits do not count. */
const normalizeDraft = (form: FormState): FormState => ({
  ...form,
  label: form.label.trim(),
  baseUrl: form.baseUrl.trim(),
  apiKey: form.apiKey.trim(),
  models: form.models
    .map((model) => ({ id: model.id.trim(), label: model.label.trim(), contextWindow: model.contextWindow.trim() }))
    .filter((model) => model.id),
  env: form.env
    .map((entry) => ({ key: entry.key.trim(), value: entry.value }))
    .filter((entry) => entry.key || entry.value),
  aliases: {
    opus: form.aliases.opus.trim(),
    sonnet: form.aliases.sonnet.trim(),
    haiku: form.aliases.haiku.trim(),
  },
});

/** Full-size cards for the new-provider flow: one tap seeds the whole form. */
export function PresetPicker({ onPick }: { onPick(presetId: string): void }) {
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <CardTitle text="新建 Provider" hint="选一个预设开始——端点、鉴权与常用模型已预填，全部可改" />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        {PROVIDER_PRESETS.map((preset) => (
          <HoverPressable
            key={preset.id}
            accessibilityRole="button"
            accessibilityLabel={`用 ${preset.label} 预设新建`}
            onPress={() => onPick(preset.id)}
            style={({ hovered, pressed }) => ({
              backgroundColor: pressed || hovered ? colors().surface2 : colors().surface1,
              borderColor: hovered ? colors().accent : colors().border,
              borderWidth: 1,
              borderRadius: 12,
              padding: 14,
              gap: 6,
              flexGrow: 1,
              flexBasis: 260,
            })}
          >
            <Text style={{ color: colors().foreground, fontSize: 15, fontWeight: "700" }}>{preset.label}</Text>
            <Text style={{ color: colors().foregroundMuted, fontSize: 12 }}>{preset.description}</Text>
            {preset.baseUrl ? (
              <Text numberOfLines={1} style={{ color: colors().foregroundMuted, fontSize: 11, fontFamily: MONO_FONT }}>
                {preset.baseUrl}
              </Text>
            ) : null}
            <Text style={{ color: colors().foregroundMuted, fontSize: 11 }}>{preset.keyHint}</Text>
          </HoverPressable>
        ))}
      </View>
    </ScrollView>
  );
}

export function ProviderEditor({
  initial, presetId, wide, showBack, onBack, onDirtyChange, onSaved, onDeleted,
}: {
  initial: ProviderView | null;
  /** Seeds the blank form when creating; ignored when editing. */
  presetId: string;
  wide: boolean;
  showBack?: boolean;
  onBack?(): void;
  onDirtyChange(dirty: boolean): void;
  onSaved(providers: ProviderView[]): void;
  onDeleted(providers: ProviderView[]): void;
}) {
  const toast = useToast();
  const saveRpc = useRpc(saveProviderRpc);
  const deleteRpc = useRpc(deleteProviderRpc);
  const modelsRpc = useRpc(fetchModelsRpc);
  const [deleting, setDeleting] = useState(false);

  const [form, setForm] = useState<FormState>(() => (initial ? formFromView(initial) : presetForm(presetId)));
  /** Serialized saved state; the form is dirty when it drifts from this. */
  const [baseline, setBaseline] = useState(() => JSON.stringify(normalizeDraft(initial ? formFromView(initial) : presetForm(presetId))));
  const [saving, setSaving] = useState(false);
  /** null: the provider form; "new" or a model index: that model's editor. */
  const [editingModel, setEditingModel] = useState<number | "new" | null>(null);
  /** Non-null while picking models from the vendor's /v1/models. */
  const [picking, setPicking] = useState<{ models: FetchedModel[]; selected: Set<string> } | null>(null);
  const [fetching, setFetching] = useState(false);

  const dirty = JSON.stringify(normalizeDraft(form)) !== baseline;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const patch = useCallback((changes: Partial<FormState>) => {
    setForm((current) => ({ ...current, ...changes }));
  }, []);

  /** Discard edits and go back to the saved state. */
  const discard = useCallback(() => {
    const fresh = initial ? formFromView(initial) : presetForm(presetId);
    setForm(fresh);
    setBaseline(JSON.stringify(normalizeDraft(fresh)));
  }, [initial, presetId]);

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
        enabled: form.enabled,
        models,
        env,
        aliasOverrides,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      });
      if (result.ok) {
        toast.show(
          form.enabled
            ? `已保存 ${form.label.trim()}，其模型已加入 Claude 的模型选择器`
            : `已保存 ${form.label.trim()}（当前停用，启用后模型回到选择器）`,
        );
        // The saved form (minus the typed key, now stored daemon-side) is the new baseline.
        const saved = { ...form, apiKey: "" };
        setForm(saved);
        setBaseline(JSON.stringify(normalizeDraft(saved)));
        onSaved(result.providers);
      } else {
        toast.error(`保存失败：${result.error ?? "未知错误"}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [form, initial, onSaved, saving, saveRpc, toast]);

  const remove = useCallback(async () => {
    if (!initial || saving || deleting) return;
    setDeleting(true);
    try {
      const result = await deleteRpc({ id: initial.id });
      if (result.ok) {
        toast.show(`已删除 ${initial.label}`);
        onDeleted(result.providers);
      } else {
        toast.error(`删除失败：${result.error ?? "未知错误"}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }, [deleteRpc, deleting, initial, onDeleted, saving, toast]);

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
        onToggle={togglePick}
        onConfirm={() => addPicked(selectedModels)}
        onCancel={() => setPicking(null)}
      />
    );
  }

  if (editingModel !== null) {
    return (
      <ModelForm
        key={editingModel === "new" ? "new" : `edit-${editingModel}`}
        initial={editingModel === "new" ? null : form.models[editingModel] ?? null}
        wide={wide}
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

  const sectionStyle = wide ? { flexGrow: 1, flexBasis: 320, minWidth: 300 } : undefined;
  const preset = PROVIDER_PRESETS.find((entry) => entry.id === presetId);

  return (
    <View style={{ flex: 1 }}>
      {/* Action bar */}
      <View style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: colors().border,
        backgroundColor: colors().surface1,
      }}>
        {showBack ? (
          <HoverPressable
            accessibilityRole="button"
            accessibilityLabel="返回列表"
            onPress={onBack}
            style={({ hovered }) => ({
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: 6,
              backgroundColor: hovered ? colors().surface2 : "transparent",
            })}
          >
            <Text style={{ color: colors().foreground, fontSize: 16 }}>‹</Text>
          </HoverPressable>
        ) : null}
        <View style={{ flexShrink: 1, gap: 1 }}>
          <Text numberOfLines={1} style={{ color: colors().foreground, fontSize: 14, fontWeight: "700" }}>
            {initial ? `编辑 ${initial.label}` : `新建${preset && preset.id !== "custom" ? ` · ${preset.label}` : " Provider"}`}
          </Text>
          <Text numberOfLines={1} style={{ color: colors().foregroundMuted, fontSize: 11, fontFamily: MONO_FONT }}>
            {initial?.keyHint ? `Key 已保存 ${initial.keyHint}` : "保存后模型立即进入 Claude 的模型选择器"}
          </Text>
        </View>
        {dirty ? <Pill text="未保存" tone="warning" /> : null}
        <View style={{ flex: 1 }} />
        {dirty ? (
          <PrimaryButton label="放弃" subtle onPress={discard} disabled={saving} />
        ) : null}
        {initial ? (
          <PrimaryButton label={deleting ? "删除中…" : "删除"} danger onPress={() => { void remove(); }} disabled={saving || deleting} />
        ) : null}
        <PrimaryButton label={saving ? "保存中…" : "保存"} onPress={() => { void save(); }} disabled={saving} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <View style={wide ? { flexDirection: "row", flexWrap: "wrap", gap: 12 } : { gap: 12 }}>
          <Card style={sectionStyle}>
            <CardTitle text="基本信息" hint="Anthropic 兼容端点填根地址；OpenAI 兼容端点填到 /v1 之前" />
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, color: colors().foreground }}>启用这个 Provider</Text>
                <Text style={{ fontSize: 12, color: colors().foregroundMuted, marginTop: 1 }}>
                  停用后其模型立即从选择器移除，配置保留
                </Text>
              </View>
              <Switch
                accessibilityLabel="启停 Provider"
                value={form.enabled}
                onValueChange={(value) => patch({ enabled: value })}
                trackColor={{ true: colors().accent, false: colors().surface2 }}
                thumbColor={colors().foreground}
              />
            </View>
            <TextField
              label="名称"
              placeholder="DeepSeek"
              value={form.label}
              onChangeText={(text) => patch({ label: text })}
            />
            <TextField
              label="API 地址"
              placeholder="https://api.deepseek.com/anthropic"
              value={form.baseUrl}
              onChangeText={(text) => patch({ baseUrl: text })}
              mono
            />
            <View style={{ gap: 4 }}>
              <FieldLabel text="协议" />
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                <ChoicePill
                  label="Anthropic Messages"
                  active={form.protocol === "anthropic"}
                  onPress={() => patch({ protocol: "anthropic" })}
                />
                <ChoicePill
                  label="OpenAI Chat Completions"
                  active={form.protocol === "chat"}
                  onPress={() => patch({ protocol: "chat" })}
                />
              </View>
            </View>
            <View style={{ gap: 4 }}>
              <FieldLabel text="鉴权头" />
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                <ChoicePill
                  label="Authorization: Bearer"
                  active={form.authHeader === "bearer"}
                  onPress={() => patch({ authHeader: "bearer" })}
                />
                <ChoicePill
                  label="x-api-key"
                  active={form.authHeader === "x-api-key"}
                  onPress={() => patch({ authHeader: "x-api-key" })}
                />
              </View>
            </View>
            <TextField
              label="API Key"
              placeholder={initial?.keyHint ? `已保存 ${initial.keyHint}，留空保持不变` : "粘贴 API Key"}
              value={form.apiKey}
              onChangeText={(text) => patch({ apiKey: text })}
              secureTextEntry
              hint={preset?.keyHint}
            />
          </Card>

          <Card style={sectionStyle}>
            <CardTitle
              text={`模型列表（${form.models.length}）`}
              hint="点条目编辑；[1m] 结尾为 1M 窗口标识，转发时自动剥掉"
            />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <PrimaryButton
                label={fetching ? "获取中…" : "从端点获取"}
                subtle
                onPress={() => { void discover(); }}
                disabled={fetching}
              />
              <PrimaryButton label="＋ 手动添加" subtle onPress={() => setEditingModel("new")} />
            </View>
            <View style={{ gap: 8 }}>
              {form.models.map((model, index) => (
                <ModelRow
                  key={`${index}-${model.id}`}
                  model={model}
                  onEdit={() => setEditingModel(index)}
                  onDelete={() => deleteModel(index)}
                />
              ))}
              {form.models.length === 0 ? (
                <Text style={{ color: colors().foregroundMuted, fontSize: 12 }}>
                  还没有模型：从端点获取，或手动添加（ID 必须与厂商一致）
                </Text>
              ) : null}
            </View>
          </Card>

          <Card style={sectionStyle}>
            <CardTitle
              text="别名映射（可选）"
              hint="Claude Code 内部的 Opus / Sonnet / Haiku 用哪个模型；留「自动」时：Opus / Sonnet 跟随会话所选模型（缺省取旗舰），Haiku 与子代理取快速模型"
            />
            {(["opus", "sonnet", "haiku"] as const).map((alias) => (
              <View key={alias} style={{ gap: 4 }}>
                <FieldLabel text={alias === "opus" ? "Opus（深度任务）" : alias === "sonnet" ? "Sonnet（主力）" : "Haiku（后台 / 子代理）"} />
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  <ChoicePill
                    label="自动"
                    active={form.aliases[alias] === ""}
                    onPress={() => patch({ aliases: { ...form.aliases, [alias]: "" } })}
                  />
                  {form.models
                    .filter((model) => model.id.trim())
                    .map((model) => (
                      <ChoicePill
                        key={model.id}
                        label={model.label.trim() || model.id.trim()}
                        active={form.aliases[alias] === model.id.trim()}
                        onPress={() => patch({ aliases: { ...form.aliases, [alias]: model.id.trim() } })}
                      />
                    ))}
                </View>
              </View>
            ))}
            {form.models.length === 0 ? (
              <Text style={{ color: colors().foregroundMuted, fontSize: 12 }}>先添加模型，才能指定别名</Text>
            ) : null}
          </Card>

          <Card style={sectionStyle}>
            <CardTitle
              text="会话环境变量（可选）"
              hint="注入到该 Provider 会话的额外变量；值里可用 ${API_KEY} 引用已保存的 Key（推荐）"
            />
            {form.env.map((entry, index) => (
              <View key={`env-${index}`} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <TextInput
                  value={entry.key}
                  placeholder="Z_AI_API_KEY"
                  placeholderTextColor={colors().foregroundMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={(text) => patch({
                    env: form.env.map((item, position) => (position === index ? { ...item, key: text } : item)),
                  })}
                  style={inputStyle({ flex: 1, fontFamily: MONO_FONT })}
                />
                <TextInput
                  value={entry.value}
                  placeholder="${API_KEY}"
                  placeholderTextColor={colors().foregroundMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={(text) => patch({
                    env: form.env.map((item, position) => (position === index ? { ...item, value: text } : item)),
                  })}
                  style={inputStyle({ flex: 1.5, fontFamily: MONO_FONT })}
                />
                <HoverPressable
                  accessibilityRole="button"
                  accessibilityLabel="移除环境变量"
                  onPress={() => patch({ env: form.env.filter((_, position) => position !== index) })}
                  style={({ hovered }) => ({
                    width: 26,
                    height: 26,
                    borderRadius: 6,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: hovered ? colors().surface2 : "transparent",
                  })}
                >
                  {({ hovered }) => (
                    <Text style={{ color: hovered ? colors().statusDanger : colors().foregroundMuted, fontSize: 13, lineHeight: 15 }}>
                      ✕
                    </Text>
                  )}
                </HoverPressable>
              </View>
            ))}
            <Text style={{ fontSize: 11, color: colors().foregroundMuted }}>
              ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY 由插件接管，不可配置
            </Text>
            <PrimaryButton
              label="＋ 添加环境变量"
              subtle
              onPress={() => patch({ env: [...form.env, { key: "", value: "" }] })}
            />
          </Card>
        </View>
      </ScrollView>
    </View>
  );
}

/** One model row in the provider form's list; tap to edit, ✕ removes. */
function ModelRow({ model, onEdit, onDelete }: { model: ModelDraft; onEdit(): void; onDelete(): void }) {
  const id = model.id.trim();
  const label = model.label.trim() || id || "未命名模型";
  const window = Number.parseInt(model.contextWindow.trim(), 10);
  return (
    <HoverPressable
      accessibilityRole="button"
      accessibilityLabel={`编辑模型 ${label}`}
      onPress={onEdit}
      style={({ hovered, pressed }) => ({
        backgroundColor: pressed || hovered ? colors().surface2 : colors().surface0,
        borderColor: hovered ? colors().accent : colors().border,
        borderWidth: 1,
        borderRadius: 10,
        padding: 10,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text numberOfLines={1} style={{ color: colors().foreground, fontSize: 13, fontWeight: "600", flexShrink: 1 }}>
          {label}
        </Text>
        <View style={{ flex: 1 }} />
        <View style={{ backgroundColor: colors().surface2, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 }}>
          <Text style={{ color: colors().foregroundMuted, fontSize: 11, fontFamily: MONO_FONT }}>
            {Number.isFinite(window) && window >= 4096 ? formatWindow(window) : "默认 200k"}
          </Text>
        </View>
        {/* A nested pressable is its own responder, so ✕ never opens the editor. */}
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
            backgroundColor: hovered ? colors().surface2 : "transparent",
          })}
        >
          {({ hovered }) => (
            <Text style={{ color: hovered ? colors().statusDanger : colors().foregroundMuted, fontSize: 13, lineHeight: 15 }}>
              ✕
            </Text>
          )}
        </HoverPressable>
      </View>
      <Text numberOfLines={1} style={{ color: colors().foregroundMuted, fontSize: 11, fontFamily: MONO_FONT, marginTop: 6 }}>
        {id || "（未填写 ID）"}
      </Text>
    </HoverPressable>
  );
}

/** One model's editor: a drill-down view opened from the provider form. */
function ModelForm({ initial, wide, connection, onSave, onDelete, onCancel }: {
  initial: ModelDraft | null;
  wide: boolean;
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
    <View style={{ flex: 1 }}>
      <View style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: colors().border,
        backgroundColor: colors().surface1,
      }}>
        <HoverPressable
          accessibilityRole="button"
          accessibilityLabel="返回 Provider 表单"
          onPress={onCancel}
          style={({ hovered }) => ({
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 6,
            backgroundColor: hovered ? colors().surface2 : "transparent",
          })}
        >
          <Text style={{ color: colors().foreground, fontSize: 16 }}>‹</Text>
        </HoverPressable>
        <Text style={{ color: colors().foreground, fontSize: 14, fontWeight: "700", flexShrink: 1 }}>
          {initial ? `编辑模型 ${initial.label.trim() || initial.id.trim()}` : "添加模型"}
        </Text>
        <View style={{ flex: 1 }} />
        {initial && onDelete ? (
          <PrimaryButton label="删除" danger onPress={onDelete} />
        ) : null}
        <PrimaryButton label={initial ? "保存修改" : "添加这个模型"} onPress={save} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, maxWidth: 880, width: "100%", alignSelf: "center" }}>
        <Card>
          <CardTitle text="模型" hint="模型 ID 必须与厂商一致；保存后回到 Provider 表单" />
          <View style={wide ? { flexDirection: "row", gap: 8 } : { gap: 8 }}>
            <TextField
              label="模型 ID"
              placeholder="glm-5.3 或 glm-5.3[1m]"
              value={id}
              onChangeText={setId}
              hint="要 1M 长上下文在末尾加 [1m]（转发时自动剥掉）"
              mono
            />
            <TextField
              label="显示名（可选）"
              placeholder="GLM-5.3"
              value={label}
              onChangeText={setLabel}
              hint="只用于模型选择器，留空用 ID"
            />
            <TextField
              label="上下文窗口（可选）"
              placeholder="200000"
              value={contextWindow}
              onChangeText={setContextWindow}
              hint="留空按 Claude Code 默认的 200k 处理自动压缩"
              mono
            />
          </View>
        </Card>
        <Card>
          <CardTitle text="测试连通性" hint="向端点发一条最小请求，验证 Key、地址与模型 ID；测试不落库、不进菜单" />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <PrimaryButton
              label={testing ? "测试中…" : "测试"}
              onPress={() => { void runTest(); }}
              disabled={testing}
            />
            {testResult ? (
              <Text style={{
                color: testResult.ok ? colors().statusSuccess : colors().statusDanger,
                fontSize: 12,
                flexShrink: 1,
              }}>
                {testResult.ok ? "✓ " : "✗ "}{testResult.text}
              </Text>
            ) : null}
          </View>
        </Card>
      </ScrollView>
    </View>
  );
}

/** Checkable list of the vendor's discovered models, with search and bulk pick. */
function ModelPicker({ models, selected, onToggle, onConfirm, onCancel }: {
  models: readonly FetchedModel[];
  selected: ReadonlySet<string>;
  onToggle(id: string): void;
  onConfirm(): void;
  onCancel(): void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? models.filter((model) => model.id.toLowerCase().includes(needle) || (model.label ?? "").toLowerCase().includes(needle))
    : models;
  const visibleSelected = visible.filter((model) => selected.has(model.id)).length;

  return (
    <View style={{ flex: 1 }}>
      <View style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: colors().border,
        backgroundColor: colors().surface1,
      }}>
        <HoverPressable
          accessibilityRole="button"
          accessibilityLabel="返回 Provider 表单"
          onPress={onCancel}
          style={({ hovered }) => ({
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 6,
            backgroundColor: hovered ? colors().surface2 : "transparent",
          })}
        >
          <Text style={{ color: colors().foreground, fontSize: 16 }}>‹</Text>
        </HoverPressable>
        <Text style={{ color: colors().foreground, fontSize: 14, fontWeight: "700", flexShrink: 1 }}>
          选择要添加的模型
        </Text>
        <View style={{ flex: 1 }} />
        <Pill text={`已选 ${selected.size}`} tone={selected.size > 0 ? "success" : "muted"} />
        <PrimaryButton label="添加所选" onPress={onConfirm} disabled={selected.size === 0} />
      </View>

      <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 8 }}>
        <TextInput
          value={query}
          placeholder="搜索模型 ID / 显示名…"
          placeholderTextColor={colors().foregroundMuted}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          style={inputStyle()}
        />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: colors().foregroundMuted, fontSize: 12, flex: 1 }}>
            {needle ? `${visible.length} 个匹配，其中已选 ${visibleSelected}` : `共 ${models.length} 个`}
            （显示名与窗口已按预设知识填好，[1m] 为 1M 窗口变体）
          </Text>
          <PrimaryButton
            label={visibleSelected === visible.length ? "清空所见" : "全选所见"}
            subtle
            onPress={() => {
              for (const model of visible) {
                if (visibleSelected === visible.length) onToggle(model.id);
                else if (!selected.has(model.id)) onToggle(model.id);
              }
            }}
            disabled={visible.length === 0}
          />
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }}>
        {visible.map((model) => {
          const picked = selected.has(model.id);
          return (
            <HoverPressable
              key={model.id}
              accessibilityRole="button"
              accessibilityLabel={`${picked ? "取消选择" : "选择"} ${model.id}`}
              onPress={() => onToggle(model.id)}
              style={({ hovered, pressed }) => ({
                backgroundColor: pressed || hovered ? colors().surface2 : colors().surface1,
                borderColor: picked ? colors().accent : hovered ? colors().accent : colors().border,
                borderWidth: 1,
                borderRadius: 10,
                padding: 10,
              })}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View style={{
                  width: 18, height: 18, borderRadius: 5,
                  borderWidth: 1,
                  borderColor: picked ? colors().accent : colors().border,
                  backgroundColor: picked ? colors().accent : "transparent",
                  alignItems: "center",
                  justifyContent: "center",
                }}>
                  {picked ? (
                    <Text style={{ color: colors().accentForeground, fontSize: 12, lineHeight: 14, fontWeight: "700" }}>✓</Text>
                  ) : null}
                </View>
                <Text numberOfLines={1} style={{ color: colors().foreground, fontSize: 12, fontFamily: MONO_FONT, flexShrink: 1 }}>
                  {model.id}
                </Text>
                {model.label ? (
                  <Text numberOfLines={1} style={{ color: colors().foregroundMuted, fontSize: 12, flexShrink: 1 }}>
                    {model.label}
                  </Text>
                ) : null}
                <View style={{ flex: 1 }} />
                {model.contextWindow ? (
                  <View style={{ backgroundColor: colors().surface2, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 }}>
                    <Text style={{ color: colors().foregroundMuted, fontSize: 11, fontFamily: MONO_FONT }}>
                      {formatWindow(model.contextWindow)}
                    </Text>
                  </View>
                ) : null}
              </View>
            </HoverPressable>
          );
        })}
        {visible.length === 0 ? (
          <Text style={{ color: colors().foregroundMuted, fontSize: 13 }}>没有匹配的模型</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}
