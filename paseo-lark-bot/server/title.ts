import type { SessionPaseoApi, SessionWorkspaceHandle } from "./sessions.ts";
import { sanitizeTopicText } from "./format.ts";
import { createHelperAgent } from "./workspace.ts";

/** Hard stop for the one-shot naming turn; the caller falls back on timeout. */
const TITLE_TIMEOUT_MS = 45_000;
/** Upper bound asked from the naming model in the prompt below. */
const TITLE_TARGET_CHARS = 40;
/**
 * Hard clip for the AI title itself. Workspace tabs cut whatever overflows
 * their width, so the description must stay meaningful but compact.
 */
const TITLE_MAX_CHARS = 60;

/**
 * One-shot agent turn that names a Feishu topic session. It runs on the
 * chat's bound provider so no extra model configuration is needed. Any
 * failure — provider error, timeout, empty answer — resolves to null so the
 * caller can fall back to the sanitized topic text.
 *
 * The naming session carries the "lark-bot-purpose": "title" label (and
 * autoArchive) so companion plugins such as paseo-lark-notify can skip its
 * lifecycle notifications. It rides in the topic's existing workspace: a
 * standalone agents.create() would make Paseo mint a fresh workspace for
 * every naming turn (0.15+) and leave an empty "main" entry behind.
 */
export async function generateTopicTitle(options: {
  paseo: SessionPaseoApi;
  /** Topic workspace; helpers never create a standalone workspace. */
  workspace?: SessionWorkspaceHandle | null;
  /** Resolved provider id in `provider/model` form. */
  provider: string;
  cwd: string;
  chatId: string;
  topicKey: string;
  /** Sanitized thread-root text, when the topic has one. */
  topicRootText: string | null;
  instruction: string;
}): Promise<string | null> {
  const parts: string[] = [];
  if (options.topicRootText) parts.push("话题发起内容：" + options.topicRootText);
  parts.push("本次请求：" + sanitizeTopicText(options.instruction));
  const prompt =
    "以下是一轮飞书对话的素材，请为对应的智能体会话起一个标题。\n\n" +
    parts.join("\n") +
    `\n\n要求：不超过 ${TITLE_TARGET_CHARS} 个字；标题要直接描述用户想让智能体完成的具体任务（做什么、对象是什么），保留请求中的关键名词与数字，` +
    "让只看到标题的人也能明白这轮任务；不要用「计算」「处理」「任务」这类空泛词单独成题；直接输出标题文字本身，不要引号、序号或任何解释；不要使用任何工具。";
  try {
    const agentOptions = {
      config: { provider: options.provider },
      title: "飞书话题命名",
      labels: {
        "lark-bot-purpose": "title",
        "lark-bot-chat": options.chatId,
        "lark-bot-topic": options.topicKey,
      },
      autoArchive: true,
    };
    const handle = await createHelperAgent({
      paseo: options.paseo,
      workspace: options.workspace,
      cwd: options.cwd,
      agent: agentOptions,
    });
    if (!handle) return null;
    const result = await handle.run(prompt, { timeoutMs: TITLE_TIMEOUT_MS });
    return cleanTitle(result.lastMessage);
  } catch {
    return null;
  }
}

/** Keep the first line, drop surrounding markdown/quote decoration, clip. */
function cleanTitle(raw: string | null): string | null {
  if (!raw) return null;
  const firstLine = (raw.split(/\r?\n/, 1)[0] ?? "").trim();
  const bare = firstLine
    .replace(/^[#>*\-\s]+/, "")
    .replace(/^["'“「『【]+/, "")
    .replace(/["'”」』】]+$/, "")
    .trim();
  if (!bare) return null;
  return sanitizeTopicText(bare, TITLE_MAX_CHARS);
}
