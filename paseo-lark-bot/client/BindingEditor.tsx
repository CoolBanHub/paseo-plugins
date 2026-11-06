import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { LarkBotChatMember, LarkBotProviderInfo } from "../shared/contracts.ts";
import type { ChatBinding, ReplyFormat } from "../shared/settings.ts";
import {
  Card,
  CardTitle,
  ChoicePill,
  FieldLabel,
  PrimaryButton,
  colors,
  inputStyle,
} from "./widgets.tsx";

/**
 * The right-hand pane for one chat binding: provider/model/thinking/permission
 * pickers, the @-allowlist, and per-chat options. All edits go through the
 * parent's draft; nothing saves until the pane's save action.
 */

export const REPLY_FORMATS: { value: ReplyFormat; label: string }[] = [
  { value: "markdown", label: "Markdown" },
  { value: "text", label: "纯文本" },
  { value: "post", label: "富文本@" },
];

export interface MemberCatalogState {
  loading: boolean;
  members: LarkBotChatMember[];
  error: string | null;
}

/** Provider ids can be `provider/model`; the picker lists the bare id. */
export function findProvider(providers: LarkBotProviderInfo[], providerId: string): LarkBotProviderInfo | undefined {
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

export function BindingEditor({
  binding, providers, memberCatalog, allowedText,
  onPatch, onSelectProvider, onSelectModel, onRemove,
  onAllowedTextChange, onAddAllowedFromText, onAddAllowedUser, onRemoveAllowedUser, onLoadMembers,
}: {
  binding: ChatBinding;
  providers: LarkBotProviderInfo[];
  memberCatalog: MemberCatalogState | undefined;
  /** Free-text open_id entry; owned by the parent so it survives pane switches. */
  allowedText: string;
  onPatch(patch: Partial<ChatBinding>): void;
  onSelectProvider(provider: string): void;
  onSelectModel(model: string): void;
  onRemove(): void;
  onAllowedTextChange(text: string): void;
  onAddAllowedFromText(): void;
  onAddAllowedUser(user: LarkBotChatMember): void;
  onRemoveAllowedUser(openId: string): void;
  onLoadMembers(): void;
}) {
  const provider = findProvider(providers, binding.provider);
  const effectiveModel = findModel(provider, binding.model);
  const thinkingOptions = effectiveModel?.thinkingOptions ?? [];
  const selectedMemberIds = new Set(binding.allowedUsers.map((user) => user.openId));
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
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12, maxWidth: 880, width: "100%", alignSelf: "center" }}>
      <Card>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ flex: 1, flexShrink: 1 }}>
            <Text numberOfLines={1} style={{ fontWeight: "700", fontSize: 15, color: colors().foreground }}>
              {binding.chatName || "未命名会话"}
            </Text>
            <Text numberOfLines={1} style={{ color: colors().foregroundMuted, fontSize: 11, marginTop: 1 }}>
              {binding.chatId}
            </Text>
          </View>
          <Pressable onPress={onRemove} hitSlop={6}>
            <Text style={{ color: colors().statusDanger, fontSize: 13 }}>移除绑定</Text>
          </Pressable>
        </View>
      </Card>

      <Card>
        <CardTitle text="Provider 与模型" hint="群里 @ 机器人（或单聊直发）即由这里选的 provider 处理" />
        <FieldLabel text="Provider" />
        {providers.length > 0 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {providers.map((candidate) => (
              <ChoicePill
                key={candidate.id}
                label={candidate.label}
                active={provider?.id === candidate.id}
                onPress={() => onSelectProvider(candidate.id)}
              />
            ))}
          </View>
        ) : (
          <Text style={{ color: colors().foregroundMuted, fontSize: 13 }}>
            未获取到 provider 列表，请回到列表页点「刷新」。
          </Text>
        )}

        <FieldLabel text="模型（留空 = provider 默认模型）" />
        {(provider?.models.length ?? 0) > 0 || unknownModel ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <ChoicePill label="默认" active={!binding.model} onPress={() => onSelectModel("")} />
            {(provider?.models ?? []).map((model) => (
              <ChoicePill
                key={model.id}
                label={model.label + (model.isDefault ? "（默认）" : "")}
                active={binding.model === model.id}
                onPress={() => onSelectModel(model.id)}
              />
            ))}
            {unknownModel ? (
              <ChoicePill label={`${unknownModel}（未在列表）`} active onPress={() => onSelectModel("")} />
            ) : null}
          </View>
        ) : (
          <Text style={{ color: colors().foregroundMuted, fontSize: 13 }}>
            未获取到模型列表，留空使用 provider 默认模型。
          </Text>
        )}
      </Card>

      <Card>
        <CardTitle text="思考与权限" hint="两者都留空时用 provider / 模型默认" />
        <FieldLabel text="思考深度（dsh 留空 = 最深）" />
        {thinkingOptions.length > 0 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <ChoicePill
              label={thinkingDefaultLabel}
              active={!binding.thinkingOptionId}
              onPress={() => onPatch({ thinkingOptionId: "" })}
            />
            {thinkingOptions.map((option) => (
              <ChoicePill
                key={option.id}
                label={option.label}
                active={binding.thinkingOptionId === option.id}
                onPress={() => onPatch({ thinkingOptionId: option.id })}
              />
            ))}
            {unknownThinking ? (
              <ChoicePill
                label={`${unknownThinking}（未在列表）`}
                active
                onPress={() => onPatch({ thinkingOptionId: "" })}
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

        <FieldLabel text="权限" />
        {(provider?.permissionOptions.length ?? 0) > 0 || unknownPermission ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <ChoicePill label="默认" active={!binding.permission} onPress={() => onPatch({ permission: "" })} />
            {(provider?.permissionOptions ?? []).map((option) => (
              <ChoicePill
                key={option.value}
                label={option.label}
                active={binding.permission === option.value}
                onPress={() => onPatch({ permission: option.value })}
              />
            ))}
            {unknownPermission ? (
              <ChoicePill
                label={`${unknownPermission}（未在列表）`}
                active
                onPress={() => onPatch({ permission: "" })}
              />
            ) : null}
          </View>
        ) : null}
        <Text style={{ color: colors().foregroundMuted, fontSize: 12 }}>{permissionHint}</Text>
      </Card>

      <Card>
        <CardTitle text="允许 @ 的成员" hint="留空 = 所有人可触发；非指定成员 @ 时只提示、不触发，其未 @ 的发言仍会进入话题上下文" />
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
                onPress={() => onRemoveAllowedUser(user.openId)}
              />
            ))}
          </View>
        )}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <TextInput
            value={allowedText}
            placeholder="ou_xxx，多个用逗号分隔"
            placeholderTextColor={colors().foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={onAddAllowedFromText}
            onChangeText={onAllowedTextChange}
            style={inputStyle({ flex: 1 })}
          />
          <PrimaryButton label="添加" onPress={onAddAllowedFromText} subtle />
          <PrimaryButton
            label={memberCatalog?.loading ? "读取中…" : "读取群成员"}
            onPress={onLoadMembers}
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
                onPress={() => onAddAllowedUser(member)}
              />
            ))}
          </View>
        ) : null}
        <Text style={{ color: colors().foregroundMuted, fontSize: 12 }}>
          读取成员需要飞书权限 im:chat.members:read。
        </Text>
      </Card>

      <Card>
        <CardTitle text="会话设置" />
        <FieldLabel text="工作目录（空 = 用户主目录；支持 ~/ 开头）" />
        <TextInput
          value={binding.cwd}
          placeholder="~/Workspace/project"
          placeholderTextColor={colors().foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={(text) => onPatch({ cwd: text })}
          style={inputStyle()}
        />
        <FieldLabel text="系统提示（可选，追加在该会话的指令前）" />
        <TextInput
          value={binding.systemPrompt}
          placeholder="例：你是项目维护助手，用中文回答"
          placeholderTextColor={colors().foregroundMuted}
          multiline
          onChangeText={(text) => onPatch({ systemPrompt: text })}
          style={inputStyle({ minHeight: 64, textAlignVertical: "top" })}
        />
        <FieldLabel text="回复格式（富文本@ 可在回复里 @ 其他机器人接力）" />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {REPLY_FORMATS.map((format) => (
            <ChoicePill
              key={format.value}
              label={format.label}
              active={binding.replyFormat === format.value}
              onPress={() => onPatch({ replyFormat: format.value })}
            />
          ))}
        </View>
      </Card>
    </ScrollView>
  );
}

/** The pane for adding a binding: one row per chat the bot can see. */
export function AddChatPicker({
  addable,
  onPick,
}: {
  addable: { chatId: string; label: string; note?: string }[];
  onPick(chatId: string): void;
}) {
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 8, maxWidth: 880, width: "100%", alignSelf: "center" }}>
      <CardTitle text="添加会话绑定" hint="来自机器人可见的会话列表；点一下即加入并进入编辑" />
      {addable.length === 0 ? (
        <Text style={{ color: colors().foregroundMuted, fontSize: 13, marginTop: 4 }}>
          没有可选会话：先把机器人拉进飞书群，或等有人给机器人发过消息后回到列表页点「刷新」。
        </Text>
      ) : (
        addable.map((chat) => (
          <Pressable
            key={chat.chatId}
            onPress={() => onPick(chat.chatId)}
            style={({ pressed }) => ({
              borderWidth: 1,
              borderColor: colors().border,
              borderRadius: 10,
              padding: 12,
              gap: 4,
              backgroundColor: pressed ? colors().surface2 : colors().surface1,
            })}
          >
            <Text style={{ color: colors().foreground, fontSize: 13, fontWeight: "600" }}>+ {chat.label}</Text>
            {chat.note ? (
              <Text style={{ color: colors().foregroundMuted, fontSize: 12 }}>{chat.note}</Text>
            ) : null}
          </Pressable>
        ))
      )}
    </ScrollView>
  );
}
