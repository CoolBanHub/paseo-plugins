# paseo-custom-models 注意事项

- 服务端改动需 `paseo plugin reload custom-models`。reload 会重启本机代理桥：端口与路由会自动恢复，已开的自定义模型会话继续可用，但在途流式请求会中断一次——reload 前确认没有正在输出的自定义模型会话。
- 通过设置页（RPC）改 Provider / Key / 模型列表**无需 reload**，保存即生效并同步模型菜单。
- API Key 永远不能进 Paseo 配置、日志或 RPC 返回值：只存 `$PASEO_HOME/plugin-data/custom-models/keys/`（0600），渲染端只允许拿到 `••••` 末四位提示。
- 客户端 bundle 不得 import `server/`；client/server 共享类型与契约放 `shared/`。
- 测试用真实回环 socket + mock 厂商（`tests/bridge.test.mts`），不访问外网；store/session/sync 是纯逻辑测试，注入临时目录。
- 协议转换器（`server/protocol/`）移植自 cc-switch（MIT），保留原始版权注释，不要重写其内部实现，修 bug 时对照上游。
