/**
 * Git operations for the git-manager panel. Every command goes through an
 * injected runner so tests can exercise the real `git` binary while the
 * daemon wires in the SDK process helper.
 */

import { access, readFile, realpath, unlink } from "node:fs/promises";
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
  ChangeEntry,
  ChangesResult,
  CommitDetail,
  CommitFile,
  CommitSummary,
  DiffResult,
  GitRun,
  LocalBranchEntry,
  LogResult,
  PathsResult,
  RawError,
  RecentMessagesResult,
  SequenceKind,
  SequenceState,
  StashEntry,
  StashListResult,
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
  ChangeEntry,
  ChangesResult,
  CommitDetail,
  CommitFile,
  CommitSummary,
  DiffResult,
  GitRun,
  LocalBranchEntry,
  LogResult,
  PathsResult,
  RawError,
  RecentMessagesResult,
  SequenceKind,
  SequenceState,
  StashEntry,
  StashListResult,
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
  "%(upstream:short)",
  "%(upstream:track,nobracket)",
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

/**
 * A checkout/commit target must be a plain object name: a full or abbreviated
 * hex object id, or a ref expression the same character class allows. Values
 * starting with "-" would be parsed as git options by the child process
 * (e.g. `--output=...` can write files), so they are rejected outright.
 */
export function isValidRevision(revision: string): boolean {
  return revision.length > 0 && revision.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._/+@-]*$/.test(revision);
}

/** A full or abbreviated commit hash. */
export function isValidCommitHash(hash: string): boolean {
  return /^[0-9a-fA-F]{4,64}$/.test(hash);
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

/** Parse "ahead 2", "behind 3", "ahead 1, behind 2" from %(upstream:track,nobracket). */
export function parseTrackCounts(track: string): { ahead: number | null; behind: number | null } {
  if (track.trim().length === 0) return { ahead: 0, behind: 0 };
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  if (!ahead && !behind) return { ahead: null, behind: null }; // gone/diverged w/o counts
  return {
    ahead: ahead ? Number.parseInt(ahead[1] ?? "0", 10) : 0,
    behind: behind ? Number.parseInt(behind[1] ?? "0", 10) : 0,
  };
}

export function parseForEachRef(body: string): { locals: LocalBranchEntry[]; remotes: BranchEntry[] } {
  const locals: LocalBranchEntry[] = [];
  const remotes: BranchEntry[] = [];
  for (const record of body.split("\n")) {
    if (record.trim().length === 0) continue;
    const fields = record.split(US);
    if (fields.length < 8) continue;
    const [name, shortName, hash, date, headMark, subject, upstream, track] = fields;
    if (!name || !hash) continue;
    if (name.startsWith("refs/heads/")) {
      const counts = parseTrackCounts(track ?? "");
      locals.push({
        name,
        shortName: shortName ?? name.slice("refs/heads/".length),
        hash,
        subject: subject ?? "",
        date: date ?? "",
        isCurrent: headMark === "1",
        upstream: upstream && upstream.length > 0 ? upstream : null,
        ahead: upstream && upstream.length > 0 ? counts.ahead : null,
        behind: upstream && upstream.length > 0 ? counts.behind : null,
      });
    } else if (name.startsWith("refs/remotes/")) {
      // Skip the symbolic origin/HEAD pointer; it duplicates a real branch.
      if (name.endsWith("/HEAD")) continue;
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
  // Ahead/behind come straight from for-each-ref's upstream:track field — one
  // command total instead of a rev-list per branch.
  return { ok: true, error: null, ...parseForEachRef(body) };
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
  if (!isValidCommitHash(hash)) {
    return failed(`无效的提交哈希：${hash.slice(0, 80)}`);
  }
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
  if (!isValidRevision(ref)) {
    return { ok: false, error: `无效的检出目标：${ref.slice(0, 80)}`, message: null };
  }
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

export interface PushResult extends ActionResult {
  /** True when the push was refused only because the branch has no upstream. */
  needsUpstream: boolean;
}

/** One toast-sized line, counted before pushing so the number survives the update. */
export function formatPushSummary(upstream: string, commits: number): string {
  if (commits === 0) return "远端已是最新，没有可推送的提交";
  return `已推送 ${commits} 个提交到 ${upstream}`;
}

/**
 * Push the current branch. Without an upstream the push is refused with
 * `needsUpstream: true` — the panel asks, then retries with setUpstream to
 * run `push -u origin <branch>` (branch name comes from the repo itself,
 * never the client).
 */
export async function gitPush(run: GitRun, cwd: string, setUpstream: boolean, force = false): Promise<PushResult> {
  const failed = (error: string): PushResult => ({ ok: false, error, message: null, needsUpstream: false });
  let root: string;
  try {
    root = (await runChecked(run, ["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
  try {
    const branch = (await runChecked(run, ["rev-parse", "--abbrev-ref", "HEAD"], root)).trim();
    if (branch === "HEAD") return failed("当前处于分离头指针状态，没有分支可推送");
    let upstream: string | null = null;
    try {
      upstream = (await runChecked(run, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], root)).trim();
    } catch {
      upstream = null; // branch.<name>.remote / .push not configured yet
    }
    if (upstream === null) {
      if (!setUpstream) {
        return { ok: false, error: `分支 ${branch} 没有上游分支`, message: null, needsUpstream: true };
      }
      await runChecked(run, ["push", "-u", "origin", ...(force ? ["--force-with-lease"] : []), branch], root, 120_000);
      return { ok: true, error: null, message: `已推送 ${branch} 并建立上游跟踪 origin/${branch}`, needsUpstream: false };
    }
    const countText = await runChecked(run, ["rev-list", "--count", `${upstream}..HEAD`], root);
    const commits = Number.parseInt(countText.trim(), 10) || 0;
    const pushArgs = ["push"];
    if (force) pushArgs.push("--force-with-lease");
    await runChecked(run, pushArgs, root, 120_000);
    return {
      ok: true,
      error: null,
      message: force && commits >= 0
        ? `已强制推送到 ${upstream}`
        : formatPushSummary(upstream, commits),
      needsUpstream: false,
    };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// working-tree changes, staging, commit
// ---------------------------------------------------------------------------

/**
 * Parse `git status --porcelain=v1 -z -uall`. NUL replaces the newline; only
 * rename entries carry a second NUL field with the old path ("XY new\0old\0"),
 * everything else is "XY path" with a plain space separator.
 */
export function parseChangesBody(body: string): ChangeEntry[] {
  const tokens = body.split("\0");
  const entries: ChangeEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    const record = tokens[index] ?? "";
    if (record.length < 3) {
      index += 1;
      continue;
    }
    const x = record[0] ?? " ";
    const y = record[1] ?? " ";
    let path = record.slice(3);
    let oldPath: string | null = null;
    if (x === "R" || x === "C") {
      oldPath = tokens[index + 1] ?? "";
      index += 2;
    } else {
      index += 1;
    }
    if (path.length === 0) continue;

    if (x === "?" && y === "?") {
      entries.push({ path, oldPath, status: "?", staged: false, untracked: true, conflict: false });
      continue;
    }
    const conflict = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(`${x}${y}`);
    if (conflict) {
      entries.push({ path, oldPath, status: `${x}${y}`, staged: false, untracked: false, conflict: true });
      continue;
    }
    if (x !== " ") {
      entries.push({ path, oldPath, status: x, staged: true, untracked: false, conflict: false });
    }
    if (y !== " " && y !== "?") {
      entries.push({ path, oldPath, status: y, staged: false, untracked: false, conflict: false });
    }
  }
  return entries;
}

export async function gitChanges(run: GitRun, cwd: string): Promise<ChangesResult> {
  const failed = (error: string): ChangesResult => ({ ok: false, error, entries: [] });
  let root: string;
  try {
    root = (await runChecked(run, ["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
  try {
    const body = await runChecked(run, ["status", "--porcelain=v1", "-z", "-uall"], root);
    return { ok: true, error: null, entries: parseChangesBody(body) };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

function validPaths(paths: readonly string[]): boolean {
  return paths.every((path) => path.length > 0 && !path.startsWith("/") && !path.includes("..") && !path.includes("\0"));
}

export async function gitStage(
  run: GitRun,
  cwd: string,
  paths: readonly string[],
  all: boolean,
): Promise<ActionResult> {
  const failed = (error: string): ActionResult => ({ ok: false, error, message: null });
  if (!all && paths.length === 0) return failed("没有要暂存的文件");
  if (!validPaths(paths)) return failed("无效的文件路径");
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  try {
    // -A picks up deletions and untracked files alike within the pathspecs.
    const args = all && paths.length === 0 ? ["add", "-A"] : ["add", "-A", "--", ...paths];
    await runChecked(run, args, rootInfo.root, 30_000);
    return { ok: true, error: null, message: all && paths.length === 0 ? "已暂存全部改动" : "已暂存所选文件" };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

export async function gitUnstage(
  run: GitRun,
  cwd: string,
  paths: readonly string[],
  all: boolean,
): Promise<ActionResult> {
  const failed = (error: string): ActionResult => ({ ok: false, error, message: null });
  if (!all && paths.length === 0) return failed("没有要取消暂存的文件");
  if (!validPaths(paths)) return failed("无效的文件路径");
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  try {
    const args = all && paths.length === 0 ? ["reset", "-q"] : ["reset", "-q", "HEAD", "--", ...paths];
    await runChecked(run, args, rootInfo.root, 30_000);
    return { ok: true, error: null, message: all && paths.length === 0 ? "已取消全部暂存" : "已取消暂存所选文件" };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

export interface CommitCreateResult extends ActionResult {
  /** Short hash of the created commit, when available. */
  shortHash: string | null;
}

/**
 * Commit with the IDEA semantics: the checked files are the commit scope,
 * committed from their working-tree state while the rest of the index stays
 * untouched. `git commit --only` is exactly this; untracked paths just need
 * to enter the index first (--only refuses unknown pathspecs).
 */
export async function gitCommitCreate(
  run: GitRun,
  cwd: string,
  message: string,
  paths: readonly string[],
  amend: boolean,
): Promise<CommitCreateResult> {
  const failed = (error: string): CommitCreateResult => ({ ok: false, error, message: null, shortHash: null });
  const note = message.trim();
  if (note.length === 0) return failed("提交信息不能为空");
  if (!validPaths(paths)) return failed("无效的文件路径");
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  const root = rootInfo.root;
  const commitArgs = ["commit", "--only", ...(amend ? ["--amend"] : []), "-m", note.slice(0, 20000)];

  try {
    if (paths.length === 0) {
      // No scope given: commit the index as-is.
      await runChecked(run, ["commit", ...(amend ? ["--amend"] : []), "-m", note.slice(0, 20000)], root, 60_000);
    } else {
      try {
        await runChecked(run, ["add", "--", ...paths], root, 30_000);
      } catch {
        // already-tracked paths are fine; --only still knows them via HEAD
      }
      await runChecked(run, [...commitArgs, "--", ...paths], root, 60_000);
    }
    let shortHash: string | null = null;
    try {
      shortHash = (await runChecked(run, ["rev-parse", "--short", "HEAD"], root)).trim();
    } catch {
      // hash is cosmetic
    }
    return { ok: true, error: null, message: amend ? "已修正上一提交" : "已创建提交", shortHash };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

export async function gitRecentMessages(run: GitRun, cwd: string): Promise<RecentMessagesResult> {
  const failed = (error: string): RecentMessagesResult => ({ ok: false, error, messages: [] });
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  try {
    const body = await runChecked(run, ["log", "-20", "--format=%s"], rootInfo.root);
    const messages = body.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    return { ok: true, error: null, messages };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

export async function gitDiff(
  run: GitRun,
  cwd: string,
  mode: "worktree" | "staged" | "head" | "commit" | "stash",
  ref: string,
  path: string,
  maxLines: number,
): Promise<DiffResult> {
  const failed = (error: string): DiffResult => ({ ok: false, error, text: "", truncated: false, binary: false });
  if (!validPaths([path])) return failed("无效的文件路径");
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  let args: readonly string[];
  if (mode === "worktree") {
    args = ["diff", "--no-color", "-M", "--", path];
  } else if (mode === "staged") {
    args = ["diff", "--no-color", "-M", "--cached", "--", path];
  } else if (mode === "head") {
    args = ["diff", "--no-color", "-M", "HEAD", "--", path];
  } else if (mode === "commit") {
    if (!/^[0-9a-fA-F]{4,40}$/.test(ref)) return failed("无效的提交哈希");
    // --format= keeps the patch, drops the commit header; --first-parent
    // mirrors what the commit detail list shows for merge commits.
    args = ["show", "--no-color", "-M", "--first-parent", "--format=", ref, "--", path];
  } else {
    if (!/^\d{1,4}$/.test(ref)) return failed("无效的贮藏索引");
    const label = `stash@{${ref}}`;
    args = ["diff", "--no-color", "-M", `${label}^`, label, "--", path];
  }
  try {
    const body = await runChecked(run, args, rootInfo.root);
    const binary = body.includes("Binary files") && body.includes("differ");
    const lines = body.split("\n");
    const truncated = lines.length > maxLines;
    const text = truncated ? lines.slice(0, maxLines).join("\n") : body;
    return { ok: true, error: null, text, truncated, binary };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Restore one file to HEAD, IDEA-style rollback. Files that do not exist in
 * HEAD (staged additions, untracked files) are unstaged and removed from the
 * working tree — the client confirms before calling.
 */
export async function gitRollbackFile(run: GitRun, cwd: string, path: string): Promise<ActionResult> {
  const failed = (error: string): ActionResult => ({ ok: false, error, message: null });
  if (!validPaths([path])) return failed("无效的文件路径");
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  const root = rootInfo.root;
  try {
    let inHead = true;
    try {
      await runChecked(run, ["cat-file", "-e", `HEAD:${path}`], root);
    } catch {
      inHead = false;
    }
    if (inHead) {
      await runChecked(run, ["checkout", "HEAD", "--", path], root, 15_000);
      return { ok: true, error: null, message: `已还原 ${path}` };
    }
    try {
      await runChecked(run, ["reset", "-q", "HEAD", "--", path], root);
    } catch {
      // not staged at all (plain untracked file) — nothing to unstage
    }
    try {
      await unlink(pathJoin(root, path));
    } catch {
      // already gone
    }
    return { ok: true, error: null, message: `已删除 ${path}` };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// stash
// ---------------------------------------------------------------------------

const STASH_FORMAT = ["%gd", "%s", "%aI"].join(US);

export function parseStashListBody(body: string): { label: string; subject: string; date: string; index: number }[] {
  const entries: { label: string; subject: string; date: string; index: number }[] = [];
  for (const record of body.split("\n")) {
    if (record.trim().length === 0) continue;
    const [label, subject, date] = record.split(US);
    if (!label) continue;
    const match = /stash@\{(\d+)\}$/.exec(label);
    entries.push({
      label,
      subject: subject ?? "",
      date: date ?? "",
      index: match ? Number.parseInt(match[1] ?? "0", 10) : 0,
    });
  }
  return entries;
}

export async function gitStashList(run: GitRun, cwd: string): Promise<StashListResult> {
  const failed = (error: string): StashListResult => ({ ok: false, error, stashes: [] });
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  try {
    const body = await runChecked(run, ["stash", "list", `--format=${STASH_FORMAT}`], rootInfo.root);
    const base = parseStashListBody(body);
    const stashes: StashEntry[] = [];
    for (const entry of base) {
      let files: StashEntry["files"] = [];
      try {
        const showBody = await runChecked(
          run,
          ["stash", "show", "--name-status", "-z", entry.label],
          rootInfo.root,
        );
        const tokens = showBody.length === 0 ? [] : showBody.split("\0").filter((token) => token.length > 0);
        files = parseNameStatusTokens(tokens).map((item) => ({ path: item.path, status: item.status }));
      } catch {
        // untracked-only stashes have no tracked diff; leave files empty
      }
      stashes.push({ ...entry, files });
    }
    return { ok: true, error: null, stashes };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

export interface StashPushResult extends ActionResult {
  /** True when the working tree was clean and nothing got stashed. */
  empty: boolean;
}

/** Stash everything, or only the checked paths (including their untracked files). */
export async function gitStashPush(
  run: GitRun,
  cwd: string,
  message: string,
  paths: readonly string[],
): Promise<StashPushResult> {
  const failed = (error: string): StashPushResult => ({ ok: false, error, message: null, empty: false });
  if (!validPaths(paths)) return failed("无效的文件路径");
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  try {
    const args = ["stash", "push", "-u"];
    const note = message.trim();
    if (note.length > 0) args.push("-m", note.slice(0, 500));
    if (paths.length > 0) {
      args.push("--", ...paths);
    }
    const body = await runChecked(run, args, rootInfo.root, 60_000);
    if (/No local changes to save/.test(body)) {
      return { ok: true, error: null, message: "没有可贮藏的改动", empty: true };
    }
    return { ok: true, error: null, message: paths.length > 0 ? "已贮藏所选文件" : "已贮藏全部改动", empty: false };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

export async function gitStashApply(
  run: GitRun,
  cwd: string,
  index: number,
  drop: boolean,
): Promise<ActionResult> {
  const failed = (error: string): ActionResult => ({ ok: false, error, message: null });
  const label = `stash@{${index}}`;
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  try {
    await runChecked(run, ["stash", drop ? "pop" : "apply", label], rootInfo.root, 60_000);
    return {
      ok: true,
      error: null,
      message: drop ? `已恢复并删除 ${label}` : `已恢复 ${label}（保留贮藏）`,
    };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

export async function gitStashDrop(run: GitRun, cwd: string, index: number): Promise<ActionResult> {
  const failed = (error: string): ActionResult => ({ ok: false, error, message: null });
  const label = `stash@{${index}}`;
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  try {
    await runChecked(run, ["stash", "drop", label], rootInfo.root, 30_000);
    return { ok: true, error: null, message: `已删除 ${label}` };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// merge / rebase / cherry-pick
// ---------------------------------------------------------------------------

/** rev-parse --git-dir is relative to the cwd it ran in; absolutise it. */
async function gitDirOf(run: GitRun, root: string): Promise<string> {
  const dir = (await runChecked(run, ["rev-parse", "--git-dir"], root)).trim();
  return pathIsAbsolute(dir) ? dir : pathJoin(root, dir);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readTextSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function parseMergeBranch(msg: string | null): string | null {
  if (msg === null) return null;
  const match = /^Merge (?:remote-tracking )?(?:branch|tag) '([^']+)'/m.exec(msg);
  return match ? (match[1] ?? null) : null;
}

function parseIntSafe(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Which long-running sequence (if any) is in progress, read from .git files. */
export async function gitSequenceState(run: GitRun, cwd: string): Promise<SequenceState> {
  const failed = (error: string): SequenceState => ({
    ok: false, error, kind: "none", branch: null, step: null, total: null, conflicts: [],
  });
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  const root = rootInfo.root;
  try {
    const gitDir = await gitDirOf(run, root);
    let conflictPaths: string[] = [];
    try {
      const body = await runChecked(run, ["diff", "--name-only", "--diff-filter=U"], root);
      conflictPaths = body.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    } catch {
      // unborn HEAD etc.
    }

    if (await pathExists(pathJoin(gitDir, "CHERRY_PICK_HEAD"))) {
      return { ok: true, error: null, kind: "cherryPick", branch: null, step: null, total: null, conflicts: conflictPaths };
    }
    if (await pathExists(pathJoin(gitDir, "rebase-merge"))) {
      const headName = await readTextSafe(pathJoin(gitDir, "rebase-merge", "head-name"));
      const branch = headName !== null ? headName.replace(/^refs\/heads\//, "").trim() : null;
      const step = parseIntSafe(await readTextSafe(pathJoin(gitDir, "rebase-merge", "msgnum")));
      const total = parseIntSafe(await readTextSafe(pathJoin(gitDir, "rebase-merge", "end")));
      return { ok: true, error: null, kind: "rebase", branch: branch || null, step, total, conflicts: conflictPaths };
    }
    if (await pathExists(pathJoin(gitDir, "rebase-apply"))) {
      const step = parseIntSafe(await readTextSafe(pathJoin(gitDir, "rebase-apply", "next")));
      const total = parseIntSafe(await readTextSafe(pathJoin(gitDir, "rebase-apply", "last")));
      return { ok: true, error: null, kind: "rebase", branch: null, step, total, conflicts: conflictPaths };
    }
    if (await pathExists(pathJoin(gitDir, "MERGE_HEAD"))) {
      const msg = await readTextSafe(pathJoin(gitDir, "MERGE_MSG"));
      return { ok: true, error: null, kind: "merge", branch: parseMergeBranch(msg), step: null, total: null, conflicts: conflictPaths };
    }
    return { ok: true, error: null, kind: "none", branch: null, step: null, total: null, conflicts: conflictPaths };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

async function sequenceInProgress(run: GitRun, root: string, kind: "merge" | "rebase" | "cherryPick"): Promise<boolean> {
  const gitDir = await gitDirOf(run, root);
  if (kind === "merge") return pathExists(pathJoin(gitDir, "MERGE_HEAD"));
  if (kind === "cherryPick") return pathExists(pathJoin(gitDir, "CHERRY_PICK_HEAD"));
  return (await pathExists(pathJoin(gitDir, "rebase-merge"))) || (await pathExists(pathJoin(gitDir, "rebase-apply")));
}

export interface MergeActionResult extends ActionResult {
  /** True when the operation paused on conflicts (a banner takes over the UI). */
  conflicts: boolean;
}

/** Run merge/rebase/cherry-pick; a conflict pause is a success-shaped outcome. */
async function runSequencer(
  run: GitRun,
  root: string,
  kind: "merge" | "rebase" | "cherryPick",
  args: readonly string[],
  doneMessage: string,
  conflictMessage: string,
): Promise<MergeActionResult> {
  try {
    await runChecked(run, args, root, 120_000);
    return { ok: true, error: null, message: doneMessage, conflicts: false };
  } catch (err) {
    if (await sequenceInProgress(run, root, kind)) {
      return { ok: true, error: null, message: conflictMessage, conflicts: true };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err), message: null, conflicts: false };
  }
}

export async function gitMerge(
  run: GitRun,
  cwd: string,
  ref: string,
  noFf: boolean,
): Promise<MergeActionResult> {
  const failed = (error: string): MergeActionResult => ({ ok: false, error, message: null, conflicts: false });
  if (!isValidRefName(ref)) return failed("无效的分支名");
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  const args = ["merge", ...(noFf ? ["--no-ff"] : []), ref];
  return runSequencer(run, rootInfo.root, "merge", args, `已合并 ${ref}`, `合并 ${ref} 遇到冲突，请解决后继续`);
}

export async function gitRebase(run: GitRun, cwd: string, ref: string): Promise<MergeActionResult> {
  const failed = (error: string): MergeActionResult => ({ ok: false, error, message: null, conflicts: false });
  if (!isValidRefName(ref)) return failed("无效的分支名");
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  return runSequencer(
    run,
    rootInfo.root,
    "rebase",
    ["rebase", ref],
    `已将当前分支变基到 ${ref}`,
    `变基到 ${ref} 遇到冲突，请解决后继续`,
  );
}

export async function gitCherryPick(
  run: GitRun,
  cwd: string,
  hashes: readonly string[],
): Promise<MergeActionResult> {
  const failed = (error: string): MergeActionResult => ({ ok: false, error, message: null, conflicts: false });
  const clean = hashes.map((hash) => hash.trim()).filter((hash) => /^[0-9a-fA-F]{4,40}$/.test(hash));
  if (clean.length === 0) return failed("无效的提交哈希");
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  return runSequencer(
    run,
    rootInfo.root,
    "cherryPick",
    ["cherry-pick", ...clean],
    `已拣选 ${clean.length} 个提交`,
    "拣选遇到冲突，请解决后继续",
  );
}

export async function gitSequenceAction(
  run: GitRun,
  cwd: string,
  sequence: "merge" | "rebase" | "cherryPick",
  action: "continue" | "skip" | "abort",
): Promise<ActionResult> {
  const failed = (error: string): ActionResult => ({ ok: false, error, message: null });
  if (sequence === "merge" && action === "skip") return failed("合并没有可跳过的步骤");
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  const root = rootInfo.root;
  try {
    if (action === "abort") {
      const verb = sequence === "merge" ? "merge" : sequence === "rebase" ? "rebase" : "cherry-pick";
      await runChecked(run, [verb, "--abort"], root, 60_000);
      const label = sequence === "merge" ? "合并" : sequence === "rebase" ? "变基" : "拣选";
      return { ok: true, error: null, message: `已中止${label}` };
    }
    if (action === "skip") {
      const verb = sequence === "rebase" ? "rebase" : "cherry-pick";
      await runChecked(run, [verb, "--skip"], root, 60_000);
      return { ok: true, error: null, message: "已跳过该步骤" };
    }
    // continue: resolved conflicts must be staged first (git refuses otherwise)
    if (sequence !== "merge") {
      try {
        await runChecked(run, ["add", "-u"], root, 30_000);
      } catch {
        // nothing to stage; the sequencer itself will complain if it disagrees
      }
    }
    const verb = sequence === "merge" ? "merge" : sequence === "rebase" ? "rebase" : "cherry-pick";
    await runChecked(run, [verb, "--continue"], root, 60_000);
    const label = sequence === "merge" ? "合并" : sequence === "rebase" ? "变基" : "拣选";
    return { ok: true, error: null, message: `${label}已继续` };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

/** Resolve one unmerged path by taking our or their side, then stage it. */
export async function gitConflictResolve(
  run: GitRun,
  cwd: string,
  path: string,
  take: "ours" | "theirs",
): Promise<ActionResult> {
  const failed = (error: string): ActionResult => ({ ok: false, error, message: null });
  if (!validPaths([path])) return failed("无效的文件路径");
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  try {
    await runChecked(run, ["checkout", take === "ours" ? "--ours" : "--theirs", "--", path], rootInfo.root, 15_000);
    await runChecked(run, ["add", "--", path], rootInfo.root, 15_000);
    return { ok: true, error: null, message: `已采用${take === "ours" ? "本方" : "对方"}版本：${path}` };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// history actions
// ---------------------------------------------------------------------------

export async function gitReset(
  run: GitRun,
  cwd: string,
  hash: string,
  mode: "soft" | "mixed" | "hard",
): Promise<ActionResult> {
  const failed = (error: string): ActionResult => ({ ok: false, error, message: null });
  if (!/^[0-9a-fA-F]{4,40}$/.test(hash)) return failed("无效的提交哈希");
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  try {
    await runChecked(run, ["reset", `--${mode}`, hash], rootInfo.root, 30_000);
    const labels = { soft: "软重置（保留暂存与工作区）", mixed: "重置（保留工作区改动）", hard: "硬重置（丢弃全部改动）" } as const;
    return { ok: true, error: null, message: `已重置到 ${hash.slice(0, 8)}：${labels[mode]}` };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

export async function gitRevert(run: GitRun, cwd: string, hash: string): Promise<ActionResult> {
  const failed = (error: string): ActionResult => ({ ok: false, error, message: null });
  if (!/^[0-9a-fA-F]{4,40}$/.test(hash)) return failed("无效的提交哈希");
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  try {
    await runChecked(run, ["revert", "--no-edit", hash], rootInfo.root, 60_000);
    return { ok: true, error: null, message: `已还原提交 ${hash.slice(0, 8)}` };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

export async function gitBranchRename(
  run: GitRun,
  cwd: string,
  name: string,
  newName: string,
): Promise<ActionResult> {
  const failed = (error: string): ActionResult => ({ ok: false, error, message: null });
  if (!isValidRefName(name) || !isValidRefName(newName)) return failed("无效的分支名");
  const rootInfo = await gitRoot(run, cwd);
  if ("error" in rootInfo) return failed(rootInfo.error);
  try {
    await runChecked(run, ["branch", "-m", name, newName], rootInfo.root, 15_000);
    return { ok: true, error: null, message: `已重命名 ${name} → ${newName}` };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}
