import type { SessionPaseoApi, SessionWorkspaceHandle } from "./sessions.ts";
import { createHelperAgent } from "./workspace.ts";

export interface IssueStatusReview {
  /** Ready to move from 处理中 to 待验收. Never means 已修复/已发布. */
  done: boolean;
  summary: string | null;
  reason: string;
}

const REVIEW_TIMEOUT_MS = 20_000;
const MAX_ROOT = 1_000;
const MAX_COMMENT = 300;
const MAX_COMMENTS = 10;

/**
 * Review the recent thread context when an ambient comment hints that the
 * issue may be finished. The model may only advance 处理中 → 待验收; human
 * acceptance is still required for 已修复/已发布.
 *
 * Failure resolves to null (leave the status untouched).
 */
export async function reviewIssueStatusWithModel(options: {
  paseo: SessionPaseoApi;
  workspace?: SessionWorkspaceHandle | null;
  provider: string;
  cwd: string;
  chatId: string;
  topicKey: string;
  rootText: string;
  currentStatus: string;
  comments: Array<{ sender: string; text: string }>;
  timeoutMs?: number;
  log?: (message: string, detail?: unknown) => void;
}): Promise<IssueStatusReview | null> {
  const rootText = options.rootText.replace(/\s+/g, " ").trim().slice(0, MAX_ROOT);
  const comments = options.comments
    .map((entry) => ({
      sender: entry.sender,
      text: entry.text.replace(/\s+/g, " ").trim().slice(0, MAX_COMMENT),
    }))
    .filter((entry) => entry.text)
    .slice(-MAX_COMMENTS);
  if (!rootText && comments.length === 0) return null;

  const prompt = [
    "你在维护一个飞书问题跟踪话题。请根据话题根消息和最近的评论，判断这个问题是否已经完成、可以进入「待验收」。",
    "",
    "注意：",
    "- 你只能判断「是否可验收」；「已修复」「已发布」必须由人确认，不在这里判断。",
    "- 只有评论明确表示“已修复/已改好/已上线/已验证/已完成/没问题”，或机器人明确给出完成结论且没有人提出异议时，才 done=true。",
    "- 疑问句（“修好了吗？”）、否定（“还没/有问题/仍异常”）、讨论、计划、稍后处理、测试中，都必须 done=false。",
    "- 不确定时 done=false；不要为了推进状态而猜测。",
    "",
    "只输出一个 JSON 对象，不要 markdown、不要解释：",
    '{"done": true, "summary": "一句话说明当前完成情况", "reason": "一句话依据"}',
    "done=false 时 summary 用空字符串。",
    "",
    `当前状态：${options.currentStatus}`,
    "话题根消息：",
    rootText || "（无）",
    "",
    "最近评论（从旧到新）：",
    comments.length > 0
      ? comments.map((entry) => `- ${entry.sender}: ${entry.text}`).join("\n")
      : "（无）",
  ].join("\n");

  try {
    const handle = await createHelperAgent({
      paseo: options.paseo,
      workspace: options.workspace,
      cwd: options.cwd,
      agent: {
        config: { provider: options.provider },
        title: "问题状态判断",
        labels: {
          "lark-bot-purpose": "issue-status",
          "lark-bot-chat": options.chatId,
          "lark-bot-topic": options.topicKey,
        },
        autoArchive: true,
      },
    });
    if (!handle) return null;
    const result = await handle.run(prompt, {
      timeoutMs: options.timeoutMs ?? REVIEW_TIMEOUT_MS,
    });
    const parsed = parseIssueStatusReview(result.lastMessage);
    if (!parsed) {
      options.log?.("问题状态模型返回无法解析", result.lastMessage?.slice(0, 120));
    }
    return parsed;
  } catch (error) {
    options.log?.(
      "问题状态模型调用失败",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

/** Parse the strict JSON above; tolerate code fences/prose. */
export function parseIssueStatusReview(raw: string | null | undefined): IssueStatusReview | null {
  if (!raw) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof parsed.done !== "boolean") return null;
    const summary =
      typeof parsed.summary === "string"
        ? parsed.summary.replace(/\s+/g, " ").trim().slice(0, 200)
        : "";
    const reason =
      typeof parsed.reason === "string"
        ? parsed.reason.replace(/\s+/g, " ").trim().slice(0, 200)
        : "";
    return {
      done: parsed.done,
      summary: parsed.done ? summary || null : null,
      reason,
    };
  } catch {
    return null;
  }
}
