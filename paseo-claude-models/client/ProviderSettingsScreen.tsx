import { useCallback, useEffect, useMemo, useState } from "react";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import {
  deleteProviderRpc,
  listProvidersRpc,
  saveProviderRpc,
  type ProviderView,
} from "../shared/contracts";
import { PROVIDER_PRESETS, type AuthHeader, type ProviderProtocol } from "../shared/presets";

/**
 * Host-level settings screen: manage the personal model providers whose
 * models appear in Paseo's Claude model picker. API keys are stored on the
 * daemon side and never leave it — the screen only sees a masked hint.
 */

type ModelDraft = { id: string; label: string; contextWindow: string };

type FormState = {
  presetId: string;
  label: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  authHeader: AuthHeader;
  apiKey: string;
  enabled: boolean;
  models: ModelDraft[];
};

const NEW = "__new__";

const emptyForm = (): FormState => ({
  presetId: "custom",
  label: "",
  baseUrl: "",
  protocol: "anthropic",
  authHeader: "bearer",
  apiKey: "",
  enabled: true,
  models: [],
});

const presetForm = (presetId: string): FormState => {
  const preset = PROVIDER_PRESETS.find((entry) => entry.id === presetId);
  if (!preset) return emptyForm();
  return {
    presetId,
    label: preset.id === "custom" ? "" : preset.label,
    baseUrl: preset.baseUrl,
    protocol: preset.protocol,
    authHeader: preset.authHeader,
    apiKey: "",
    enabled: true,
    models: preset.models.map((model) => ({
      id: model.id,
      label: model.label,
      contextWindow: model.contextWindow ? String(model.contextWindow) : "",
    })),
  };
};

const formFromView = (provider: ProviderView): FormState => ({
  presetId: "custom",
  label: provider.label,
  baseUrl: provider.baseUrl,
  protocol: provider.protocol,
  authHeader: provider.authHeader,
  apiKey: "",
  enabled: provider.enabled,
  models: provider.models.map((model) => ({
    id: model.id,
    label: model.label,
    contextWindow: model.contextWindow ? String(model.contextWindow) : "",
  })),
});

export function ProviderSettingsScreen(_props: PluginSurfaceProps) {
  const toast = useToast();
  const listRpc = useRpc(listProvidersRpc);
  const saveRpc = useRpc(saveProviderRpc);
  const deleteRpc = useRpc(deleteProviderRpc);

  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [target, setTarget] = useState<string>(NEW);
  const [form, setForm] = useState<FormState>(emptyForm);
  // Inputs are uncontrolled; bumping this remounts them with fresh values.
  const [formVersion, setFormVersion] = useState(0);
  const [saving, setSaving] = useState(false);

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

  const editing = useMemo(
    () => (target === NEW ? null : providers.find((provider) => provider.id === target) ?? null),
    [providers, target],
  );

  const applyForm = useCallback((next: FormState) => {
    setForm(next);
    setFormVersion((version) => version + 1);
  }, []);

  const onTargetChange = useCallback((value: string) => {
    setTarget(value);
    if (value === NEW) { applyForm(emptyForm()); return; }
    const provider = providers.find((entry) => entry.id === value);
    if (provider) applyForm(formFromView(provider));
  }, [applyForm, providers]);

  const onPresetChange = useCallback((value: string) => {
    applyForm(presetForm(value));
  }, [applyForm]);

  const key = (field: string) => `${field}-${formVersion}`;

  const setModel = useCallback((index: number, patch: Partial<ModelDraft>) => {
    setForm((current) => ({
      ...current,
      models: current.models.map((model, position) => (position === index ? { ...model, ...patch } : model)),
    }));
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
    setSaving(true);
    try {
      const result = await saveRpc({
        ...(editing ? { id: editing.id } : {}),
        label: form.label.trim(),
        baseUrl: form.baseUrl.trim(),
        protocol: form.protocol,
        authHeader: form.authHeader,
        enabled: form.enabled,
        models,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      });
      if (result.ok) {
        setProviders(result.providers);
        toast.show(`已保存 ${form.label.trim()}，其模型已加入 Claude 的模型选择器`);
        setTarget(NEW);
        applyForm(emptyForm());
      } else {
        toast.error(`保存失败：${result.error ?? "未知错误"}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [applyForm, editing, form, saveRpc, saving, toast]);

  const remove = useCallback(async () => {
    if (!editing || saving) return;
    setSaving(true);
    try {
      const result = await deleteRpc({ id: editing.id });
      if (result.ok) {
        setProviders(result.providers);
        toast.show(`已删除 ${editing.label}`);
        setTarget(NEW);
        applyForm(emptyForm());
      } else {
        toast.error(`删除失败：${result.error ?? "未知错误"}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [applyForm, deleteRpc, editing, saving, toast]);

  return (
    <SettingsSection
      title="Claude 自定义模型"
      info="把 DeepSeek、GLM、Kimi 等自有 API Key 的模型加入 Claude 的模型选择器；新会话选择后即走对应厂商，请求经本机代理转发"
    >
      <SettingsSection title="Provider" info="内置预设可改：端点、鉴权与模型列表都以表单为准">
        <SettingsSelect
          label="编辑对象"
          value={target}
          options={[
            { label: "＋ 新建 Provider", value: NEW },
            ...providers.map((provider) => ({ label: provider.label, value: provider.id })),
          ]}
          onValueChange={onTargetChange}
        />
        {editing ? (
          <SettingsSelect
            label="套用预设"
            value={form.presetId}
            options={PROVIDER_PRESETS.map((preset) => ({ label: preset.label, value: preset.id }))}
            onValueChange={onPresetChange}
            hint="选择预设会用该预设覆盖下方表单"
          />
        ) : (
          <SettingsSelect
            label="从预设开始"
            value={form.presetId}
            options={PROVIDER_PRESETS.map((preset) => ({ label: preset.label, value: preset.id }))}
            onValueChange={onPresetChange}
            hint={PROVIDER_PRESETS.find((preset) => preset.id === form.presetId)?.keyHint}
          />
        )}
        {editing ? (
          <SettingsAction
            label={`删除 ${editing.label}`}
            hint="模型会从选择器移除；已开会话的下一条请求会失败，请关闭后再删除"
            actionLabel="删除"
            onPress={() => { void remove(); }}
            disabled={saving}
          />
        ) : null}
      </SettingsSection>

      <SettingsSection title="连接">
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
          placeholder={editing?.keyHint ? `已保存 ${editing.keyHint}，留空保持不变` : "粘贴 API Key"}
          initialValue=""
          secureTextEntry
          onChangeText={(text) => setForm((current) => ({ ...current, apiKey: text }))}
          hint={PROVIDER_PRESETS.find((preset) => preset.id === form.presetId)?.keyHint}
        />
        <SettingsSwitch
          label="启用"
          hint="关闭后模型不再出现在选择器"
          value={form.enabled}
          onValueChange={(value) => setForm((current) => ({ ...current, enabled: value }))}
        />
      </SettingsSection>

      <SettingsSection title="模型列表" info="模型 ID 必须与厂商一致；显示名只用于选择器">
        {form.models.map((model, index) => (
          <SettingsSection key={`model-${formVersion}-${index}`} title={`模型 ${index + 1}`}>
            <SettingsInput
              key={key(`m${index}-id`)}
              label="模型 ID"
              placeholder="glm-4.6"
              initialValue={model.id}
              onChangeText={(text) => setModel(index, { id: text })}
            />
            <SettingsInput
              key={key(`m${index}-label`)}
              label="显示名"
              placeholder="GLM-4.6"
              initialValue={model.label}
              onChangeText={(text) => setModel(index, { label: text })}
            />
            <SettingsInput
              key={key(`m${index}-window`)}
              label="上下文窗口（可选）"
              placeholder="200000"
              initialValue={model.contextWindow}
              onChangeText={(text) => setModel(index, { contextWindow: text })}
              hint="留空按 200k 处理自动压缩"
            />
            <SettingsAction
              label="移除这个模型"
              actionLabel="移除"
              onPress={() => setForm((current) => ({
                ...current,
                models: current.models.filter((_, position) => position !== index),
              }))}
            />
          </SettingsSection>
        ))}
        <SettingsAction
          label="添加模型"
          actionLabel="添加"
          onPress={() => setForm((current) => ({ ...current, models: [...current.models, { id: "", label: "", contextWindow: "" }] }))}
        />
      </SettingsSection>

      <SettingsSection title="保存">
        <SettingsAction
          label={editing ? `保存对 ${editing.label} 的修改` : "保存为新 Provider"}
          actionLabel={saving ? "保存中…" : "保存"}
          onPress={() => { void save(); }}
          disabled={saving}
        />
      </SettingsSection>
    </SettingsSection>
  );
}
