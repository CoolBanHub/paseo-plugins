import assert from "node:assert/strict";
import { test } from "node:test";
import {
  gitBranches,
  gitCommit,
  gitLog,
  gitPaths,
  gitStatus,
  gitCheckout,
  listChildPaths,
  parseForEachRef,
  parseLogBody,
  parseNameStatusTokens,
  parseNumstatTokens,
  parseStatusBody,
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
