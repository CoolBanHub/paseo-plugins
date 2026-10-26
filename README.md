# paseo-plugins

Paseo 插件集合：把本地编码智能体注册为 [Paseo](https://github.com/getpaseo) 的原生 provider，或为 Paseo 工作区补充新的面板——智能体与 Claude Code、Codex 等并列出现，可以发起会话、发送 prompt、查看时间线（推理、工具调用、回复）、应答权限确认，并在 Paseo 内切换模型与模式。

## 插件一览

| 目录 | 插件 ID | 说明 | 额外依赖 |
| --- | --- | --- | --- |
| [`paseo-dsh/`](paseo-dsh/) | `dsh` | 通过 dsh 的 ACP 接口（`dsh --profile acp`）把 DeepSeek 编码智能体 [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) 接入 Paseo：独立切换 Agent 模式（标准 / PTC / 极简 / 创造）与权限预设，PTC 模式下每个子工具调用都展开为独立时间线行 | dsh（npx 缓存 / 全局 / `DSH_BIN`）、DeepSeek 账号、Node 版本见环境要求 |
| [`paseo-git/`](paseo-git/) | `git-manager` | IDEA 风格的 Git 面板：左侧分支 / 标签 / Worktree 树，右侧提交图谱（车道着色、合并斜线、徽章）与提交详情，筛选条（分支 / 作者 / 日期 / 路径 / 文本），fetch / pull，以及可配置的网络代理设置 | `git` 在 PATH 上 |
| [`paseo-zcode/`](paseo-zcode/) | `zcode` | 通过本地 `zcode app-server --stdio` 协议把 ZCode（GLM）接入 Paseo，会话与桌面端共享；附带智谱 Coding Plan 配额的用量展示 | macOS + ZCode 桌面端（`zcode login`） |
| [`paseo-lark-notify/`](paseo-lark-notify/) | `lark-notify` | 把「需要你确认」与「会话结束」通过 `lark-cli` 以机器人身份私聊发到飞书，覆盖 Paseo 内所有 provider | `lark-cli`（已登录，机器人可私聊） |
| [`paseo-claude-models/`](paseo-claude-models/) | `claude-models` | 把自有 API Key 的模型（DeepSeek、GLM、Kimi、通义千问及任意 Anthropic / OpenAI 兼容端点）注入 Claude provider 的模型选择器：会话经内置本机代理桥按所选模型路由到对应厂商，Anthropic 协议直通、OpenAI Chat 协议自动转换 | 各厂商 API Key（或自建 vLLM / Ollama 等端点）、Claude provider 可用 |

每个插件目录内都有各自的 `OVERVIEW.md`，详细说明架构、能力边界、环境要求与已知限制。

## 环境要求

下表从各插件的 `paseo-plugin.json` 和 `package.json` 生成，CI 会检查是否过期。Paseo 要求表示声明的宿主兼容范围；开发 SDK 版本不代表已在所有宿主版本上完成实测。额外 Node 要求用于 dsh 子进程，其他插件使用 Paseo 宿主运行时。

<!-- plugin-requirements:start -->
| 目录 | 插件 ID | 显示名称 | Paseo 要求 | 开发 SDK | 额外 Node 要求 |
| --- | --- | --- | --- | --- | --- |
| [paseo-claude-models/](paseo-claude-models/) | `claude-models` | Claude 自定义模型 | `>=0.11.4` | `0.12.0` | — |
| [paseo-dsh/](paseo-dsh/) | `dsh` | dsh (DeepSeek) | `>=0.12.0` | `0.12.0` | `>=22.15.0` |
| [paseo-git/](paseo-git/) | `git-manager` | Git 管理 | `>=0.11.4` | `0.11.4` | — |
| [paseo-lark-notify/](paseo-lark-notify/) | `lark-notify` | 飞书通知 | `>=0.11.4` | `0.12.0` | — |
| [paseo-zcode/](paseo-zcode/) | `zcode` | ZCode（GLM） | `>=0.11.4` | `0.11.4` | — |
<!-- plugin-requirements:end -->

各插件自身的其他依赖与限制见上表及对应 `OVERVIEW.md`。

## 安装

在 Paseo 中把这些目录作为本地插件添加（Paseo 设置 > Plugins > 添加本地插件，指向对应插件目录），或直接把本仓库克隆到 Paseo 的插件目录。插件 ID 分别为 `dsh`、`git-manager`、`zcode`、`lark-notify`、`claude-models`。

## 开发

开发与 CI 使用根目录 `.node-version` 固定的 Node 版本。GitHub Actions 在 push、PR 和手动触发时，先校验元数据，再自动发现所有插件并分别检查：`npm ci` → `npm run typecheck` → `npm test`。

每个插件是独立的 npm 包，在各自目录内安装依赖并开发：

```bash
cd paseo-dsh   # 或 paseo-git / paseo-zcode / paseo-lark-notify / paseo-claude-models
npm install
npm test          # 回归测试（git 插件使用临时目录内的真实 git 仓库作为 fixture）
npm run typecheck # TypeScript 检查
```

类型检查包含 `.ts`、`.tsx` 和 `.mts`，也覆盖 dsh 的手动诊断脚本；ZCode 现有 `.cjs` 测试继续通过 `npm test` 执行，尚未纳入静态类型检查。CI 使用 mock、临时文件和本机回环服务，不执行需要真实账号的诊断脚本，也不代表完成了真实 Paseo 客户端验收。

在根目录运行 `node scripts/check-metadata.mjs` 可检查插件 ID、显示名称、版本与锁文件声明、打包入口以及 OVERVIEW 环境要求；修改元数据后运行 `node scripts/check-metadata.mjs --write` 更新上面的环境表。校验器的回归测试通过 `node --test scripts/*.test.mjs` 执行。

行为改动的提交或 PR 说明应记录自动检查结果、真实客户端操作和结果，并明确列出尚未验证项；需要截图时可放入已忽略的 `artifacts/acceptance/日期-主题/` 目录。要让 CI 阻止不合格的远端合并，还需在 GitHub 分支规则中将对应检查设为必需。

修改插件后，在 Paseo 中执行 `paseo plugin reload <插件ID>` 重新加载：

- `dsh` / `git-manager` / `lark-notify`：直接 reload 即可；
- `claude-models`：reload 会重启本机代理桥（自动恢复端口与路由），建议避开正在流式输出的自定义模型会话；
- `zcode`：reload 会断开所有进行中的 ZCode 会话，建议使用 `npm run reload:check` 检查存活智能体、`npm run reload` 安全重载（有智能体运行时拒绝重载）。

文档、测试或开发脚本的改动不需要 reload。

## 仓库结构

```
paseo-plugins/
├── paseo-claude-models/ # 自定义模型注入插件（claude-models）
├── paseo-dsh/    # dsh (DeepSeek) provider 插件
├── paseo-git/    # Git 管理面板插件（git-manager）
├── paseo-lark-notify/ # 飞书私聊通知插件（lark-notify）
└── paseo-zcode/  # ZCode (GLM) provider 插件
```
