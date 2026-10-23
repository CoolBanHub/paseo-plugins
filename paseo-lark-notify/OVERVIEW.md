# 飞书通知（lark-notify）

把 Paseo 里「智能体需要你确认」和「会话结束」两件事，通过 `lark-cli` 以机器人身份私聊发到飞书。

## 为什么是插件

Paseo 的插件服务端可以订阅生命周期事件，事件是守护进程级的：Claude Code、Codex、dsh、zcode 的会话都会经过这里，所以只维护一份通知逻辑，不用给每个 provider 单独挂钩子。

用到的两个事件：

| 事件 | 触发时机 | 通知 |
| --- | --- | --- |
| `agent.permission_requested` | 智能体发起权限/计划/提问请求，等待你处理 | 🔐 需要你确认（项目、会话、请求、命令/文件等详情、可选操作） |
| `agent.closed` | 会话被关闭 | 🏁 会话结束（项目、会话、结果、轮次与耗时、最后回复、最后动作、目录） |

## 前置条件

- Paseo ≥ 0.11.4（插件协议含生命周期事件）；
- 已安装并登录 `lark-cli`（`lark-cli whoami` 能返回身份）；
- 机器人对该用户可见、可发起单聊。用户身份发送需要 `im:message.send_as_user` scope，默认不启用。

插件默认用机器人身份、接收人取 `lark-cli whoami` 的 `onBehalfOf.openId`，因此装好即可用。

## 设置

host 级设置（`lark_notify`，version 1），未配置时全部走默认值：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `openId` | `""` | 接收人 open_id；空表示用 lark-cli 登录身份 |
| `larkCliPath` | `""` | lark-cli 绝对路径；空表示自动发现（PATH → nvm → Homebrew → /usr/local） |
| `identity` | `bot` | `bot` 或 `user`；后者需要 send_as_user scope |
| `notifyPermission` | `true` | 是否通知权限请求 |
| `notifySessionEnd` | `true` | 是否通知会话结束 |
| `includeSubagents` | `false` | 子代理关闭是否也通知 |

## 行为细节

- 只通知显式结束的会话；守护进程关闭、provider reload 和会话 reload 产生的 `agent.closed` 会静默跳过；旧版 Paseo 未提供关闭原因时按显式结束处理；
- 启动后 60 秒内仍忽略无关闭原因的 `agent.closed`：兼容旧版守护进程重启时的一次性关闭，避免轰炸；
- 会话结束的「结果 / 最后回复 / 最后动作」来自本轮 `agent.turn_ended` 事件时间线，不额外拉取历史；
- 最后回复会剔除混在中文答案前的英文推理句，避免把思维链发到聊天里；
- 权限请求按 `request.id` 去重，会话关闭按 `agent.id` 去重，内存表上限 500；
- 发送失败只写插件日志（`paseo plugin logs lark-notify`），不影响智能体；
- 找不到 lark-cli 或 openId 时每类只告警一次，随后静默跳过。

## 开发与验证

```bash
npm install
npm test
npm run typecheck
```

改动后执行 `paseo plugin reload lark-notify`（只影响通知，不会断开任何会话）。

## 已知限制

- 只发私聊，不建群、不 @ 人；
- 需要守护进程所在机器能执行 lark-cli 且能访问 `open.feishu.cn`；
- 通知内容取自事件本身，不额外拉取会话时间线。
