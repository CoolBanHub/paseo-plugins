import { DSH_DEFAULT_PERMISSION, DSH_PERMISSION_OPTIONS, isDshProvider, type BotValues, type ChatBinding } from "../shared/settings.ts";
import type {
  SessionAgentSummary,
  SessionProviderSnapshot,
  SessionRunResult,
  TopicOverrides,
} from "./sessions.ts";
import type { LarkChatBot, LarkChatDirectoryEntry } from "./lark.ts";
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
  bots: "bots",
  机器人: "bots",
  members: "members",
  成员: "members",
  agents: "agents",
  智能体: "agents",
  delegate: "delegate",
  委派: "delegate",
  issues: "issues",
  问题列表: "issues",
  issue: "issue",
  问题: "issue",
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
    "`/bots` 查看群内机器人及其 open_id（用富文本 @ 转交任务）",
    "`/members [关键词]` 搜索群成员（含机器人），返回 open_id 用于 @",
    "`/agents` 列出可委派的 Paseo Agent（需在绑定里开启 Agent 委派）",
    "`/delegate <id|前缀> <任务>` 把任务交给其他 Paseo Agent 并等待结果（需开启）",
    "`/issues [mine|pending|all]` 查看本群的问题/需求台账（默认未关闭）",
    "`/issue done [说明]` 把当前话题标记为待验收；`/issue release` 标记已发布",
    "`/issue close [原因]` 关闭当前话题的问题记录",
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

export interface CommandIssueActions {
  /** Formatted list for `/issues`; filter is open|mine|pending|all. */
  query: (filter: string, senderId: string) => Promise<string>;
  /** Current topic's ledger status/URL. */
  status: () => Promise<string>;
  done: (summary: string) => Promise<string>;
  release: () => Promise<string>;
  close: (reason: string) => Promise<string>;
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
  /** Optional issue-ledger actions; omitted when tracking is not configured. */
  issue?: CommandIssueActions;
  /** Group bots for /bots; omitted when the host cannot list members. */
  listBots?: () => Promise<LarkChatBot[]>;
  /** Users + bots for /members; omitted when the host cannot list members. */
  listMembers?: (query: string) => Promise<LarkChatDirectoryEntry[]>;
  /** Paseo agents for /agents and /delegate; omitted on older hosts. */
  listAgents?: () => Promise<SessionAgentSummary[]>;
  delegateAgent?: (agentId: string, task: string) => Promise<SessionRunResult>;
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
    case "bots":
      await runBotsCommand(context);
      return;
    case "members":
      await runMembersCommand(context, args);
      return;
    case "agents":
      await runAgentsCommand(context);
      return;
    case "delegate":
      await runDelegateCommand(context, args);
      return;
    case "issues": {
      if (!context.issue) {
        await reply("本会话还没有启用问题跟踪；请让管理员在「飞书机器人 → 问题跟踪」里创建或配置跟踪表。");
        return;
      }
      const filter = (args.split(/\s+/)[0] || "open").toLowerCase();
      const normalized = ["open", "mine", "pending", "all"].includes(filter) ? filter : "open";
      await reply(await context.issue.query(normalized, context.senderId));
      return;
    }
    case "issue": {
      if (!context.issue) {
        await reply("本会话还没有启用问题跟踪；请让管理员在「飞书机器人 → 问题跟踪」里创建或配置跟踪表。");
        return;
      }
      const [sub, ...rest] = args.split(/\s+/).filter(Boolean);
      const tail = rest.join(" ");
      if (!sub || sub === "status") {
        await reply(await context.issue.status());
        return;
      }
      if (sub === "done") {
        await reply(await context.issue.done(tail));
        return;
      }
      if (sub === "release") {
        await reply(await context.issue.release());
        return;
      }
      if (sub === "close") {
        await reply(await context.issue.close(tail));
        return;
      }
      await reply("用法：`/issue` 查看状态，`/issue done [说明]` 待验收，`/issue release` 已发布，`/issue close [原因]` 关闭。");
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

async function runBotsCommand(context: CommandContext): Promise<void> {
  const { reply } = context;
  if (!context.listBots) {
    await reply("当前宿主不支持读取群机器人。");
    return;
  }
  try {
    const bots = await context.listBots();
    if (bots.length === 0) {
      await reply("没有读到其他机器人；可能需要 `im:chat.members:read` 权限，或群里只有我自己。");
      return;
    }
    const lines = bots.slice(0, 20).map((bot, index) => {
      const name = bot.name || `机器人${index + 1}`;
      return `- [机器人] ${name} · \`${bot.openId}\`${bot.appId ? ` · app \`${bot.appId}\`` : ""}`;
    });
    if (bots.length > 20) lines.push(`…还有 ${bots.length - 20} 个未列出。`);
    await reply(
      [
        `**群内机器人（${bots.length}）**`,
        ...lines,
        "",
        "要让它们干活：绑定「回复格式」选 `post`（富文本@），在回复里写 `<at user_id=\"ou_xxx\">名称</at> 任务内容`。",
      ].join("\n"),
    );
  } catch (error) {
    await reply(`读取群机器人失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runMembersCommand(context: CommandContext, args: string): Promise<void> {
  const { reply } = context;
  if (!context.listMembers) {
    await reply("当前宿主不支持读取群成员。");
    return;
  }
  const query = args.trim();
  try {
    const entries = await context.listMembers(query);
    if (entries.length === 0) {
      await reply(
        query
          ? `没有找到匹配「${query}」的群成员。`
          : "没有读到群成员；可能需要 `im:chat.members:read` 权限。",
      );
      return;
    }
    const lines = entries.slice(0, 30).map((entry, index) => {
      const kind = entry.kind === "bot" ? "[机器人]" : "[成员]";
      const name =
        entry.name || (entry.kind === "bot" ? `机器人${index + 1}` : `成员${index + 1}`);
      const app = entry.appId ? ` · app \`${entry.appId}\`` : "";
      return `- ${kind} ${name} · \`${entry.openId}\`${app}`;
    });
    if (entries.length > 30) lines.push(`…还有 ${entries.length - 30} 个未列出，缩小关键词再搜。`);
    await reply(
      [
        `**群成员（${entries.length}）${query ? ` · 关键词「${query}」` : ""}**`,
        ...lines,
        "",
        "要 @ 谁：绑定回复格式选 `post`，在回复里写 `[[@名字]]` 或精确的 `@名字`（插件会换成真正的 @）；也可以直接写 `<at user_id=\"ou_xxx\">名字</at>`。只 @ 需要的人，不要 @ 所有人。",
      ].join("\n"),
    );
  } catch (error) {
    await reply(`读取群成员失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runAgentsCommand(context: CommandContext): Promise<void> {
  const { reply } = context;
  if (!context.binding.allowAgentDelegation) {
    await reply("本会话未开启 Agent 委派。可在绑定的「会话设置」里打开「允许 /delegate 调用其他 Paseo Agent」。");
    return;
  }
  if (!context.listAgents) {
    await reply("当前宿主不支持列出 Paseo Agent。");
    return;
  }
  try {
    const agents = (await context.listAgents()).filter((agent) => agent.id !== context.session.agentId);
    if (agents.length === 0) {
      await reply("没有可委派的 Paseo Agent（本插件的话题会话和辅助会话已排除）。");
      return;
    }
    const lines = agents.slice(0, 20).map((agent, index) => {
      const title = agent.title || `Agent ${index + 1}`;
      const provider = agent.provider || "unknown";
      const model = agent.model && !provider.includes("/") ? `/${agent.model}` : "";
      const status = agent.status || "unknown";
      return `- \`${agent.id.slice(0, 8)}\` · ${title} · ${provider}${model} · ${status}`;
    });
    if (agents.length > 20) lines.push(`…还有 ${agents.length - 20} 个未列出。`);
    await reply(
      [
        `**可委派的 Paseo Agent（${agents.length}）**`,
        ...lines,
        "",
        "用 `/delegate <id 前 8 位> <任务>` 派活；目标 Agent 的权限和工作目录由它自己决定。",
      ].join("\n"),
    );
  } catch (error) {
    await reply(`读取 Agent 列表失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runDelegateCommand(context: CommandContext, args: string): Promise<void> {
  const { reply } = context;
  if (!context.binding.allowAgentDelegation) {
    await reply("本会话未开启 Agent 委派。可在绑定的「会话设置」里打开「允许 /delegate 调用其他 Paseo Agent」。");
    return;
  }
  if (!context.listAgents || !context.delegateAgent) {
    await reply("当前宿主不支持把任务委派给 Paseo Agent。");
    return;
  }
  const [targetArg, ...rest] = args.split(/\s+/).filter(Boolean);
  const task = rest.join(" ");
  if (!targetArg || !task) {
    await reply("用法：`/delegate <id 或前 8 位> <任务>`。先发 `/agents` 查看可委派的 Agent。");
    return;
  }

  let agents: SessionAgentSummary[];
  try {
    agents = (await context.listAgents()).filter((agent) => agent.id !== context.session.agentId);
  } catch (error) {
    await reply(`读取 Agent 列表失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const normalized = targetArg.toLowerCase();
  const exact = agents.find((agent) => agent.id === targetArg);
  const matches = exact
    ? [exact]
    : agents.filter(
        (agent) =>
          agent.id.startsWith(targetArg) || (agent.title ?? "").toLowerCase() === normalized,
      );
  if (matches.length === 0) {
    await reply(`没有找到 Agent \`${targetArg}\`。发送 \`/agents\` 查看可用列表。`);
    return;
  }
  if (matches.length > 1) {
    const lines = matches.slice(0, 10).map((agent) => `- \`${agent.id.slice(0, 8)}\` · ${agent.title || "未命名"}`);
    await reply([`\`${targetArg}\` 匹配到多个 Agent，请用更长的 id：`, ...lines].join("\n"));
    return;
  }
  const target = matches[0]!;
  if (target.id === context.session.agentId) {
    await reply("不能把任务委派给当前正在处理这条消息的 Agent。");
    return;
  }

  const title = target.title || target.id.slice(0, 8);
  await reply(
    `已把任务交给 **${title}**（\`${target.id.slice(0, 8)}\`）${target.status === "running" ? "，它当前在忙，任务会排队" : ""}，等待完成…`,
  );
  let result: SessionRunResult;
  try {
    result = await context.delegateAgent(target.id, task);
  } catch (error) {
    await reply(`委派失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (result.status === "idle") {
    await reply(
      result.lastMessage
        ? `**${title} 已完成**\n\n${result.lastMessage}`
        : `**${title} 已完成**，但没有返回文本；可到 Paseo 查看它的时间线。`,
    );
    return;
  }
  if (result.status === "permission") {
    await reply(
      `**${title}** 正在等待权限确认，请到 Paseo 处理；本次没有拿到最终回复，处理后可重新发送 /delegate 或查看它的时间线。`,
    );
    return;
  }
  if (result.status === "timeout") {
    await reply(`等待 **${title}** 超时；任务可能仍在运行，可到 Paseo 查看时间线。`);
    return;
  }
  await reply(`**${title}** 执行失败：${result.error || "未知错误"}`);
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
