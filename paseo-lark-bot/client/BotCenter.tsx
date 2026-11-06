import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { useToast } from "@getpaseo/plugin/client/react-native";
import {
  larkBotChatMembersRpc,
  larkBotChatsRpc,
  larkBotProvidersRpc,
  larkBotStatusRpc,
  type LarkBotChatMember,
  type LarkBotProviderInfo,
} from "../shared/contracts.ts";
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

interface MemberCatalogState {
  loading: boolean;
  members: LarkBotChatMember[];
  error: string | null;
}

/** Provider ids can be `provider/model`; the picker lists the bare id. */
function findProvider(providers: LarkBotProviderInfo[], providerId: string): LarkBotProviderInfo | undefined {
  const base = providerId.split("/", 1)[0] ?? providerId;
  return providers.find((candidate) => candidate.id === base) ?? providers.find((candidate) => candidate.id === providerId);
}

/** The selected model, or the provider default when the binding leaves it empty. */
function findModel(provider: LarkBotProviderInfo | undefined, modelId: string) {
  if (!provider) return undefined;
  if (modelId) {
    const selected = provider.models.find((model) => model.id === modelId);
    if (selected) return selected;
  }
  return (
    provider.models.find((model) => model.isDefault) ??
    provider.models[0] ??
    undefined
  );
}

function permissionLabel(provider: LarkBotProviderInfo | undefined, value: string): string {
  if (!value) return "默认";
  return provider?.permissionOptions.find((option) => option.value === value)?.label ?? value;
}

export function BotCenterSurface(props: PluginSurfaceProps) {
  applyTheme(props.theme);
  const toast = useToast();
  const readRpc = useRpc(larkBotSettingsRpc.read);
  const writeRpc = useRpc(larkBotSettingsRpc.write);
  const chatsRpc = useRpc(larkBotChatsRpc);
  const providersRpc = useRpc(larkBotProvidersRpc);
  const chatMembersRpc = useRpc(larkBotChatMembersRpc);
  const statusRpc = useRpc(larkBotStatusRpc);

  const [revision, setRevision] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<BotValues | null>(null);
  const [draft, setDraft] = useState<BotValues | null>(null);
  const [saving, setSaving] = useState(false);
  const [chatCatalog, setChatCatalog] = useState<{ chatId: string; name: string }[]>([]);
  const [providers, setProviders] = useState<LarkBotProviderInfo[]>([]);
  const [memberCatalogs, setMemberCatalogs] = useState<Record<string, MemberCatalogState>>({});
  const [allowedDrafts, setAllowedDrafts] = useState<Record<string, string>>({});
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
              model: "",
              thinkingOptionId: "",
              permission: "",
              allowedUsers: [],
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

  const selectProvider = useCallback(
    (chatId: string, provider: string) => {
      // Model/thinking/permission ids are provider-specific; keeping a stale
      // value would make the next agents.create() reject the config.
      patchBinding(chatId, { provider, model: "", thinkingOptionId: "", permission: "" });
    },
    [patchBinding],
  );

  const selectModel = useCallback(
    (chatId: string, model: string) => {
      patchBinding(chatId, { model, thinkingOptionId: "" });
    },
    [patchBinding],
  );

  const addAllowedUser = useCallback((chatId: string, user: LarkBotChatMember) => {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        chats: current.chats.map((chat) => {
          if (chat.chatId !== chatId || chat.allowedUsers.some((entry) => entry.openId === user.openId)) {
            return chat;
          }
          return { ...chat, allowedUsers: [...chat.allowedUsers, { openId: user.openId, name: user.name }] };
        }),
      };
    });
  }, []);

  const removeAllowedUser = useCallback((chatId: string, openId: string) => {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        chats: current.chats.map((chat) =>
          chat.chatId === chatId
            ? { ...chat, allowedUsers: chat.allowedUsers.filter((entry) => entry.openId !== openId) }
            : chat,
        ),
      };
    });
  }, []);

  const addAllowedFromText = useCallback(
    (chatId: string) => {
      const text = (allowedDrafts[chatId] ?? "").trim();
      if (!text) return;
      const tokens = text.split(/[\s,，;；]+/u).map((token) => token.trim()).filter(Boolean);
      const invalid = tokens.find((token) => !token.startsWith("ou_"));
      if (invalid) {
        toast.error(`open_id 应以 ou_ 开头：${invalid}`);
        return;
      }
      const names = new Map<string, string>();
      for (const chat of draft?.chats ?? []) {
        for (const user of chat.allowedUsers) names.set(user.openId, user.name);
      }
      for (const member of memberCatalogs[chatId]?.members ?? []) names.set(member.openId, member.name);
      for (const openId of new Set(tokens)) {
        addAllowedUser(chatId, { openId, name: names.get(openId) ?? "" });
      }
      setAllowedDrafts((current) => ({ ...current, [chatId]: "" }));
    },
    [addAllowedUser, allowedDrafts, draft, memberCatalogs, toast],
  );

  const loadMembers = useCallback(
    async (chatId: string) => {
      setMemberCatalogs((current) => ({
        ...current,
        [chatId]: { loading: true, members: current[chatId]?.members ?? [], error: null },
      }));
      try {
        const result = await chatMembersRpc({ chatId });
        setMemberCatalogs((current) => ({
          ...current,
          [chatId]: { loading: false, members: result.members, error: result.error },
        }));
      } catch (error) {
        setMemberCatalogs((current) => ({
          ...current,
          [chatId]: {
            loading: false,
            members: current[chatId]?.members ?? [],
            error: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    },
    [chatMembersRpc],
  );

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
        if (parsed.success) {
          setLoaded(parsed.data);
          setDraft(parsed.data);
        }
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
        {draft.chats.map((binding) => {
          const provider = findProvider(providers, binding.provider);
          const effectiveModel = findModel(provider, binding.model);
          const thinkingOptions = effectiveModel?.thinkingOptions ?? [];
          const selectedMemberIds = new Set(binding.allowedUsers.map((user) => user.openId));
          const memberCatalog = memberCatalogs[binding.chatId];
          const addableMembers = (memberCatalog?.members ?? []).filter(
            (member) => !selectedMemberIds.has(member.openId),
          );
          const unknownModel =
            binding.model && !provider?.models.some((model) => model.id === binding.model)
              ? binding.model
              : null;
          const unknownThinking =
            binding.thinkingOptionId && !thinkingOptions.some((option) => option.id === binding.thinkingOptionId)
              ? binding.thinkingOptionId
              : null;
          const unknownPermission =
            binding.permission && !provider?.permissionOptions.some((option) => option.value === binding.permission)
              ? binding.permission
              : null;
          const defaultPermissionLabel = provider?.defaultPermission
            ? permissionLabel(provider, provider.defaultPermission)
            : null;
          const permissionHint = !provider
            ? "未获取到 provider 信息，留空使用 provider / 插件默认权限。"
            : provider.permissionKind === "dsh-preset"
              ? "留空 = 完全权限（与旧版一致）；按 dsh 权限预设限制本会话可用的工具能力。"
              : provider.permissionKind === "mode"
                ? `留空 = provider 默认${defaultPermissionLabel ? `（${defaultPermissionLabel}）` : ""}；决定工具审批/运行模式。`
                : "该 provider 没有可配置的权限模式，使用自身默认。";
          const thinkingDefaultLabel = provider?.permissionKind === "dsh-preset" ? "默认（最深）" : "默认";
          return (
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
              {providers.length > 0 ? (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {providers.map((candidate) => (
                    <ChoicePill
                      key={candidate.id}
                      label={candidate.label}
                      active={findProvider(providers, binding.provider)?.id === candidate.id}
                      onPress={() => selectProvider(binding.chatId, candidate.id)}
                    />
                  ))}
                </View>
              ) : (
                <Text style={{ color: colors().foregroundMuted, fontSize: 13 }}>
                  未获取到 provider 列表，请先点顶部「刷新」。
                </Text>
              )}

              <FieldLabel text="模型（留空 = provider 默认模型）" />
              {(provider?.models.length ?? 0) > 0 || unknownModel ? (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  <ChoicePill
                    label="默认"
                    active={!binding.model}
                    onPress={() => selectModel(binding.chatId, "")}
                  />
                  {(provider?.models ?? []).map((model) => (
                    <ChoicePill
                      key={model.id}
                      label={model.label + (model.isDefault ? "（默认）" : "")}
                      active={binding.model === model.id}
                      onPress={() => selectModel(binding.chatId, model.id)}
                    />
                  ))}
                  {unknownModel ? (
                    <ChoicePill
                      label={`${unknownModel}（未在列表）`}
                      active
                      onPress={() => selectModel(binding.chatId, "")}
                    />
                  ) : null}
                </View>
              ) : (
                <Text style={{ color: colors().foregroundMuted, fontSize: 13 }}>
                  未获取到模型列表，留空使用 provider 默认模型。
                </Text>
              )}

              <FieldLabel text="思考深度（留空 = 模型默认；dsh 留空 = 最深）" />
              {thinkingOptions.length > 0 ? (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  <ChoicePill
                    label={thinkingDefaultLabel}
                    active={!binding.thinkingOptionId}
                    onPress={() => patchBinding(binding.chatId, { thinkingOptionId: "" })}
                  />
                  {thinkingOptions.map((option) => (
                    <ChoicePill
                      key={option.id}
                      label={option.label}
                      active={binding.thinkingOptionId === option.id}
                      onPress={() => patchBinding(binding.chatId, { thinkingOptionId: option.id })}
                    />
                  ))}
                  {unknownThinking ? (
                    <ChoicePill
                      label={`${unknownThinking}（未在列表）`}
                      active
                      onPress={() => patchBinding(binding.chatId, { thinkingOptionId: "" })}
                    />
                  ) : null}
                </View>
              ) : (
                <Text style={{ color: colors().foregroundMuted, fontSize: 13 }}>
                  {provider
                    ? "该模型没有可选的思考深度，留空使用 provider / 模型默认。"
                    : "未获取到 provider 信息，留空使用默认思考深度。"}
                </Text>
              )}

              <FieldLabel text="权限（留空 = provider / 插件默认）" />
              {(provider?.permissionOptions.length ?? 0) > 0 || unknownPermission ? (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  <ChoicePill
                    label="默认"
                    active={!binding.permission}
                    onPress={() => patchBinding(binding.chatId, { permission: "" })}
                  />
                  {(provider?.permissionOptions ?? []).map((option) => (
                    <ChoicePill
                      key={option.value}
                      label={option.label}
                      active={binding.permission === option.value}
                      onPress={() => patchBinding(binding.chatId, { permission: option.value })}
                    />
                  ))}
                  {unknownPermission ? (
                    <ChoicePill
                      label={`${unknownPermission}（未在列表）`}
                      active
                      onPress={() => patchBinding(binding.chatId, { permission: "" })}
                    />
                  ) : null}
                </View>
              ) : null}
              <Text style={{ color: colors().foregroundMuted, fontSize: 12 }}>{permissionHint}</Text>

              <FieldLabel text="允许 @ 的成员（留空 = 所有人可触发）" />
              {binding.allowedUsers.length === 0 ? (
                <Text style={{ color: colors().foregroundMuted, fontSize: 13 }}>
                  当前所有人都可以 @ 我处理。
                </Text>
              ) : (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {binding.allowedUsers.map((user) => (
                    <ChoicePill
                      key={user.openId}
                      label={`${user.name || user.openId} ×`}
                      active
                      onPress={() => removeAllowedUser(binding.chatId, user.openId)}
                    />
                  ))}
                </View>
              )}
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <TextInput
                  value={allowedDrafts[binding.chatId] ?? ""}
                  placeholder="ou_xxx，多个用逗号分隔"
                  placeholderTextColor={colors().foregroundMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                  onSubmitEditing={() => addAllowedFromText(binding.chatId)}
                  onChangeText={(text) =>
                    setAllowedDrafts((current) => ({ ...current, [binding.chatId]: text }))
                  }
                  style={inputStyle({ flex: 1 })}
                />
                <PrimaryButton label="添加" onPress={() => addAllowedFromText(binding.chatId)} subtle />
                <PrimaryButton
                  label={memberCatalog?.loading ? "读取中…" : "读取群成员"}
                  onPress={() => void loadMembers(binding.chatId)}
                  subtle
                />
              </View>
              {memberCatalog?.error ? (
                <Text style={{ color: colors().statusDanger, fontSize: 12 }}>
                  读取群成员失败：{memberCatalog.error}。仍可手动填写 open_id。
                </Text>
              ) : null}
              {addableMembers.length > 0 ? (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {addableMembers.slice(0, 50).map((member) => (
                    <ChoicePill
                      key={member.openId}
                      label={member.name || member.openId}
                      active={false}
                      onPress={() => addAllowedUser(binding.chatId, member)}
                    />
                  ))}
                </View>
              ) : null}
              <Text style={{ color: colors().foregroundMuted, fontSize: 12 }}>
                非指定成员 @ 时会收到提示，消息不会进入话题上下文。读取成员需要飞书权限 im:chat.members:read。
              </Text>

              <FieldLabel text="工作目录（空 = 用户主目录；支持 ~/ 开头）" />
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
                placeholder="例：你是项目维护助手，用中文回答"
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
          );
        })}

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
          hint="留空沿用 lark-cli 已有配置；填写后保存即验证并写入 lark-cli（按本地使用场景明文保存，不加密）"
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
          已有配置的 Secret 存在系统钥匙串里、无法回显；要从界面管理凭证，请到飞书开发者后台（凭证与基础信息）复制 App Secret 填入并保存。按当前本地使用场景，这份值会明文保存在 Paseo 设置中并明文显示；请确保本机账户与备份安全。
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
        <ToggleRow
          label="收到消息先确认"
          hint="收到 @ 消息立即回复一条「收到，正在处理」，处理完成后再回结果"
          value={draft.ackOnReceive}
          onChange={(value) => patchDraft({ ackOnReceive: value })}
        />
        <ToggleRow
          label="权限请求通知到群"
          hint="默认关闭；开启后权限请求会发到话题，仍需在 Paseo 客户端批准"
          value={draft.notifyPermission}
          onChange={(value) => patchDraft({ notifyPermission: value })}
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
      model: chat.model.trim(),
      thinkingOptionId: chat.thinkingOptionId.trim(),
      permission: chat.permission.trim(),
      allowedUsers: chat.allowedUsers
        .map((user) => ({ openId: user.openId.trim(), name: user.name.trim() }))
        .filter(
          (user, index, users) =>
            user.openId.length > 0 && users.findIndex((candidate) => candidate.openId === user.openId) === index,
        ),
      cwd: chat.cwd.trim(),
      systemPrompt: chat.systemPrompt.trim(),
    })),
  };
}
