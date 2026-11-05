import { useCallback, useEffect, useRef, useState } from "react";
import { Text } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  type SettingsInputHandle,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { larkBotChatsRpc, larkBotProvidersRpc, larkBotStatusRpc } from "../shared/contracts.ts";
import {
  botValuesSchema,
  larkBotSettingsRpc,
  type BotValues,
  type ChatBinding,
  type ReplyFormat,
} from "../shared/settings.ts";

interface StatusState {
  consumerState: string;
  lastError: string | null;
  cliPath: string | null;
  botOpenId: string | null;
  sessions: { chatId: string; topicKey: string; agentId: string | null; busy: boolean; queued: number }[];
  unmatched: { chatId: string; chatType: string; lastSeenAt: number }[];
}

const CONSUMER_LABELS: Record<string, string> = {
  stopped: "未运行（没有已绑定的会话）",
  starting: "连接中…",
  ready: "已连接，正在监听消息",
  retrying: "连接断开，自动重试中…",
};

const REPLY_FORMAT_OPTIONS: { label: string; value: ReplyFormat }[] = [
  { label: "Markdown（排版最佳）", value: "markdown" },
  { label: "纯文本（保留原样）", value: "text" },
  { label: "富文本 post（支持 @ 其他机器人）", value: "post" },
];

/**
 * Host-level settings for the Feishu bot: global options plus the
 * chat → provider bindings. Saving takes effect immediately — the event
 * consumer restarts whenever the binding list changes.
 */
export function BotSettingsScreen(_props: PluginSurfaceProps) {
  const toast = useToast();
  const readRpc = useRpc(larkBotSettingsRpc.read);
  const writeRpc = useRpc(larkBotSettingsRpc.write);
  const chatsRpc = useRpc(larkBotChatsRpc);
  const providersRpc = useRpc(larkBotProvidersRpc);
  const statusRpc = useRpc(larkBotStatusRpc);

  const cliInputRef = useRef<SettingsInputHandle | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<BotValues | null>(null);
  const [draft, setDraft] = useState<BotValues | null>(null);
  const [saving, setSaving] = useState(false);
  const [chatCatalog, setChatCatalog] = useState<{ chatId: string; name: string }[]>([]);
  const [providerOptions, setProviderOptions] = useState<{ label: string; value: string }[]>([]);
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
          cliInputRef.current?.replaceText(parsed.data.larkCliPath);
        } else {
          toast.error(`已保存的设置无效，已按默认值处理：${parsed.error.issues[0]?.message ?? ""}`);
        }
      } else if (result.status === "invalid") {
        setRevision(result.revision);
        toast.error(`已保存的设置无效：${result.error}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [readRpc, toast]);

  const refreshAux = useCallback(async () => {
    try {
      const [chats, providers, current] = await Promise.all([
        chatsRpc({}),
        providersRpc({}),
        statusRpc({}),
      ]);
      setChatCatalog(chats.chats);
      setProviderOptions(providers.providers.map((provider) => ({ label: provider.label, value: provider.id })));
      setStatus(current);
      if (chats.error) toast.error(`拉取群列表失败：${chats.error}`);
      if (providers.error) toast.error(`拉取 provider 失败：${providers.error}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [chatsRpc, providersRpc, statusRpc, toast]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    void refreshAux();
  }, [refreshAux]);

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

  const boundIds = new Set(draft?.chats.map((chat) => chat.chatId) ?? []);
  const boundNames = new Map(draft?.chats.map((chat) => [chat.chatId, chat.chatName]) ?? []);
  const addableChats = [
    ...chatCatalog
      .filter((chat) => !boundIds.has(chat.chatId))
      .map((chat) => ({ label: chat.name || chat.chatId, value: chat.chatId })),
    ...(status?.unmatched ?? [])
      .filter((chat) => !boundIds.has(chat.chatId))
      .map((chat) => ({
        label: `${chat.chatType === "p2p" ? "单聊" : "会话"} ${chat.chatId}（最近发过消息）`,
        value: chat.chatId,
      })),
  ];

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
              provider: providerOptions[0]?.value ?? "",
              cwd: "",
              systemPrompt: "",
              replyFormat: "markdown",
            },
          ],
        };
      });
    },
    [chatCatalog, providerOptions],
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
        void refreshAux();
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
  }, [draft, reload, refreshAux, revision, saving, toast, writeRpc]);

  if (!draft) {
    return (
      <SettingsSection title="飞书机器人">
        <SettingsAction label="设置" actionLabel="重新加载" onPress={() => void reload()} />
      </SettingsSection>
    );
  }

  const consumerLabel = status ? (CONSUMER_LABELS[status.consumerState] ?? status.consumerState) : "未知";

  return (
    <>
      <SettingsSection title="运行状态" info="绑定列表为空时事件监听不会启动">
        <SettingsRow label="监听状态">
          <Text>
            {consumerLabel}
            {status?.lastError ? `（${status.lastError}）` : ""}
          </Text>
        </SettingsRow>
        <SettingsRow label="lark-cli">
          <Text>{status?.cliPath ?? "未找到（请填写路径或安装 lark-cli）"}</Text>
        </SettingsRow>
        {(status?.sessions ?? []).map((session) => (
          <SettingsRow
            key={session.topicKey}
            label={`${boundNames.get(session.chatId) || session.chatId} · 话题 ${session.topicKey.slice(-8)}`}
          >
            <Text>
              {session.busy ? "处理中" : "空闲"}
              {session.queued > 0 ? ` · 排队 ${session.queued} 条` : ""}
            </Text>
          </SettingsRow>
        ))}
        <SettingsAction label="刷新状态" actionLabel="刷新" onPress={() => void refreshAux()} />
      </SettingsSection>

      <SettingsSection title="全局设置" info="对全部会话生效">
        <SettingsInput
          ref={cliInputRef}
          label="lark-cli 路径"
          placeholder="留空自动发现（PATH / nvm / Homebrew）"
          onChangeText={(text) => patchDraft({ larkCliPath: text })}
        />
        <SettingsSwitch
          label="回复进话题"
          hint="回复挂在被 @ 消息的话题下，而不是群消息流"
          value={draft.replyInThread}
          onValueChange={(value) => patchDraft({ replyInThread: value })}
        />
        <SettingsInput
          label="会话空闲重建（分钟）"
          placeholder="30"
          initialValue={String(draft.sessionIdleMinutes)}
          onChangeText={(text) => {
            const minutes = Number.parseInt(text, 10);
            if (Number.isFinite(minutes)) patchDraft({ sessionIdleMinutes: minutes });
          }}
        />
        <SettingsSwitch
          label="提示未配置会话"
          hint="未绑定的会话 @ 机器人时回复一条配置提示"
          value={draft.notifyUnmatched}
          onValueChange={(value) => patchDraft({ notifyUnmatched: value })}
        />
      </SettingsSection>

      <SettingsSection
        title="会话绑定"
        info="每个飞书会话（群或单聊）用哪个 provider 处理 @ 机器人的消息；单聊直接发消息即可触发"
      >
        {draft.chats.map((chat) => (
          <SettingsCard key={chat.chatId}>
            <SettingsRow label={chat.chatName || "未命名会话"} hint={chat.chatId} />
            <SettingsSelect
              label="Provider"
              value={chat.provider}
              options={
                providerOptions.length > 0
                  ? providerOptions
                  : [{ label: chat.provider || "（刷新状态拉取 provider 列表）", value: chat.provider }]
              }
              onValueChange={(value) => patchBinding(chat.chatId, { provider: value })}
            />
            <SettingsInput
              label="工作目录"
              placeholder="默认用户主目录"
              initialValue={chat.cwd}
              onChangeText={(text) => patchBinding(chat.chatId, { cwd: text })}
            />
            <SettingsSelect
              label="回复格式"
              value={chat.replyFormat}
              options={REPLY_FORMAT_OPTIONS}
              onValueChange={(value: ReplyFormat) => patchBinding(chat.chatId, { replyFormat: value })}
            />
            <SettingsAction label="移除该绑定" actionLabel="移除" onPress={() => removeBinding(chat.chatId)} />
          </SettingsCard>
        ))}
        <SettingsSelect
          label="添加会话"
          value=""
          hint={addableChats.length === 0 ? "没有可选会话：先把机器人拉进群，或等收到消息后刷新" : undefined}
          options={[{ label: "选择要添加的会话…", value: "" }, ...addableChats]}
          onValueChange={(value) => addBinding(value)}
        />
      </SettingsSection>

      <SettingsSection title="保存">
        <SettingsAction
          label={dirty ? "有未保存的修改" : "无修改"}
          actionLabel={saving ? "保存中…" : "保存"}
          onPress={() => void save()}
          disabled={!dirty || !bindingsValid || revision === null || saving}
        />
      </SettingsSection>
    </>
  );
}

/** Trim strings so cosmetic edits do not mark the form dirty. */
function normalize(values: BotValues): BotValues {
  return {
    ...values,
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
