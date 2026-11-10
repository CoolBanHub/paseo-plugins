import { DSH_DEFAULT_PERMISSION, DSH_PERMISSION_OPTIONS, isDshProvider, type BotValues, type ChatBinding } from "../shared/settings.ts";
import type { SessionProviderSnapshot, TopicOverrides } from "./sessions.ts";
import { formatCronTime, nextCronTime } from "./cron.ts";
import type { CronScheduler, CronJob } from "./cron.ts";

/**
 * Chat-side control plane. Commands are parsed before the message reaches an
 * agent, run under the same allowlist as normal turns, and answer in the
 * topic. They exist so a phone user can inspect the session, rotate it, pick a
 * model or schedule a prompt without opening the Paseo settings screen.
 */

export interface ParsedCommand {
  name: string;
  args: string;
}

const ALIASES: Record<string, string> = {
  help: "help",
  帮助: "help",
  whoami: "whoami",
  我是谁: "whoami",
  status: "status",
  状态: "status",
  new: "new",
  新会话: "new",
  reset: "reset",
  重置: "reset",
  stop: "stop",
  停止: "stop",
  model: "model",
  模型: "model",
  mode: "mode",
  permission: "mode",
  模式: "mode",
  权限: "mode",
  thinking: "thinking",
  思考: "thinking",
  cron: "cron",
  定时: "cron",
  doctor: "doctor",
  诊断: "doctor",
};

/** Parse `/name args`; returns null for non-command messages. */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = /^\/([A-Za-z][A-Za-z0-9_-]*|[\u4e00-\u9fff]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match?.[1]) return null;
  const name = ALIASES[match[1].toLowerCase()] ?? ALIASES[match[1]] ?? match[1].toLowerCase();
  return { name, args: (match[2] ?? "").trim() };
}

export function commandHelp(): string {
  return [
    "**可用命令**",
    "`/status` 查看当前会话、模型与队列",
    "`/whoami` 查看自己的 open_id 与会话 id",
    "`/new` 结束当前话题的智能体会话（下条消息开新会话）",
    "`/reset` 清空本话题的模型/权限覆盖并重建会话",
    "`/model` 列出/切换本话题模型，例如 `/model claude-opus-4`",
    "`/mode` 列出/切换权限模式（dsh 为权限预设）",
    "`/thinking` 列出/切换思考深度",
    "`/stop` 清空本话题的排队消息（不会中断 Paseo 中已开始的轮次）",
    "`/cron list` 查看定时任务；`/cron add 0 6 * * * 总结 GitHub trending` 新建",
    "`/cron remove|on|off|run <id>` 管理定时任务",
    "`/doctor` 自检 lark-cli、监听、卡片回调与 provider",
    "`/help` 显示这份帮助",
  ].join("\n");
}

export interface CommandSessionInfo {
  agentId: string | null;
  busy: boolean;
  queued: number;
  provider: string;
  model: string;
  permission: string;
  thinking: string;
  cwd: string;
  remaining: number;
}

export interface CommandContext {
  command: ParsedCommand;
  values: BotValues;
  binding: ChatBinding;
  chatId: string;
  chatName: string;
  topicKey: string;
  senderId: string;
  overrides: TopicOverrides;
  session: CommandSessionInfo;
  providers: SessionProviderSnapshot | null;
  cron: CronScheduler;
  helperPath: string | null;
  attachmentMaxMb: number;
  doctor: () => Promise<string>;
  resetSession: (options: { clearOverrides: boolean }) => void;
  stopQueue: () => number;
  setOverrides: (patch: TopicOverrides) => void;
  reply: (text: string) => Promise<void>;
}

/** Base provider id (`dsh/model` → `dsh`). */
function baseProvider(provider: string): string {
  const slash = provider.indexOf("/");
  return slash > 0 ? provider.slice(0, slash) : provider;
}

function providerEntry(providers: SessionProviderSnapshot | null, provider: string) {
  const base = baseProvider(provider);
  return providers?.entries.find((entry) => entry.provider === base) ?? null;
}

function clip(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit - 1) + "…" : flat;
}

function modelIds(snapshot: SessionProviderSnapshot | null, provider: string): string[] {
  return (providerEntry(snapshot, provider)?.models ?? [])
    .filter((model) => model.isSelectable !== false)
    .map((model) => model.id);
}

function permissionOptions(snapshot: SessionProviderSnapshot | null, provider: string): { id: string; label: string }[] {
  if (isDshProvider(provider)) {
    return DSH_PERMISSION_OPTIONS.map((option) => ({ id: option.value, label: option.label }));
  }
  return (providerEntry(snapshot, provider)?.modes ?? []).map((mode) => ({ id: mode.id, label: mode.label }));
}

function thinkingOptions(snapshot: SessionProviderSnapshot | null, provider: string, model: string) {
  const entry = providerEntry(snapshot, provider);
  const selected =
    entry?.models?.find((candidate) => candidate.id === model) ??
    entry?.models?.find((candidate) => candidate.isDefault) ??
    entry?.models?.[0];
  return selected?.thinkingOptions ?? [];
}

function cronLine(job: CronJob): string {
  const state = job.enabled ? "启用" : "暂停";
  return (
    `\`${job.id}\` · \`${job.expression}\` · ${state} · 下次 ${formatCronTime(job.nextRunAt)}` +
    (job.lastError ? ` · 上次失败：${clip(job.lastError, 60)}` : "") +
    `\n　${clip(job.prompt, 80)}`
  );
}

function formatSessionStatus(context: CommandContext): string {
  const { session, binding, overrides, values } = context;
  const lines = [
    "**📋 当前会话**",
    `会话：${context.chatName || context.chatId}`,
    `话题：\`${context.topicKey}\``,
    `Provider：\`${session.provider}\`${overrides.provider ? "（话题覆盖）" : "（来自绑定）"}`,
    `模型：\`${session.model || "默认"}\`${overrides.model ? "（话题覆盖）" : ""}`,
    `权限：\`${session.permission || "默认"}\`${overrides.permission ? "（话题覆盖）" : ""}`,
    `思考：\`${session.thinking || "默认"}\`${overrides.thinkingOptionId ? "（话题覆盖）" : ""}`,
    `目录：\`${session.cwd}\``,
    `状态：${session.busy ? "处理中" : "空闲"}${session.queued > 0 ? ` · 排队 ${session.queued} 条` : ""}`,
    `智能体：\`${session.agentId ?? "尚未创建"}\``,
  ];
  if (values.rateLimitPerHour > 0) {
    lines.push(`本小时剩余轮次：${session.remaining === Number.POSITIVE_INFINITY ? "不限" : session.remaining}`);
  }
  if (values.attachmentSend && context.helperPath) {
    lines.push(`附件回传：\`${context.helperPath}\`（上限 ${context.attachmentMaxMb}MB）`);
  }
  lines.push("", binding.allowedUsers.length > 0 ? `白名单：${binding.allowedUsers.length} 人` : "白名单：所有人可触发");
  return lines.join("\n");
}

function listModels(context: CommandContext): string {
  const ids = modelIds(context.providers, context.session.provider);
  if (ids.length === 0) {
    return "Paseo 没有返回该 provider 的模型列表；仍可直接 `/model <模型 id>` 指定。";
  }
  const current = context.overrides.model || context.session.model;
  const lines = [`**可用模型**（当前：\`${current || "默认"}\`）`];
  for (const id of ids.slice(0, 40)) {
    lines.push(`${id === current ? "• **" + id + "**" : "• `" + id + "`"}`);
  }
  if (ids.length > 40) lines.push(`…共 ${ids.length} 个`);
  lines.push("", "用 `/model <id>` 切换；`/reset` 恢复绑定默认。");
  return lines.join("\n");
}

function listPermissions(context: CommandContext): string {
  const options = permissionOptions(context.providers, context.session.provider);
  const current = context.overrides.permission || context.session.permission;
  if (options.length === 0) {
    return "该 provider 没有可选权限模式；`/mode` 不可用。";
  }
  const lines = [`**可用权限模式**（当前：\`${current || "默认"}\`）`];
  for (const option of options) {
    lines.push(`${option.id === current ? "• **" + option.id + "**" : "• `" + option.id + "`"} — ${option.label}`);
  }
  if (isDshProvider(context.session.provider)) {
    lines.push("", `dsh 留空时默认 \`${DSH_DEFAULT_PERMISSION}\`；\`/reset\` 恢复绑定默认。`);
  } else {
    lines.push("", "用 `/mode <id>` 切换；下一条消息在新会话中生效。");
  }
  return lines.join("\n");
}

function listThinking(context: CommandContext): string {
  const options = thinkingOptions(context.providers, context.session.provider, context.overrides.model || context.session.model);
  const current = context.overrides.thinkingOptionId || context.session.thinking;
  if (options.length === 0) {
    return "该模型没有可选的思考深度；仍可直接 `/thinking <id>` 指定。";
  }
  const lines = [`**可用思考深度**（当前：\`${current || "默认"}\`）`];
  for (const option of options) {
    lines.push(`${option.id === current ? "• **" + option.id + "**" : "• `" + option.id + "`"} — ${option.label}`);
  }
  lines.push("", "用 `/thinking <id>` 切换；下一条消息在新会话中生效。");
  return lines.join("\n");
}

/** Run one command. Unknown commands get the help hint instead of a turn. */
export async function runCommand(context: CommandContext): Promise<void> {
  const { command, reply } = context;
  const args = command.args.trim();

  switch (command.name) {
    case "help":
      await reply(commandHelp());
      return;
    case "whoami":
      await reply(
        [
          "**🪪 身份**",
          `发送者 open_id：\`${context.senderId}\``,
          `会话 chat_id：\`${context.chatId}\``,
          `话题 key：\`${context.topicKey}\``,
          context.binding.allowedUsers.length > 0
            ? "本会话启用了白名单；把上面的 open_id 加进「允许 @ 的成员」即可授权。"
            : "本会话未启用白名单，所有人可触发。",
        ].join("\n"),
      );
      return;
    case "status":
      await reply(formatSessionStatus(context));
      return;
    case "new":
      context.resetSession({ clearOverrides: false });
      await reply("已结束当前话题的智能体会话；下一条消息会开新会话，话题覆盖（模型/权限）保留。");
      return;
    case "reset":
      context.resetSession({ clearOverrides: true });
      await reply("已清空本话题的模型/权限/思考覆盖并重建会话；下一条消息使用绑定默认值。");
      return;
    case "stop": {
      const dropped = context.stopQueue();
      await reply(
        dropped > 0
          ? `已清空本话题的 ${dropped} 条排队消息。Paseo 中已经开始的轮次仍会继续，完成后结果会回到本话题。`
          : "当前话题没有排队消息。Paseo 中已经开始的轮次不会被这个命令中断。",
      );
      return;
    }
    case "model": {
      if (!args) {
        await reply(listModels(context));
        return;
      }
      const ids = modelIds(context.providers, context.session.provider);
      if (ids.length > 0 && !ids.includes(args)) {
        await reply(`没有找到模型 \`${args}\`。发送 \`/model\` 查看可用列表。`);
        return;
      }
      context.setOverrides({ model: args });
      context.resetSession({ clearOverrides: false });
      await reply(`已切换到模型 \`${args}\`，下一条消息在新会话中生效。发送 \`/reset\` 恢复绑定默认模型。`);
      return;
    }
    case "mode": {
      if (!args) {
        await reply(listPermissions(context));
        return;
      }
      const options = permissionOptions(context.providers, context.session.provider);
      if (options.length > 0 && !options.some((option) => option.id === args)) {
        await reply(`没有找到权限模式 \`${args}\`。发送 \`/mode\` 查看可用列表。`);
        return;
      }
      context.setOverrides({ permission: args });
      context.resetSession({ clearOverrides: false });
      await reply(`已切换权限为 \`${args}\`，下一条消息在新会话中生效。发送 \`/reset\` 恢复绑定默认。`);
      return;
    }
    case "thinking": {
      if (!args) {
        await reply(listThinking(context));
        return;
      }
      context.setOverrides({ thinkingOptionId: args });
      context.resetSession({ clearOverrides: false });
      await reply(`已切换思考深度为 \`${args}\`，下一条消息在新会话中生效。发送 \`/reset\` 恢复绑定默认。`);
      return;
    }
    case "cron":
      await runCronCommand(context, args);
      return;
    case "doctor":
      await reply(await context.doctor());
      return;
    default:
      await reply(`未知命令 \`/${command.name}\`。\n\n` + commandHelp());
  }
}

async function runCronCommand(context: CommandContext, args: string): Promise<void> {
  const { cron, reply } = context;
  const [sub, ...rest] = args.split(/\s+/).filter(Boolean);
  const tail = rest.join(" ");

  if (!sub || sub === "list") {
    const jobs = cron.list();
    if (jobs.length === 0) {
      await reply("还没有定时任务。用法：`/cron add 0 6 * * * 总结 GitHub trending`。");
      return;
    }
    await reply(["**⏰ 定时任务**", ...jobs.map(cronLine)].join("\n\n"));
    return;
  }

  if (sub === "add") {
    // The expression is the first five tokens; everything after is the prompt.
    const tokens = args.split(/\s+/).slice(1);
    if (tokens.length < 6) {
      await reply("用法：`/cron add <分> <时> <日> <月> <周> <提示词>`，例如 `/cron add 0 6 * * * 总结 GitHub trending`。");
      return;
    }
    const expression = tokens.slice(0, 5).join(" ");
    const prompt = tokens.slice(5).join(" ");
    try {
      nextCronTime(expression, Date.now());
      const job = cron.add({
        chatId: context.chatId,
        topicKey: context.topicKey,
        expression,
        prompt,
        createdBy: context.senderId,
      });
      cron.flush();
      await reply(
        `已创建定时任务 \`${job.id}\`：\`${job.expression}\`，下次 ${formatCronTime(job.nextRunAt)}。\n每次运行使用新会话，结果发到本会话。`,
      );
    } catch (error) {
      await reply("创建定时任务失败：" + (error instanceof Error ? error.message : String(error)));
    }
    return;
  }

  if (sub === "remove" || sub === "on" || sub === "off" || sub === "run") {
    if (!tail) {
      await reply(`用法：\`/cron ${sub} <任务 id>\`。先发 \`/cron list\` 查看 id。`);
      return;
    }
    if (sub === "remove") {
      const job = cron.remove(tail);
      cron.flush();
      await reply(job ? `已删除定时任务 \`${job.id}\`。` : "没有找到唯一匹配的任务 id。");
      return;
    }
    if (sub === "on" || sub === "off") {
      const job = cron.setEnabled(tail, sub === "on");
      cron.flush();
      await reply(
        job
          ? `定时任务 \`${job.id}\` 已${sub === "on" ? "启用" : "暂停"}${job.nextRunAt ? "，下次 " + formatCronTime(job.nextRunAt) : ""}。`
          : "没有找到唯一匹配的任务 id。",
      );
      return;
    }
    const job = cron.resolveId(tail);
    if (!job) {
      await reply("没有找到唯一匹配的任务 id。");
      return;
    }
    void cron.runNow(tail).catch(() => undefined);
    await reply(`已触发定时任务 \`${job.id}\`，结果会发到本会话。`);
    return;
  }

  await reply("用法：`/cron list`、`/cron add <表达式> <提示词>`、`/cron remove|on|off|run <id>`。");
}
