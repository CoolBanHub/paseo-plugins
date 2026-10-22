# Git 管理 (git-manager) for Paseo

An IDEA-style Git panel for Paseo workspaces: branch tree on the left,
commit graph with times/hashes/authors on the right, and a commit-details
pane below — like the JetBrains Git Log view.

## What you get

- **分支树** — 本地 / 远程分组、当前分支、每条本地分支相对当前 HEAD 的
  领先/落后计数、按名称筛选；点分支名把提交历史过滤到该分支，
  点 `检出` 图标直接 `git checkout`（远程分支会按 git 默认行为建立本地跟踪分支）。
- **提交历史** — 图谱列（车道着色、合并斜线、分支头圆点）、提交时间、
  短哈希（按作者着色）、提交信息、HEAD/分支/远程/标签徽章、作者列；
  客户端搜索（提交信息 / 作者 / 哈希前缀）；分页加载（每页 300 条）。
- **筛选条**（工具栏内联下拉，同 IDEA Git Log）— 分支下拉（搜索 + 本地/远程，
  显示当前与领先落后）、作者下拉（搜索 + 提交数，从已加载提交聚合）、
  日期范围日历（快捷项：今天/昨天/最近 7 天/最近 30 天/本月，月历点选区间）、
  路径下拉（浏览仓库跟踪文件的目录树，面包屑导航 + 手动输入兜底，
  服务端 `git log -- <path>` 精确过滤）、文本搜索。工具栏放不下时自动换行。
- **提交详情** — 完整哈希（点击复制）、父提交、作者与提交时间（含相对时间）、
  正文、改动文件列表（A/M/D/R 状态、路径、增删行数、二进制标记）。
  合并提交按 first-parent 展示其带来的变更。
- **状态头** — 仓库名、当前分支、领先/落后上游、工作区改动计数；
  获取（`fetch --prune`）、拉取（`pull --ff-only`，发散时拒绝并报 git 原文）、
  手动刷新；面板打开期间每 45 秒静默刷新。
- **网络代理** — 设置页（Paseo 设置 > Git 代理）可填写代理地址
  （`http://127.0.0.1:7897` 或 `socks5://…`，留空直连），拉取 GitHub 等
  远端时由守护进程注入 `HTTP(S)_PROXY`/`ALL_PROXY`；可选让
  `git@` SSH 远端也经 `nc` 走代理（`GIT_SSH_COMMAND`）。保存后下一次
  获取/拉取即生效，无需重启。适合本机没有透明代理环境的使用者各自填写。
- 非 Git 工作区显示友好空态；git 报错以 toast 展示原文。

## How it works

- Client: a workspace panel (`addWorkspacePanel`, workspace + explorer
  locations) resolves the workspace `directory` via `useWorkspace` and calls
  the daemon over typed zod RPC contracts (`shared/contracts.ts`).
- Server: handlers run `git` through the SDK's `execCommand`
  (`server/git-runner.ts`) with `LC_ALL=C` and `GIT_OPTIONAL_LOCKS=0`;
  parsing lives in `server/git-ops.ts` with runner injection so tests
  exercise the real git binary. Host-scoped proxy settings
  (`shared/settings.ts`, `server/proxy-env.ts`) are applied as extra
  environment variables on every git invocation — inert for local
  commands, steering only the network transports.
- The commit graph is rendered from a lane model computed client-side
  (`client/graph.ts`, gitgraph.js-style algorithm) and drawn with plain
  RN Views: verticals, rotated diagonals for merges, and collapse bars when
  a lane terminates.
- Safe by construction: ref/hash inputs are regex-validated before being
  passed to git, and `execCommand` spawns without a shell.

## Requirements

- `git` on the daemon's PATH.
- Paseo >= 0.11.4.

## Limits

- 查看 + 检出 + fetch/pull only — no push, stage, commit or rebase UI yet.
- Merge diffs use `--first-parent`, not combined diffs.
- Search only covers loaded pages (first 300 by default).
- Remote branch ahead/behind is not shown (only local branches vs HEAD).

## Development

`npm run typecheck`, `npm test` (real-git fixture repo in a temp dir —
covers status/porcelain v2, for-each-ref, log pagination, numstat/name-status
-z rename & binary ordering, checkout failures, and the graph lane model).
After editing, `paseo plugin reload git-manager` picks up server changes.
