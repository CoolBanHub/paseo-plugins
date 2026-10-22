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
    // Ref names only: reject anything that could parse as a git option.
    ref: z.string().regex(/^(?!-)[A-Za-z0-9][A-Za-z0-9._/@+-]*$/),
  }),
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
