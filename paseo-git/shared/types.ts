/**
 * Plain data types shared by the daemon-side git operations and the panel
 * client. The client bundle cannot import from server/, so every type the
 * UI renders lives here.
 */

export interface RawError {
  ok: boolean;
  error: string | null;
}

export type GitRun = (args: readonly string[], cwd: string, timeoutMs?: number) => Promise<string>;

export interface StatusResult extends RawError {
  root: string | null;
  currentBranch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  staged: number;
  unstaged: number;
  untracked: number;
  head: string | null;
}

export interface BranchEntry {
  name: string;
  shortName: string;
  hash: string;
  subject: string;
  date: string;
}

export interface LocalBranchEntry extends BranchEntry {
  isCurrent: boolean;
  /** Upstream tracking ref short name (e.g. "origin/main"); null when unset. */
  upstream: string | null;
  /** Commits the branch has/lacks against its upstream (null without one). */
  ahead: number | null;
  behind: number | null;
}

export interface BranchesResult extends RawError {
  locals: LocalBranchEntry[];
  remotes: BranchEntry[];
}

export interface CommitSummary {
  hash: string;
  shortHash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerDate: string;
  refs: string[];
  subject: string;
  body: string;
}

export interface LogResult extends RawError {
  commits: CommitSummary[];
  hasMore: boolean;
}

export interface CommitFile {
  path: string;
  oldPath: string | null;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  status: string;
}

export interface CommitDetail extends RawError {
  hash: string;
  shortHash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerDate: string;
  subject: string;
  body: string;
  files: CommitFile[];
  totalAdditions: number;
  totalDeletions: number;
}

export interface TagEntry {
  name: string;
  shortName: string;
  /** Tag object hash when annotated, otherwise the commit hash. */
  hash: string;
  /** The commit the tag ultimately points at (peeled for annotated tags). */
  commitHash: string;
  subject: string;
  date: string;
  annotated: boolean;
}

export interface TagsResult extends RawError {
  tags: TagEntry[];
}

export interface WorktreeEntry {
  path: string;
  head: string;
  /** Full branch ref; null for detached or bare worktrees. */
  branch: string | null;
  detached: boolean;
  bare: boolean;
  isMain: boolean;
}

export interface WorktreesResult extends RawError {
  worktrees: WorktreeEntry[];
}

export interface ActionResult extends RawError {
  message: string | null;
}

export interface PathsResult extends RawError {
  dir: string;
  dirs: string[];
  files: string[];
}

/** One working-tree change row; a path staged AND modified twice yields two rows. */
export interface ChangeEntry {
  path: string;
  oldPath: string | null;
  /** Status letter: A/M/D/R/C/T for changes, U-family collapsed to "U". */
  status: string;
  staged: boolean;
  untracked: boolean;
  conflict: boolean;
}

export interface ChangesResult extends RawError {
  entries: ChangeEntry[];
}

export interface DiffResult extends RawError {
  /** Unified diff text, already trimmed to maxLines. */
  text: string;
  truncated: boolean;
  binary: boolean;
}

export interface StashFile {
  path: string;
  status: string;
}

export interface StashEntry {
  /** Position in `git stash list` order (0 = newest). */
  index: number;
  /** Ref selector, e.g. "stash@{0}". */
  label: string;
  subject: string;
  date: string;
  files: StashFile[];
}

export interface StashListResult extends RawError {
  stashes: StashEntry[];
}

export type SequenceKind = "none" | "merge" | "rebase" | "cherryPick";

/** Ongoing merge/rebase/cherry-pick state read from .git bookkeeping files. */
export interface SequenceState extends RawError {
  kind: SequenceKind;
  /** Merge: the ref being merged; rebase: the branch being rebased. */
  branch: string | null;
  step: number | null;
  total: number | null;
  /** Unmerged paths while a sequence is in progress. */
  conflicts: string[];
}

export interface RecentMessagesResult extends RawError {
  messages: string[];
}
