import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import {
  formatPullSummary,
  gitBranchCreate,
  gitBranchDelete,
  gitBranches,
  gitCommit,
  gitLog,
  gitPaths,
  gitPull,
  gitPush,
  gitStatus,
  gitCheckout,
  gitTagCreate,
  gitTagDelete,
  gitTags,
  gitWorktreeAdd,
  gitWorktreePrune,
  gitWorktreeRemove,
  gitWorktrees,
  listChildPaths,
  parseForEachRef,
  parseLogBody,
  parseNameStatusTokens,
  parseNumstatTokens,
  parseShortStat,
  parseStatusBody,
  parseTagsBody,
  parseWorktreeList,
  resolveWorktreePath,
} from "../server/git-ops.ts";
import { createBinaryCommit, git, testRun, withFixtureRepo } from "./fixture.mts";

test("gitStatus 解析分支、领先落后与工作区状态", async () => {
  await withFixtureRepo(async (repo) => {
    const status = await gitStatus(testRun, repo.root);
    assert.equal(status.ok, true);
    assert.equal(status.currentBranch, "main");
    assert.equal(status.detached, false);
    assert.equal(status.upstream, "origin/main");
    assert.equal(status.ahead, 3, "main 领先 origin/main 三个提交（merge、rename、以及 c2 之后）");
    assert.equal(status.behind, 0);
    assert.equal(status.staged, 1, "hello.txt 已暂存修改");
    assert.equal(status.unstaged, 1, "hello.txt 又有未暂存修改");
    assert.equal(status.untracked, 1, "untracked.log");
    assert.equal(status.head, repo.hashes.c6);
    assert.ok(status.root && status.root.length > 0);
  });
});

test("gitStatus 在非 git 目录返回友好错误", async () => {
  const status = await gitStatus(async () => {
    throw Object.assign(new Error("fatal: not a git repository (or any of the parent directories): .git"), {
      stderr: "fatal: not a git repository (or any of the parent directories): .git",
    });
  }, "/tmp");
  assert.equal(status.ok, false);
  assert.match(status.error ?? "", /not a git repository/);
});

test("gitBranches 列出本地/远程分支并计算与 HEAD 的领先落后", async () => {
  await withFixtureRepo(async (repo) => {
    const branches = await gitBranches(testRun, repo.root);
    assert.equal(branches.ok, true);

    const main = branches.locals.find((branch) => branch.shortName === "main");
    const feature = branches.locals.find((branch) => branch.shortName === "feature");
    const side = branches.locals.find((branch) => branch.shortName === "side");
    assert.ok(main && feature && side, "三个本地分支都在");

    assert.equal(main?.isCurrent, true);
    assert.equal(main?.ahead, 0);
    assert.equal(main?.behind, 0);

    // feature 已合并：相对 HEAD 无领先，落后 main 上的 merge 与 rename。
    assert.equal(feature?.ahead, 0);
    assert.equal(feature?.behind, 2);

    // side 自 merge 后切出：领先 c5，落后 c6。
    assert.equal(side?.ahead, 1);
    assert.equal(side?.behind, 1);

    const originMain = branches.remotes.find((branch) => branch.shortName === "origin/main");
    assert.ok(originMain, "远程分支 origin/main 在列表中");
    assert.equal(originMain?.hash, repo.hashes.c2);
  });
});

test("gitLog 返回带父提交/引用/正文的提交（--all）", async () => {
  await withFixtureRepo(async (repo) => {
    const result = await gitLog(testRun, repo.root, "ALL", 100, 0);
    assert.equal(result.ok, true);
    assert.equal(result.commits.length, 6);
    assert.equal(result.hasMore, false);

    const head = result.commits.find((commit) => commit.hash === repo.hashes.c6);
    assert.ok(head);
    assert.equal(head?.subject, "重命名 src/main.ts");
    assert.equal(head?.parents.length, 1);

    const merge = result.commits.find((commit) => commit.hash === repo.hashes.c4);
    assert.ok(merge);
    assert.equal(merge?.parents.length, 2, "merge 提交有两个父提交");
    assert.deepEqual(
      merge?.parents,
      [repo.hashes.c2, repo.hashes.c3],
      "first-parent 是 main 上的 c2",
    );

    const root = result.commits.find((commit) => commit.hash === repo.hashes.c1);
    assert.ok(root);
    assert.equal(root?.parents.length, 0);
    assert.equal(root?.body, "第一行的说明\n第二行");
    assert.ok(root?.refs.some((ref) => ref === "tag: v1"), "v1 标签出现在引用装饰里");

    const current = result.commits.find((commit) => commit.refs.some((ref) => ref.startsWith("HEAD ->")));
    assert.ok(current, "当前分支带 HEAD -> 装饰");
  });
});

test("gitLog 分支作用域与分页", async () => {
  await withFixtureRepo(async (repo) => {
    const sideOnly = await gitLog(testRun, repo.root, "side", 100, 0);
    assert.equal(sideOnly.ok, true);
    assert.equal(sideOnly.commits.length, 5, "side 包含 merge 及之前的历史，不含 c6");
    assert.ok(sideOnly.commits.some((commit) => commit.hash === repo.hashes.c5));
    assert.ok(sideOnly.commits.some((commit) => commit.hash === repo.hashes.c4));
    assert.ok(!sideOnly.commits.some((commit) => commit.hash === repo.hashes.c6));

    const paged = await gitLog(testRun, repo.root, "ALL", 2, 0);
    assert.equal(paged.commits.length, 2);
    assert.equal(paged.hasMore, true);
    const next = await gitLog(testRun, repo.root, "ALL", 2, 2);
    assert.notEqual(next.commits[0]?.hash, paged.commits[0]?.hash);
  });
});

test("gitLog 按文件路径过滤", async () => {
  await withFixtureRepo(async (repo) => {
    const result = await gitLog(testRun, repo.root, "ALL", 100, 0, "feature.txt");
    assert.equal(result.ok, true);
    // git 默认历史简化：merge 提交被剪枝，只留真正改动该文件的提交
    assert.equal(result.commits.length, 1, "只有引入 feature.txt 的提交");
    assert.equal(result.commits[0]?.hash, repo.hashes.c3);

    const none = await gitLog(testRun, repo.root, "ALL", 100, 0, "does-not-exist.txt");
    assert.equal(none.ok, true);
    assert.equal(none.commits.length, 0);

    const blank = await gitLog(testRun, repo.root, "ALL", 100, 0, "   ");
    assert.equal(blank.commits.length, 6, "空白路径等于不过滤");
  });
});

test("gitCommit 输出文件增删、重命名与状态", async () => {
  await withFixtureRepo(async (repo) => {
    const rename = await gitCommit(testRun, repo.root, repo.hashes.c6);
    assert.equal(rename.ok, true);
    assert.equal(rename.files.length, 1);
    const file = rename.files[0];
    assert.equal(file?.status, "R");
    assert.equal(file?.path, "src-renamed.ts");
    assert.equal(file?.oldPath, "src/main.ts");
    assert.equal(file?.additions, 0);
    assert.equal(file?.deletions, 0);

    const initial = await gitCommit(testRun, repo.root, repo.hashes.c1);
    assert.equal(initial.files.length, 1);
    assert.equal(initial.files[0]?.path, "hello.txt");
    assert.equal(initial.files[0]?.status, "A");
    assert.equal(initial.files[0]?.additions, 1);

    const merge = await gitCommit(testRun, repo.root, repo.hashes.c4);
    assert.equal(merge.ok, true);
    assert.deepEqual(
      merge.parents,
      [repo.hashes.c2, repo.hashes.c3],
    );
    // --first-parent: merge 相对 c2 的差异就是 feature 带来的文件。
    assert.equal(merge.files.length, 1);
    assert.equal(merge.files[0]?.path, "feature.txt");

    // 二进制文件（先清掉随检出携带的未提交改动）
    await git(repo.root, "checkout", "-q", repo.hashes.c6);
    await git(repo.root, "reset", "--hard", "-q");
    await git(repo.root, "clean", "-fdq");
    const binaryHash = await createBinaryCommit(repo.root);
    const binary = await gitCommit(testRun, repo.root, binaryHash);
    assert.equal(binary.files.length, 1);
    assert.equal(binary.files[0]?.binary, true);
    assert.equal(binary.files[0]?.additions, null);
  });
});

test("gitCheckout 切换分支并报错安全失败", async () => {
  await withFixtureRepo(async (repo) => {
    // hello.txt 的未提交改动与 side 无冲突，git 会带着改动切换成功。
    const carried = await gitCheckout(testRun, repo.root, "side");
    assert.equal(carried.ok, true, "无冲突的改动随检出携带");

    const result = await gitCheckout(testRun, repo.root, "main");
    assert.equal(result.ok, true);

    const missing = await gitCheckout(testRun, repo.root, "does-not-exist");
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? "", /did not match|did not exist/i);
  });
});

test("gitPaths 按层级列出跟踪的目录与文件", async () => {
  await withFixtureRepo(async (repo) => {
    const rootLevel = await gitPaths(testRun, repo.root, "");
    assert.equal(rootLevel.ok, true);
    assert.deepEqual(rootLevel.dirs, ["src"]);
    assert.deepEqual(rootLevel.files, ["feature.txt", "hello.txt", "src-renamed.ts"]);

    const src = await gitPaths(testRun, repo.root, "src/");
    assert.equal(src.ok, true);
    assert.equal(src.dir, "src", "结尾斜杠被归一化");
    assert.deepEqual(src.dirs, ["util"]);
    assert.deepEqual(src.files, []);

    const util = await gitPaths(testRun, repo.root, "src/util");
    assert.deepEqual(util.dirs, []);
    assert.deepEqual(util.files, ["helper.ts"]);

    const bad = await gitPaths(testRun, repo.root, "../escape");
    assert.equal(bad.ok, false);
  });
});

test("gitPaths 中文文件名按 UTF-8 原样返回（不转义成八进制）", async () => {
  await withFixtureRepo(async (repo) => {
    await mkdir(join(repo.root, "文档"), { recursive: true });
    await writeFile(join(repo.root, "文档", "说明.md"), "# 说明\n", "utf8");
    await git(repo.root, "add", "--", "文档/说明.md");
    await git(repo.root, "commit", "-q", "-m", "添加中文文档");

    const rootLevel = await gitPaths(testRun, repo.root, "");
    assert.ok(rootLevel.dirs.includes("文档"), JSON.stringify(rootLevel.dirs));

    const inner = await gitPaths(testRun, repo.root, "文档");
    assert.deepEqual(inner.files, ["说明.md"]);
  });
});

test("listChildPaths 边界", () => {
  const files = ["a.txt", "b/c.txt", "b/d/e.txt", "f/g.txt"];
  const root = listChildPaths(files, "");
  assert.deepEqual(root, { dirs: ["b", "f"], files: ["a.txt"] });
  const b = listChildPaths(files, "b");
  assert.deepEqual(b, { dirs: ["d"], files: ["c.txt"] });
  const none = listChildPaths(files, "missing");
  assert.deepEqual(none, { dirs: [], files: [] });
});

test("parseStatusBody 空输入与 detached", () => {
  const empty = parseStatusBody("");
  assert.equal(empty.currentBranch, null);
  assert.equal(empty.staged, 0);

  const detached = parseStatusBody("# branch.head (detached)\n# branch.oid abc123\n");
  assert.equal(detached.detached, true);
  assert.equal(detached.head, "abc123");
});

test("parseForEachRef 忽略残缺记录", () => {
  const parsed = parseForEachRef("");
  assert.equal(parsed.locals.length, 0);
  const junk = parseForEachRef("garbage-line\n\n");
  assert.equal(junk.locals.length + junk.remotes.length, 0);
});

test("parseLogBody 分隔符安全", () => {
  const commits = parseLogBody("");
  assert.equal(commits.length, 0);
  // 引用列表里的逗号按 ", " 拆分，字段分隔符不受影响
  const one = parseLogBody(
    ["h", "s", "p", "an", "ae", "aI", "cI", "HEAD -> main, origin/main", "subject here", "body"].join("\u001f") + "\u001e",
  );
  assert.equal(one.length, 1);
  assert.equal(one[0]?.subject, "subject here");
  assert.deepEqual(one[0]?.refs, ["HEAD -> main", "origin/main"]);
});

test("parseNumstatTokens 处理重命名与二进制", () => {
  // -z 格式：普通文件路径内联；重命名是「计数+空路径\0旧\0新」
  const files = parseNumstatTokens(["1\t2\tb.txt", "0\t0\t", "old.txt", "new.txt", "-\t-\tlogo.png"]);
  assert.equal(files.length, 3);
  assert.equal(files[0]?.path, "b.txt");
  assert.equal(files[0]?.oldPath, null);
  assert.equal(files[0]?.additions, 1);
  assert.equal(files[1]?.path, "new.txt");
  assert.equal(files[1]?.oldPath, "old.txt");
  assert.equal(files[2]?.binary, true);
});

test("parseNameStatusTokens 处理重命名顺序", () => {
  const entries = parseNameStatusTokens(["R100", "old.txt", "new.txt", "M", "a.ts"]);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { path: "new.txt", status: "R", oldPath: "old.txt" });
  assert.deepEqual(entries[1], { path: "a.ts", status: "M", oldPath: null });
});

// ---------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------

test("gitTags 列出轻量标签并解析指向的提交", async () => {
  await withFixtureRepo(async (repo) => {
    const result = await gitTags(testRun, repo.root);
    assert.equal(result.ok, true);
    const v1 = result.tags.find((tag) => tag.shortName === "v1");
    assert.ok(v1, "fixture 的 v1 标签在列表中");
    assert.equal(v1?.annotated, false);
    assert.equal(v1?.hash, repo.hashes.c1);
    assert.equal(v1?.commitHash, repo.hashes.c1);
  });
});

test("gitTagCreate 附注/轻量标签与 gitTagDelete", async () => {
  await withFixtureRepo(async (repo) => {
    const annotated = await gitTagCreate(testRun, repo.root, "v2.0", repo.hashes.c2, "发布说明");
    assert.equal(annotated.ok, true, annotated.error ?? "");

    const light = await gitTagCreate(testRun, repo.root, "light", "", "");
    assert.equal(light.ok, true, light.error ?? "");

    const result = await gitTags(testRun, repo.root);
    const v2 = result.tags.find((tag) => tag.shortName === "v2.0");
    assert.ok(v2);
    assert.equal(v2?.annotated, true, "带说明的标签是附注标签");
    assert.equal(v2?.commitHash, repo.hashes.c2, "附注标签剥壳后指向 c2");
    assert.notEqual(v2?.hash, repo.hashes.c2, "附注标签本体是 tag 对象");

    const lightEntry = result.tags.find((tag) => tag.shortName === "light");
    assert.ok(lightEntry);
    assert.equal(lightEntry?.annotated, false);
    assert.equal(lightEntry?.commitHash, repo.hashes.c6, "默认打在 HEAD 上");

    const deleted = await gitTagDelete(testRun, repo.root, "v1");
    assert.equal(deleted.ok, true, deleted.error ?? "");
    const after = await gitTags(testRun, repo.root);
    assert.ok(!after.tags.some((tag) => tag.shortName === "v1"));

    const invalid = await gitTagCreate(testRun, repo.root, "-bad", "", "");
    assert.equal(invalid.ok, false);
    assert.match(invalid.error ?? "", /无效的标签名/);

    const duplicate = await gitTagCreate(testRun, repo.root, "v2.0", "", "");
    assert.equal(duplicate.ok, false, "同名标签被 git 拒绝");
  });
});

test("gitCheckout 标签进入分离头指针并给出友好提示", async () => {
  await withFixtureRepo(async (repo) => {
    // 清掉 fixture 制造的未提交改动，避免检出被拒
    await git(repo.root, "checkout", "-q", repo.hashes.c6);
    await git(repo.root, "reset", "--hard", "-q");
    await git(repo.root, "clean", "-fdq");

    const result = await gitCheckout(testRun, repo.root, "v1");
    assert.equal(result.ok, true, result.error ?? "");
    assert.match(result.message ?? "", /分离头指针/);
    const status = await gitStatus(testRun, repo.root);
    assert.equal(status.detached, true);

    const back = await gitCheckout(testRun, repo.root, "main");
    assert.equal(back.ok, true);
  });
});

// ---------------------------------------------------------------------------
// branch create / delete
// ---------------------------------------------------------------------------

test("gitBranchCreate 建分支并可选检出", async () => {
  await withFixtureRepo(async (repo) => {
    const created = await gitBranchCreate(testRun, repo.root, "topic", "side", false);
    assert.equal(created.ok, true, created.error ?? "");
    const branches = await gitBranches(testRun, repo.root);
    const topic = branches.locals.find((branch) => branch.shortName === "topic");
    assert.ok(topic);
    assert.equal(topic?.hash, repo.hashes.c5, "从 side 切出");
    assert.equal(topic?.isCurrent, false);

    const checkedOut = await gitBranchCreate(testRun, repo.root, "quick", "HEAD", true);
    assert.equal(checkedOut.ok, true, checkedOut.error ?? "");
    const status = await gitStatus(testRun, repo.root);
    assert.equal(status.currentBranch, "quick");

    const invalid = await gitBranchCreate(testRun, repo.root, "-x", "", false);
    assert.equal(invalid.ok, false);
    assert.match(invalid.error ?? "", /无效的分支名/);

    const duplicate = await gitBranchCreate(testRun, repo.root, "topic", "", false);
    assert.equal(duplicate.ok, false, "重名分支被 git 拒绝");
  });
});

test("gitBranchDelete 安全删除与强制删除", async () => {
  await withFixtureRepo(async (repo) => {
    const safe = await gitBranchDelete(testRun, repo.root, "side", false);
    assert.equal(safe.ok, false, "side 有未合并提交，-d 拒绝");
    assert.match(safe.error ?? "", /not fully merged|未合并/i);

    const forced = await gitBranchDelete(testRun, repo.root, "side", true);
    assert.equal(forced.ok, true, forced.error ?? "");
    const branches = await gitBranches(testRun, repo.root);
    assert.ok(!branches.locals.some((branch) => branch.shortName === "side"));

    const current = await gitBranchDelete(testRun, repo.root, "main", false);
    assert.equal(current.ok, false, "不能删除当前分支");

    const merged = await gitBranchDelete(testRun, repo.root, "feature", false);
    assert.equal(merged.ok, true, "已合并的 feature 可安全删除");
  });
});

// ---------------------------------------------------------------------------
// worktrees
// ---------------------------------------------------------------------------

test("parseWorktreeList 解析 porcelain 块", () => {
  const body = [
    "worktree /repo/main",
    "HEAD aaaa",
    "branch refs/heads/main",
    "",
    "worktree /repo/feature",
    "HEAD bbbb",
    "detached",
    "",
    "worktree /repo/bare.git",
    "bare",
    "",
  ].join("\n");
  const worktrees = parseWorktreeList(body);
  assert.equal(worktrees.length, 3);
  assert.deepEqual(worktrees[0], {
    path: "/repo/main",
    head: "aaaa",
    branch: "refs/heads/main",
    detached: false,
    bare: false,
    isMain: true,
  });
  assert.equal(worktrees[1]?.detached, true);
  assert.equal(worktrees[1]?.branch, null);
  assert.equal(worktrees[1]?.isMain, false);
  assert.equal(worktrees[2]?.bare, true);

  assert.equal(parseWorktreeList("").length, 0);
});

test("resolveWorktreePath 相对目录落在仓库同级并拒绝穿越", () => {
  assert.equal(resolveWorktreePath("/repo/root", "../escape"), null);
  assert.equal(resolveWorktreePath("/repo/root", "a//b"), null);
  assert.equal(resolveWorktreePath("/repo/root", "  "), null);
  assert.equal(resolveWorktreePath("/repo/root", "/abs/path"), "/abs/path");
  assert.equal(resolveWorktreePath("/repo/root", "feature-x"), "/repo/feature-x");
});

test("gitWorktrees 列出 / gitWorktreeAdd 添加 / gitWorktreeRemove 移除", async () => {
  await withFixtureRepo(async (repo) => {
    const parent = await mkdtemp(join(tmpdir(), "paseo-git-wt-"));
    try {
      const initial = await gitWorktrees(testRun, repo.root);
      assert.equal(initial.ok, true);
      assert.equal(initial.worktrees.length, 1);
      assert.equal(initial.worktrees[0]?.isMain, true);
      assert.equal(initial.worktrees[0]?.branch, "refs/heads/main");

      const wtPath = join(parent, "feature-x");
      const added = await gitWorktreeAdd(testRun, repo.root, wtPath, "wt-feature", "");
      assert.equal(added.ok, true, added.error ?? "");

      const listed = await gitWorktrees(testRun, repo.root);
      assert.equal(listed.worktrees.length, 2);
      const realWt = await realpath(wtPath);
      const entry = listed.worktrees.find((worktree) => worktree.path === realWt);
      assert.ok(entry);
      assert.equal(entry?.branch, "refs/heads/wt-feature");
      assert.equal(entry?.detached, false);
      assert.equal(entry?.isMain, false);

      const removed = await gitWorktreeRemove(testRun, repo.root, wtPath, false);
      assert.equal(removed.ok, true, removed.error ?? "");
      const after = await gitWorktrees(testRun, repo.root);
      assert.equal(after.worktrees.length, 1);

      const mainRemove = await gitWorktreeRemove(testRun, repo.root, repo.root, false);
      assert.equal(mainRemove.ok, false, "主 worktree 不能移除");
      assert.match(mainRemove.error ?? "", /主 worktree/);

      const unknown = await gitWorktreeRemove(testRun, repo.root, join(parent, "nope"), false);
      assert.equal(unknown.ok, false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

test("gitWorktreeAdd 直接检出分支与非法路径", async () => {
  await withFixtureRepo(async (repo) => {
    const parent = await mkdtemp(join(tmpdir(), "paseo-git-wt-"));
    try {
      // 无新分支：直接检出已存在的 side（main 上未占用）
      const wtPath = join(parent, "on-side");
      const added = await gitWorktreeAdd(testRun, repo.root, wtPath, "", "side");
      assert.equal(added.ok, true, added.error ?? "");
      const listed = await gitWorktrees(testRun, repo.root);
      const realWt = await realpath(wtPath);
      const entry = listed.worktrees.find((worktree) => worktree.path === realWt);
      assert.equal(entry?.branch, "refs/heads/side");

      // side 已被占用，再检出会被 git 拒绝（无需真正建目录）
      const conflict = await gitWorktreeAdd(testRun, repo.root, join(parent, "again"), "", "side");
      assert.equal(conflict.ok, false);

      // 相对路径解析到仓库同级目录
      const relative = await gitWorktreeAdd(testRun, repo.root, "sibling-wt", "wt-rel", "");
      assert.equal(relative.ok, true, relative.error ?? "");
      const relativeListed = await gitWorktrees(testRun, repo.root);
      const root = relativeListed.worktrees[0]?.path ?? repo.root;
      assert.ok(
        relativeListed.worktrees.some((worktree) => worktree.path === join(dirname(root), "sibling-wt")),
        "相对目录落在仓库同级",
      );

      const traversal = await gitWorktreeAdd(testRun, repo.root, "../evil", "", "");
      assert.equal(traversal.ok, false);
      assert.match(traversal.error ?? "", /无效的目录名/);
    } finally {
      await rm(parent, { recursive: true, force: true });
      // 清理落在仓库同级的 sibling-wt
      const listed = await gitWorktrees(testRun, repo.root);
      const root = listed.worktrees[0]?.path ?? repo.root;
      await rm(join(dirname(root), "sibling-wt"), { recursive: true, force: true });
    }
  });
});

test("gitWorktreePrune 清理失效记录", async () => {
  await withFixtureRepo(async (repo) => {
    const parent = await mkdtemp(join(tmpdir(), "paseo-git-wt-"));
    try {
      const wtPath = join(parent, "stale");
      const added = await gitWorktreeAdd(testRun, repo.root, wtPath, "wt-stale", "");
      assert.equal(added.ok, true, added.error ?? "");
      // 直接删掉目录模拟外部移除：记录仍挂着，prune 后消失
      await rm(wtPath, { recursive: true, force: true });
      const before = await gitWorktrees(testRun, repo.root);
      assert.equal(before.worktrees.length, 2);

      const pruned = await gitWorktreePrune(testRun, repo.root);
      assert.equal(pruned.ok, true, pruned.error ?? "");
      const after = await gitWorktrees(testRun, repo.root);
      assert.equal(after.worktrees.length, 1);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

test("parseTagsBody 忽略残缺记录", () => {
  assert.equal(parseTagsBody("").length, 0);
  assert.equal(parseTagsBody("garbage\n\n").length, 0);
});

// ---------------------------------------------------------------------------
// fetch / pull
// ---------------------------------------------------------------------------

test("parseShortStat 解析文件数与增删行", () => {
  assert.deepEqual(parseShortStat(""), { files: 0, additions: 0, deletions: 0 });
  assert.deepEqual(parseShortStat(" 3 files changed, 12 insertions(+), 4 deletions(-)"), {
    files: 3,
    additions: 12,
    deletions: 4,
  });
  assert.deepEqual(parseShortStat(" 1 file changed, 5 deletions(-)"), {
    files: 1,
    additions: 0,
    deletions: 5,
  });
  assert.deepEqual(parseShortStat(" 2 files changed"), { files: 2, additions: 0, deletions: 0 });
});

test("formatPullSummary 输出单行摘要", () => {
  const before = "9a4a53ed00000000000000000000000000000000";
  const after = "ffc7185900000000000000000000000000000000";
  assert.equal(
    formatPullSummary(before, after, 2, { files: 2, additions: 2, deletions: 0 }),
    "已快进 2 个提交（9a4a53ed → ffc71859），更新 2 个文件（+2 −0）",
  );
  // 只改二进制时 diff —shortstat 不报增删行
  assert.equal(
    formatPullSummary(before, after, 1, { files: 1, additions: 0, deletions: 0 }),
    "已快进 1 个提交（9a4a53ed → ffc71859），更新 1 个文件",
  );
  assert.equal(
    formatPullSummary(before, after, 3, { files: 0, additions: 0, deletions: 0 }),
    "已快进 3 个提交（9a4a53ed → ffc71859）",
  );
});

test("gitPull 快进后返回简短摘要而不是原始 diffstat", async () => {
  const base = await mkdtemp(join(tmpdir(), "paseo-git-pull-"));
  try {
    const origin = join(base, "origin");
    await initRepo(origin);
    await writeFile(join(origin, "a.txt"), "one\n", "utf8");
    const c1 = await commitAll(origin, "c1");

    const clone = join(base, "clone");
    await git(base, "clone", "-q", origin, clone);

    await mkdir(join(origin, "文档"), { recursive: true });
    await writeFile(join(origin, "文档", "说明.md"), "# 说明\n", "utf8");
    await commitAll(origin, "添加中文文档");
    await writeFile(join(origin, "a.txt"), "one\ntwo\n", "utf8");
    const c3 = await commitAll(origin, "修改 a.txt");

    const result = await gitPull(testRun, clone);
    assert.equal(result.ok, true, result.error ?? "");
    const message = result.message ?? "";
    assert.ok(!message.includes("\n"), `摘要只有一行：${message}`);
    assert.match(message, /快进 2 个提交/);
    assert.match(message, /2 个文件（\+2 −0）/);
    assert.ok(message.includes(c1.slice(0, 8)) && message.includes(c3.slice(0, 8)), message);

    const again = await gitPull(testRun, clone);
    assert.equal(again.ok, true, again.error ?? "");
    assert.match(again.message ?? "", /已是最新/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("gitPush 推送领先提交并汇报数量，重复推送提示已是最新", async () => {
  const base = await mkdtemp(join(tmpdir(), "paseo-git-push-"));
  try {
    // bare origin: pushing to a checked-out branch of a non-bare repo is refused
    const seed = join(base, "seed");
    await initRepo(seed);
    await writeFile(join(seed, "a.txt"), "one\n", "utf8");
    await commitAll(seed, "c1");
    const origin = join(base, "origin");
    await git(base, "clone", "-q", "--bare", seed, origin);

    const clone = join(base, "clone");
    await git(base, "clone", "-q", origin, clone);

    await writeFile(join(clone, "b.txt"), "new\n", "utf8");
    await commitAll(clone, "本地提交");
    await writeFile(join(clone, "c.txt"), "more\n", "utf8");
    const head = await commitAll(clone, "再提交一个");

    const result = await gitPush(testRun, clone, false);
    assert.equal(result.ok, true, result.error ?? "");
    assert.equal(result.needsUpstream, false);
    assert.match(result.message ?? "", /已推送 2 个提交到 origin\/main/);

    const remotes = await git(clone, "ls-remote", "--heads", "origin");
    assert.ok(remotes.includes(head), "远端收到推送的提交");

    const again = await gitPush(testRun, clone, false);
    assert.equal(again.ok, true, again.error ?? "");
    assert.match(again.message ?? "", /已是最新/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("gitPush 无上游分支时拒绝并提示，setUpstream 后推送到 origin 并建立跟踪", async () => {
  const base = await mkdtemp(join(tmpdir(), "paseo-git-push-setup-"));
  try {
    const seed = join(base, "seed");
    await initRepo(seed);
    await writeFile(join(seed, "a.txt"), "one\n", "utf8");
    await commitAll(seed, "c1");
    const origin = join(base, "origin");
    await git(base, "clone", "-q", "--bare", seed, origin);

    const clone = join(base, "clone");
    await git(base, "clone", "-q", origin, clone);

    await git(clone, "checkout", "-q", "-b", "feature/x");
    await writeFile(join(clone, "b.txt"), "feature\n", "utf8");
    await commitAll(clone, "feature 提交");

    const refused = await gitPush(testRun, clone, false);
    assert.equal(refused.ok, false);
    assert.equal(refused.needsUpstream, true);
    assert.match(refused.error ?? "", /feature\/x 没有上游分支/);

    const remotesBefore = await git(clone, "ls-remote", "--heads", "origin");
    assert.ok(!remotesBefore.includes("feature/x"), "确认前不应推送");

    const setup = await gitPush(testRun, clone, true);
    assert.equal(setup.ok, true, setup.error ?? "");
    assert.match(setup.message ?? "", /已推送 feature\/x 并建立上游跟踪 origin\/feature\/x/);

    const remotesAfter = await git(clone, "ls-remote", "--heads", "origin");
    assert.ok(remotesAfter.includes("refs/heads/feature/x"), "远端出现 feature/x");
    const status = await gitStatus(testRun, clone);
    assert.equal(status.upstream, "origin/feature/x", "push -u 建立了跟踪关系");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "--initial-branch=main");
  await git(dir, "config", "user.name", "李四");
  await git(dir, "config", "user.email", "li@example.com");
  await git(dir, "config", "commit.gpgsign", "false");
}

async function commitAll(dir: string, message: string): Promise<string> {
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", message);
  return (await git(dir, "rev-parse", "HEAD")).trim();
}
