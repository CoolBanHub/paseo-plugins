# Git 管理 (git-manager) for Paseo

An IDEA-style Git panel for Paseo workspaces, modelled after JetBrains Git
Control: a branch tree on the left, the commit graph in the middle, a
commit-details pane below — plus a working-tree tab with the IDEA commit
flow (checked files as the commit scope, amend, stash) and inline
merge/rebase/cherry-pick banners.

## What you get

### 日志 Tab

- **分支树** — 本地 / 远程 / 标签 / Worktrees 分组；本地与远程分支按 `/`
  切段建目录树（单链目录压缩显示 `src/git`），当前分支固定在本地组首行；
  每条本地分支显示与**上游**（upstream）的领先/落后计数（↑绿 ↓蓝），
  按名称筛选；点分支名把提交历史过滤到该分支。
- **分支 ⋯ 菜单**（替代 IDEA 的右键菜单）— 检出、从此分支新建、合并到
  当前分支、将当前分支变基到它、重命名、删除（未合并需勾选强制）、
  更新（拉取）与推送（仅当前分支）。
- **标签管理** — 列出全部标签（附注/轻量标识、指向提交与说明），点击
  按标签过滤历史；支持新建（默认 HEAD，填说明则附注）与删除（仅本地引用）。
- **Worktree 管理** — 添加（目录名解析到仓库同级，可选新分支/检出既有）、
  移除（可勾选强制）、一键 `prune`；路径经 realpath 归一化。
- **提交历史** — IDEA 三段折线图谱（车道着色、merge 同心圆节点、HEAD
  光环、未加载历史的悬空箭头）、列宽拖拽与列显隐（时间/哈希/作者）、
  本地与远程同名分支合并显示的 ref 徽章（绿本地/紫远程/金标签/红 HEAD）、
  作者列；客户端搜索（信息/作者/哈希前缀）；分页加载（每页 300 条）。
- **提交 ⋯ 菜单** — 复制哈希、cherry-pick 到当前分支、检出此提交
  （分离头指针）、重置到此处（soft/mixed/hard，hard 需二次确认）、
  revert、在此提交新建分支/标签。
- **筛选条**（工具栏内联下拉）— 分支（搜索 + 本地/远程/标签）、作者
  （提交数聚合）、日期范围月历、路径（目录树浏览 + 手动输入）、文本搜索。
- **提交详情** — 完整哈希（点击复制）、父提交、作者/提交时间、正文；
  改动文件按目录分组，点击任一文件弹出该提交中此文件的行内 diff。
- **状态头** — 仓库名、当前分支与上游领先/落后、改动计数（点击切到
  改动 Tab）；fetch（`--prune`）、pull（`--ff-only`）、push、手动刷新；
  每 45 秒静默刷新。拉取/推送只提示一行摘要。

### 改动 Tab（IDEA 提交流程）

- **文件分组** — 合并冲突 / 已暂存 / 未暂存改动 / 未跟踪文件，组头
  三态勾选（全选/半选）、折叠、整组暂存/取消暂存；目录树分组默认开启
  （单链压缩 + 目录计数），可切平铺；未跟踪组可隐藏。
- **勾选即提交范围** — 勾选文件（含未跟踪）按工作区内容提交，其余
  暂存原样保留（`git commit --only`）；提交信息多行输入、amend
  （自动回填上一条信息）、最近 20 条提交信息下拉回填；提交 /
  提交并推送。
- **文件 ⋯ 菜单** — 查看差异（工作区/暂存/HEAD 对应模式）、暂存/取消
  暂存、回滚改动（未跟踪即删除文件，需确认）、复制路径。
- **冲突解决** — 冲突组内每文件可「采用本方（ours）/采用对方（theirs）」
  并自动 stage；面板顶部出现 merge/rebase（step/total）/cherry-pick
  状态横幅，提供继续（绿）/跳过（橙）/中止（红）。
- **贮藏（Stash）子 Tab** — 列出贮藏条目（标题/相对时间/文件数），
  可按勾选文件或全部贮藏（`stash push -u`，含未跟踪）、恢复（保留或
  删除贮藏）、删除。
- **行内 diff 查看器** — 自绘 unified diff（hunk 头、+绿/-红行、新旧
  行号、长行按对话框宽度自动换行），支持工作区/暂存/HEAD/任意提交/贮藏
  五种模式，超长截断与二进制提示。

### 通用

- **网络代理** — 设置页（Paseo 设置 > Git 代理）填写代理地址，
  拉取/推送时注入 `HTTP(S)_PROXY`/`ALL_PROXY`；`git@` SSH 远端可选经
  `nc` 走代理。
- 非 Git 工作区显示友好空态；git 报错以 toast 展示原文。

## How it works

- Client: a workspace panel (`addWorkspacePanel`, workspace + explorer
  locations) with a top tab bar (日志/改动). It resolves the workspace
  `directory` via `useWorkspace` and calls the daemon over typed zod RPC
  contracts (`shared/contracts.ts`).
- Server: handlers run `git` through the SDK's `execCommand`
  (`server/git-runner.ts`) with `LC_ALL=C` and `GIT_OPTIONAL_LOCKS=0`;
  every invocation also carries `-c core.quotepath=false` so non-ASCII
  paths print verbatim. Parsing lives in `server/git-ops.ts` with runner
  injection so tests exercise the real git binary. Working-tree changes
  parse `status --porcelain=v1 -z -uall` (double-status files become two
  rows); the sequence state (merge/rebase/cherry-pick) reads `.git`
  bookkeeping files (`MERGE_HEAD`, `CHERRY_PICK_HEAD`,
  `rebase-merge`/`rebase-apply`). Proxy settings apply as extra
  environment variables on every git invocation.
- The commit graph is rendered from a lane model computed client-side
  (`client/graph.ts`, gitgraph.js-style assignment) and drawn with plain
  RN Views: vertical stubs, rotated diagonals whose height equals the
  lane distance (IDEA shape), merge rings and a HEAD halo. Directory
  grouping for file/branch lists lives in `client/filetree.ts` (pure,
  tested). Host-scoped proxy settings (`shared/settings.ts`,
  `server/proxy-env.ts`).
- Safe by construction: ref/hash inputs are regex-validated before being
  passed to git, paths always travel after `--`, and `execCommand` spawns
  without a shell.

## Requirements

- `git` (>= 2.16 for pathspec stash) on the daemon's PATH.
- Paseo >= 0.11.4.

## Limits

- 没有编辑器级功能：行内 blame 注解、行号变更标记、资源管理器文件
  着色（Paseo 插件平台没有编辑器装饰 API）。
- 冲突解决为本方/对方二选一 + 继续变基/合并；没有 3-way merge 编辑器。
- Merge diffs use `--first-parent`, not combined diffs.
- Search only covers loaded pages (first 300 by default).
- Push 面板暂未做远端分支选择；推送始终针对当前分支的上游
  （`--force-with-lease` 已在服务端支持，UI 暂未暴露）。
- 标签仅管理本地引用；没有远端标签的 push/delete。
- Cherry-pick 一次一个提交（菜单逐个触发）。

## Development

`npm run typecheck`, `npm test` (real-git fixture repo in a temp dir —
covers status/porcelain v2, for-each-ref with upstream tracking, log
pagination, numstat/name-status -z ordering, checkout failures, tag/branch
management, worktree operations, changes parsing (double status/conflicts/
rename -z order), stage/unstage round-trips, checked-files commit via
`commit --only`, stash push/list/apply/drop (incl. pathspec), merge/rebase/
cherry-pick conflict flows with continue/abort, reset/revert/rollback,
diff modes with truncation, and the graph lane + IDEA segment models).
After editing, `paseo plugin reload git-manager` picks up server changes.
