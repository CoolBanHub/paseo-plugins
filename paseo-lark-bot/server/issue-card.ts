import type { IssueRecord, IssueStatus } from "./issues.ts";

/**
 * Feishu Card 2.0 for issue acceptance. The card is a thin UI over the Base
 * record: the callback carries the record/topic coordinates, and the plugin
 * re-reads the record before changing it, so a stale/replayed click cannot
 * move an already-closed item.
 */

export type IssueCardAction = "accept" | "reject";

export interface IssueCardPayload {
  kind: "issue";
  action: IssueCardAction;
  recordId: string;
  chatId: string;
  topicKey: string;
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
): Record<string, unknown> {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    behaviors: [{ type: "callback", value }],
  };
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
        {
          tag: "action",
          actions: [
            button("验收通过", "primary", payload("accept")),
            button("还没修好", "danger", payload("reject")),
          ],
        },
        {
          tag: "markdown",
          content: "验收通过后状态变为「已修复」；发布上线后在话题里发送 `/issue release` 标记为「已发布」。",
        },
      ],
    },
  };
}

/** Static replacement after a click; keeps the original buttons from lingering. */
export function buildIssueResolvedCard(options: {
  title: string;
  status: IssueStatus;
  action: IssueCardAction | "release";
  operatorOpenId: string;
}): Record<string, unknown> {
  const actionText =
    options.action === "accept"
      ? "已验收通过"
      : options.action === "reject"
        ? "验收未通过，已打回处理中"
        : "已标记为已发布";
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
      elements: [
        {
          tag: "markdown",
          content: [
            `**${clip(options.title || "未命名话题", MAX_TITLE)}**`,
            `状态：${options.status}`,
            `${actionText}（操作人 <at id="${options.operatorOpenId}"></at>）`,
            "",
            "不能重复操作；如需变更请在 Base 里修改，或在话题里使用 `/issue` 命令。",
          ].join("\n"),
        },
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
    if (parsed.action !== "accept" && parsed.action !== "reject") return null;
    if (typeof parsed.recordId !== "string" || !parsed.recordId) return null;
    if (typeof parsed.chatId !== "string" || !parsed.chatId) return null;
    if (typeof parsed.topicKey !== "string" || !parsed.topicKey) return null;
    return {
      kind: "issue",
      action: parsed.action,
      recordId: parsed.recordId,
      chatId: parsed.chatId,
      topicKey: parsed.topicKey,
    };
  } catch {
    return null;
  }
}
