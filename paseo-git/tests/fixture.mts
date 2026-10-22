import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitRun } from "../server/git-ops.ts";

const execFileAsync = promisify(execFile);

/** Test runner against the real git binary, mirroring server/git-runner.ts. */
export const testRun: GitRun = async (args, cwd, timeoutMs = 15_000) => {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout;
};

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return testRun(args, cwd);
}

export interface FixtureRepo {
  root: string;
  hashes: Record<string, string>;
}

function commitEnv(date: string) {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "张三",
    GIT_AUTHOR_EMAIL: "zhang@example.com",
    GIT_COMMITTER_NAME: "李四",
    GIT_COMMITTER_EMAIL: "li@example.com",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
}

async function commit(root: string, date: string, message: string): Promise<string> {
  await execFileAsync(
    "git",
    ["commit", "--allow-empty", "-m", message],
    { cwd: root, env: commitEnv(date) },
  );
  return (await git(root, "rev-parse", "HEAD")).trim();
}

/** Run git with the fixture's deterministic author/committer dates. */
async function gitDated(root: string, date: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: root, env: commitEnv(date) });
}

/**
 * Fixture layout:
 *   main:    c1 - c2 - c4(merge) - c6(rename)
 *   feature:  \- c3 ----------/
 *   side:     c4 - c5（从 merge 之后切出，未合并）
 *   origin/main tracks c2; tag v1 on c1.
 *   Working tree has staged + unstaged + untracked files.
 */
export async function createFixtureRepo(): Promise<FixtureRepo> {
  const root = await mkdtemp(join(tmpdir(), "paseo-git-test-"));
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.name", "李四");
  await git(root, "config", "user.email", "li@example.com");
  await git(root, "config", "commit.gpgsign", "false");

  await writeFile(join(root, "hello.txt"), "line1\n", "utf8");
  await git(root, "add", ".");
  const c1 = await commit(root, "2026-01-01T10:00:00+08:00", "初始提交\n\n第一行的说明\n第二行");

  await writeFile(join(root, "hello.txt"), "line1\nline2\n", "utf8");
  await mkdir(join(root, "src", "util"), { recursive: true });
  await writeFile(join(root, "src", "main.ts"), "export const a = 1;\n", "utf8");
  await writeFile(join(root, "src", "util", "helper.ts"), "export const b = 2;\n", "utf8");
  await git(root, "add", ".");
  const c2 = await commit(root, "2026-01-02T11:00:00+08:00", "添加第二行与 src 目录");

  await git(root, "checkout", "-b", "feature");
  await writeFile(join(root, "feature.txt"), "feature\n", "utf8");
  await git(root, "add", ".");
  const c3 = await commit(root, "2026-01-03T12:00:00+08:00", "feature 分支提交");

  await git(root, "checkout", "main");
  await gitDated(root, "2026-01-02T12:30:00+08:00", "merge", "--no-ff", "-m", "合并 feature", "feature");
  const c4 = (await git(root, "rev-parse", "HEAD")).trim();

  await git(root, "checkout", "-b", "side");
  const c5 = await commit(root, "2026-01-04T09:00:00+08:00", "side 分支提交");
  await git(root, "checkout", "main");

  await rename(join(root, "src", "main.ts"), join(root, "src-renamed.ts"));
  await git(root, "add", ".");
  const c6 = await commit(root, "2026-01-05T09:30:00+08:00", "重命名 src/main.ts");

  await git(root, "tag", "v1", c1);

  // Fake a remote tracking ref pointing at c2 (no network): a configured
  // remote is required before git accepts upstream tracking.
  await git(root, "remote", "add", "origin", root);
  await git(root, "update-ref", "refs/remotes/origin/main", c2);
  await git(root, "branch", "--set-upstream-to=origin/main", "main");

  // Working tree: staged edit, unstaged edit, untracked file.
  await writeFile(join(root, "hello.txt"), "line1\nline2\nline3-staged\n", "utf8");
  await git(root, "add", "hello.txt");
  await writeFile(join(root, "hello.txt"), "line1\nline2\nline3-staged\nline4-worktree\n", "utf8");
  await writeFile(join(root, "untracked.log"), "noise\n", "utf8");

  return {
    root,
    hashes: { c1, c2, c3, c4, c5, c6 },
  };
}

export async function withFixtureRepo(test: (repo: FixtureRepo) => Promise<void>): Promise<void> {
  const repo = await createFixtureRepo();
  try {
    await test(repo);
  } finally {
    await rm(repo.root, { recursive: true, force: true });
  }
}

export async function createBinaryCommit(root: string): Promise<string> {
  const dir = join(root, "assets");
  await mkdir(dir, { recursive: true });
  // PNG magic + NUL bytes: git classifies blobs with NULs as binary.
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64),
    Buffer.from([0x49, 0x45, 0x4e, 0x44]),
  ]);
  await writeFile(join(dir, "logo.png"), png);
  await git(root, "add", ".");
  return commit(root, "2026-01-06T10:00:00+08:00", "添加二进制文件");
}

export { mkdir };
