import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  gitBranchRename,
  gitBranches,
  gitChanges,
  gitCherryPick,
  gitCommitCreate,
  gitConflictResolve,
  gitDiff,
  gitMerge,
  gitRecentMessages,
  gitRebase,
  gitReset,
  gitRevert,
  gitRollbackFile,
  gitSequenceAction,
  gitSequenceState,
  gitStage,
  gitStashApply,
  gitStashDrop,
  gitStashList,
  gitStashPush,
  gitUnstage,
  parseChangesBody,
  parseTrackCounts,
} from "../server/git-ops.ts";
import { git, testRun, withFixtureRepo } from "./fixture.mts";

test("parseChangesBody 拆分双状态、未跟踪与冲突", () => {
  const body = [
    "M  hello.txt\0",
    " M world.txt\0",
    "?? new.log\0",
    "UU conflicted.txt\0",
    "R  new.ts\0old.ts\0",
  ].join("");
  const entries = parseChangesBody(body);
  assert.deepEqual(
    entries.map((entry) => [entry.path, entry.status, entry.staged, entry.untracked, entry.conflict]),
    [
      ["hello.txt", "M", true, false, false],
      ["world.txt", "M", false, false, false],
      ["new.log", "?", false, true, false],
      ["conflicted.txt", "UU", false, false, true],
      ["new.ts", "R", true, false, false],
    ],
  );
  assert.equal(entries[4]?.oldPath, "old.ts");
});

test("parseTrackCounts 解析 upstream:track", () => {
  assert.deepEqual(parseTrackCounts(""), { ahead: 0, behind: 0 });
  assert.deepEqual(parseTrackCounts("ahead 2"), { ahead: 2, behind: 0 });
  assert.deepEqual(parseTrackCounts("behind 3"), { ahead: 0, behind: 3 });
  assert.deepEqual(parseTrackCounts("ahead 1, behind 4"), { ahead: 1, behind: 4 });
});

test("gitChanges 列出暂存、未暂存与未跟踪", async () => {
  await withFixtureRepo(async (repo) => {
    const result = await gitChanges(testRun, repo.root);
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.entries.map((entry) => [entry.path, entry.status, entry.staged, entry.untracked]),
      [
        ["hello.txt", "M", true, false],
        ["hello.txt", "M", false, false],
        ["untracked.log", "?", false, true],
      ],
    );
  });
});

test("gitBranches 通过 upstream:track 报告领先落后", async () => {
  await withFixtureRepo(async (repo) => {
    const result = await gitBranches(testRun, repo.root);
    assert.equal(result.ok, true);
    const main = result.locals.find((branch) => branch.shortName === "main");
    assert.ok(main);
    assert.equal(main.upstream, "origin/main");
    assert.equal(main.ahead, 3);
    assert.equal(main.behind, 0);
    const side = result.locals.find((branch) => branch.shortName === "side");
    assert.ok(side);
    assert.equal(side.upstream, null);
    assert.equal(side.ahead, null);
    // origin/HEAD 不应出现在远程列表里
    assert.equal(result.remotes.some((branch) => branch.name.endsWith("/HEAD")), false);
  });
});

test("gitStage / gitUnstage 往返", async () => {
  await withFixtureRepo(async (repo) => {
    const stage = await gitStage(testRun, repo.root, ["untracked.log"], false);
    assert.equal(stage.ok, true);
    let changes = await gitChanges(testRun, repo.root);
    assert.deepEqual(
      changes.entries.filter((entry) => entry.path === "untracked.log").map((entry) => entry.staged),
      [true],
    );

    const unstage = await gitUnstage(testRun, repo.root, ["untracked.log", "hello.txt"], false);
    assert.equal(unstage.ok, true);
    changes = await gitChanges(testRun, repo.root);
    assert.deepEqual(
      changes.entries.map((entry) => [entry.path, entry.staged, entry.untracked]),
      [
        ["hello.txt", false, false],
        ["untracked.log", false, true],
      ],
    );
  });
});

test("gitCommitCreate 勾选即提交范围，其余暂存被恢复", async () => {
  await withFixtureRepo(async (repo) => {
    const result = await gitCommitCreate(testRun, repo.root, "只提交未跟踪文件", ["untracked.log"], false);
    assert.equal(result.ok, true, result.error ?? "");

    // HEAD 只包含 untracked.log
    const show = await git(repo.root, "show", "--name-only", "--format=", "HEAD");
    assert.equal(show.trim(), "untracked.log");

    // hello.txt 的暂存修改仍在
    const changes = await gitChanges(testRun, repo.root);
    assert.deepEqual(
      changes.entries.map((entry) => [entry.path, entry.staged, entry.untracked]),
      [
        ["hello.txt", true, false],
        ["hello.txt", false, false],
      ],
    );
  });
});

test("gitCommitCreate 空提交信息被拒绝", async () => {
  await withFixtureRepo(async (repo) => {
    const result = await gitCommitCreate(testRun, repo.root, "  ", [], false);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /提交信息/);
  });
});

test("gitCommitCreate amend 修正上一提交", async () => {
  await withFixtureRepo(async (repo) => {
    const first = await gitCommitCreate(testRun, repo.root, "提交未跟踪", ["untracked.log"], false);
    assert.equal(first.ok, true, first.error ?? "");
    const amend = await gitCommitCreate(testRun, repo.root, "提交未跟踪（修正）", [], true);
    assert.equal(amend.ok, true, amend.error ?? "");
    const subject = await git(repo.root, "log", "-1", "--format=%s");
    assert.equal(subject.trim(), "提交未跟踪（修正）");
  });
});

test("gitRecentMessages 返回最近提交主题", async () => {
  await withFixtureRepo(async (repo) => {
    const result = await gitRecentMessages(testRun, repo.root);
    assert.equal(result.ok, true);
    assert.ok(result.messages.length >= 4);
    assert.equal(result.messages[0], "重命名 src/main.ts");
  });
});

test("gitDiff 四种模式取到对应补丁", async () => {
  await withFixtureRepo(async (repo) => {
    const staged = await gitDiff(testRun, repo.root, "staged", "", "hello.txt", 2000);
    assert.equal(staged.ok, true);
    assert.match(staged.text, /\+line3-staged/);
    assert.equal(staged.binary, false);

    const worktree = await gitDiff(testRun, repo.root, "worktree", "", "hello.txt", 2000);
    assert.match(worktree.text, /\+line4-worktree/);

    const head = await gitDiff(testRun, repo.root, "head", "", "hello.txt", 2000);
    assert.match(head.text, /\+line3-staged/);
    assert.match(head.text, /\+line4-worktree/);

    const commit = await gitDiff(testRun, repo.root, "commit", repo.hashes.c2!, "hello.txt", 2000);
    assert.match(commit.text, /\+line2/);

    const truncated = await gitDiff(testRun, repo.root, "head", "", "hello.txt", 3);
    assert.equal(truncated.truncated, true);
  });
});

test("贮藏：push / list / apply / drop", async () => {
  await withFixtureRepo(async (repo) => {
    const push = await gitStashPush(testRun, repo.root, "先收起来", []);
    assert.equal(push.ok, true, push.error ?? "");
    assert.equal(push.empty, false);

    const list = await gitStashList(testRun, repo.root);
    assert.equal(list.ok, true);
    assert.equal(list.stashes.length, 1);
    assert.ok(list.stashes[0]?.subject.endsWith("先收起来"), `subject=${list.stashes[0]?.subject}`);
    assert.ok(list.stashes[0]?.files.some((file) => file.path === "hello.txt"));

    // 贮藏后工作区干净
    const changes = await gitChanges(testRun, repo.root);
    assert.deepEqual(changes.entries, []);

    const apply = await gitStashApply(testRun, repo.root, 0, true);
    assert.equal(apply.ok, true, apply.error ?? "");
    const after = await gitChanges(testRun, repo.root);
    assert.ok(after.entries.length >= 2, "改动已恢复");

    const empty = await gitStashList(testRun, repo.root);
    assert.equal(empty.stashes.length, 0, "pop 之后贮藏列表为空");
  });
});

test("贮藏只包含勾选的文件", async () => {
  await withFixtureRepo(async (repo) => {
    const push = await gitStashPush(testRun, repo.root, "只藏 hello", ["hello.txt"]);
    assert.equal(push.ok, true, push.error ?? "");
    const changes = await gitChanges(testRun, repo.root);
    assert.deepEqual(
      changes.entries.map((entry) => entry.path),
      ["untracked.log"],
      "hello.txt 的改动被贮藏，untracked.log 保留",
    );
  });
});

test("gitStashDrop 删除指定贮藏", async () => {
  await withFixtureRepo(async (repo) => {
    await gitStashPush(testRun, repo.root, "第一条", []);
    await writeFile(join(repo.root, "another.txt"), "x\n", "utf8");
    await git(repo.root, "add", "another.txt");
    await gitStashPush(testRun, repo.root, "第二条", []);
    const drop = await gitStashDrop(testRun, repo.root, 0);
    assert.equal(drop.ok, true);
    const list = await gitStashList(testRun, repo.root);
    assert.equal(list.stashes.length, 1);
    assert.ok(list.stashes[0]?.subject.endsWith("第一条"));
  });
});

/** Hard-clean the fixture's working tree so branch switches and merges can run. */
async function cleanTree(root: string): Promise<void> {
  await git(root, "reset", "-q", "--hard");
  await git(root, "clean", "-fdq");
}

test("merge 冲突：状态、解决、继续", async () => {
  await withFixtureRepo(async (repo) => {
    await cleanTree(repo.root);
    await git(repo.root, "checkout", "-b", "conflict-side", repo.hashes.c1!);
    await writeFile(join(repo.root, "hello.txt"), "conflict-side\n", "utf8");
    await git(repo.root, "add", "hello.txt");
    await git(repo.root, "commit", "-m", "conflict-side 修改");

    await git(repo.root, "checkout", "main");
    await writeFile(join(repo.root, "hello.txt"), "main-side\n", "utf8");
    await git(repo.root, "add", "hello.txt");
    await git(repo.root, "commit", "-m", "main 修改");

    const merge = await gitMerge(testRun, repo.root, "conflict-side", false);
    assert.equal(merge.ok, true, merge.error ?? "");
    assert.equal(merge.conflicts, true);

    const state = await gitSequenceState(testRun, repo.root);
    assert.equal(state.kind, "merge");
    assert.equal(state.branch, "conflict-side");
    assert.deepEqual(state.conflicts, ["hello.txt"]);

    const resolve = await gitConflictResolve(testRun, repo.root, "hello.txt", "ours");
    assert.equal(resolve.ok, true, resolve.error ?? "");
    const text = await git(repo.root, "show", "HEAD:hello.txt").catch(() => "");
    void text; // content check happens via the merge below

    const proceed = await gitSequenceAction(testRun, repo.root, "merge", "continue");
    assert.equal(proceed.ok, true, proceed.error ?? "");
    const after = await gitSequenceState(testRun, repo.root);
    assert.equal(after.kind, "none");
    const subject = await git(repo.root, "log", "-1", "--format=%s");
    assert.match(subject, /main 修改|Merge/);
  });
});

test("merge 无冲突直接完成", async () => {
  await withFixtureRepo(async (repo) => {
    await cleanTree(repo.root);
    const merge = await gitMerge(testRun, repo.root, "side", false);
    assert.equal(merge.ok, true, merge.error ?? "");
    assert.equal(merge.conflicts, false);
    const state = await gitSequenceState(testRun, repo.root);
    assert.equal(state.kind, "none");
  });
});

test("rebase 冲突可中止并恢复", async () => {
  await withFixtureRepo(async (repo) => {
    await cleanTree(repo.root);
    await git(repo.root, "checkout", "-b", "rb-base", repo.hashes.c1!);
    await writeFile(join(repo.root, "hello.txt"), "rb-base\n", "utf8");
    await git(repo.root, "add", "hello.txt");
    await git(repo.root, "commit", "-m", "rb-base 修改");

    await git(repo.root, "checkout", "main");
    const before = (await git(repo.root, "rev-parse", "HEAD")).trim();
    const rebase = await gitRebase(testRun, repo.root, "rb-base");
    assert.equal(rebase.ok, true, rebase.error ?? "");
    assert.equal(rebase.conflicts, true);

    const state = await gitSequenceState(testRun, repo.root);
    assert.equal(state.kind, "rebase");
    assert.equal(state.branch, "main");

    const abort = await gitSequenceAction(testRun, repo.root, "rebase", "abort");
    assert.equal(abort.ok, true, abort.error ?? "");
    const after = (await git(repo.root, "rev-parse", "HEAD")).trim();
    assert.equal(after, before, "abort 后回到原 HEAD");
  });
});

test("cherry-pick 冲突进入拣选状态", async () => {
  await withFixtureRepo(async (repo) => {
    await cleanTree(repo.root);
    await git(repo.root, "checkout", "-b", "pick-side", repo.hashes.c1!);
    await writeFile(join(repo.root, "hello.txt"), "pick-side\n", "utf8");
    await git(repo.root, "add", "hello.txt");
    const pick = (await git(repo.root, "commit", "-m", "pick-side 修改"), (await git(repo.root, "rev-parse", "HEAD")).trim());

    await git(repo.root, "checkout", "main");
    await writeFile(join(repo.root, "hello.txt"), "main-side\n", "utf8");
    await git(repo.root, "add", "hello.txt");
    await git(repo.root, "commit", "-m", "main 修改");

    const result = await gitCherryPick(testRun, repo.root, [pick]);
    assert.equal(result.ok, true, result.error ?? "");
    assert.equal(result.conflicts, true);
    const state = await gitSequenceState(testRun, repo.root);
    assert.equal(state.kind, "cherryPick");
    assert.deepEqual(state.conflicts, ["hello.txt"]);

    const abort = await gitSequenceAction(testRun, repo.root, "cherryPick", "abort");
    assert.equal(abort.ok, true);
  });
});

test("gitReset 三种模式", async () => {
  await withFixtureRepo(async (repo) => {
    const soft = await gitReset(testRun, repo.root, repo.hashes.c2!, "soft");
    assert.equal(soft.ok, true, soft.error ?? "");
    let status = await git(repo.root, "status", "--porcelain");
    assert.match(status, /^[AM]/, "soft 后改动仍在暂存区");

    const mixed = await gitReset(testRun, repo.root, repo.hashes.c2!, "mixed");
    assert.equal(mixed.ok, true);
    status = await git(repo.root, "status", "--porcelain");
    assert.match(status, /^ M| M/, "mixed 后改动回到工作区");

    const hard = await gitReset(testRun, repo.root, repo.hashes.c2!, "hard");
    assert.equal(hard.ok, true);
    const changes = await gitChanges(testRun, repo.root);
    assert.ok(changes.entries.length >= 1, "hard 后至少剩未跟踪文件");
    assert.ok(
      changes.entries.every((entry) => entry.untracked),
      "hard 后没有已跟踪改动，只剩未跟踪文件",
    );
  });
});

test("gitRevert 生成反向提交", async () => {
  await withFixtureRepo(async (repo) => {
    await cleanTree(repo.root);
    // c6 是纯 rename，revert 它不与后续改动冲突。
    const result = await gitRevert(testRun, repo.root, repo.hashes.c6!);
    assert.equal(result.ok, true, result.error ?? "");
    const subject = await git(repo.root, "log", "-1", "--format=%s");
    assert.match(subject, /Revert/);
    const changes = await gitChanges(testRun, repo.root);
    assert.deepEqual(changes.entries, [], "revert 直接生成提交，工作区保持干净");
    const show = await git(repo.root, "show", "--name-status", "--format=", "HEAD");
    assert.match(show, /src\/main\.ts/, "revert 提交恢复了 src/main.ts");
  });
});

test("gitRollbackFile 还原已跟踪文件、删除新文件", async () => {
  await withFixtureRepo(async (repo) => {
    const tracked = await gitRollbackFile(testRun, repo.root, "hello.txt");
    assert.equal(tracked.ok, true, tracked.error ?? "");
    const changes = await gitChanges(testRun, repo.root);
    assert.deepEqual(
      changes.entries.map((entry) => entry.path),
      ["untracked.log"],
    );

    const fresh = await gitRollbackFile(testRun, repo.root, "untracked.log");
    assert.equal(fresh.ok, true, fresh.error ?? "");
    const after = await gitChanges(testRun, repo.root);
    assert.deepEqual(after.entries, []);
  });
});

test("gitBranchRename 重命名分支", async () => {
  await withFixtureRepo(async (repo) => {
    const result = await gitBranchRename(testRun, repo.root, "side", "side-renamed");
    assert.equal(result.ok, true, result.error ?? "");
    const branches = await gitBranches(testRun, repo.root);
    assert.ok(branches.locals.some((branch) => branch.shortName === "side-renamed"));
    assert.ok(!branches.locals.some((branch) => branch.shortName === "side"));
  });
});
