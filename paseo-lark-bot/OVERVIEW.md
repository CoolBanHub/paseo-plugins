# 飞书机器人（lark-bot）

把飞书机器人接入 Paseo：在设置里为每个飞书会话（群聊或单聊）指定一个 provider，在群里 @ 机器人（或单聊直接发消息）即由该 provider 的智能体处理，结果以**话题回复**的形式回到被 @ 的那条消息下。

## 工作方式

```
飞书（WebSocket 事件订阅，经 lark-cli）
  └→ lark-cli event consume im.message.receive_v1（插件管理的长驻子进程，NDJSON 流）
       └→ 路由：chat_id → 绑定的 provider / cwd / systemPrompt / 回复格式
            └→ 每个话题（thread）一个智能体会话：话题内共享上下文串行处理，不同话题并行互不干扰
                 └→ agent.turn_ended 统一回复：lark-cli im +messages-reply 挂回原消息话题
权限请求 → 只通知到群（打开 Paseo 处理），批准后轮次继续，完成结果仍回到原话题
```

- 事件订阅走 lark-cli 的长连接模式，插件只需本机能跑 lark-cli 并访问 `open.feishu.cn`，无需公网地址。
- 回复统一由 `agent.turn_ended` 驱动：权限批准后的继续执行、超过 10 分钟仍在跑的轮次，完成后都会回到原话题。
- 群聊需要 @ 机器人；单聊（p2p）直接发消息即触发；只处理 text / post 消息，其他类型忽略。
- 其他机器人 @ 本机器人也会响应（支持群内 agent 协作）；插件自身发出的消息不会再触发自己。

## 前置条件

- Paseo ≥ 0.11.4；
- 已安装 lark-cli 并完成应用凭证配置（`lark-cli config init`，凭证存于系统钥匙串）；
- 飞书开发者后台（该 appId）：
  - 事件订阅切换为**长连接**方式，并添加事件 `im.message.receive_v1`（接收消息）；
  - 权限至少包含：`im:message:send_as_bot`（以机器人身份回复）、`im:message.p2p_msg:readonly`（接收单聊消息）、`im:message.group_at_msg:readonly`（接收群里被 @ 的消息）、`im:message.group_at_msg.include_bot:readonly`（接收群里其他机器人 @ 本机器人的消息）、`application:bot.basic_info:read`（读取机器人信息）；
- 机器人已被拉进目标群（单聊则需用户能搜到该机器人）。

## 设置

host 级设置（`lark_bot`，version 1），在 Paseo 设置里的「飞书机器人」界面配置：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `larkCliPath` | `""` | lark-cli 绝对路径；空表示自动发现（PATH → nvm → Homebrew → /usr/local） |
| `replyInThread` | `true` | 回复进被 @ 消息的话题；关闭则回复到消息流 |
| `sessionIdleMinutes` | `30` | 话题空闲多少分钟后该话题新建智能体会话（0 表示一直复用） |
| `maxReplyChars` | `4000` | 回复超过该长度截断并提示打开 Paseo 查看 |
| `notifyUnmatched` | `false` | 未绑定的会话 @ 机器人时是否回复配置提示 |
| `chats[]` | `[]` | 会话绑定列表，每项含 `chatId`、`chatName`、`provider`（可带 `/model`）、`cwd`、`systemPrompt`、`replyFormat` |

- 绑定列表为空时事件监听不启动；保存设置即生效（监听进程随绑定列表启停）。
- 回复格式：`markdown`（默认，排版最佳）/ `text`（原样纯文本）/ `post`（富文本，保留 `<at user_id=…>` 以 @ 群里其他机器人，实现 agent 接力）。
- 设置界面的会话选择器来自 lark-cli 的群列表；单聊的 chat_id 拿不到，可先给机器人发条消息，再从「添加会话」的“最近发过消息”里一键添加。

## 行为细节

- 会话按话题隔离：群里新 @ 机器人的消息开启新话题、新建智能体；在某条消息的话题内继续回复（root 消息相同）则复用该话题的智能体，上下文连续。同一话题内串行处理（上一轮未结束时新消息排队，排队状态在设置界面可见），不同话题并行；一轮卡死超过 30 分钟后自动重建该话题的会话；
- 处理中发起权限请求时，群里收到「🔐 智能体需要确认」通知，请在 Paseo 客户端里批准 / 拒绝，处理完成后结果自动回到原话题；
- 回复内容为该轮最后一条助手消息；中英文混排时会剔除混在答案前的英文推理句（同 lark-notify）；无文本回复时提示打开 Paseo 查看时间线；
- 事件子进程异常退出后按指数退避自动重启（1s → 60s 封顶）；发送失败只写插件日志（`paseo plugin logs lark-bot`）；
- 创建的智能体会话标题为「飞书 · 会话名 · 任务摘要」，带 `lark-bot-chat` / `lark-bot-topic` 标签，可在 Paseo 客户端中查看完整时间线并手动接管。

## 开发与验证

```bash
npm install
npm test
npm run typecheck
```

改动后执行 `paseo plugin reload lark-bot`（会重启事件监听与所有进行中的轮次等待，不影响 Paseo 里已有的智能体会话）。

## 已知限制

- 只处理文本类消息（text / post），图片、文件、卡片等类型忽略；
- post 消息的入站内容为 lark-cli 预渲染文本，排版细节以实际渲染为准；
- 机器人自己发起的回复不会触发其他会话轮次，但若 post 回复中 @ 了其他机器人，对方 agent 的响应由对方的接入方处理；
- 与 lark-notify 同时启用时，本插件创建的会话轮次结束也会触发 lark-notify 的私聊通知（可在 lark-notify 设置里关闭）；
- daemon 重启后，需要一次任意的智能体活动或打开一次设置界面，插件才能拿到 PaseoApi 句柄并开始处理消息。
