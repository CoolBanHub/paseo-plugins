/**
 * Git operations for the git-manager panel. Every command goes through an
 * injected runner so tests can exercise the real `git` binary while the
 * daemon wires in the SDK process helper.
 */

import { realpath } from "node:fs/promises";
import {
  basename as pathBasename,
  dirname as pathDirname,
  isAbsolute as pathIsAbsolute,
  join as pathJoin,
} from "node:path";
import type {
  ActionResult,
  BranchEntry,
  BranchesResult,
  CommitDetail,
  CommitFile,
  CommitSummary,
  GitRun,
  LocalBranchEntry,
  LogResult,
  PathsResult,
  RawError,
  StatusResult,
  TagEntry,
  TagsResult,
  WorktreeEntry,
  WorktreesResult,
} from "../shared/types";

export type {
  ActionResult,
  BranchEntry,
  BranchesResult,
  CommitDetail,
  CommitFile,
  CommitSummary,
  GitRun,
  LocalBranchEntry,
  LogResult,
  PathsResult,
  RawError,
  StatusResult,
  TagEntry,
  TagsResult,
  WorktreeEntry,
  WorktreesResult,
};

const FS = "\u001f"; // unit separator between fields of one record
const RS = "\u001e"; // record separator between commits
const US = "\u0001"; // separator between for-each-ref fields

const LOG_FORMAT = ["%H", "%h", "%P", "%an", "%ae", "%aI", "%cI", "%D", "%s", "%b"].join(FS) + RS;
const SHOW_FORMAT = ["%H", "%h", "%P", "%an", "%ae", "%aI", "%cn", "%cI", "%D", "%s", "%b"].join(FS) + RS;
const REF_FORMAT = [
  "%(refname)",
  "%(refname:short)",
  "%(objectname)",
  "%(committerdate:iso8601-strict)",
  "%(if)%(HEAD)%(then)1%(else)0%(end)",
  "%(subject)",
].join(US);
const TAG_FORMAT = [
  "%(refname)",
  "%(refname:short)",
  "%(objectname)",
  "%(objecttype)",
  "%(*objectname)",
  "%(creatordate:iso8601-strict)",
  "%(subject)",
].join(US);

/** Ref names only: rejects leading dashes (option injection) and shell-unsafe bytes. */
export function isValidRefName(name: string): boolean {
  return /^(?!-)[A-Za-z0-9][A-Za-z0-9._/@+-]*$/.test(name);
}

export function describeError(err: unknown): string {
  const stderr = (err as { stderr?: unknown }).stderr;
  if (typeof stderr === "string" && stderr.trim().length > 0) {
    return stderr.trim().split("\n").slice(0, 4).join("\n");
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n").slice(0, 4).join("\n");
}

/**
 * Global options carried by every invocation. git quotes non-ASCII paths as
 * C-style octal escapes by default (`core.quotepath`), which turns Chinese
 * filenames into mojibake; print them verbatim instead.
 */
const GIT_GLOBAL_ARGS: readonly string[] = ["-c", "core.quotepath=false"];

async function runChecked(run: GitRun, args: readonly string[], cwd: string, timeoutMs?: number): Promise<string> {
  try {
    return await run([...GIT_GLOBAL_ARGS, ...args], cwd, timeoutMs);
  } catch (err) {
    //execFile rejects on non-zero exits; surface git's own words.
    throw new Error(describeError(err));
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export function parseStatusBody(body: string): Omit<StatusResult, "root" | keyof RawError> {
  const result = {
    currentBranch: null as string | null,
    detached: false,
    upstream: null as string | null,
    ahead: null as number | null,
    behind: null as number | null,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    head: null as string | null,
  };
  for (const line of body.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length).trim();
      if (value === "(detached)") {
        result.detached = true;
      } else {
        result.currentBranch = value;
      }
    } else if (line.startsWith("# branch.upstream ")) {
      result.upstream = line.slice("# branch.upstream ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const counts = line.slice("# branch.ab ".length).trim().split(/\s+/);
      result.ahead = Number.parseInt(counts[0] ?? "", 10) || 0;
      result.behind = Number.parseInt(counts[1] ?? "", 10) || 0;
    } else if (line.startsWith("# branch.oid ")) {
      result.head = line.slice("# branch.oid ".length).trim();
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      // Ordinary and rename entries alike: "1 <XY> …" / "2 <XY> … old new".
      const index = line[2];
      const worktree = line[3];
      if (index !== undefined && index !== ".") result.staged += 1;
      if (worktree !== undefined && worktree !== ".") result.unstaged += 1;
    } else if (line.startsWith("u ")) {
      result.unstaged += 1;
    } else if (line.startsWith("? ")) {
      result.untracked += 1;
    }
  }
  return result;
}

export async function gitStatus(run: GitRun, cwd: string): Promise<StatusResult> {
  const failed = (error: string): StatusResult => ({
    ok: false,
    error,
    root: null,
    currentBranch: null,
    detached: false,
    upstream: null,
    ahead: null,
    behind: null,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    head: null,
  });
  let root: string;
  try {
    root = (await runChecked(run, ["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
  try {
    const body = await runChecked(run, ["status", "--porcelain=v2", "--branch"], root);
    return { ok: true, error: null, root, ...parseStatusBody(body) };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// branches
// ---------------------------------------------------------------------------

export function parseForEachRef(body: string): { locals: LocalBranchEntry[]; remotes: BranchEntry[] } {
  const locals: LocalBranchEntry[] = [];
  const remotes: BranchEntry[] = [];
  for (const record of body.split("\n")) {
    if (record.trim().length === 0) continue;
    const fields = record.split(US);
    if (fields.length < 6) continue;
    const [name, shortName, hash, date, headMark, subject] = fields;
    if (!name || !hash) continue;
    if (name.startsWith("refs/heads/")) {
      locals.push({
        name,
        shortName: shortName ?? name.slice("refs/heads/".length),
        hash,
        subject: subject ?? "",
        date: date ?? "",
        isCurrent: headMark === "1",
        ahead: null,
        behind: null,
      });
    } else if (name.startsWith("refs/remotes/")) {
      remotes.push({
        name,
        shortName: shortName ?? name.slice("refs/remotes/".length),
        hash,
        subject: subject ?? "",
        date: date ?? "",
      });
    }
  }
  return { locals, remotes };
}

export async function gitBranches(run: GitRun, cwd: string): Promise<BranchesResult> {
  const failed = (error: string): BranchesResult => ({ ok: false, error, locals: [], remotes: [] });
  let root: string;
  try {
    root = (await runChecked(run, ["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
  let body: string;
  try {
    body = await runChecked(
      run,
      ["for-each-ref", "--sort=-committerdate", `--format=${REF_FORMAT}`, "refs/heads", "refs/remotes"],
      root,
    );
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
  const { locals, remotes } = parseForEachRef(body);

  // Ahead/behind of each local branch against HEAD (0/0 for the current
  // branch), capped and parallelised; one fast rev-list per branch.
  for (const branch of locals) {
    if (branch.isCurrent) {
      branch.ahead = 0;
      branch.behind = 0;
    }
  }
  const targets = locals.filter((branch) => !branch.isCurrent).slice(0, 64);
  await Promise.all(
    targets.map(async (branch) => {
      try {
        const out = await runChecked(run, ["rev-list", "--left-right", "--count", `${branch.name}...HEAD`], root);
        const [ahead, behind] = out.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
        branch.ahead = Number.isFinite(ahead) ? ahead : null;
        branch.behind = Number.isFinite(behind) ? behind : null;
      } catch {
        // leave null when the count is unavailable
      }
    }),
  );

  return { ok: true, error: null, locals, remotes };
}

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

export function parseLogBody(body: string): CommitSummary[] {
  const commits: CommitSummary[] = [];
  for (const rawRecord of body.split(RS)) {
    const record = rawRecord.replace(/^\n/, "");
    if (record.trim().length === 0) continue;
    const fields = record.split(FS);
    if (fields.length < 10) continue;
    const [hash, shortHash, parents, authorName, authorEmail, authorDate, committerDate, refs, subject, ...bodyParts] = fields;
    commits.push({
      hash: hash ?? "",
      shortHash: shortHash ?? "",
      parents: parents && parents.length > 0 ? parents.split(" ").filter((value) => value.length > 0) : [],
      authorName: authorName ?? "",
      authorEmail: authorEmail ?? "",
      authorDate: authorDate ?? "",
      committerDate: committerDate ?? "",
      refs: refs && refs.length > 0 ? refs.split(", ").filter((value) => value.length > 0) : [],
      subject: subject ?? "",
      body: bodyParts.join(FS).replace(/\n+$/, ""),
    });
  }
  return commits;
}

export async function gitLog(
  run: GitRun,
  cwd: string,
  ref: string,
  limit: number,
  skip: number,
  path = "",
): Promise<LogResult> {
  const failed = (error: string): LogResult => ({ ok: false, error, commits: [], hasMore: false });
  if (ref !== "ALL" && !isValidRefName(ref)) {
    return failed("无效的分支名");
  }
  const pathFilter = path.trim().slice(0, 512);
  let root: string;
  try {
    root = (await runChecked(run, ["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
  try {
    const args = [
      "log",
      "--date-order",
      `--pretty=format:${LOG_FORMAT}`,
      `--max-count=${limit + 1}`,
      `--skip=${skip}`,
    ];
    if (ref === "ALL") {
      args.push("--all");
    } else {
      args.push(ref);
    }
    if (pathFilter.length > 0) {
      // Everything after -- is a pathspec, never an option.
      args.push("--", pathFilter);
    }
    const body = await runChecked(run, args, root);
    const commits = parseLogBody(body);
    const hasMore = commits.length > limit;
    if (hasMore) commits.length = limit;
    return { ok: true, error: null, commits, hasMore };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// commit detail
// ---------------------------------------------------------------------------

export function parseNumstatTokens(tokens: readonly string[]): Omit<CommitFile, "status">[] {
  const files: Omit<CommitFile, "status">[] = [];
  let index = 0;
  const numstatHead = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/;
  while (index < tokens.length) {
    const match = numstatHead.exec(tokens[index] ?? "");
    if (!match) break;
    const additions = match[1] === "-" ? null : Number.parseInt(match[1], 10);
    const deletions = match[2] === "-" ? null : Number.parseInt(match[2], 10);
    let path = match[3];
    let oldPath: string | null = null;
    if (path.length === 0) {
      // Rename under -z: the path field is empty, then old path, then new path.
      const old = tokens[index + 1] ?? "";
      const next = tokens[index + 2] ?? "";
      if (old.length > 0 && next.length > 0 && !numstatHead.test(old) && !numstatHead.test(next)) {
        oldPath = old;
        path = next;
        index += 3;
      } else {
        index += 1;
      }
    } else {
      index += 1;
    }
    files.push({
      path,
      oldPath,
      additions,
      deletions,
      binary: additions === null || deletions === null,
    });
  }
  return files;
}

export function parseNameStatusTokens(tokens: readonly string[]): { path: string; status: string; oldPath: string | null }[] {
  const entries: { path: string; status: string; oldPath: string | null }[] = [];
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index] ?? "";
    if (status.length === 0) {
      index += 1;
      continue;
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      // Under -z: status, old path, new path.
      entries.push({
        oldPath: tokens[index + 1] ?? null,
        path: tokens[index + 2] ?? "",
        status: status[0] ?? "?",
      });
      index += 3;
    } else {
      entries.push({ path: tokens[index + 1] ?? "", status: status[0] ?? "?", oldPath: null });
      index += 2;
    }
  }
  return entries;
}

export async function gitCommit(run: GitRun, cwd: string, hash: string): Promise<CommitDetail> {
  const failed = (error: string): CommitDetail => ({
    ok: false,
    error,
    hash: "",
    shortHash: "",
    parents: [],
    authorName: "",
    authorEmail: "",
    authorDate: "",
    committerName: "",
    committerDate: "",
    subject: "",
    body: "",
    files: [],
    totalAdditions: 0,
    totalDeletions: 0,
  });
  let root: string;
  try {
    root = (await runChecked(run, ["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
  try {
    const showArgs = [
      "show",
      "--no-color",
      "--first-parent",
      "-M",
      "--numstat",
      "-z",
      `--format=${SHOW_FORMAT}`,
      hash,
    ];
    const showBody = await runChecked(run, showArgs, root);
    const [headerRecord, numstatBlob] = splitShowBody(showBody);
    const fields = headerRecord.split(FS);
    if (fields.length < 11) {
      return failed("无法解析提交信息");
    }
    const [hashFull, shortHash, parents, authorName, authorEmail, authorDate, committerName, committerDate, refs, subject, ...bodyParts] = fields;

    const statusBody = await runChecked(
      run,
      ["diff-tree", "--no-commit-id", "--name-status", "-r", "-M", "-z", "--first-parent", "--root", hashFull ?? ""],
      root,
    );
    const statusTokens = statusBody.length === 0 ? [] : statusBody.split("\0").filter((token) => token.length > 0);
    const statusEntries = parseNameStatusTokens(statusTokens);
    const statusByPath = new Map<string, { status: string; oldPath: string | null }>();
    for (const entry of statusEntries) {
      statusByPath.set(entry.path, entry);
    }

    const numstatTokens = numstatBlob.length === 0 ? [] : numstatBlob.split("\0").filter((token) => token.length > 0);
    const parsedFiles = parseNumstatTokens(numstatTokens);
    const files: CommitFile[] = parsedFiles.map((file) => {
      const status = statusByPath.get(file.path);
      return {
        ...file,
        status: status?.status ?? (file.binary ? "M" : file.oldPath ? "R" : "M"),
      };
    });

    let totalAdditions = 0;
    let totalDeletions = 0;
    for (const file of files) {
      totalAdditions += file.additions ?? 0;
      totalDeletions += file.deletions ?? 0;
    }

    return {
      ok: true,
      error: null,
      hash: hashFull ?? "",
      shortHash: shortHash ?? "",
      parents: parents && parents.length > 0 ? parents.split(" ").filter((value) => value.length > 0) : [],
      authorName: authorName ?? "",
      authorEmail: authorEmail ?? "",
      authorDate: authorDate ?? "",
      committerName: committerName ?? "",
      committerDate: committerDate ?? "",
      subject: subject ?? "",
      body: bodyParts.join(FS).replace(/\n+$/, ""),
      files,
      totalAdditions,
      totalDeletions,
    };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

function splitShowBody(body: string): [string, string] {
  const recordEnd = body.indexOf(RS);
  if (recordEnd === -1) {
    return [body, ""];
  }
  const header = body.slice(0, recordEnd).replace(/^\n/, "");
  // With -z, git terminates the pretty header with NUL before the diff.
  const rest = body.slice(recordEnd + RS.length).replace(/^[\0\n\r\t ]+/, "");
  return [header, rest];
}

// ---------------------------------------------------------------------------
// path browser (for the path filter dropdown)
// ---------------------------------------------------------------------------

export function listChildPaths(files: readonly string[], dir: string): { dirs: string[]; files: string[] } {
  const prefix = dir.length > 0 ? `${dir}/` : "";
  const dirs = new Set<string>();
  const childFiles: string[] = [];
  for (const file of files) {
    if (prefix.length > 0 && !file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    if (rest.length === 0) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) {
      childFiles.push(rest);
    } else {
      const segment = rest.slice(0, slash);
      if (segment.length > 0 && segment !== "." && segment !== "..") dirs.add(segment);
    }
  }
  return {
    dirs: [...dirs].sort((a, b) => a.localeCompare(b)),
    files: childFiles.sort((a, b) => a.localeCompare(b)),
  };
}

export async function gitPaths(run: GitRun, cwd: string, dir: string): Promise<PathsResult> {
  const failed = (error: string): PathsResult => ({ ok: false, error, dir: "", dirs: [], files: [] });
  const clean = dir.replace(/\/+$/, "");
  if (clean.includes("..") || clean.startsWith("/") || /[\0]/.test(clean)) {
    return failed("无效的目录");
  }
  let root: string;
  try {
    root = (await runChecked(run, ["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
  try {
    const body = await runChecked(run, ["ls-files", "--"], root);
    const files = body.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    const children = listChildPaths(files, clean);
    return { ok: true, error: null, dir: clean, ...children };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------

export function parseTagsBody(body: string): TagEntry[] {
  const tags: TagEntry[] = [];
  for (const record of body.split("\n")) {
    if (record.trim().length === 0) continue;
    const fields = record.split(US);
    if (fields.length < 7) continue;
    const [name, shortName, hash, objectType, peeled, date, subject] = fields;
    if (!name || !hash) continue;
    const annotated = objectType === "tag";
    tags.push({
      name,
      shortName: shortName ?? name.slice("refs/tags/".length),
      hash,
      // Annotated tags point at a tag object; %(*objectname) peels to the commit.
      commitHash: (peeled && peeled.length > 0 ? peeled : hash) ?? "",
      subject: subject ?? "",
      date: date ?? "",
      annotated,
    });
  }
  return tags;
}

export async function gitTags(run: GitRun, cwd: string): Promise<TagsResult> {
  const failed = (error: string): TagsResult => ({ ok: false, error, tags: [] });
  let root: string;
  try {
    root = (await runChecked(run, ["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
  try {
    const body = await runChecked(
      run,
      ["for-each-ref", "--sort=-creatordate", `--format=${TAG_FORMAT}`, "refs/tags"],
      root,
    );
    return { ok: true, error: null, tags: parseTagsBody(body) };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// worktrees
// ---------------------------------------------------------------------------

/** Parse `git worktree list --porcelain`: blank-line separated attribute blocks. */
export function parseWorktreeList(body: string): WorktreeEntry[] {
  const worktrees: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  const flush = () => {
    if (current && current.path.length > 0) worktrees.push(current);
    current = null;
  };
  for (const line of body.split("\n")) {
    const text = line.replace(/\r$/, "");
    if (text.trim().length === 0) {
      flush();
      continue;
    }
    if (text.startsWith("worktree ")) {
      flush();
      current = {
        path: text.slice("worktree ".length).trim(),
        head: "",
        branch: null,
        detached: false,
        bare: false,
        isMain: false,
      };
    } else if (!current) {
      continue;
    } else if (text.startsWith("HEAD ")) {
      current.head = text.slice("HEAD ".length).trim();
    } else if (text.startsWith("branch ")) {
      current.branch = text.slice("branch ".length).trim();
    } else if (text === "bare") {
      current.bare = true;
    } else if (text === "detached") {
      current.detached = true;
    }
    // "locked <reason>" / "prunable <reason>" carry no UI weight yet.
  }
  flush();
  if (worktrees.length > 0) worktrees[0]!.isMain = true;
  return worktrees;
}

async function gitRoot(run: GitRun, cwd: string): Promise<{ root: string } | { error: string }> {
  try {
    return { root: (await runChecked(run, ["rev-parse", "--show-toplevel"], cwd)).trim() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * git reports physical paths while callers hand us symlinked ones (e.g.
 * macOS /var vs /private/var); normalise every worktree path through
 * realpath so add/list/remove compare against the same strings.
 */
async function realpathSafe(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function listWorktreeEntries(run: GitRun, root: string): Promise<WorktreeEntry[]> {
  const body = await runChecked(run, ["worktree", "list", "--porcelain"], root);
  const entries = parseWorktreeList(body);
  await Promise.all(
    entries.map(async (entry) => {
      entry.path = await realpathSafe(entry.path);
    }),
  );
  return entries;
}

export async function gitWorktrees(run: GitRun, cwd: string): Promise<WorktreesResult> {
  const failed = (error: string): WorktreesResult => ({ ok: false, error, worktrees: [] });
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  try {
    return { ok: true, error: null, worktrees: await listWorktreeEntries(run, rootInfo.root) };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Relative folder names land next to the repository (like the usual
 * `git worktree add ../name`); absolute paths pass through. Traversal and
 * empty components are rejected before git ever sees them.
 */
export function resolveWorktreePath(root: string, input: string): string | null {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (trimmed.length === 0 || trimmed.includes("\0")) return null;
  if (pathIsAbsolute(trimmed)) return trimmed;
  const parts = trimmed.split(/[\\/]/);
  if (parts.some((part) => part.length === 0 || part === "..")) return null;
  return pathJoin(pathDirname(root), ...parts);
}

export async function gitWorktreeAdd(
  run: GitRun,
  cwd: string,
  path: string,
  newBranch: string,
  ref: string,
): Promise<ActionResult> {
  const failed = (error: string): ActionResult => ({ ok: false, error, message: null });
  if (newBranch.length > 0 && !isValidRefName(newBranch)) return failed("无效的分支名");
  if (ref.length > 0 && !isValidRefName(ref)) return failed("无效的起点");
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  const resolved = resolveWorktreePath(rootInfo.root, path);
  if (resolved === null) return failed("无效的目录名");
  // The target does not exist yet; canonicalise through its (existing) parent.
  const canonical = pathJoin(await realpathSafe(pathDirname(resolved)), pathBasename(resolved));
  try {
    const args = ["worktree", "add"];
    if (newBranch.length > 0) args.push("-b", newBranch);
    args.push(canonical);
    if (ref.length > 0) args.push(ref);
    await runChecked(run, args, rootInfo.root, 60_000);
    return { ok: true, error: null, message: `已添加 worktree ${canonical}` };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

export async function gitWorktreeRemove(
  run: GitRun,
  cwd: string,
  path: string,
  force: boolean,
): Promise<ActionResult> {
  const failed = (error: string): ActionResult => ({ ok: false, error, message: null });
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  try {
    // Match a registered worktree exactly: never remove by fuzzy path.
    const worktrees = await listWorktreeEntries(run, rootInfo.root);
    const requested = await realpathSafe(path.trim());
    const target = worktrees.find((worktree) => worktree.path === requested);
    if (!target) return failed("worktree 不存在");
    if (target.isMain) return failed("主 worktree 不能移除");
    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(target.path);
    await runChecked(run, args, rootInfo.root, 30_000);
    return { ok: true, error: null, message: `已移除 worktree ${target.path}` };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

export async function gitWorktreePrune(run: GitRun, cwd: string): Promise<ActionResult> {
  const failed = (error: string): ActionResult => ({ ok: false, error, message: null });
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  try {
    await runChecked(run, ["worktree", "prune"], rootInfo.root, 30_000);
    return { ok: true, error: null, message: "已清理失效的 worktree 记录" };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

export async function gitCheckout(run: GitRun, cwd: string, ref: string): Promise<ActionResult> {
  try {
    const root = (await runChecked(run, ["rev-parse", "--show-toplevel"], cwd)).trim();
    await runChecked(run, ["checkout", ref], root, 30_000);
    // git's switch notes go to stderr, so detect the outcome state directly:
    // symbolic-ref exits non-zero when HEAD is detached (tag/commit checkout).
    let detached = false;
    try {
      await runChecked(run, ["symbolic-ref", "-q", "HEAD"], root);
    } catch {
      detached = true;
    }
    const message = detached ? `已检出 ${ref}（分离头指针）` : `已切换到 ${ref}`;
    return { ok: true, error: null, message };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), message: null };
  }
}

export async function gitBranchCreate(
  run: GitRun,
  cwd: string,
  name: string,
  startPoint: string,
  checkout: boolean,
): Promise<ActionResult> {
  const failed = (error: string): ActionResult => ({ ok: false, error, message: null });
  if (!isValidRefName(name)) return failed("无效的分支名");
  if (startPoint.length > 0 && !isValidRefName(startPoint)) return failed("无效的起点");
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  try {
    const args = checkout ? ["checkout", "-b", name] : ["branch", name];
    if (startPoint.length > 0) args.push(startPoint);
    await runChecked(run, args, rootInfo.root, 30_000);
    return {
      ok: true,
      error: null,
      message: checkout ? `已创建并检出 ${name}` : `已创建分支 ${name}`,
    };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

export async function gitBranchDelete(
  run: GitRun,
  cwd: string,
  name: string,
  force: boolean,
): Promise<ActionResult> {
  const failed = (error: string): ActionResult => ({ ok: false, error, message: null });
  if (!isValidRefName(name)) return failed("无效的分支名");
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  try {
    // -d keeps unmerged commits safe; -D only after the UI confirms.
    await runChecked(run, ["branch", force ? "-D" : "-d", name], rootInfo.root, 15_000);
    return { ok: true, error: null, message: `已删除分支 ${name}` };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

export async function gitTagCreate(
  run: GitRun,
  cwd: string,
  name: string,
  ref: string,
  message: string,
): Promise<ActionResult> {
  const failed = (error: string): ActionResult => ({ ok: false, error, message: null });
  if (!isValidRefName(name)) return failed("无效的标签名");
  if (ref.length > 0 && !isValidRefName(ref)) return failed("无效的目标");
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  try {
    const args = ["tag"];
    const note = message.trim();
    if (note.length > 0) args.push("-a", name, "-m", note.slice(0, 2000));
    else args.push(name);
    if (ref.length > 0) args.push(ref);
    await runChecked(run, args, rootInfo.root, 15_000);
    return { ok: true, error: null, message: `已创建标签 ${name}` };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

export async function gitTagDelete(run: GitRun, cwd: string, name: string): Promise<ActionResult> {
  const failed = (error: string): ActionResult => ({ ok: false, error, message: null });
  if (!isValidRefName(name)) return failed("无效的标签名");
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  try {
    await runChecked(run, ["tag", "-d", name], rootInfo.root, 15_000);
    return { ok: true, error: null, message: `已删除标签 ${name}` };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

export async function gitFetch(run: GitRun, cwd: string): Promise<ActionResult> {
  try {
    const root = (await runChecked(run, ["rev-parse", "--show-toplevel"], cwd)).trim();
    await runChecked(run, ["fetch", "--prune"], root, 120_000);
    return { ok: true, error: null, message: "已从远端获取更新" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), message: null };
  }
}

export interface DiffStat {
  files: number;
  additions: number;
  deletions: number;
}

/** Parse the one-line summary printed by `git diff --shortstat` (LC_ALL=C). */
export function parseShortStat(body: string): DiffStat {
  const files = /(\d+) files? changed/.exec(body);
  const insertions = /(\d+) insertions?\(\+\)/.exec(body);
  const deletions = /(\d+) deletions?\(-\)/.exec(body);
  return {
    files: files ? Number.parseInt(files[1] ?? "0", 10) : 0,
    additions: insertions ? Number.parseInt(insertions[1] ?? "0", 10) : 0,
    deletions: deletions ? Number.parseInt(deletions[1] ?? "0", 10) : 0,
  };
}

/** One toast-sized line instead of git's own multi-screen diffstat. */
export function formatPullSummary(
  before: string,
  after: string,
  commits: number,
  stat: DiffStat,
): string {
  const range = `${before.slice(0, 8)} → ${after.slice(0, 8)}`;
  const head = `快进 ${commits} 个提交（${range}）`;
  if (stat.files === 0) return `已${head}`;
  const delta =
    stat.additions === 0 && stat.deletions === 0 ? "" : `（+${stat.additions} −${stat.deletions}）`;
  return `已${head}，更新 ${stat.files} 个文件${delta}`;
}

async function headOrNull(run: GitRun, cwd: string): Promise<string | null> {
  try {
    const head = (await runChecked(run, ["rev-parse", "--verify", "--quiet", "HEAD"], cwd)).trim();
    return head.length > 0 ? head : null;
  } catch {
    return null; // unborn branch: the repository has no commit yet
  }
}

/**
 * Pull fast-forwards only, so the panel can describe the result itself: git's
 * stdout is a full per-file diffstat, far too noisy for a toast (and it used to
 * leak octal-escaped paths).
 */
export async function gitPull(run: GitRun, cwd: string): Promise<ActionResult> {
  try {
    const root = (await runChecked(run, ["rev-parse", "--show-toplevel"], cwd)).trim();
    const before = await headOrNull(run, root);
    await runChecked(run, ["pull", "--ff-only"], root, 120_000);
    const after = (await runChecked(run, ["rev-parse", "HEAD"], root)).trim();
    if (before === null) {
      // Empty repository: the pull seeded the first commits.
      return { ok: true, error: null, message: `已拉取到 ${after.slice(0, 8)}` };
    }
    if (before === after) {
      return { ok: true, error: null, message: "已是最新，没有可拉取的提交" };
    }
    const countText = await runChecked(run, ["rev-list", "--count", `${before}..${after}`], root);
    const commits = Number.parseInt(countText.trim(), 10) || 0;
    const statText = await runChecked(run, ["diff", "--no-ext-diff", "--shortstat", before, after], root);
    return { ok: true, error: null, message: formatPullSummary(before, after, commits, parseShortStat(statText)) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), message: null };
  }
}
