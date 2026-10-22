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

export interface ActionResult extends RawError {
  message: string | null;
}

export interface PathsResult extends RawError {
  dir: string;
  dirs: string[];
  files: string[];
}
