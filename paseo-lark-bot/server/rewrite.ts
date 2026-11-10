import { DEFAULT_REWRITE_INSTRUCTION } from "../shared/settings.ts";
import type { SessionPaseoApi } from "./sessions.ts";

/** Hard stop for the one-shot rewrite; the caller falls back to the original. */
const REWRITE_TIMEOUT_MS = 30_000;

export interface RewriteReplyOptions {
  paseo: SessionPaseoApi;
  /** Resolved provider id in `provider/model` form. */
  provider: string;
  cwd: string;
  chatId: string;
  topicKey: string;
  /** Final answer of the main turn. */
  text: string;
  /** Style/rewrite instruction; falls back to DEFAULT_REWRITE_INSTRUCTION. */
  instruction: string;
  timeoutMs?: number;
  log?: (message: string, detail?: unknown) => void;
}

/**
 * One-shot model turn that rewrites the final answer into a shorter Feishu
 * reply. It runs on the chat's bound provider/model (same as the main turn),
 * carries the `lark-bot-purpose: rewrite` label so companion plugins can skip
 * its lifecycle notifications, and is auto-archived/backgrounded so it never
 * appears as an interactive workspace session.
 *
 * Any failure — provider error, timeout, empty answer — resolves to null so
 * the caller sends the original text instead of losing the reply.
 */
export async function rewriteReplyWithModel(options: RewriteReplyOptions): Promise<string | null> {
  if (!options.text.trim()) return null;
  const instruction = options.instruction.trim() || DEFAULT_REWRITE_INSTRUCTION;
  const prompt = [
    "下面是一轮飞书对话的最终回答。请把它改写成更适合直接发在飞书里的短版。",
    "",
    "改写要求：",
    instruction,
    "",
    "硬性要求：",
    "- 只基于原文，不要编造原文没有的事实、数字或结论。",
    "- 保留代码块、命令、文件路径、链接、数字和专有名词；不要省略关键步骤。",
    "- 不要使用任何工具，不要输出解释、标题或「以下是改写」之类的话，直接输出正文。",
    "- 使用与原文相同的语言。",
    "",
    "原文：",
    options.text,
  ].join("\n");

  try {
    const handle = await options.paseo.agents.create({
      config: { provider: options.provider },
      cwd: options.cwd,
      title: "飞书回复改写",
      labels: {
        "lark-bot-purpose": "rewrite",
        ...(options.chatId ? { "lark-bot-chat": options.chatId } : {}),
        ...(options.topicKey ? { "lark-bot-topic": options.topicKey } : {}),
      },
      autoArchive: true,
      background: true,
    });
    const result = await handle.run(prompt, { timeoutMs: options.timeoutMs ?? REWRITE_TIMEOUT_MS });
    const rewritten = (result.lastMessage ?? "").trim();
    return rewritten || null;
  } catch (error) {
    options.log?.(
      "回复改写失败，发送原文",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}
