# paseo-plugin 仓库规范

本文件面向在本仓库工作的 AI 编码智能体与贡献者，约定仓库级的协作规范。各插件目录下的 `AGENTS.md` 补充该插件特有的注意事项，优先级高于本文件。

## 语言

- 与用户沟通、提交信息、新建文档一律使用中文；代码标识符与注释遵循所在文件的既有风格（现有源码注释为英文），不回改历史内容。

## 工作流：必须使用 worktree

任何代码改动都不允许直接在主工作区的 `main` 分支上进行：

1. **开工前**：从 `main` 创建 worktree 和同名分支，在 worktree 内开发：

   ```bash
   git worktree add ../paseo-plugin-<任务名> -b <任务名> main
   ```

2. **开发中**：所有改动、测试都在 worktree 内完成。worktree 不共享主工作区的 `node_modules`，先在对应插件目录 `npm install`。

3. **完成后**：合并回 `main`，并删除任务分支与 worktree，不留残留：

   ```bash
   git merge --ff-only <任务名>      # main 有新提交时先在 worktree 内 rebase
   git worktree remove ../paseo-plugin-<任务名>
   git branch -d <任务名>
   ```

## 提交规范

- 一个提交只涉及一个插件目录，提交信息以目录名作前缀：`paseo-dsh: …`、`paseo-git: …`、`paseo-zcode: …`。
- 跨插件或纯文档（README / AGENTS / OVERVIEW）改动用 `docs: …` 等合适的前缀。
- 不把无关文件混进提交；不动任务范围之外的插件代码。

## 验证

- 合并前必须在对应插件目录内运行并确保通过：

  ```bash
  npm test
  npm run typecheck
  ```

- 本仓库没有根级 package.json：各插件是独立 npm 包，依赖安装、测试、构建都在各自目录内进行。开发与 CI 的 Node 版本由根目录 `.node-version` 固定。
- 修改插件清单、依赖或环境要求时，在根目录运行 `node scripts/check-metadata.mjs`；环境表变化后运行 `node scripts/check-metadata.mjs --write` 更新 README。校验器改动还需通过 `node --test scripts/*.test.mjs`。
- 行为改动的验收说明需记录自动检查结果、真实客户端操作及结果、尚未验证项。截图放入 `artifacts/acceptance/日期-主题/`，该目录不提交。

## 文档同步

- 插件的行为、能力边界或环境要求发生变化时，同步更新该插件的 `OVERVIEW.md`；插件清单、版本要求等首页信息变化时更新根 `README.md`。

## 其他

- 插件协议版本：各插件 `paseo-plugin.json` 的版本要求与 `@getpaseo/plugin` 依赖需与实际运行的 Paseo 守护进程保持一致（详见各 `OVERVIEW.md`）。
- 服务端代码改动需 `paseo plugin reload <插件ID>` 才生效，由用户在 Paseo 中执行；文档与测试改动无需 reload。各插件 reload 的安全注意事项见其目录内 `AGENTS.md`（尤其 `paseo-zcode`：reload 会断开所有进行中的会话，必须走 `npm run reload:check` / `npm run reload` 守护流程）。
- 推送到远端（push）只能由用户明确要求时进行。
