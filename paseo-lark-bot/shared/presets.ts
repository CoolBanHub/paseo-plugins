/**
 * One-tap reply-instruction presets shown under the binding's prompt box.
 *
 * The texts are adapted from the team baseline in
 * InfiniteStatesInc/justin-agent-best-practices (concise-reporting and
 * autonomy-boundaries) and rewritten for a chat assistant: one screen, at most
 * three asks, plain language, and a short red-line list. They are ordinary
 * prompt text — editable after filling, and not enforced by code.
 */
export type ReplyInstructionPresetId = "concise" | "boundaries";

export interface ReplyInstructionPreset {
  id: ReplyInstructionPresetId;
  label: string;
  hint: string;
  text: string;
}

const CONCISE = [
  "按「手机一屏」汇报，不要复述分析过程：",
  "1. 先给结论：1-2 句说清发生了什么、结果如何；每条事项都有主语和结果。",
  "2. 需要对方决定的事最多 3 条，每条给出你的建议和理由；能自己定的技术选择直接定，并在汇报里说明。",
  "3. 用平实语言，不用内部代号；必须用时先说明它是做什么的。",
  "4. 汇报前刷新最新状态，不要把已处理的事再列为待办。",
  "5. 提到文件用绝对路径；代码、命令、路径和链接原样保留。",
  "6. 需要对方做的事单独成段，不要混在过程叙述里。",
].join("\n");

const BOUNDARIES = [
  "在目标范围内自行决定技术方案、命令和重试，不要为常规选择停下来问；测试连续跑完并报告结果。",
  "只有以下情况先停下来说明影响、等待明确同意：",
  "- 花钱（含超出免费额度）；",
  "- 删除或覆盖任何内容，包括你刚创建的；",
  "- 修改共享/全局配置（网络、代理、账号、CI）；",
  "- 把内容发送到团队之外；",
  "- 合并到 main 或发布分支；",
  "- 放宽别人设置的安全阈值。",
  "一次授权只覆盖一次操作。执行前说清影响、能否恢复和备选方案；只清理你能证明属于自己的东西。",
].join("\n");

export const REPLY_INSTRUCTION_PRESETS: readonly ReplyInstructionPreset[] = [
  {
    id: "concise",
    label: "简洁汇报",
    hint: "先结论、一屏以内、待办不超过 3 条并附建议",
    text: CONCISE,
  },
  {
    id: "boundaries",
    label: "自主边界",
    hint: "常规技术选择自己做，只对删除/花钱/改配置等红线先确认",
    text: BOUNDARIES,
  },
];
