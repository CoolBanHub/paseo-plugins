import { useCallback, useEffect, useState } from "react";
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
 * Host-level settings screen, as a list: every configured provider is a
 * section with its endpoint, model count, key hint, an enable switch and
 * edit/delete actions; add and edit open the form. API keys are stored on
 * the daemon side and never leave it — the screen only sees a masked hint.
 */

type ModelDraft = { id: string; label: string; contextWindow: string };

type FormState = {
  presetId: string;
  label: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  authHeader: AuthHeader;
  apiKey: string;
  models: ModelDraft[];
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
});

export function ProviderSettingsScreen(_props: PluginSurfaceProps) {
  const toast = useToast();
  const listRpc = useRpc(listProvidersRpc);
  const saveRpc = useRpc(saveProviderRpc);
  const deleteRpc = useRpc(deleteProviderRpc);

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

  const remove = useCallback(async (provider: ProviderView) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await deleteRpc({ id: provider.id });
      if (result.ok) {
        setProviders(result.providers);
        toast.show(`已删除 ${provider.label}`);
      } else {
        toast.error(`删除失败：${result.error ?? "未知错误"}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, deleteRpc, toast]);

  if (editing !== null) {
    return (
      <ProviderForm
        initial={editing === "new" ? null : editing}
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
      {providers.length === 0 ? (
        <SettingsAction
          label="还没有 Provider"
          hint="添加后其模型会出现在 Claude 的模型选择器（描述为「自定义模型 · …」）"
          actionLabel="添加"
          onPress={() => setEditing("new")}
        />
      ) : providers.map((provider) => (
        <SettingsSection
          key={provider.id}
          title={provider.label}
          info={`${provider.baseUrl} · ${provider.models.length} 个模型 · ${provider.keyHint ?? "未配置 Key"}${provider.enabled ? "" : " · 已停用"}`}
        >
          <SettingsSwitch
            label="启用"
            hint="停用后模型从选择器移除；已开会话的下一条请求会失败"
            value={provider.enabled}
            onValueChange={(value) => { void toggle(provider, value); }}
            disabled={busy}
          />
          <SettingsAction
            label="编辑配置"
            hint="名称、端点、鉴权、API Key 与模型列表"
            actionLabel="编辑"
            onPress={() => setEditing(provider)}
            disabled={busy}
          />
          <SettingsAction
            label={`删除 ${provider.label}`}
            hint="配置与 Key 一并删除，模型从选择器移除"
            actionLabel="删除"
            onPress={() => { void remove(provider); }}
            disabled={busy}
          />
        </SettingsSection>
      ))}
      <SettingsAction
        label="新建 Provider"
        hint="从 DeepSeek / GLM / Kimi / 通义千问预设开始，或自定义任意 Anthropic / OpenAI 兼容端点"
        actionLabel="添加"
        onPress={() => setEditing("new")}
        disabled={busy}
      />
    </SettingsSection>
  );
}

function ProviderForm({ initial, onDone }: { initial: ProviderView | null; onDone(): void }) {
  const toast = useToast();
  const saveRpc = useRpc(saveProviderRpc);

  const [form, setForm] = useState<FormState>(() => (initial ? formFromView(initial) : presetForm("deepseek")));
  // Inputs are uncontrolled; bumping this remounts them with fresh values.
  const [formVersion, setFormVersion] = useState(0);
  const [saving, setSaving] = useState(false);

  const applyForm = useCallback((next: FormState) => {
    setForm(next);
    setFormVersion((version) => version + 1);
  }, []);

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
        ...(initial ? { id: initial.id } : {}),
        label: form.label.trim(),
        baseUrl: form.baseUrl.trim(),
        protocol: form.protocol,
        authHeader: form.authHeader,
        enabled: true,
        models,
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
              hint="留空按 Claude Code 默认的 200k 处理自动压缩"
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
      </SettingsSection>
    </SettingsSection>
  );
}
