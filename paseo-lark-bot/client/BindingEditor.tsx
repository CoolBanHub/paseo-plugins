import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { LarkBotChatMember, LarkBotProviderInfo } from "../shared/contracts.ts";
import {
  MENTION_ON_REPLY_OPTIONS,
  REPLY_REWRITE_OPTIONS,
  REPLY_STYLE_OPTIONS,
  type ChatBinding,
  type ReplyFormat,
} from "../shared/settings.ts";
import {
  Card,
  CardTitle,
  ChoicePill,
  Divider,
  FieldLabel,
  PrimaryButton,
  SelectRow,
  ToggleRow,
  colors,
  inputStyle,
} from "./widgets.tsx";

/**
 * The right-hand pane for one chat binding. Every choice field is a collapsed
 * SelectRow (label left, current value right) that expands in place to its
 * pill picker and hint, so the page reads as a short settings list instead of
 * a wall of pills. Cards: agent (identity + provider/model/thinking/permission),
 * runtime (cwd/system prompt/delegation), reply presentation (style/rewrite/
 * format/mention), and the @-allowlist. All edits go through the parent's
 * draft; nothing saves until the pane's save action.
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
  /** Which choice row is expanded; one at a time keeps the page tidy. */
  const [openField, setOpenField] = useState<string | null>(binding.provider ? null : "provider");
  const toggleField = (field: string) => setOpenField((current) => (current === field ? null : field));

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
  const rewriteProviderInfo = binding.rewriteProvider
    ? providers.find((candidate) => candidate.id === binding.rewriteProvider)
    : undefined;
  const unknownRewriteProvider =
    binding.rewriteProvider && !rewriteProviderInfo ? binding.rewriteProvider : null;
  const unknownRewriteModel =
    binding.rewriteModel && !rewriteProviderInfo?.models.some((model) => model.id === binding.rewriteModel)
      ? binding.rewriteModel
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

  // Collapsed-row summaries; unknown ids surface in warning tone so they are
  // visible without expanding the picker.
  const providerTone: "default" | "warning" = provider ? "default" : "warning";
  const providerValue = provider?.label ?? binding.provider ?? "未选择 provider";
  const defaultModel = provider?.models.find((model) => model.isDefault);
  const selectedModel = binding.model ? provider?.models.find((model) => model.id === binding.model) : undefined;
  const modelTone: "default" | "warning" = binding.model && !selectedModel ? "warning" : "default";
  const modelValue = binding.model
    ? selectedModel?.label ?? `${binding.model}（未在列表）`
    : defaultModel
      ? `默认（${defaultModel.label}）`
      : "默认";
  const thinkingTone: "default" | "warning" = unknownThinking ? "warning" : "default";
  const thinkingValue = binding.thinkingOptionId
    ? thinkingOptions.find((option) => option.id === binding.thinkingOptionId)?.label ?? `${unknownThinking}（未在列表）`
    : thinkingDefaultLabel;
  const styleValue = REPLY_STYLE_OPTIONS.find((style) => style.value === binding.replyStyle)?.label ?? binding.replyStyle;
  const rewriteValue = REPLY_REWRITE_OPTIONS.find((option) => option.value === binding.replyRewrite)?.label ?? binding.replyRewrite;
  const rewriteModelTone: "default" | "warning" = unknownRewriteProvider || unknownRewriteModel ? "warning" : "default";
  const rewriteModelValue = !binding.rewriteProvider
    ? "跟随当前绑定"
    : `${rewriteProviderInfo?.label ?? binding.rewriteProvider} · ${
        binding.rewriteModel
          ? rewriteProviderInfo?.models.find((model) => model.id === binding.rewriteModel)?.label ?? `${unknownRewriteModel}（未在列表）`
          : "默认模型"
      }`;
  const formatValue = REPLY_FORMATS.find((format) => format.value === binding.replyFormat)?.label ?? binding.replyFormat;
  const mentionValue = MENTION_ON_REPLY_OPTIONS.find((option) => option.value === binding.mentionOnReply)?.label ?? binding.mentionOnReply;

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
        <Divider />

        <SelectRow
          label="Provider"
          value={providerValue}
          tone={providerTone}
          expanded={openField === "provider"}
          onPress={() => toggleField("provider")}
        >
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
        </SelectRow>

        <SelectRow
          label="模型"
          value={modelValue}
          tone={modelTone}
          expanded={openField === "model"}
          onPress={() => toggleField("model")}
        >
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
          <Text style={{ fontSize: 12, color: colors().foregroundMuted }}>留空 = provider 默认模型；切换 provider 会清空模型、思考与权限。</Text>
        </SelectRow>

        <SelectRow
          label="思考深度"
          value={thinkingValue}
          tone={thinkingTone}
          expanded={openField === "thinking"}
          onPress={() => toggleField("thinking")}
        >
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
        </SelectRow>

        <SelectRow
          label="权限"
          value={permissionLabel(provider, binding.permission)}
          tone={unknownPermission ? "warning" : "default"}
          expanded={openField === "permission"}
          onPress={() => toggleField("permission")}
        >
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
        </SelectRow>
      </Card>

      <Card>
        <CardTitle text="运行环境" hint="智能体在哪运行、以什么身份运行" />
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
        <FieldLabel text="系统提示（可选，替换插件默认提示；留空用默认）" />
        <TextInput
          value={binding.systemPrompt}
          placeholder="例：你是项目维护助手，用中文回答"
          placeholderTextColor={colors().foregroundMuted}
          multiline
          onChangeText={(text) => onPatch({ systemPrompt: text })}
          style={inputStyle({ minHeight: 64, textAlignVertical: "top" })}
        />
        <ToggleRow
          label="允许 /delegate 调用其他 Paseo Agent"
          hint="白名单成员可把任务转给本机其他 agent；目标 agent 的权限和目录由它自己决定，请只开给可信群"
          value={binding.allowAgentDelegation}
          onChange={(value) => onPatch({ allowAgentDelegation: value })}
        />
      </Card>

      <Card>
        <CardTitle text="回复呈现" hint="回答的风格、长度、格式与完成提醒；点一行展开选择" />
        <SelectRow
          label="回复风格"
          value={styleValue}
          expanded={openField === "style"}
          onPress={() => toggleField("style")}
        >
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {REPLY_STYLE_OPTIONS.map((style) => (
              <ChoicePill
                key={style.value}
                label={style.label}
                active={binding.replyStyle === style.value}
                onPress={() => onPatch({ replyStyle: style.value })}
              />
            ))}
          </View>
          <Text style={{ fontSize: 12, color: colors().foregroundMuted }}>
            {REPLY_STYLE_OPTIONS.find((style) => style.value === binding.replyStyle)?.hint ?? ""}
          </Text>
          <Text style={{ fontSize: 11, color: colors().foregroundMuted }}>
            风格是提示词，模型可能不完全遵守；保存后对新建会话生效，已有话题可发 /new 重建。硬性长度限制可在全局设置里调小「单条回复长度」。
          </Text>
        </SelectRow>
        {binding.replyStyle === "custom" ? (
          <>
            <FieldLabel text="自定义回复要求" />
            <TextInput
              value={binding.replyStylePrompt}
              placeholder="例：用 3-5 句中文回答，先说结论，面向非技术同事，保留代码和命令"
              placeholderTextColor={colors().foregroundMuted}
              multiline
              onChangeText={(text) => onPatch({ replyStylePrompt: text })}
              style={inputStyle({ minHeight: 64, textAlignVertical: "top" })}
            />
          </>
        ) : null}

        <SelectRow
          label="AI 改写"
          value={rewriteValue}
          expanded={openField === "rewrite"}
          onPress={() => toggleField("rewrite")}
        >
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {REPLY_REWRITE_OPTIONS.map((option) => (
              <ChoicePill
                key={option.value}
                label={option.label}
                active={binding.replyRewrite === option.value}
                onPress={() => onPatch({ replyRewrite: option.value })}
              />
            ))}
          </View>
          <Text style={{ fontSize: 12, color: colors().foregroundMuted }}>
            {REPLY_REWRITE_OPTIONS.find((option) => option.value === binding.replyRewrite)?.hint ?? ""}
          </Text>
        </SelectRow>
        {binding.replyRewrite !== "off" ? (
          <>
            <SelectRow
              label="改写模型"
              value={rewriteModelValue}
              tone={rewriteModelTone}
              expanded={openField === "rewriteModel"}
              onPress={() => toggleField("rewriteModel")}
            >
              {providers.length > 0 ? (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  <ChoicePill
                    label="跟随当前绑定"
                    active={!binding.rewriteProvider}
                    onPress={() => onPatch({ rewriteProvider: "", rewriteModel: "" })}
                  />
                  {providers.map((candidate) => (
                    <ChoicePill
                      key={candidate.id}
                      label={candidate.label}
                      active={binding.rewriteProvider === candidate.id}
                      onPress={() => onPatch({ rewriteProvider: candidate.id, rewriteModel: "" })}
                    />
                  ))}
                  {unknownRewriteProvider ? (
                    <ChoicePill
                      label={`${unknownRewriteProvider}（未在列表）`}
                      active
                      onPress={() => onPatch({ rewriteProvider: "", rewriteModel: "" })}
                    />
                  ) : null}
                </View>
              ) : (
                <Text style={{ fontSize: 12, color: colors().foregroundMuted }}>
                  未获取到 provider 列表；留空跟随当前绑定。
                </Text>
              )}
              {binding.rewriteProvider && ((rewriteProviderInfo?.models.length ?? 0) > 0 || unknownRewriteModel) ? (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  <ChoicePill
                    label="默认"
                    active={!binding.rewriteModel}
                    onPress={() => onPatch({ rewriteModel: "" })}
                  />
                  {rewriteProviderInfo?.models.map((model) => (
                    <ChoicePill
                      key={model.id}
                      label={model.label + (model.isDefault ? "（默认）" : "")}
                      active={binding.rewriteModel === model.id}
                      onPress={() => onPatch({ rewriteModel: model.id })}
                    />
                  ))}
                  {unknownRewriteModel ? (
                    <ChoicePill
                      label={`${unknownRewriteModel}（未在列表）`}
                      active
                      onPress={() => onPatch({ rewriteModel: "" })}
                    />
                  ) : null}
                </View>
              ) : null}
              <Text style={{ fontSize: 11, color: colors().foregroundMuted }}>
                适合「主回答用强模型、改写用便宜快模型」；不选则跟随主绑定/话题覆盖。
              </Text>
            </SelectRow>
            <ToggleRow
              label="改写不套用回复风格"
              hint="开启后改写只压缩长度，保持原文的语气与术语深度；不注入回复风格，风格为「默认」时也不用内置的通俗化指令"
              value={binding.rewriteIgnoreStyle}
              onChange={(value) => onPatch({ rewriteIgnoreStyle: value })}
            />
            <Text style={{ fontSize: 11, color: colors().statusWarning, lineHeight: 17 }}>
              会额外调用一次模型，增加延迟和费用；原文保留在 Paseo，失败/超时自动发原文。带 @ 接力的回复不改写。
            </Text>
          </>
        ) : null}

        <SelectRow
          label="回复格式"
          value={formatValue}
          expanded={openField === "format"}
          onPress={() => toggleField("format")}
        >
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
          <Text style={{ fontSize: 11, color: colors().foregroundMuted }}>
            {"post 会保留 `<at>`，并在新会话提示里附带群内机器人目录；markdown/text 不会触发 @。"}
          </Text>
        </SelectRow>

        <SelectRow
          label="完成后 @ 谁"
          value={mentionValue}
          expanded={openField === "mention"}
          onPress={() => toggleField("mention")}
        >
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {MENTION_ON_REPLY_OPTIONS.map((option) => (
              <ChoicePill
                key={option.value}
                label={option.label}
                active={binding.mentionOnReply === option.value}
                onPress={() => onPatch({ mentionOnReply: option.value })}
              />
            ))}
          </View>
          <Text style={{ fontSize: 12, color: colors().foregroundMuted }}>
            {MENTION_ON_REPLY_OPTIONS.find((option) => option.value === binding.mentionOnReply)?.hint ?? ""}
            完成提醒以独立的纯文本消息发送（飞书只在文本消息里触发 @ 通知），不会影响正文格式；读取不到发送者姓名时会跳过 @。仅群聊生效。
          </Text>
        </SelectRow>
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
