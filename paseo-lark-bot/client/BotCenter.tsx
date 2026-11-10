import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text, TextInput, View, useWindowDimensions } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
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
} from "../shared/settings.ts";
import {
  AddChatPicker,
  BindingEditor,
  findProvider,
  type MemberCatalogState,
} from "./BindingEditor.tsx";
import { AppCreationSection } from "./AppCreation.tsx";
import {
  Card,
  CardTitle,
  FieldLabel,
  HoverPressable,
  InfoRow,
  Pill,
  PrimaryButton,
  ToggleRow,
  applyTheme,
  colors,
  inputStyle,
} from "./widgets.tsx";

/**
 * Standalone Feishu-bot management screen (sidebar entry "飞书机器人"):
 * binding list and settings sections on the left, the selected page's editor
 * on the right; narrow windows stack the panes with back navigation. One
 * draft for everything with a single save action in the pane's action bar
 * (visible from every page, so long forms never need scrolling to save).
 */

interface StatusState {
  consumerState: string;
  lastError: string | null;
  cardConsumerState: string;
  cardLastError: string | null;
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

const CARD_CONSUMER_LABELS: Record<string, { text: string; tone: "success" | "warning" | "danger" | "muted" }> = {
  stopped: { text: "未运行", tone: "muted" },
  starting: { text: "连接中…", tone: "warning" },
  ready: { text: "监听中", tone: "success" },
  retrying: { text: "重试中", tone: "danger" },
};

type Selection =
  | { kind: "none" }
  | { kind: "add" }
  | { kind: "binding"; chatId: string }
  | { kind: "status" }
  | { kind: "credentials" }
  | { kind: "global" };

/** Below this window width the panes stack and navigate instead of splitting. */
const WIDE_MIN_WIDTH = 960;

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
  const savingRef = useRef(false);
  const [chatCatalog, setChatCatalog] = useState<{ chatId: string; name: string }[]>([]);
  const [providers, setProviders] = useState<LarkBotProviderInfo[]>([]);
  const [memberCatalogs, setMemberCatalogs] = useState<Record<string, MemberCatalogState>>({});
  const [allowedDrafts, setAllowedDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<StatusState | null>(null);
  const [selection, setSelection] = useState<Selection>({ kind: "none" });
  const wide = useWindowDimensions().width >= WIDE_MIN_WIDTH;

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
      setSelection({ kind: "binding", chatId });
    },
    [chatCatalog, providers],
  );

  const removeBinding = useCallback((chatId: string) => {
    setDraft((current) =>
      current ? { ...current, chats: current.chats.filter((chat) => chat.chatId !== chatId) } : current,
    );
    setSelection({ kind: "none" });
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

  const discard = useCallback(() => {
    setDraft(loaded);
  }, [loaded]);

  const persistDraft = useCallback(
    async (values: BotValues, message: string): Promise<boolean> => {
      if (revision === null || savingRef.current) return false;
      savingRef.current = true;
      setSaving(true);
      try {
        const result = await writeRpc({ revision, values: normalize(values) });
        if (result.status === "saved") {
          setRevision(result.revision);
          const parsed = botValuesSchema.safeParse(result.values ?? {});
          if (parsed.success) {
            setLoaded(parsed.data);
            setDraft(parsed.data);
          }
          toast.show(message);
          void refreshStatus();
          return true;
        }
        if (result.status === "conflict") {
          toast.error("设置已被其他端修改，已重新加载，请再次操作");
          await reload();
          return false;
        }
        toast.error(`保存失败：${result.error}`);
        return false;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [reload, refreshStatus, revision, toast, writeRpc],
  );

  const save = useCallback(() => {
    if (!draft) return;
    void persistDraft(draft, "已保存，机器人设置已生效");
  }, [draft, persistDraft]);

  /** Switch to the app just created by the scan flow: clear the plugin's
   * saved credentials so lark-cli's new keychain config takes over. */
  const applyScannedApp = useCallback(
    async (appId: string): Promise<boolean> => {
      if (!draft) return false;
      // Only SAVED credentials override lark-cli. If the draft was merely
      // cleared without saving, the old values still win and must be written.
      const savedOverrides = Boolean(loaded?.appId.trim() || loaded?.appSecret);
      if (!savedOverrides) {
        // Nothing saved overrides lark-cli; the server already restarted the
        // consumers. Drop any unsaved credential text so a later save cannot
        // accidentally switch back.
        if (draft.appId || draft.appSecret) patchDraft({ appId: "", appSecret: "" });
        void refreshStatus();
        return true;
      }
      return persistDraft(
        { ...draft, appId: "", appSecret: "" },
        `已创建并切换到新应用 ${appId}；当前设置已保存、旧凭证已清空`,
      );
    },
    [draft, loaded, patchDraft, persistDraft, refreshStatus],
  );

  if (!draft || !loaded) {
    return (
      <View style={{ flex: 1, backgroundColor: colors().surface0, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: colors().foregroundMuted }}>正在加载飞书机器人设置…</Text>
      </View>
    );
  }

  const consumer = status ? (CONSUMER_LABELS[status.consumerState] ?? { text: status.consumerState, tone: "muted" as const }) : null;
  const cardConsumer = status
    ? (CARD_CONSUMER_LABELS[status.cardConsumerState] ?? { text: status.cardConsumerState, tone: "muted" as const })
    : null;
  const addableChats = [
    ...chatCatalog
      .filter((chat) => !boundIds.has(chat.chatId))
      .map((chat) => ({ chatId: chat.chatId, label: chat.name || chat.chatId })),
    ...(status?.unmatched ?? [])
      .filter((chat) => !boundIds.has(chat.chatId))
      .map((chat) => ({
        chatId: chat.chatId,
        label: `${chat.chatType === "p2p" ? "单聊" : "会话"} ${chat.chatId}`,
        note: "最近有人给机器人发过消息",
      })),
  ];
  const selectedBinding = selection.kind === "binding"
    ? draft.chats.find((chat) => chat.chatId === selection.chatId) ?? null
    : null;

  const navRow = (key: string, title: string, subtitle: string | null, active: boolean, onPress: () => void, trailing?: React.ReactNode) => (
    <HoverPressable
      key={key}
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={({ hovered, pressed }) => ({
        backgroundColor: active || pressed || hovered ? colors().surface2 : colors().surface1,
        borderLeftWidth: 3,
        borderLeftColor: active ? colors().accent : "transparent",
        borderRadius: 8,
        paddingVertical: 10,
        paddingHorizontal: 12,
        gap: 2,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text numberOfLines={1} style={{ color: colors().foreground, fontSize: 13, fontWeight: "600", flexShrink: 1 }}>
          {title}
        </Text>
        <View style={{ flex: 1 }} />
        {trailing}
      </View>
      {subtitle !== null ? (
        <Text numberOfLines={1} style={{ color: colors().foregroundMuted, fontSize: 11 }}>
          {subtitle}
        </Text>
      ) : null}
    </HoverPressable>
  );

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
      <View style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ fontSize: 18, fontWeight: "700", color: colors().foreground, flex: 1 }}>飞书机器人</Text>
          <PrimaryButton label="刷新" onPress={() => void refreshStatus()} subtle />
        </View>
        {consumer ? <Pill text={consumer.text} tone={consumer.tone} /> : null}
        <Text style={{ fontSize: 12, color: colors().foregroundMuted }}>
          群里 @ 机器人（或单聊直发）即由绑定的 provider 处理；一个话题一个智能体会话。
        </Text>
      </View>
      {/* Saving stays reachable on the stacked list view too. */}
      {!wide && dirty ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8 }}>
          <Text style={{ color: colors().statusWarning, fontSize: 12, flex: 1 }}>有未保存的修改</Text>
          <PrimaryButton label="放弃" onPress={discard} subtle />
          <PrimaryButton label={saving ? "保存中…" : "保存"} onPress={() => void save()} disabled={!bindingsValid || saving} />
        </View>
      ) : null}
      <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 16, gap: 4 }}>
        <Text style={{ fontSize: 11, fontWeight: "700", color: colors().foregroundMuted, marginTop: 8, paddingHorizontal: 4 }}>
          会话绑定（{draft.chats.length}）
        </Text>
        {draft.chats.map((binding) => {
          const providerLabel = binding.provider.trim()
            ? findProvider(providers, binding.provider)?.label ?? binding.provider
            : "未选择 provider";
          return navRow(
            binding.chatId,
            binding.chatName || binding.chatId,
            providerLabel,
            selection.kind === "binding" && selection.chatId === binding.chatId,
            () => setSelection({ kind: "binding", chatId: binding.chatId }),
          );
        })}
        {navRow("add", "＋ 添加会话", "机器人可见的会话列表", selection.kind === "add", () => setSelection({ kind: "add" }))}

        <Text style={{ fontSize: 11, fontWeight: "700", color: colors().foregroundMuted, marginTop: 12, paddingHorizontal: 4 }}>
          设置
        </Text>
        {navRow(
          "status",
          "运行状态",
          consumer ? consumer.text + (status?.sessions.length ? ` · ${status.sessions.length} 个话题` : "") : "未知",
          selection.kind === "status",
          () => setSelection({ kind: "status" }),
          <View style={{
            width: 8, height: 8, borderRadius: 4,
            backgroundColor: consumer
              ? consumer.tone === "success" ? colors().statusSuccess
                : consumer.tone === "warning" ? colors().statusWarning
                  : consumer.tone === "danger" ? colors().statusDanger
                    : colors().foregroundMuted
              : colors().foregroundMuted,
          }} />,
        )}
        {navRow(
          "credentials",
          "应用凭证",
          draft.appId.trim() || status?.currentAppId || "未配置（沿用 lark-cli）",
          selection.kind === "credentials",
          () => setSelection({ kind: "credentials" }),
        )}
        {navRow("global", "全局设置", "路径、话题、回复选项", selection.kind === "global", () => setSelection({ kind: "global" }))}
      </ScrollView>
    </View>
  );

  const pageTitle =
    selection.kind === "binding" ? selectedBinding?.chatName || selectedBinding?.chatId || "会话绑定"
    : selection.kind === "add" ? "添加会话绑定"
    : selection.kind === "status" ? "运行状态"
    : selection.kind === "credentials" ? "飞书应用凭证"
    : selection.kind === "global" ? "全局设置"
    : "飞书机器人";

  const detailPane = (
    <View style={{ flex: 1, backgroundColor: colors().surface0 }}>
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
        {!wide ? (
          <HoverPressable
            accessibilityRole="button"
            accessibilityLabel="返回列表"
            onPress={() => setSelection({ kind: "none" })}
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
        <Text numberOfLines={1} style={{ color: colors().foreground, fontSize: 14, fontWeight: "700", flexShrink: 1 }}>
          {pageTitle}
        </Text>
        {!bindingsValid && selection.kind !== "none" ? <Pill text="有绑定未选 provider" tone="danger" /> : null}
        {dirty ? <Pill text="未保存" tone="warning" /> : null}
        <View style={{ flex: 1 }} />
        {dirty ? <PrimaryButton label="放弃" onPress={discard} subtle disabled={saving} /> : null}
        <PrimaryButton
          label={saving ? "保存中…" : "保存"}
          onPress={() => void save()}
          disabled={!dirty || !bindingsValid || revision === null || saving}
        />
      </View>

      {selection.kind === "binding" && selectedBinding ? (
        <BindingEditor
          key={selectedBinding.chatId}
          binding={selectedBinding}
          providers={providers}
          memberCatalog={memberCatalogs[selectedBinding.chatId]}
          allowedText={allowedDrafts[selectedBinding.chatId] ?? ""}
          onPatch={(patch) => patchBinding(selectedBinding.chatId, patch)}
          onSelectProvider={(provider) => selectProvider(selectedBinding.chatId, provider)}
          onSelectModel={(model) => selectModel(selectedBinding.chatId, model)}
          onRemove={() => removeBinding(selectedBinding.chatId)}
          onAllowedTextChange={(text) => setAllowedDrafts((current) => ({ ...current, [selectedBinding.chatId]: text }))}
          onAddAllowedFromText={() => addAllowedFromText(selectedBinding.chatId)}
          onAddAllowedUser={(user) => addAllowedUser(selectedBinding.chatId, user)}
          onRemoveAllowedUser={(openId) => removeAllowedUser(selectedBinding.chatId, openId)}
          onLoadMembers={() => { void loadMembers(selectedBinding.chatId); }}
        />
      ) : selection.kind === "add" ? (
        <AddChatPicker addable={addableChats} onPick={addBinding} />
      ) : selection.kind === "status" ? (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12, maxWidth: 880, width: "100%", alignSelf: "center" }}>
          <Card>
            <CardTitle text="运行状态" />
            <InfoRow label="事件监听" value={consumer ? consumer.text + (status?.lastError ? `（${status.lastError}）` : "") : "未知"} />
            <InfoRow
              label="问题卡片回调"
              value={
                cardConsumer
                  ? cardConsumer.text + (status?.cardLastError ? `（${status.cardLastError}）` : "")
                  : "未知"
              }
            />
            <InfoRow label="lark-cli" value={status?.cliPath ?? "未找到（请在全局设置填写路径）"} muted={!status?.cliPath} />
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
        </ScrollView>
      ) : selection.kind === "credentials" ? (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12, maxWidth: 880, width: "100%", alignSelf: "center" }}>
          <Card>
            <CardTitle
              text="扫码创建飞书应用（推荐）"
              hint="用飞书扫码自动创建一个 PersonalAgent 应用，默认带机器人能力、长连接事件订阅和常用权限"
            />
            <AppCreationSection
              currentAppId={status?.currentAppId ?? null}
              storedAppId={draft.appId}
              onCreated={applyScannedApp}
            />
          </Card>
          <Card>
            <CardTitle
              text="手动填写应用凭证"
              hint="已有应用时使用；留空沿用 lark-cli 已有配置，填写后保存即验证并写入 lark-cli（按本地使用场景明文保存，不加密）"
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
        </ScrollView>
      ) : selection.kind === "global" ? (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12, maxWidth: 880, width: "100%", alignSelf: "center" }}>
          <Card>
            <CardTitle text="全局设置" hint="对全部会话生效" />
            <FieldLabel text="lark-cli 路径（空 = 自动发现：PATH / nvm / Homebrew）" />
            <TextInput
              value={draft.larkCliPath}
              placeholder="留空自动发现"
              placeholderTextColor={colors().foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
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
              label="AI 生成会话标题"
              hint="新话题首次 @ 时用绑定的模型生成一句可读标题；失败或超时回退为清洗后的话题文本"
              value={draft.aiTitle}
              onChange={(value) => patchDraft({ aiTitle: value })}
            />
            <ToggleRow
              label="权限请求通知到群"
              hint="默认关闭；开启后普通权限请求会发到话题，仍需在 Paseo 客户端批准"
              value={draft.notifyPermission}
              onChange={(value) => patchDraft({ notifyPermission: value })}
            />
            <ToggleRow
              label="问题卡片发到话题"
              hint="dsh 的 ask_user_question 以交互卡片发到话题，点选项即可回答；需在飞书后台开启 card.action.trigger"
              value={draft.questionCards}
              onChange={(value) => patchDraft({ questionCards: value })}
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
        </ScrollView>
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 }}>
          <Text style={{ color: colors().foreground, fontSize: 15, fontWeight: "600" }}>
            {draft.chats.length === 0 ? "还没有会话绑定" : "选择一个会话绑定"}
          </Text>
          <Text style={{ color: colors().foregroundMuted, fontSize: 13, textAlign: "center" }}>
            {draft.chats.length === 0
              ? "点左侧「＋ 添加会话」把机器人所在的飞书群绑定到 provider；绑定后群里 @ 机器人即可使用。"
              : "从左侧选择会话编辑 provider、模型与权限，或在「设置」里查看运行状态。"}
          </Text>
        </View>
      )}
    </View>
  );

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
