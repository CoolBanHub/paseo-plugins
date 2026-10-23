# paseo-plugin

Paseo 插件集合：把本地编码智能体注册为 [Paseo](https://github.com/getpaseo) 的原生 provider，或为 Paseo 工作区补充新的面板——智能体与 Claude Code、Codex 等并列出现，可以发起会话、发送 prompt、查看时间线（推理、工具调用、回复）、应答权限确认，并在 Paseo 内切换模型与模式。

## 插件一览

| 目录 | 插件 ID | 说明 | 额外依赖 |
| --- | --- | --- | --- |
| [`paseo-dsh/`](paseo-dsh/) | `dsh` | 通过 dsh 的 ACP 接口（`dsh --profile acp`）把 DeepSeek 编码智能体 [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) 接入 Paseo：独立切换 Agent 模式（标准 / PTC / 极简 / 创造）与权限预设，PTC 模式下每个子工具调用都展开为独立时间线行 | Node 18+、dsh（npx 缓存 / 全局 / `DSH_BIN`）、DeepSeek 账号 |
| [`paseo-git/`](paseo-git/) | `git-manager` | IDEA 风格的 Git 面板：左侧分支 / 标签 / Worktree 树，右侧提交图谱（车道着色、合并斜线、徽章）与提交详情，筛选条（分支 / 作者 / 日期 / 路径 / 文本），fetch / pull，以及可配置的网络代理设置 | `git` 在 PATH 上 |
| [`paseo-zcode/`](paseo-zcode/) | `zcode` | 通过本地 `zcode app-server --stdio` 协议把 ZCode（GLM）接入 Paseo，会话与桌面端共享；附带智谱 Coding Plan 配额的用量展示 | macOS + ZCode 桌面端（`zcode login`） |
| [`paseo-lark-notify/`](paseo-lark-notify/) | `lark-notify` | 把「需要你确认」与「会话结束」通过 `lark-cli` 以机器人身份私聊发到飞书，覆盖 Paseo 内所有 provider | `lark-cli`（已登录，机器人可私聊） |

每个插件目录内都有各自的 `OVERVIEW.md`，详细说明架构、能力边界、环境要求与已知限制。

## 环境要求

- [Paseo](https://github.com/getpaseo) 桌面端：`dsh` 插件要求 ≥ 0.12.0（插件协议版本与守护进程保持一致），`git-manager`、`zcode` 与 `lark-notify` 要求 ≥ 0.11.4。
- 各插件自身的依赖见上表与对应 `OVERVIEW.md`。

## 安装

在 Paseo 中把这些目录作为本地插件添加（Paseo 设置 > Plugins > 添加本地插件，指向对应插件目录），或直接把本仓库克隆到 Paseo 的插件目录。插件 ID 分别为 `dsh`、`git-manager`、`zcode`、`lark-notify`。

## 开发

每个插件是独立的 npm 包，在各自目录内安装依赖并开发：

```bash
cd paseo-dsh   # 或 paseo-git / paseo-zcode / paseo-lark-notify
npm install
npm test          # 回归测试（git 插件使用临时目录内的真实 git 仓库作为 fixture）
npm run typecheck # TypeScript 检查
```

修改插件后，在 Paseo 中执行 `paseo plugin reload <插件ID>` 重新加载：

- `dsh` / `git-manager` / `lark-notify`：直接 reload 即可；
- `zcode`：reload 会断开所有进行中的 ZCode 会话，建议使用 `npm run reload:check` 检查存活智能体、`npm run reload` 安全重载（有智能体运行时拒绝重载）。

文档、测试或开发脚本的改动不需要 reload。

## 仓库结构

```
paseo-plugin/
├── paseo-dsh/    # dsh (DeepSeek) provider 插件
├── paseo-git/    # Git 管理面板插件（git-manager）
├── paseo-lark-notify/ # 飞书私聊通知插件（lark-notify）
└── paseo-zcode/  # ZCode (GLM) provider 插件
```
