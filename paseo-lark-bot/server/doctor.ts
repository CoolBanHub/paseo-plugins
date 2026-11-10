import { accessSync, constants, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatCronTime } from "./cron.ts";

/**
 * `/doctor`: a chat-side self check for the failure modes that otherwise
 * degrade silently — missing lark-cli, stopped event consumers, no card
 * callback subscription, absent bot identity, no provider snapshot.
 */

export type DoctorLevel = "pass" | "warn" | "fail";

export interface DoctorCheck {
  level: DoctorLevel;
  label: string;
  detail: string;
}

const ICONS: Record<DoctorLevel, string> = { pass: "✅", warn: "⚠️", fail: "❌" };

export function renderDoctorReport(checks: DoctorCheck[]): string {
  const lines = ["**🩺 飞书机器人自检**", ""];
  for (const check of checks) {
    lines.push(`${ICONS[check.level]} **${check.label}**：${check.detail}`);
  }
  const failed = checks.filter((check) => check.level === "fail").length;
  const warned = checks.filter((check) => check.level === "warn").length;
  lines.push("");
  lines.push(failed > 0 ? `共 ${failed} 项失败、${warned} 项警告。` : warned > 0 ? `通过，另有 ${warned} 项警告。` : "全部检查通过。");
  return lines.join("\n");
}

export function checkDataDir(dir: string): DoctorCheck {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.doctor-${process.pid}`);
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    return { level: "pass", label: "数据目录", detail: dir + " 可写" };
  } catch (error) {
    return {
      level: "fail",
      label: "数据目录",
      detail: `不可写：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function checkFfmpeg(path: string | null): DoctorCheck {
  if (!path) {
    return {
      level: "warn",
      label: "ffmpeg",
      detail: "未找到，视频只能记录为占位（图片不受影响）",
    };
  }
  try {
    accessSync(path, constants.X_OK);
    return { level: "pass", label: "ffmpeg", detail: path };
  } catch {
    return { level: "warn", label: "ffmpeg", detail: path + " 不可执行" };
  }
}

export interface DoctorDeps {
  cliPath: string | null;
  cliVersion: string | null;
  currentAppId: string | null;
  botOpenId: string | null;
  consumerState: string;
  consumerError: string | null;
  cardConsumerState: string;
  cardConsumerError: string | null;
  bindingCount: number;
  providerCount: number;
  ffmpegPath: string | null;
  pluginDataDir: string;
  cronJobs: { expression: string; nextRunAt: number | null; enabled: boolean; lastError: string | null }[];
  pendingQuestions: number;
}

export function runDoctorChecks(deps: DoctorDeps): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  if (!deps.cliPath) {
    checks.push({ level: "fail", label: "lark-cli", detail: "未找到，可在全局设置填写绝对路径" });
  } else if (!deps.cliVersion) {
    checks.push({ level: "warn", label: "lark-cli", detail: deps.cliPath + " 无法读取版本" });
  } else {
    const old = compareVersions(deps.cliVersion, "1.0.98") < 0;
    checks.push({
      level: old ? "warn" : "pass",
      label: "lark-cli",
      detail: deps.cliPath + " · " + deps.cliVersion + (old ? "（扫码创建应用需要 ≥ 1.0.98）" : ""),
    });
  }

  checks.push(
    deps.currentAppId
      ? { level: "pass", label: "应用", detail: deps.currentAppId }
      : { level: "fail", label: "应用", detail: "没有可用的 App ID：填写凭证或用「使用 lark-cli 当前应用」" },
  );

  checks.push(
    deps.botOpenId
      ? { level: "pass", label: "机器人身份", detail: deps.botOpenId }
      : { level: "warn", label: "机器人身份", detail: "尚未读到 open_id，群聊 @ 识别不可用" },
  );

  if (deps.consumerState === "ready") {
    checks.push({ level: "pass", label: "消息监听", detail: "长连接就绪" });
  } else if (deps.consumerState === "starting") {
    checks.push({ level: "warn", label: "消息监听", detail: "正在连接" });
  } else {
    checks.push({
      level: "fail",
      label: "消息监听",
      detail: `${deps.consumerState}${deps.consumerError ? "：" + deps.consumerError : ""}`,
    });
  }

  if (deps.cardConsumerState === "ready") {
    checks.push({ level: "pass", label: "卡片回调", detail: "card.action.trigger 已订阅" });
  } else {
    checks.push({
      level: "warn",
      label: "卡片回调",
      detail:
        `${deps.cardConsumerState}${deps.cardConsumerError ? "：" + deps.cardConsumerError : ""}；` +
        "ask_user_question 卡片需要它；进度卡片和表情回执仍可用",
    });
  }

  checks.push(
    deps.bindingCount > 0
      ? { level: "pass", label: "会话绑定", detail: `${deps.bindingCount} 个` }
      : { level: "fail", label: "会话绑定", detail: "还没有绑定任何会话，事件监听不会启动" },
  );

  checks.push(
    deps.providerCount > 0
      ? { level: "pass", label: "Provider", detail: `${deps.providerCount} 个可用` }
      : { level: "warn", label: "Provider", detail: "Paseo 没有返回可用 provider" },
  );

  checks.push(checkFfmpeg(deps.ffmpegPath));
  checks.push(checkDataDir(deps.pluginDataDir));

  if (deps.pendingQuestions > 0) {
    checks.push({ level: "warn", label: "待答问题", detail: `${deps.pendingQuestions} 个卡片仍待回答` });
  }

  if (deps.cronJobs.length === 0) {
    checks.push({ level: "pass", label: "定时任务", detail: "未配置" });
  } else {
    const broken = deps.cronJobs.filter((job) => job.lastError);
    const next = deps.cronJobs
      .filter((job) => job.enabled && job.nextRunAt)
      .sort((left, right) => (left.nextRunAt ?? 0) - (right.nextRunAt ?? 0))[0];
    checks.push(
      broken.length > 0
        ? { level: "warn", label: "定时任务", detail: `${deps.cronJobs.length} 个，${broken.length} 个上次执行失败` }
        : {
            level: "pass",
            label: "定时任务",
            detail: `${deps.cronJobs.length} 个${next ? "，下次 " + formatCronTime(next.nextRunAt) : ""}`,
          },
    );
  }

  return checks;
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
