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
  /** Commits the branch has that HEAD does not (null when equal to current branch). */
  ahead: z.number().int().nullable(),
  /** Commits HEAD has that the branch does not. */
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
  }),
  output: gitError.extend({
    message: z.string().nullable(),
    /** True when the push was refused only because the branch has no upstream. */
    needsUpstream: z.boolean().default(false),
  }),
});
