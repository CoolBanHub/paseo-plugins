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
  NumberField,
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
  enabled: boolean;
  botOpenId: string | null;
  sessions: { chatId: string; topicKey: string; agentId: string | null; busy: boolean; queued: number }[];
  unmatched: { chatId: string; chatType: string; lastSeenAt: number }[];
  cron: {
    id: string;
    expression: string;
    prompt: string;
    enabled: boolean;
    nextRunAt: number | null;
    lastRunAt: number | null;
    lastError: string | null;
  }[];
  pendingQuestions: number;
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
  const [confirmingUnbind, setConfirmingUnbind] = useState(false);
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
              replyStyle: "default",
              replyStylePrompt: "",
              replyRewrite: "off",
              rewriteProvider: "",
              rewriteModel: "",
              replyFormat: "markdown",
              mentionOnReply: "off",
              allowAgentDelegation: false,
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
      setConfirmingUnbind(false);
      // Only SAVED credentials override lark-cli. If the draft was merely
      // cleared without saving, the old values still win and must be written.
      const savedOverrides = Boolean(loaded?.appId.trim() || loaded?.appSecret);
      const needsEnable = !draft.enabled;
      if (!savedOverrides && !needsEnable) {
        // Nothing saved overrides lark-cli; the server already restarted the
        // consumers. Drop any unsaved credential text so a later save cannot
        // accidentally switch back.
        if (draft.appId || draft.appSecret) patchDraft({ appId: "", appSecret: "" });
        void refreshStatus();
        return true;
      }
      return persistDraft(
        { ...draft, appId: "", appSecret: "", enabled: true },
        `已创建并切换到新应用 ${appId}；当前设置已保存、旧凭证已清空、监听已启用`,
      );
    },
    [draft, loaded, patchDraft, persistDraft, refreshStatus],
  );

  /** Keep lark-cli's app and its keychain secret, but drop the plaintext copy
   * the plugin may have saved. */
  const useCurrentApp = useCallback(() => {
    const appId = status?.currentAppId;
    if (!draft || !appId) return;
    setConfirmingUnbind(false);
    void persistDraft(
      { ...draft, appId: "", appSecret: "", enabled: true },
      `已改用 lark-cli 当前应用 ${appId}`,
    );
  }, [draft, persistDraft, status?.currentAppId]);

  /** Use the manually entered App ID/Secret and make sure listening resumes. */
  const useManualApp = useCallback(() => {
    if (!draft) return;
    if (!draft.appId.trim() || !draft.appSecret) {
      toast.error("请先填写 App ID 和 App Secret");
      return;
    }
    setConfirmingUnbind(false);
    void persistDraft({ ...draft, enabled: true }, "已保存应用凭证；服务端验证通过后会切换到该应用");
  }, [draft, persistDraft, toast]);

  /** Stop listening and clear plugin credentials; keep the Feishu app and
   * lark-cli's own configuration untouched. */
  const unbindBot = useCallback(() => {
    if (!draft) return;
    setConfirmingUnbind(false);
    void persistDraft(
      { ...draft, enabled: false, appId: "", appSecret: "" },
      "已解绑当前机器人；事件监听已停止，lark-cli 配置保持不变",
    );
  }, [draft, persistDraft]);

  const reenableBot = useCallback(() => {
    if (!draft) return;
    setConfirmingUnbind(false);
    void persistDraft({ ...draft, enabled: true }, "已重新启用事件监听");
  }, [draft, persistDraft]);

  if (!draft || !loaded) {
    return (
      <View style={{ flex: 1, backgroundColor: colors().surface0, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: colors().foregroundMuted }}>正在加载飞书机器人设置…</Text>
      </View>
    );
  }

  const consumer = status
    ? !status.enabled
      ? { text: "已停止 · 未启用", tone: "muted" as const }
      : (CONSUMER_LABELS[status.consumerState] ?? { text: status.consumerState, tone: "muted" as const })
    : null;
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
          !draft.enabled ? "已停止 · 未启用" : draft.appId.trim() || status?.currentAppId || "未配置（沿用 lark-cli）",
          selection.kind === "credentials",
          () => setSelection({ kind: "credentials" }),
        )}
        {navRow("global", "全局设置", "回复、通知、会话与限制", selection.kind === "global", () => setSelection({ kind: "global" }))}
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
            <CardTitle text="连接与身份" hint="插件与飞书、lark-cli 的连接状态" />
            <InfoRow
              label="事件监听"
              value={consumer ? consumer.text + (status?.enabled && status.lastError ? `（${status.lastError}）` : "") : "未知"}
            />
            <InfoRow
              label="问题卡片回调"
              value={
                cardConsumer
                  ? cardConsumer.text + (status?.enabled && status.cardLastError ? `（${status.cardLastError}）` : "")
                  : "未知"
              }
            />
            <InfoRow label="待答问题" value={String(status?.pendingQuestions ?? 0)} muted={(status?.pendingQuestions ?? 0) === 0} />
            <InfoRow label="lark-cli" value={status?.cliPath ?? "未找到（请在全局设置填写路径）"} muted={!status?.cliPath} />
            <InfoRow label="当前应用" value={status?.currentAppId ?? "未知"} />
            <InfoRow label="机器人身份" value={status?.botOpenId ?? "尚未读取"} />
          </Card>
          <Card>
            <CardTitle
              text={`话题会话（${(status?.sessions ?? []).length}）`}
              hint="群聊里一个话题一个智能体会话；显示当前映射的会话与排队情况"
            />
            {(status?.sessions ?? []).length === 0 ? (
              <Text style={{ color: colors().foregroundMuted, fontSize: 13 }}>暂无进行中的话题会话。</Text>
            ) : (
              (status?.sessions ?? []).map((session) => (
                <SessionRow key={session.topicKey} session={session} />
              ))
            )}
          </Card>
          <Card>
            <CardTitle
              text={`定时任务（${(status?.cron ?? []).length}）`}
              hint="在会话里用 /cron 管理，这里只读展示。每次运行使用新会话，结果发到绑定会话"
            />
            {(status?.cron ?? []).length === 0 ? (
              <Text style={{ color: colors().foregroundMuted, fontSize: 13 }}>
                暂无定时任务。可在会话里发送 /cron add 0 6 * * * 总结 GitHub trending。
              </Text>
            ) : (
              (status?.cron ?? []).map((job) => <CronJobRow key={job.id} job={job} />)
            )}
          </Card>
        </ScrollView>
      ) : selection.kind === "credentials" ? (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12, maxWidth: 880, width: "100%", alignSelf: "center" }}>
          <Card>
            <CardTitle
              text="使用已有应用"
              hint="已经在飞书开放平台创建过应用：沿用 lark-cli 当前配置，或手动填写 App ID / App Secret"
            />
            <InfoRow
              label="lark-cli 当前应用"
              value={status ? (status.currentAppId ?? "未配置") : "读取中…"}
              muted={!status?.currentAppId}
            />
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              <PrimaryButton
                label="使用 lark-cli 当前应用"
                onPress={useCurrentApp}
                disabled={!status?.currentAppId || saving}
              />
            </View>
            <Text style={{ fontSize: 12, color: colors().foregroundMuted }}>
              清空插件内保存的凭证，直接使用 lark-cli 钥匙串里的 App Secret；不会改动飞书应用。
            </Text>
            <View style={{ height: 1, backgroundColor: colors().border, marginVertical: 4 }} />
            <Text style={{ fontSize: 12, color: colors().foregroundMuted }}>
              如果这个应用还没配置到 lark-cli，填写下面两项。App Secret 在飞书开发者后台「凭证与基础信息」里。
            </Text>
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
              <InfoRow
                label="当前生效"
                value={
                  status.currentAppId +
                  (draft.appId.trim() && draft.appId.trim() !== status.currentAppId ? "（保存后切换）" : "")
                }
              />
            ) : null}
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              <PrimaryButton
                label={draft.enabled ? "保存并使用这个应用" : "保存、启用并使用这个应用"}
                onPress={useManualApp}
                disabled={!draft.appId.trim() || !draft.appSecret || saving}
              />
            </View>
            {!draft.enabled ? (
              <Text style={{ fontSize: 12, color: colors().statusWarning }}>
                当前事件监听已停止；点上面的按钮会同时启用。
              </Text>
            ) : null}
            <Text style={{ fontSize: 12, color: colors().foregroundMuted }}>
              已有配置的 Secret 存在系统钥匙串里、无法回显；要从界面管理凭证，请到飞书开发者后台（凭证与基础信息）复制 App Secret 填入并保存。按当前本地使用场景，这份值会明文保存在 Paseo 设置中并明文显示；请确保本机账户与备份安全。
            </Text>
          </Card>
          <Card>
            <CardTitle
              text="创建新应用（扫码）"
              hint="没有可用的已有应用时，用飞书扫码创建一个新的 PersonalAgent 应用；会替换 lark-cli 默认应用配置"
            />
            <AppCreationSection
              currentAppId={status?.currentAppId ?? null}
              storedAppId={draft.appId}
              onCreated={applyScannedApp}
            />
          </Card>
          <Card>
            <CardTitle
              text="解绑当前机器人"
              hint="停止接收新消息并清空插件内保存的凭证；不会删除飞书应用，也不会改动 lark-cli 配置。已开始的轮次可能仍会完成并回复"
            />
            {!draft.enabled ? (
              <>
                <Text style={{ fontSize: 12, color: colors().foregroundMuted }}>
                  当前已停止监听。飞书应用和 lark-cli 配置都还在，可随时重新启用。
                </Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <PrimaryButton label="重新启用事件监听" onPress={reenableBot} disabled={saving} />
                </View>
              </>
            ) : confirmingUnbind ? (
              <>
                <Text style={{ fontSize: 12, color: colors().statusWarning }}>
                  确定解绑？将停止事件监听，并清空插件内保存的 App ID / Secret。飞书应用和 lark-cli 配置不受影响。
                </Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <PrimaryButton label="确认解绑" danger onPress={unbindBot} disabled={saving} />
                  <PrimaryButton label="取消" subtle onPress={() => setConfirmingUnbind(false)} />
                </View>
              </>
            ) : (
              <View style={{ flexDirection: "row", gap: 8 }}>
                <PrimaryButton
                  label="解绑并停止监听"
                  danger
                  onPress={() => setConfirmingUnbind(true)}
                  disabled={saving}
                />
              </View>
            )}
          </Card>
        </ScrollView>
      ) : selection.kind === "global" ? (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12, maxWidth: 880, width: "100%", alignSelf: "center" }}>
          <Card>
            <CardTitle text="监听与运行" hint="插件如何接收飞书消息、调用本机 lark-cli" />
            <ToggleRow
              label="启用事件监听"
              hint="关闭后停止接收飞书消息，保留应用、凭证与群绑定；重新开启即恢复"
              value={draft.enabled}
              onChange={(value) => patchDraft({ enabled: value })}
            />
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
          </Card>
          <Card>
            <CardTitle text="回复与话题" hint="回答发到哪里、超长时如何处理" />
            <ToggleRow
              label="回复进话题"
              hint="回复挂在被 @ 消息的话题下，而不是群消息流"
              value={draft.replyInThread}
              onChange={(value) => patchDraft({ replyInThread: value })}
            />
            <ToggleRow
              label="长回复分段发送"
              hint="超过截断长度时按代码块安全地拆成多条话题回复，而不是直接截断"
              value={draft.replySplit}
              onChange={(value) => patchDraft({ replySplit: value })}
            />
            <NumberField
              label="单条回复长度"
              hint="超过该字符数后分段（关闭分段时截断）"
              value={draft.maxReplyChars}
              onChange={(value) => patchDraft({ maxReplyChars: value })}
              suffix="字符"
            />
            <NumberField
              label="每条回复最多分几段"
              hint="超出部分截断并提示去 Paseo 查看"
              value={draft.maxReplyChunks}
              onChange={(value) => patchDraft({ maxReplyChunks: value })}
              suffix="段"
            />
            <ToggleRow
              label="回复页脚"
              hint="在回答末尾追加模型、耗时和 token 用量"
              value={draft.replyFooter}
              onChange={(value) => patchDraft({ replyFooter: value })}
            />
          </Card>
          <Card>
            <CardTitle text="回执与通知" hint="处理过程中的可见性与提醒，只影响过程提示，不影响答案内容" />
            <ToggleRow
              label="表情回执"
              hint="收到 @ 后在被 @ 的消息上加「处理中」表情，完成后换成完成表情；不额外发消息"
              value={draft.ackReaction}
              onChange={(value) => patchDraft({ ackReaction: value })}
            />
            <ToggleRow
              label="文字确认"
              hint="额外回复一条「收到，正在处理」；默认关闭，群聊里会显得吵"
              value={draft.ackOnReceive}
              onChange={(value) => patchDraft({ ackOnReceive: value })}
            />
            <ToggleRow
              label="处理进度卡片"
              hint="处理中原地更新一张卡片（用时、排队、当前工具）；需要机器人能发交互卡片"
              value={draft.progressCard}
              onChange={(value) => patchDraft({ progressCard: value })}
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
            <ToggleRow
              label="提示未配置会话"
              hint="未绑定的会话 @ 机器人时回复一条配置提示"
              value={draft.notifyUnmatched}
              onChange={(value) => patchDraft({ notifyUnmatched: value })}
            />
          </Card>
          <Card>
            <CardTitle text="会话与工作区" hint="智能体会话如何创建、命名与归属" />
            <ToggleRow
              label="AI 生成会话标题"
              hint="新话题首次 @ 时用绑定的模型生成一句可读标题；失败或超时回退为清洗后的话题文本"
              value={draft.aiTitle}
              onChange={(value) => patchDraft({ aiTitle: value })}
            />
            <NumberField
              label="话题空闲重建"
              hint="0 = 一直复用；空闲超过该时长的话题，下次 @ 时新建智能体会话"
              value={draft.sessionIdleMinutes}
              onChange={(value) => patchDraft({ sessionIdleMinutes: value })}
              suffix="分钟"
            />
            <ToggleRow
              label="按会话划分 workspace"
              hint="每个会话一个以群名命名的 workspace，适合不同绑定指向不同项目目录；默认全部放进「飞书任务」"
              value={draft.workspacePerBinding}
              onChange={(value) => patchDraft({ workspacePerBinding: value })}
            />
          </Card>
          <Card>
            <CardTitle text="安全与限制" hint="谁能用、能用多少、能发什么文件" />
            <NumberField
              label="每人每小时请求上限"
              hint="0 = 不限；按发送者计，命令不占额度"
              value={draft.rateLimitPerHour}
              onChange={(value) => patchDraft({ rateLimitPerHour: value })}
              suffix="次/时"
            />
            <ToggleRow
              label="回传生成的附件"
              hint="允许智能体通过 lark-bot-send 把图片/文件发回话题（路径限定在工作目录或临时目录）"
              value={draft.attachmentSend}
              onChange={(value) => patchDraft({ attachmentSend: value })}
            />
            <NumberField
              label="附件大小上限"
              hint="出站附件的单文件上限；入站文件另有 20MB 限制"
              value={draft.attachmentMaxMb}
              onChange={(value) => patchDraft({ attachmentMaxMb: value })}
              suffix="MB"
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

/** One live topic session on the status page: topic key + state pills. */
function SessionRow({ session }: { session: StatusState["sessions"][number] }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text
        numberOfLines={1}
        style={{ color: colors().foreground, fontSize: 13, flex: 1, flexShrink: 1 }}
      >
        话题 …{session.topicKey.slice(-12)}
      </Text>
      {session.busy ? <Pill text="处理中" tone="warning" /> : <Pill text="空闲" tone="muted" />}
      {session.queued > 0 ? <Pill text={`排队 ${session.queued}`} tone="warning" /> : null}
    </View>
  );
}

/** One cron job on the status page: expression + state on the first line,
 * prompt and schedule below, last error in danger color if present. */
function CronJobRow({ job }: { job: StatusState["cron"][number] }) {
  return (
    <View style={{ gap: 3 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: colors().foreground, fontSize: 13, fontWeight: "600" }}>{job.expression}</Text>
        <Pill text={job.enabled ? "启用" : "暂停"} tone={job.enabled ? "success" : "muted"} />
        <View style={{ flex: 1 }} />
        <Text style={{ color: colors().foregroundMuted, fontSize: 11 }}>{job.id}</Text>
      </View>
      <Text numberOfLines={1} style={{ color: colors().foregroundMuted, fontSize: 12 }}>
        {job.prompt}
      </Text>
      <Text style={{ color: colors().foregroundMuted, fontSize: 11 }}>
        下次 {job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "—"}
        {job.lastRunAt ? ` · 上次 ${new Date(job.lastRunAt).toLocaleString()}` : ""}
      </Text>
      {job.lastError ? (
        <Text numberOfLines={1} style={{ color: colors().statusDanger, fontSize: 11 }}>
          上次失败：{job.lastError}
        </Text>
      ) : null}
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
      replyStylePrompt: chat.replyStylePrompt.trim(),
      rewriteProvider: chat.rewriteProvider.trim(),
      rewriteModel: chat.rewriteModel.trim(),
    })),
  };
}
