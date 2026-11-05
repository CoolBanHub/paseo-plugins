const DEFAULT_REPLY_LIMIT = 4000;

function cjkRatio(value: string): number {
  const cjk = (value.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (value.match(/[A-Za-z]/g) || []).length;
  if (cjk + latin === 0) return 0;
  return cjk / (cjk + latin);
}

/**
 * DeepSeek-style providers sometimes fold English reasoning into the final
 * message. When a reply mixes scripts, keep the CJK sentences that carry the
 * actual answer instead of shipping the chain of thought to chat.
 */
export function condenseReply(value: string): string {
  const flat = value.split(/\s+/).join(" ").trim();
  if (!flat) return "";
  if (cjkRatio(flat) > 0) {
    const sentences = flat
      .split(/(?<=[。！？!?.])/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
    const answer = sentences.filter((sentence) => cjkRatio(sentence) >= 0.3);
    if (answer.length > 0) return answer.slice(-2).join("");
  }
  return flat;
}

/**
 * Feishu rejects overly long messages; clip the reply and point the user to
 * the full timeline in Paseo.
 */
export function clipReply(value: string, limit = DEFAULT_REPLY_LIMIT): { text: string; clipped: boolean } {
  const flat = value.trim();
  if (flat.length <= limit) return { text: flat, clipped: false };
  return { text: flat.slice(0, limit - 1) + "…", clipped: true };
}

export function appendFooter(text: string, clipped: boolean): string {
  if (!clipped) return text;
  return text + "\n\n（回复过长已截断，打开 Paseo 查看完整内容。）";
}

/**
 * Exact post payload for the `post` reply format: a single md element so
 * inline `<at user_id=...>` mentions stay intact for agent-to-agent handoffs
 * (plain markdown replies never trigger other agents).
 */
export function buildPostContent(text: string): string {
  return JSON.stringify({ zh_cn: { content: [[{ tag: "md", text }]] } });
}

export function formatTurnOutcome(outcome: "completed" | "failed" | "canceled" | null, lastError: string | null): string {
  if (outcome === "failed") return lastError ? "处理失败：" + clipText(lastError) : "处理失败";
  if (outcome === "canceled") return "本轮处理已取消。";
  return "";
}

function clipText(value: string, limit = 300): string {
  const flat = value.split(/\s+/).join(" ").trim();
  return flat.length > limit ? flat.slice(0, limit - 1) + "…" : flat;
}

/**
 * Permission requests are resolved in the Paseo client; the group message only
 * needs to make the pending request visible.
 */
export function formatPermissionNotice(detail: { heading: string; extra: string | null }): string {
  const lines = ["**🔐 智能体需要确认**", "", "**请求**：" + clipText(detail.heading, 160)];
  if (detail.extra) lines.push("**详情**：" + clipText(detail.extra, 200));
  lines.push("", "打开 Paseo 处理这条请求，处理完成后结果会回到本话题。");
  return lines.join("\n");
}
