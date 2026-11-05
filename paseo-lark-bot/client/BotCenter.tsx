import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { larkBotChatsRpc, larkBotProvidersRpc, larkBotStatusRpc } from "../shared/contracts.ts";
import {
  botValuesSchema,
  larkBotSettingsRpc,
  type BotValues,
  type ChatBinding,
  type ReplyFormat,
} from "../shared/settings.ts";

/**
 * Standalone Feishu-bot management surface (sidebar entry "飞书机器人"):
 * runtime status, per-chat bindings, and global options. Draft-based editing
 * with a single save action, following the team-work admin-screen pattern.
 */

// Lightweight theme bridge: the host hands each render a fresh theme; resolve
// it once per render through module state like team-work's design.tsx.
let palette: PluginTheme["colors"] | null = null;
function applyTheme(theme: PluginTheme): void {
  palette = theme.colors;
}
function colors(): PluginTheme["colors"] {
  return palette ?? {
    surface0: "#f7f7f8",
    surface1: "#ffffff",
    surface2: "#f0f0f2",
    border: "#e3e3e6",
    foreground: "#1b1b1f",
    foregroundMuted: "#6d6d78",
    accent: "#3b5bfd",
    accentForeground: "#ffffff",
    statusSuccess: "#1f9d55",
    statusWarning: "#b7791f",
    statusDanger: "#d24545",
  };
}

interface StatusState {
  consumerState: string;
  lastError: string | null;
  cliPath: string | null;
  currentAppId: string | null;
  botOpenId: string | null;
  sessions: { chatId: string; topicKey: string; agentId: string | null; busy: boolean; queued: number }[];
  unmatched: { chatId: string; chatType: string; lastSeenAt: number }[];
}

const CONSUMER_LABELS: Record<string, { text: string; tone: "success" | "warning" | "danger" | "muted" }> = {
  stopped: { text: "未运行 · 没有绑定", tone: "muted" },
  starting: { text: "连接中…", tone: "warning" },
  ready: { text: "监听中", tone: "success" },
  retrying: { text: "重试中", tone: "danger" },
};

const REPLY_FORMATS: { value: ReplyFormat; label: string }[] = [
  { value: "markdown", label: "Markdown" },
  { value: "text", label: "纯文本" },
  { value: "post", label: "富文本@" },
];

const CARD = 12;

export function BotCenterSurface(props: PluginSurfaceProps) {
  applyTheme(props.theme);
  const toast = useToast();
  const readRpc = useRpc(larkBotSettingsRpc.read);
  const writeRpc = useRpc(larkBotSettingsRpc.write);
  const chatsRpc = useRpc(larkBotChatsRpc);
  const providersRpc = useRpc(larkBotProvidersRpc);
  const statusRpc = useRpc(larkBotStatusRpc);

  const [revision, setRevision] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<BotValues | null>(null);
  const [draft, setDraft] = useState<BotValues | null>(null);
  const [saving, setSaving] = useState(false);
  const [chatCatalog, setChatCatalog] = useState<{ chatId: string; name: string }[]>([]);
  const [providers, setProviders] = useState<{ id: string; label: string }[]>([]);
  const [status, setStatus] = useState<StatusState | null>(null);

  const reload = useCallback(async () => {
    try {
      const result = await readRpc({});
      if (result.status === "ready") {
        setRevision(result.revision);
        const parsed = botValuesSchema.safeParse(result.values ?? {});
        if (parsed.success) {
          setLoaded(parsed.data);
          setDraft(parsed.data);
        } else {
          toast.error(`已保存的设置无效：${parsed.error.issues[0]?.message ?? ""}`);
        }
      } else if (result.status === "invalid") {
        setRevision(result.revision);
        toast.error(`已保存的设置无效：${result.error}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [readRpc, toast]);

  const refreshStatus = useCallback(async () => {
    try {
      const [chats, providerList, current] = await Promise.all([
        chatsRpc({}),
        providersRpc({}),
        statusRpc({}),
      ]);
      setChatCatalog(chats.chats);
      setProviders(providerList.providers);
      setStatus(current);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [chatsRpc, providersRpc, statusRpc, toast]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const patchDraft = useCallback((patch: Partial<BotValues>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }, []);

  const patchBinding = useCallback((chatId: string, patch: Partial<ChatBinding>) => {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        chats: current.chats.map((chat) => (chat.chatId === chatId ? { ...chat, ...patch } : chat)),
      };
    });
  }, []);

  const boundIds = useMemo(() => new Set(draft?.chats.map((chat) => chat.chatId) ?? []), [draft]);

  const addBinding = useCallback(
    (chatId: string) => {
      if (!chatId) return;
      setDraft((current) => {
        if (!current || current.chats.some((chat) => chat.chatId === chatId)) return current;
        const catalogName = chatCatalog.find((chat) => chat.chatId === chatId)?.name ?? "";
        return {
          ...current,
          chats: [
            ...current.chats,
            {
              chatId,
              chatName: catalogName,
              provider: providers[0]?.id ?? "",
              cwd: "",
              systemPrompt: "",
              replyFormat: "markdown",
            },
          ],
        };
      });
    },
    [chatCatalog, providers],
  );

  const removeBinding = useCallback((chatId: string) => {
    setDraft((current) =>
      current ? { ...current, chats: current.chats.filter((chat) => chat.chatId !== chatId) } : current,
    );
  }, []);

  const dirty =
    draft !== null && loaded !== null && JSON.stringify(normalize(draft)) !== JSON.stringify(normalize(loaded));
  const bindingsValid = (draft?.chats ?? []).every((chat) => chat.provider.trim().length > 0);

  const save = useCallback(async () => {
    if (revision === null || draft === null || saving) return;
    setSaving(true);
    try {
      const result = await writeRpc({ revision, values: normalize(draft) });
      if (result.status === "saved") {
        setRevision(result.revision);
        const parsed = botValuesSchema.safeParse(result.values ?? {});
        if (parsed.success) setLoaded(parsed.data);
        toast.show("已保存，机器人设置已生效");
        void refreshStatus();
      } else if (result.status === "conflict") {
        toast.error("设置已被其他端修改，已重新加载，请再次保存");
        await reload();
      } else {
        toast.error(`保存失败：${result.error}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [draft, reload, refreshStatus, revision, saving, toast, writeRpc]);

  if (!draft || !loaded) {
    return (
      <View style={{ flex: 1, backgroundColor: colors().surface0, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: colors().foregroundMuted }}>正在加载飞书机器人设置…</Text>
      </View>
    );
  }

  const consumer = status ? (CONSUMER_LABELS[status.consumerState] ?? { text: status.consumerState, tone: "muted" as const }) : null;
  const addableChats = [
    ...chatCatalog
      .filter((chat) => !boundIds.has(chat.chatId))
      .map((chat) => ({ chatId: chat.chatId, label: chat.name || chat.chatId })),
    ...(status?.unmatched ?? [])
      .filter((chat) => !boundIds.has(chat.chatId))
      .map((chat) => ({
        chatId: chat.chatId,
        label: `${chat.chatType === "p2p" ? "单聊" : "会话"} ${chat.chatId}（最近发过消息）`,
      })),
  ];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors().surface0 }}
      contentContainerStyle={{ maxWidth: 880, width: "100%", alignSelf: "center", padding: 20, gap: 14 }}
    >
      {/* Header */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Text style={{ fontSize: 20, fontWeight: "700", color: colors().foreground, flex: 1 }}>飞书机器人</Text>
        {consumer && <Pill text={consumer.text} tone={consumer.tone} />}
        <PrimaryButton label="刷新" onPress={() => void refreshStatus()} subtle />
      </View>
      <Text style={{ color: colors().foregroundMuted, fontSize: 13, marginTop: -8 }}>
        群里 @ 机器人（或单聊直发）即由绑定的 provider 处理，结果以话题回复返回；一个话题一个智能体会话。
      </Text>

      {/* Runtime status */}
      <Card>
        <CardTitle text="运行状态" />
        <InfoRow label="事件监听" value={consumer ? consumer.text + (status?.lastError ? `（${status.lastError}）` : "") : "未知"} />
        <InfoRow label="lark-cli" value={status?.cliPath ?? "未找到（请在下方填写路径）"} muted={!status?.cliPath} />
        <InfoRow label="当前应用" value={status?.currentAppId ?? "未知"} />
        <InfoRow label="机器人身份" value={status?.botOpenId ?? "尚未读取"} />
        {(status?.sessions ?? []).length === 0 ? (
          <Text style={{ color: colors().foregroundMuted, fontSize: 13, marginTop: 6 }}>暂无进行中的话题会话。</Text>
        ) : (
          (status?.sessions ?? []).map((session) => (
            <InfoRow
              key={session.topicKey}
              label={`话题 …${session.topicKey.slice(-10)}`}
              value={`${session.busy ? "处理中" : "空闲"}${session.queued > 0 ? ` · 排队 ${session.queued} 条` : ""}`}
            />
          ))
        )}
      </Card>

      {/* Chat bindings */}
      <Card>
        <CardTitle text="会话绑定" hint="每个飞书会话用哪个 provider 处理消息" />
        {draft.chats.map((binding) => (
          <View
            key={binding.chatId}
            style={{
              borderWidth: 1,
              borderColor: colors().border,
              borderRadius: 10,
              padding: 12,
              gap: 10,
              backgroundColor: colors().surface1,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ fontWeight: "600", color: colors().foreground, flex: 1 }}>
                {binding.chatName || "未命名会话"}
              </Text>
              <Text style={{ color: colors().foregroundMuted, fontSize: 12 }}>{binding.chatId}</Text>
              <Pressable onPress={() => removeBinding(binding.chatId)} hitSlop={6}>
                <Text style={{ color: colors().statusDanger, fontSize: 13 }}>移除</Text>
              </Pressable>
            </View>

            <FieldLabel text="Provider" />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {(providers.length > 0
                ? providers
                : [{ id: binding.provider || "（刷新拉取列表）", label: binding.provider || "（刷新拉取列表）" }]
              ).map((provider) => (
                <ChoicePill
                  key={provider.id}
                  label={provider.label}
                  active={binding.provider === provider.id}
                  onPress={() => patchBinding(binding.chatId, { provider: provider.id })}
                />
              ))}
            </View>

            <FieldLabel text="工作目录（空 = 用户主目录）" />
            <TextInput
              value={binding.cwd}
              placeholder="~/Workspace/project"
              placeholderTextColor={colors().foregroundMuted}
              onChangeText={(text) => patchBinding(binding.chatId, { cwd: text })}
              style={inputStyle()}
            />

            <FieldLabel text="系统提示（可选，追加在该会话的指令前）" />
            <TextInput
              value={binding.systemPrompt}
              placeholder="例：你是项目维护的运维助手，用中文回答"
              placeholderTextColor={colors().foregroundMuted}
              multiline
              onChangeText={(text) => patchBinding(binding.chatId, { systemPrompt: text })}
              style={inputStyle({ height: 64, textAlignVertical: "top" })}
            />

            <FieldLabel text="回复格式（富文本@ 可在回复里 @ 其他机器人接力）" />
            <View style={{ flexDirection: "row", gap: 8 }}>
              {REPLY_FORMATS.map((format) => (
                <ChoicePill
                  key={format.value}
                  label={format.label}
                  active={binding.replyFormat === format.value}
                  onPress={() => patchBinding(binding.chatId, { replyFormat: format.value })}
                />
              ))}
            </View>
          </View>
        ))}

        <FieldLabel text="添加会话" />
        {addableChats.length === 0 ? (
          <Text style={{ color: colors().foregroundMuted, fontSize: 13 }}>
            没有可选会话：先把机器人拉进飞书群，或等有人给机器人发过消息后点「刷新」。
          </Text>
        ) : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {addableChats.map((chat) => (
              <ChoicePill key={chat.chatId} label={`+ ${chat.label}`} active={false} onPress={() => addBinding(chat.chatId)} />
            ))}
          </View>
        )}
      </Card>

      {/* App credentials */}
      <Card>
        <CardTitle
          text="飞书应用凭证"
          hint="留空沿用 lark-cli 已有配置；填写后保存即验证并写入 lark-cli（本机明文存储）"
        />
        <FieldLabel text="App ID（cli_ 开头）" />
        <TextInput
          value={draft.appId}
          placeholder="cli_xxxxxxxx"
          placeholderTextColor={colors().foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={(text) => patchDraft({ appId: text })}
          style={inputStyle()}
        />
        <FieldLabel text="App Secret（明文显示）" />
        <TextInput
          value={draft.appSecret}
          placeholder="与 App ID 一起填写才生效"
          placeholderTextColor={colors().foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={(text) => patchDraft({ appSecret: text })}
          style={inputStyle()}
        />
        {status?.currentAppId ? (
          <InfoRow label="当前生效" value={status.currentAppId + (draft.appId.trim() && draft.appId.trim() !== status.currentAppId ? "（保存后切换）" : "")} />
        ) : null}
        <Text style={{ fontSize: 12, color: colors().foregroundMuted }}>
          已有配置的 Secret 存在系统钥匙串里、无法回显；要从界面管理凭证，请到飞书开发者后台（凭证与基础信息）复制 App Secret 填入并保存，之后这里会一直明文显示这份值。
        </Text>
      </Card>

      {/* Global options */}
      <Card>
        <CardTitle text="全局设置" hint="对全部会话生效" />
        <FieldLabel text="lark-cli 路径（空 = 自动发现：PATH / nvm / Homebrew）" />
        <TextInput
          value={draft.larkCliPath}
          placeholder="留空自动发现"
          placeholderTextColor={colors().foregroundMuted}
          onChangeText={(text) => patchDraft({ larkCliPath: text })}
          style={inputStyle()}
        />
        <ToggleRow
          label="回复进话题"
          hint="回复挂在被 @ 消息的话题下，而不是群消息流"
          value={draft.replyInThread}
          onChange={(value) => patchDraft({ replyInThread: value })}
        />
        <ToggleRow
          label="提示未配置会话"
          hint="未绑定的会话 @ 机器人时回复一条配置提示"
          value={draft.notifyUnmatched}
          onChange={(value) => patchDraft({ notifyUnmatched: value })}
        />
        <FieldLabel text="话题空闲重建（分钟，0 = 一直复用）" />
        <TextInput
          value={String(draft.sessionIdleMinutes)}
          keyboardType="number-pad"
          onChangeText={(text) => {
            const minutes = Number.parseInt(text, 10);
            if (Number.isFinite(minutes)) patchDraft({ sessionIdleMinutes: minutes });
          }}
          style={inputStyle()}
        />
        <FieldLabel text="回复截断长度（字符）" />
        <TextInput
          value={String(draft.maxReplyChars)}
          keyboardType="number-pad"
          onChangeText={(text) => {
            const limit = Number.parseInt(text, 10);
            if (Number.isFinite(limit)) patchDraft({ maxReplyChars: limit });
          }}
          style={inputStyle()}
        />
      </Card>

      {/* Save */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 6 }}>
        <Text style={{ color: dirty ? colors().statusWarning : colors().foregroundMuted, fontSize: 13, flex: 1 }}>
          {dirty ? "有未保存的修改" : bindingsValid ? "无修改" : "有绑定未选择 provider"}
        </Text>
        <PrimaryButton
          label={saving ? "保存中…" : "保存"}
          onPress={() => void save()}
          disabled={!dirty || !bindingsValid || revision === null || saving}
        />
      </View>
    </ScrollView>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={{
        backgroundColor: colors().surface1,
        borderRadius: CARD,
        borderWidth: 1,
        borderColor: colors().border,
        padding: 16,
        gap: 10,
      }}
    >
      {children}
    </View>
  );
}

function CardTitle({ text, hint }: { text: string; hint?: string }) {
  return (
    <View>
      <Text style={{ fontSize: 15, fontWeight: "700", color: colors().foreground }}>{text}</Text>
      {hint ? <Text style={{ fontSize: 12, color: colors().foregroundMuted, marginTop: 2 }}>{hint}</Text> : null}
    </View>
  );
}

function InfoRow({ label, value, muted = true }: { label: string; value: string; muted?: boolean }) {
  return (
    <View style={{ flexDirection: "row", gap: 10 }}>
      <Text style={{ color: colors().foregroundMuted, fontSize: 13, width: 110 }}>{label}</Text>
      <Text style={{ color: muted ? colors().foreground : colors().statusDanger, fontSize: 13, flex: 1 }}>{value}</Text>
    </View>
  );
}

function FieldLabel({ text }: { text: string }) {
  return <Text style={{ fontSize: 12, color: colors().foregroundMuted }}>{text}</Text>;
}

function inputStyle(extra?: object): object {
  return {
    borderWidth: 1,
    borderColor: colors().border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    color: colors().foreground,
    fontSize: 13,
    backgroundColor: colors().surface0,
    ...extra,
  };
}

function ToggleRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 13, color: colors().foreground }}>{label}</Text>
        {hint ? <Text style={{ fontSize: 12, color: colors().foregroundMuted, marginTop: 1 }}>{hint}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: colors().accent, false: colors().surface2 }}
        thumbColor={colors().surface1}
      />
    </View>
  );
}

function ChoicePill({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress(): void;
}) {
  const c = colors();
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: active ? c.accent : c.border,
        backgroundColor: active ? c.accent : c.surface1,
      }}
    >
      <Text style={{ fontSize: 12, color: active ? c.accentForeground : c.foreground }}>{label}</Text>
    </Pressable>
  );
}

function Pill({ text, tone }: { text: string; tone: "success" | "warning" | "danger" | "muted" }) {
  const c = colors();
  const color = tone === "success" ? c.statusSuccess : tone === "warning" ? c.statusWarning : tone === "danger" ? c.statusDanger : c.foregroundMuted;
  return (
    <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: c.surface2 }}>
      <Text style={{ fontSize: 12, color }}>{text}</Text>
    </View>
  );
}

function PrimaryButton({
  label,
  onPress,
  disabled,
  subtle,
}: {
  label: string;
  onPress(): void;
  disabled?: boolean;
  subtle?: boolean;
}) {
  const c = colors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: disabled ? c.surface2 : subtle ? c.surface2 : c.accent,
        borderWidth: 1,
        borderColor: disabled ? c.border : subtle ? c.border : c.accent,
      }}
    >
      <Text style={{ fontSize: 13, color: disabled ? c.foregroundMuted : subtle ? c.foreground : c.accentForeground }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Trim strings so cosmetic edits do not mark the form dirty. */
function normalize(values: BotValues): BotValues {
  return {
    ...values,
    appId: values.appId.trim(),
    appSecret: values.appSecret.trim(),
    larkCliPath: values.larkCliPath.trim(),
    chats: values.chats.map((chat) => ({
      ...chat,
      chatName: chat.chatName.trim(),
      provider: chat.provider.trim(),
      cwd: chat.cwd.trim(),
      systemPrompt: chat.systemPrompt.trim(),
    })),
  };
}
