import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * RPC contracts shared between the panel client and the daemon-side handler.
 * Every call takes the repository path resolved from the workspace snapshot;
 * the plugin is trusted (unsandboxed) so paths travel as plain strings.
 */

const repoInput = z.object({ repoPath: z.string().min(1) });

const gitError = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
});

const isoDate = z.string();

const localBranch = z.object({
  name: z.string(),
  shortName: z.string(),
  hash: z.string(),
  subject: z.string(),
  date: isoDate,
  isCurrent: z.boolean(),
  /** Upstream tracking ref short name; null when unset. */
  upstream: z.string().nullable(),
  /** Commits the branch has/lacks against its upstream (null without one). */
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
});

const remoteBranch = z.object({
  name: z.string(),
  shortName: z.string(),
  hash: z.string(),
  subject: z.string(),
  date: isoDate,
});

const tagEntry = z.object({
  name: z.string(),
  shortName: z.string(),
  hash: z.string(),
  commitHash: z.string(),
  subject: z.string(),
  date: isoDate,
  annotated: z.boolean(),
});

const worktreeEntry = z.object({
  path: z.string(),
  head: z.string(),
  branch: z.string().nullable(),
  detached: z.boolean(),
  bare: z.boolean(),
  isMain: z.boolean(),
});

// Ref names only: reject anything that could parse as a git option.
// The optional flavour admits "" so callers can leave a start point unset.
const refName = z.string().regex(/^(?!-)[A-Za-z0-9][A-Za-z0-9._/@+-]*$/);
const optionalRefName = z.string().regex(/^(?!-)(?:[A-Za-z0-9][A-Za-z0-9._/@+-]*)?$/);

const commitSummary = z.object({
  hash: z.string(),
  shortHash: z.string(),
  parents: z.array(z.string()),
  authorName: z.string(),
  authorEmail: z.string(),
  authorDate: isoDate,
  committerDate: isoDate,
  /** Decorations like "HEAD -> main", "origin/main", "tag: v1.0". */
  refs: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
});

export const gitStatusRpc = defineRpc({
  name: "git.status",
  input: repoInput,
  output: gitError.extend({
    root: z.string().nullable(),
    currentBranch: z.string().nullable(),
    detached: z.boolean(),
    upstream: z.string().nullable(),
    ahead: z.number().int().nullable(),
    behind: z.number().int().nullable(),
    staged: z.number().int(),
    unstaged: z.number().int(),
    untracked: z.number().int(),
    head: z.string().nullable(),
  }),
});

export const gitBranchesRpc = defineRpc({
  name: "git.branches",
  input: repoInput,
  output: gitError.extend({
    locals: z.array(localBranch),
    remotes: z.array(remoteBranch),
  }),
});

export const gitLogRpc = defineRpc({
  name: "git.log",
  input: repoInput.extend({
    /** "ALL" walks every ref (--all); anything else is a ref name. */
    ref: z.string().default("ALL"),
    limit: z.number().int().min(1).max(1000).default(300),
    skip: z.number().int().min(0).default(0),
    /** Optional path filter; empty disables it. Passed after `--`. */
    path: z.string().default(""),
  }),
  output: gitError.extend({
    commits: z.array(commitSummary),
    hasMore: z.boolean(),
  }),
});

export const gitCommitRpc = defineRpc({
  name: "git.commit",
  input: repoInput.extend({
    hash: z.string().regex(/^[0-9a-fA-F]{4,40}$/),
  }),
  output: gitError.extend({
    hash: z.string(),
    shortHash: z.string(),
    parents: z.array(z.string()),
    authorName: z.string(),
    authorEmail: z.string(),
    authorDate: isoDate,
    committerName: z.string(),
    committerDate: isoDate,
    subject: z.string(),
    body: z.string(),
    files: z.array(
      z.object({
        path: z.string(),
        oldPath: z.string().nullable(),
        additions: z.number().int().nullable(),
        deletions: z.number().int().nullable(),
        binary: z.boolean(),
        status: z.string(),
      }),
    ),
    totalAdditions: z.number().int(),
    totalDeletions: z.number().int(),
  }),
});

export const gitPathsRpc = defineRpc({
  name: "git.paths",
  input: repoInput.extend({
    /** Directory to list relative to the repo root; "" lists the root. */
    dir: z.string().default(""),
  }),
  output: gitError.extend({
    dir: z.string(),
    /** Immediate subdirectories that contain tracked files. */
    dirs: z.array(z.string()),
    /** Immediate tracked files. */
    files: z.array(z.string()),
  }),
});

export const gitCheckoutRpc = defineRpc({
  name: "git.checkout",
  input: repoInput.extend({
    ref: refName,
  }),
  output: gitError.extend({
    message: z.string().nullable(),
  }),
});

export const gitBranchCreateRpc = defineRpc({
  name: "git.branch.create",
  input: repoInput.extend({
    name: refName,
    /** Commit/branch to start from; empty means current HEAD. */
    startPoint: optionalRefName.default("HEAD"),
    /** Also check the new branch out. */
    checkout: z.boolean().default(false),
  }),
  output: gitError.extend({
    message: z.string().nullable(),
  }),
});

export const gitBranchDeleteRpc = defineRpc({
  name: "git.branch.delete",
  input: repoInput.extend({
    name: refName,
    /** -D instead of -d: drop unmerged commits after confirm. */
    force: z.boolean().default(false),
  }),
  output: gitError.extend({
    message: z.string().nullable(),
  }),
});

export const gitTagsRpc = defineRpc({
  name: "git.tags",
  input: repoInput,
  output: gitError.extend({
    tags: z.array(tagEntry),
  }),
});

export const gitTagCreateRpc = defineRpc({
  name: "git.tag.create",
  input: repoInput.extend({
    name: refName,
    /** Commit/branch to tag; empty means current HEAD. */
    ref: optionalRefName.default("HEAD"),
    /** Non-empty creates an annotated tag with this message. */
    message: z.string().max(2000).default(""),
  }),
  output: gitError.extend({
    message: z.string().nullable(),
  }),
});

export const gitTagDeleteRpc = defineRpc({
  name: "git.tag.delete",
  input: repoInput.extend({
    name: refName,
  }),
  output: gitError.extend({
    message: z.string().nullable(),
  }),
});

export const gitWorktreesRpc = defineRpc({
  name: "git.worktrees",
  input: repoInput,
  output: gitError.extend({
    worktrees: z.array(worktreeEntry),
  }),
});

export const gitWorktreeAddRpc = defineRpc({
  name: "git.worktree.add",
  input: repoInput.extend({
    /** Folder name resolved next to the repo, or an absolute path. */
    path: z.string().min(1).max(400),
    /** Create this new branch inside the worktree (-b). */
    newBranch: optionalRefName.default(""),
    /** Existing ref to check out; with newBranch it is the branch point. */
    ref: optionalRefName.default(""),
  }),
  output: gitError.extend({
    message: z.string().nullable(),
  }),
});

export const gitWorktreeRemoveRpc = defineRpc({
  name: "git.worktree.remove",
  input: repoInput.extend({
    /** Must match a registered non-main worktree path exactly. */
    path: z.string().min(1).max(2000),
    /** --force to discard uncommitted or locked content after confirm. */
    force: z.boolean().default(false),
  }),
  output: gitError.extend({
    message: z.string().nullable(),
  }),
});

export const gitWorktreePruneRpc = defineRpc({
  name: "git.worktree.prune",
  input: repoInput,
  output: gitError.extend({
    message: z.string().nullable(),
  }),
});

export const gitFetchRpc = defineRpc({
  name: "git.fetch",
  input: repoInput,
  output: gitError.extend({
    message: z.string().nullable(),
  }),
});

export const gitPullRpc = defineRpc({
  name: "git.pull",
  input: repoInput,
  output: gitError.extend({
    message: z.string().nullable(),
  }),
});

export const gitPushRpc = defineRpc({
  name: "git.push",
  input: repoInput.extend({
    /** Push -u origin <branch> after the user confirms an upstream-less branch. */
    setUpstream: z.boolean().default(false),
    /** --force-with-lease after the user confirms. */
    force: z.boolean().default(false),
  }),
  output: gitError.extend({
    message: z.string().nullable(),
    /** True when the push was refused only because the branch has no upstream. */
    needsUpstream: z.boolean().default(false),
  }),
});

// ---------------------------------------------------------------------------
// working-tree changes, staging and commits
// ---------------------------------------------------------------------------

const repoPathInput = z.string().regex(/^([^\0]){1,2000}$/);

export const gitChangesRpc = defineRpc({
  name: "git.changes",
  input: repoInput,
  output: gitError.extend({
    entries: z.array(
      z.object({
        path: z.string(),
        oldPath: z.string().nullable(),
        status: z.string(),
        staged: z.boolean(),
        untracked: z.boolean(),
        conflict: z.boolean(),
      }),
    ),
  }),
});

export const gitStageRpc = defineRpc({
  name: "git.stage",
  input: repoInput.extend({
    /** Empty with all=false is a no-op the client should avoid. */
    paths: z.array(repoPathInput).max(500).default([]),
    /** Stage everything (git add -A), including untracked files. */
    all: z.boolean().default(false),
  }),
  output: gitError.extend({
    message: z.string().nullable(),
  }),
});

export const gitUnstageRpc = defineRpc({
  name: "git.unstage",
  input: repoInput.extend({
    paths: z.array(repoPathInput).max(500).default([]),
    /** Reset the whole index against HEAD. */
    all: z.boolean().default(false),
  }),
  output: gitError.extend({
    message: z.string().nullable(),
  }),
});

export const gitCommitCreateRpc = defineRpc({
  name: "git.commit.create",
  input: repoInput.extend({
    message: z.string().min(1).max(20000),
    /** Checked files only (IDEA-style commit scope); empty commits the index as-is. */
    paths: z.array(repoPathInput).max(500).default([]),
    amend: z.boolean().default(false),
  }),
  output: gitError.extend({
    message: z.string().nullable(),
  }),
});

export const gitRecentMessagesRpc = defineRpc({
  name: "git.recent.messages",
  input: repoInput,
  output: gitError.extend({
    messages: z.array(z.string()).default([]),
  }),
});

export const gitDiffRpc = defineRpc({
  name: "git.diff",
  input: repoInput.extend({
    /** worktree: index↔worktree · staged: HEAD↔index · head: HEAD↔worktree · commit/stash need ref. */
    mode: z.enum(["worktree", "staged", "head", "commit", "stash"]),
    /** Commit hash for mode=commit; stash index for mode=stash. */
    ref: z.string().default(""),
    path: repoPathInput,
    maxLines: z.number().int().min(50).max(20000).default(2000),
  }),
  output: gitError.extend({
    text: z.string().default(""),
    truncated: z.boolean().default(false),
    binary: z.boolean().default(false),
  }),
});

export const gitRollbackFileRpc = defineRpc({
  name: "git.rollback.file",
  input: repoInput.extend({
    path: repoPathInput,
  }),
  output: gitError.extend({
    message: z.string().nullable(),
  }),
});

// ---------------------------------------------------------------------------
// stash
// ---------------------------------------------------------------------------

export const gitStashListRpc = defineRpc({
  name: "git.stash.list",
  input: repoInput,
  output: gitError.extend({
    stashes: z.array(
      z.object({
        index: z.number().int(),
        label: z.string(),
        subject: z.string(),
        date: z.string(),
        files: z.array(z.object({ path: z.string(), status: z.string() })),
      }),
    ),
  }),
});

export const gitStashPushRpc = defineRpc({
  name: "git.stash.push",
  input: repoInput.extend({
    message: z.string().max(500).default(""),
    /** Stash only these paths (staged+unstaged+untracked); empty stashes everything. */
    paths: z.array(repoPathInput).max(500).default([]),
  }),
  output: gitError.extend({
    message: z.string().nullable(),
    /** True when there was nothing to stash. */
    empty: z.boolean().default(false),
  }),
});

export const gitStashApplyRpc = defineRpc({
  name: "git.stash.apply",
  input: repoInput.extend({
    index: z.number().int().min(0).max(1000),
    /** Also drop the stash entry after applying (pop). */
    drop: z.boolean().default(false),
  }),
  output: gitError.extend({
    message: z.string().nullable(),
  }),
});

export const gitStashDropRpc = defineRpc({
  name: "git.stash.drop",
  input: repoInput.extend({
    index: z.number().int().min(0).max(1000),
  }),
  output: gitError.extend({
    message: z.string().nullable(),
  }),
});

// ---------------------------------------------------------------------------
// merge / rebase / cherry-pick state machine
// ---------------------------------------------------------------------------

export const gitSequenceStateRpc = defineRpc({
  name: "git.sequence.state",
  input: repoInput,
  output: gitError.extend({
    kind: z.enum(["none", "merge", "rebase", "cherryPick"]).default("none"),
    branch: z.string().nullable(),
    step: z.number().int().nullable(),
    total: z.number().int().nullable(),
    conflicts: z.array(z.string()).default([]),
  }),
});

export const gitMergeRpc = defineRpc({
  name: "git.merge",
  input: repoInput.extend({
    ref: refName,
    /** --no-ff: always create a merge commit. */
    noFf: z.boolean().default(false),
  }),
  output: gitError.extend({
    message: z.string().nullable(),
    /** True when the merge paused on conflicts instead of failing outright. */
    conflicts: z.boolean().default(false),
  }),
});

export const gitRebaseRpc = defineRpc({
  name: "git.rebase",
  input: repoInput.extend({
    /** Rebase the current branch onto this ref. */
    ref: refName,
  }),
  output: gitError.extend({
    message: z.string().nullable(),
    conflicts: z.boolean().default(false),
  }),
});

export const gitCherryPickRpc = defineRpc({
  name: "git.cherry-pick",
  input: repoInput.extend({
    hashes: z.array(z.string().regex(/^[0-9a-fA-F]{4,40}$/)).min(1).max(100),
  }),
  output: gitError.extend({
    message: z.string().nullable(),
    conflicts: z.boolean().default(false),
  }),
});

export const gitSequenceActionRpc = defineRpc({
  name: "git.sequence.action",
  input: repoInput.extend({
    sequence: z.enum(["merge", "rebase", "cherryPick"]),
    action: z.enum(["continue", "skip", "abort"]),
  }),
  output: gitError.extend({
    message: z.string().nullable(),
  }),
});

export const gitConflictResolveRpc = defineRpc({
  name: "git.conflict.resolve",
  input: repoInput.extend({
    path: repoPathInput,
    take: z.enum(["ours", "theirs"]),
  }),
  output: gitError.extend({
    message: z.string().nullable(),
  }),
});

// ---------------------------------------------------------------------------
// history rewriting actions
// ---------------------------------------------------------------------------

const commitHash = z.string().regex(/^[0-9a-fA-F]{4,40}$/);

export const gitResetRpc = defineRpc({
  name: "git.reset",
  input: repoInput.extend({
    hash: commitHash,
    mode: z.enum(["soft", "mixed", "hard"]),
  }),
  output: gitError.extend({
    message: z.string().nullable(),
  }),
});

export const gitRevertRpc = defineRpc({
  name: "git.revert",
  input: repoInput.extend({
    hash: commitHash,
  }),
  output: gitError.extend({
    message: z.string().nullable(),
  }),
});

export const gitBranchRenameRpc = defineRpc({
  name: "git.branch.rename",
  input: repoInput.extend({
    name: refName,
    newName: refName,
  }),
  output: gitError.extend({
    message: z.string().nullable(),
  }),
});
