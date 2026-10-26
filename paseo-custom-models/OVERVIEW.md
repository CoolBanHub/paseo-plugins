# 自定义模型（custom-models）

把自有 API Key 的模型——DeepSeek、GLM、Kimi、通义千问，或任意 Anthropic / OpenAI 兼容端点（vLLM、Ollama、OpenRouter 等）——加入 Paseo 内置 Claude provider 的模型选择器。在 Paseo 里随意选模型开 Claude Code 会话，请求经插件内置的本机代理桥按所选模型路由到对应厂商。

## 工作原理

- **配置与密钥**：全部存在 `$PASEO_HOME/plugin-data/custom-models/`——`providers.json`（0600）与 `keys/<id>.secret`（0600）。API Key 不进 Paseo 配置、不回传渲染端（界面只显示末四位提示）。
- **模型注入**：通过 `paseo.config.patch` 写入 Claude provider 的 `additionalModels`。菜单 ID 带 `cm:` 前缀（如 `cm:glm-4.6`），description 带「自定义模型 · 」标记用于幂等同步；用户自己在设置里加的条目永远保留。
- **请求路由**：`agent.create` 标记选中的模型，`agent.session_open` 钩子把会话 env 的 `ANTHROPIC_BASE_URL` 指向插件内置的 127.0.0.1 代理桥，并注入每会话随机的 capability 作为 `ANTHROPIC_AUTH_TOKEN`（桥只存其 SHA-256）。桥按每个请求 body 里的 `model` 字段找到所属 Provider，带用户自己的 Key 直连厂商。
- **协议**：Anthropic 兼容端点（DeepSeek/GLM/Kimi/百炼等）原样直通；OpenAI Chat 兼容端点经 Anthropic↔Chat 协议转换（转换器与 SSE 工具移植自 cc-switch / paseo-team-work 的同源实现，MIT 许可）。
- **会话环境**：同时设置 `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL`（强/快模型按 `-pro/-max` 与 `-air/-flash/-mini` 等后缀识别）、按真实上下文窗口设置 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` / `CLAUDE_CODE_MAX_CONTEXT_TOKENS`，并清空继承的 `ANTHROPIC_*` / `AWS_*` / `DEEPSEEK_*` 等凭据，避免串线。
- **reload 连续性**：桥的端口与路由哈希持久化在 `bridge-state.json`；插件重载后重新绑定同一端口并恢复路由，已开的自定义模型会话继续工作（仅在途请求会失败一次）。

## 前置条件

- Paseo ≥ 0.11.4，且 Claude provider 可用（已安装 Claude Code）；
- 至少一个厂商的 API Key，或一个自建的兼容端点（本地 http 端点仅允许回环地址）。

## 使用

1. Paseo 设置 → 自定义模型：选择预设（DeepSeek / GLM / Kimi / 通义千问 / 自定义）→ 填 API Key → 核对模型 ID 列表 → 保存；
2. 新建会话时，在 Claude 的模型选择器里选择描述为「自定义模型 · 〈Provider〉」的条目；
3. 会话的请求会路由到对应厂商；切换到另一个自定义模型建议新开会话（见已知限制）。

## 行为细节

- 预设端点：DeepSeek `https://api.deepseek.com/anthropic`、GLM `https://open.bigmodel.cn/api/anthropic`、Kimi `https://api.moonshot.ai/anthropic`、通义千问 DashScope Claude Code 代理；预设只是表单初始值，端点 / 鉴权 / 模型列表全部可改（厂商改模型 ID 很频繁，模型列表以用户填写为准）。
- 同一模型 ID 被多个 Provider 列出时，先配置的 Provider 提供该菜单项并承接路由。
- `count_tokens`：Anthropic 协议透传，厂商返回 404/405 或 Chat 协议时按本地估算回答。
- 上游错误按 Anthropic 错误形状回给 Claude Code，状态码保留；上下文超限映射为 `invalid_request_error` + "prompt is too long" 以触发自动压缩。
- 桥只接受 `Host: 127.0.0.1:<port>`、无 `Origin`、Bearer capability 匹配的请求；`anthropic-beta` 头按白名单（prompt-caching / interleaved-thinking）过滤后转发。
- 禁用或删除 Provider 后菜单条目立即移除；仍开着的相关会话，下一条请求会收到明确错误。
- 插件被禁用 / 卸载时，自动从 Claude 的模型选择器移除自己的条目。

## 开发与验证

```bash
npm install
npm test          # 含端到端桥测试（真实回环 socket + mock 厂商）
npm run typecheck
```

改动后执行 `paseo plugin reload custom-models`（桥自动恢复端口与路由；建议避开正在流式输出的自定义模型会话）。

## 已知限制

- 只注入 Claude provider 的模型选择器；Codex 菜单不支持（Codex 需要命令行分发脚本与模型目录，见 paseo-team-work 的实现）。
- 会话中途切换到另一个自定义模型：Claude Code 可能因不认识该模型名而拒绝（`/model` 校验）；桥按请求内的 model 字段路由，能切换则生效，稳妥做法是新开会话。
- 每个会话只属于一个路由，但请求按模型实时路由：Provider 配置变更（换 Key、改端点）对下一条请求立即生效。
- 不做多租户 / 服务端聚合：每个 Key 从本机直连厂商，用量与计费看厂商后台。
- `purpose: "history"` 的回放会话不走路由、不需要 Key。
