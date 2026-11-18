import type { IssueAction } from "../shared/settings.ts";
import type { IssueRecord, IssueStatus } from "./issues.ts";

/**
 * Feishu Card 2.0 for issue acceptance. The card is a thin UI over the Base
 * record: the callback carries the record/topic coordinates, and the plugin
 * re-reads the record before changing it, so a stale/replayed click cannot
 * move an already-closed item.
 */

export type IssueCardAction = "accept" | "reject" | "run";
/** `release` is only used for the static "already released" replacement. */
export type IssueCardStatusAction = IssueCardAction | "release";

export interface IssueCardPayload {
  kind: "issue";
  action: IssueCardAction;
  recordId: string;
  chatId: string;
  topicKey: string;
  /** Set for `run`: the configured action id. The prompt never rides here. */
  actionId?: string;
}

const MAX_TITLE = 120;
const MAX_SUMMARY = 500;

function clip(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit - 1) + "…" : flat;
}

function mention(openId: string | null): string {
  return openId && openId.startsWith("ou_") ? `<at id="${openId}"></at> ` : "";
}

function button(
  label: string,
  type: "primary" | "danger" | "default",
  value: IssueCardPayload,
  confirmText?: string,
): Record<string, unknown> {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    width: "fill",
    ...(confirmText
      ? {
          confirm: {
            title: { tag: "plain_text", content: "确认操作" },
            text: { tag: "plain_text", content: clip(confirmText, 200) },
          },
        }
      : {}),
    behaviors: [{ type: "callback", value }],
  };
}

/** Buttons for configured actions whose `from` covers the current status. */
function actionButtons(options: {
  record: Pick<IssueRecord, "recordId" | "chatId" | "threadId" | "rootMessageId">;
  topicKey: string;
  status: IssueStatus;
  actions: IssueAction[];
}): Record<string, unknown>[] {
  return options.actions
    .filter((action) => action.label && action.from.includes(options.status))
    .map((action) =>
      button(
        action.label,
        action.type,
        {
          kind: "issue",
          action: "run",
          actionId: action.id,
          recordId: options.record.recordId,
          chatId: options.record.chatId,
          topicKey: options.topicKey,
        },
        action.confirm || undefined,
      ),
    );
}

export function buildIssueCard(options: {
  record: IssueRecord;
  summary?: string | null;
  topicKey: string;
}): Record<string, unknown> {
  const { record } = options;
  const topicKey = options.topicKey || record.threadId || record.rootMessageId;
  const payload = (action: IssueCardAction): IssueCardPayload => ({
    kind: "issue",
    action,
    recordId: record.recordId,
    chatId: record.chatId,
    topicKey,
  });
  const summary = clip(options.summary ?? "", MAX_SUMMARY);
  const lines = [
    `**${clip(record.title || "未命名话题", MAX_TITLE)}**`,
    `状态：待验收`,
  ];
  if (summary) lines.push(`最近进展：${summary}`);
  lines.push("", `${mention(record.requesterOpenId)}请确认这个问题是否已经修好。`);
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "default" },
    header: {
      title: { tag: "plain_text", content: "问题待验收" },
      template: "yellow",
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 20px 12px",
      elements: [
        { tag: "markdown", content: lines.join("\n") },
        button("验收通过", "primary", payload("accept")),
        button("还没修好", "danger", payload("reject")),
        {
          tag: "markdown",
          content: "验收通过后状态变为「已修复」；发布上线后在话题里发送 `/issue release` 标记为「已发布」。",
        },
      ],
    },
  };
}

/**
 * Static replacement after a click; keeps the original buttons from lingering.
 * When the record is in a status covered by configured actions, those buttons
 * are appended and each one resolves its prompt again on the server.
 */
export function buildIssueResolvedCard(options: {
  title: string;
  status: IssueStatus;
  action: IssueCardStatusAction;
  operatorOpenId: string;
  actions?: IssueAction[];
  record?: Pick<IssueRecord, "recordId" | "chatId" | "threadId" | "rootMessageId">;
  topicKey?: string;
  /** Label of the action that was just triggered, for the "已触发" state. */
  runLabel?: string;
}): Record<string, unknown> {
  const actionText =
    options.action === "accept"
      ? "已验收通过"
      : options.action === "reject"
        ? "验收未通过，已打回处理中"
        : options.action === "run"
          ? `已触发「${clip(options.runLabel || "动作", 30)}」，请等待本轮回复`
          : "已标记为已发布";
  const record = options.record;
  const topicKey = options.topicKey || record?.threadId || record?.rootMessageId || "";
  const availableActions =
    options.action === "run" || !record || !topicKey
      ? []
      : actionButtons({
          record,
          topicKey,
          status: options.status,
          actions: options.actions ?? [],
        });
  const lines = [
    `**${clip(options.title || "未命名话题", MAX_TITLE)}**`,
    `状态：${options.status}`,
    `${actionText}（操作人 <at id="${options.operatorOpenId}"></at>）`,
  ];
  if (options.action === "run") {
    lines.push("", "如果执行失败或需要重试，请在话题里直接说明。");
  } else if (availableActions.length > 0) {
    lines.push("", "可执行以下动作；点击后以操作人身份在话题里触发一轮处理。");
  } else {
    lines.push("", "不能重复操作；如需变更请在 Base 里修改，或在话题里使用 `/issue` 命令。");
  }
  const elements: Record<string, unknown>[] = [
    { tag: "markdown", content: lines.join("\n") },
    ...availableActions,
  ];
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "default" },
    header: {
      title: { tag: "plain_text", content: "问题状态已更新" },
      template: options.status === "已修复" ? "green" : options.status === "处理中" ? "orange" : "purple",
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 20px 12px",
      elements,
    },
  };
}

/**
 * Fresh card for `/issue card`: re-send the current state plus configured
 * buttons, so a topic whose card PATCH failed (or an old 已修复 card) can still
 * reach the action without waiting for a new acceptance cycle.
 */
export function buildIssueActionCard(options: {
  record: Pick<IssueRecord, "recordId" | "chatId" | "threadId" | "rootMessageId">;
  title: string;
  status: IssueStatus;
  topicKey: string;
  actions: IssueAction[];
}): Record<string, unknown> {
  const topicKey = options.topicKey || options.record.threadId || options.record.rootMessageId;
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "default" },
    header: {
      title: { tag: "plain_text", content: "问题可执行动作" },
      template: options.status === "已修复" ? "green" : "purple",
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 20px 12px",
      elements: [
        {
          tag: "markdown",
          content: [
            `**${clip(options.title || "未命名话题", MAX_TITLE)}**`,
            `状态：${options.status}`,
            "点击下面的动作后，机器人会以你的身份在本话题触发一轮处理。",
          ].join("\n"),
        },
        ...actionButtons({
          record: options.record,
          topicKey,
          status: options.status,
          actions: options.actions,
        }),
      ],
    },
  };
}

/** Parse a button callback emitted by an issue card. */
export function parseIssueAction(value: string | undefined): IssueCardPayload | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.kind !== "issue") return null;
    if (parsed.action !== "accept" && parsed.action !== "reject" && parsed.action !== "run") {
      return null;
    }
    if (typeof parsed.recordId !== "string" || !parsed.recordId) return null;
    if (typeof parsed.chatId !== "string" || !parsed.chatId) return null;
    if (typeof parsed.topicKey !== "string" || !parsed.topicKey) return null;
    const actionId =
      typeof parsed.actionId === "string" && parsed.actionId ? parsed.actionId : undefined;
    if (parsed.action === "run" && !actionId) return null;
    return {
      kind: "issue",
      action: parsed.action,
      recordId: parsed.recordId,
      chatId: parsed.chatId,
      topicKey: parsed.topicKey,
      ...(actionId ? { actionId } : {}),
    };
  } catch {
    return null;
  }
}
