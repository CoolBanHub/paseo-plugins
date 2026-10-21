# paseo-plugin

Paseo 插件集合：把本地编码智能体注册为 [Paseo](https://github.com/getpaseo) 的原生 provider，使其与 Claude Code、Codex 等并列出现在 Paseo 中——可以发起会话、发送 prompt、查看时间线（推理、工具调用、回复）、应答权限确认，并在 Paseo 内切换模型与模式。

## 插件一览

| 目录 | 插件 | 说明 |
| --- | --- | --- |
| [`paseo-dsh/`](paseo-dsh/) | dsh (DeepSeek) | 通过 dsh 的 ACP 接口（`dsh --profile acp`）把 DeepSeek 编码智能体 [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) 接入 Paseo，支持权限模式注入与 prompt 引导的计划模式 |
| [`paseo-zcode/`](paseo-zcode/) | zcode (GLM) | 通过本地 `zcode app-server --stdio` 协议把 ZCode（GLM）接入 Paseo，并附带智谱 Coding Plan 配额的用量展示 |

每个插件目录内都有各自的 `OVERVIEW.md`，详细说明架构、能力边界、环境要求与已知限制。

## 环境要求

- Paseo >= 0.11.4
- 各插件自身的依赖见对应 `OVERVIEW.md`（如 Node 18+、ZCode 桌面端、dsh 安装方式等）

## 开发

每个插件是独立的 npm 包，在各自目录内安装依赖并开发：

```bash
cd paseo-dsh && npm install      # 或 cd paseo-zcode
npm test          # 回归测试（zcode / dsh 均支持）
npm run typecheck # TypeScript 检查
```

修改插件后，在 Paseo 中执行 `paseo plugin reload <id>` 重新加载（zcode 另有 `npm run reload:check` / `npm run reload` 安全重载脚本，会在有智能体运行时拒绝重载）。
