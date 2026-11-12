import type { SessionPaseoApi, SessionWorkspaceHandle } from "./sessions.ts";
import { createHelperAgent } from "./workspace.ts";

export type ClassifiedIssueType = "问题" | "需求" | "咨询";

export interface IssueClassification {
  /** Whether this topic belongs in the issue/requirement ledger. */
  track: boolean;
  /** Model's type; null means "fall back to the local classifier". */
  type: ClassifiedIssueType | null;
  reason: string;
}

const CLASSIFY_TIMEOUT_MS = 20_000;
const MAX_TEXT = 1_200;

/**
 * One-shot model gate before a topic is recorded. The local keyword
 * classifier is cheap but cannot tell "this is a meta discussion about the
 * bot" from a product issue; this pass decides both inclusion and type.
 *
 * Failure resolves to null; the caller keeps the old fail-open behavior
 * (record it, keyword-classify it) so a transient provider error does not
 * silently lose real issues.
 */
export async function classifyIssueWithModel(options: {
  paseo: SessionPaseoApi;
  /** Topic workspace; helpers never create a standalone workspace. */
  workspace?: SessionWorkspaceHandle | null;
  /** Resolved provider id in `provider/model` form. */
  provider: string;
  cwd: string;
  chatId: string;
  topicKey: string;
  text: string;
  timeoutMs?: number;
  log?: (message: string, detail?: unknown) => void;
}): Promise<IssueClassification | null> {
  const text = options.text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  if (!text) return null;
  const prompt = [
    "你是飞书群里的“问题/需求跟踪”分类器。请判断下面这条话题是否应该进入问题跟踪表，并给出类型。",
    "",
    "纳入跟踪（track=true）的例子：",
    "- 产品/业务的 bug、报错、异常、数据错误、无法使用；",
    "- 明确的功能需求、体验优化、页面/文案调整；",
    "- 需要后续跟进的产品相关问题或用户反馈。",
    "",
    "不纳入跟踪（track=false）的例子：",
    "- 闲聊、问候、测试消息、纯表情/图片、公告；",
    "- 关于机器人本身、文档、表格、群设置、群标签、快捷按钮的说明或讨论；",
    "- 只是让机器人整理消息、介绍用法、转发链接；",
    "- 没有明确诉求、已经完成且无需跟进的同步。",
    "",
    "类型只能是：问题（bug/故障/错误）、需求（新增/修改/优化）、咨询（产品使用/规则问题）。",
    "无法确定类型时 type 用 null；track=false 时 type 也用 null。",
    "",
    "只输出一个 JSON 对象，不要 markdown、不要解释：",
    '{"track": true, "type": "问题", "reason": "一句话理由"}',
    "",
    "话题内容：",
    text,
  ].join("\n");

  try {
    const handle = await createHelperAgent({
      paseo: options.paseo,
      workspace: options.workspace,
      cwd: options.cwd,
      agent: {
        config: { provider: options.provider },
        title: "问题跟踪分类",
        labels: {
          "lark-bot-purpose": "issue-classify",
          "lark-bot-chat": options.chatId,
          "lark-bot-topic": options.topicKey,
        },
        autoArchive: true,
      },
    });
    if (!handle) return null;
    const result = await handle.run(prompt, {
      timeoutMs: options.timeoutMs ?? CLASSIFY_TIMEOUT_MS,
    });
    const parsed = parseIssueClassification(result.lastMessage);
    if (!parsed) {
      options.log?.("问题分类模型返回无法解析，回退关键词", result.lastMessage?.slice(0, 120));
    }
    return parsed;
  } catch (error) {
    options.log?.("问题分类模型调用失败，回退关键词", error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** Parse the strict JSON asked for above; tolerate code fences/prose. */
export function parseIssueClassification(raw: string | null | undefined): IssueClassification | null {
  if (!raw) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof parsed.track !== "boolean") return null;
    const type =
      parsed.type === "问题" || parsed.type === "需求" || parsed.type === "咨询"
        ? parsed.type
        : null;
    const reason =
      typeof parsed.reason === "string" ? parsed.reason.replace(/\s+/g, " ").slice(0, 200) : "";
    return {
      track: parsed.track,
      type: parsed.track ? type : null,
      reason,
    };
  } catch {
    return null;
  }
}
