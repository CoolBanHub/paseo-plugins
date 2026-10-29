import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  gitBranchCreate,
  gitBranchDelete,
  gitBranchRename,
  gitBranches,
  gitChanges,
  gitCheckout,
  gitCherryPick,
  gitCommit,
  gitCommitCreate,
  gitConflictResolve,
  gitDiff,
  gitFetch,
  gitLog,
  gitMerge,
  gitPaths,
  gitPull,
  gitPush,
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
  gitStatus,
  gitTagCreate,
  gitTagDelete,
  gitTags,
  gitUnstage,
  gitWorktreeAdd,
  gitWorktreePrune,
  gitWorktreeRemove,
  gitWorktrees,
  type GitRun,
} from "./server/git-ops";
import { runGit } from "./server/git-runner";
import { proxyEnvFromValues } from "./server/proxy-env";
import { gitProxySettings } from "./shared/settings";
import {
  gitBranchCreateRpc,
  gitBranchDeleteRpc,
  gitBranchRenameRpc,
  gitBranchesRpc,
  gitChangesRpc,
  gitCheckoutRpc,
  gitCherryPickRpc,
  gitCommitCreateRpc,
  gitCommitRpc,
  gitConflictResolveRpc,
  gitDiffRpc,
  gitFetchRpc,
  gitLogRpc,
  gitMergeRpc,
  gitPathsRpc,
  gitPullRpc,
  gitPushRpc,
  gitRecentMessagesRpc,
  gitRebaseRpc,
  gitResetRpc,
  gitRevertRpc,
  gitRollbackFileRpc,
  gitSequenceActionRpc,
  gitSequenceStateRpc,
  gitStageRpc,
  gitStashApplyRpc,
  gitStashDropRpc,
  gitStashListRpc,
  gitStashPushRpc,
  gitStatusRpc,
  gitTagCreateRpc,
  gitTagDeleteRpc,
  gitTagsRpc,
  gitUnstageRpc,
  gitWorktreeAddRpc,
  gitWorktreePruneRpc,
  gitWorktreeRemoveRpc,
  gitWorktreesRpc,
} from "./shared/contracts";

// Proxy settings apply to every git invocation: the proxy variables are
// inert for purely local commands and only steer the network transports
// (fetch/pull/ls-remote), so no per-command filtering is needed.
let proxyEnv: Readonly<Record<string, string>> = {};

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(gitProxySettings);
  const applyState = (state: Awaited<ReturnType<typeof settings.read>>) => {
    proxyEnv = state.status === "ready" ? proxyEnvFromValues(state.values) : {};
  };
  void settings.read().then(applyState, () => undefined);
  const unsubscribe = settings.subscribe(applyState);

  const run: GitRun = (args, cwd, timeoutMs) => runGit(args, cwd, timeoutMs, proxyEnv);

  server.handle(gitStatusRpc, ({ repoPath }) => gitStatus(run, repoPath));
  server.handle(gitBranchesRpc, ({ repoPath }) => gitBranches(run, repoPath));
  server.handle(gitLogRpc, ({ repoPath, ref, limit, skip, path }) =>
    gitLog(run, repoPath, ref, limit, skip, path),
  );
  server.handle(gitCommitRpc, ({ repoPath, hash }) => gitCommit(run, repoPath, hash));
  server.handle(gitPathsRpc, ({ repoPath, dir }) => gitPaths(run, repoPath, dir));
  server.handle(gitCheckoutRpc, ({ repoPath, ref }) => gitCheckout(run, repoPath, ref));
  server.handle(gitBranchCreateRpc, ({ repoPath, name, startPoint, checkout }) =>
    gitBranchCreate(run, repoPath, name, startPoint, checkout),
  );
  server.handle(gitBranchDeleteRpc, ({ repoPath, name, force }) =>
    gitBranchDelete(run, repoPath, name, force),
  );
  server.handle(gitTagsRpc, ({ repoPath }) => gitTags(run, repoPath));
  server.handle(gitTagCreateRpc, ({ repoPath, name, ref, message }) =>
    gitTagCreate(run, repoPath, name, ref, message),
  );
  server.handle(gitTagDeleteRpc, ({ repoPath, name }) => gitTagDelete(run, repoPath, name));
  server.handle(gitWorktreesRpc, ({ repoPath }) => gitWorktrees(run, repoPath));
  server.handle(gitWorktreeAddRpc, ({ repoPath, path, newBranch, ref }) =>
    gitWorktreeAdd(run, repoPath, path, newBranch, ref),
  );
  server.handle(gitWorktreeRemoveRpc, ({ repoPath, path, force }) =>
    gitWorktreeRemove(run, repoPath, path, force),
  );
  server.handle(gitWorktreePruneRpc, ({ repoPath }) => gitWorktreePrune(run, repoPath));
  server.handle(gitFetchRpc, ({ repoPath }) => gitFetch(run, repoPath));
  server.handle(gitPullRpc, ({ repoPath }) => gitPull(run, repoPath));
  server.handle(gitPushRpc, ({ repoPath, setUpstream, force }) =>
    gitPush(run, repoPath, setUpstream, force),
  );

  // Working tree / staging / commit panel.
  server.handle(gitChangesRpc, ({ repoPath }) => gitChanges(run, repoPath));
  server.handle(gitStageRpc, ({ repoPath, paths, all }) => gitStage(run, repoPath, paths, all));
  server.handle(gitUnstageRpc, ({ repoPath, paths, all }) => gitUnstage(run, repoPath, paths, all));
  server.handle(gitCommitCreateRpc, ({ repoPath, message, paths, amend }) =>
    gitCommitCreate(run, repoPath, message, paths, amend),
  );
  server.handle(gitRecentMessagesRpc, ({ repoPath }) => gitRecentMessages(run, repoPath));
  server.handle(gitDiffRpc, ({ repoPath, mode, ref, path, maxLines }) =>
    gitDiff(run, repoPath, mode, ref, path, maxLines),
  );
  server.handle(gitRollbackFileRpc, ({ repoPath, path }) => gitRollbackFile(run, repoPath, path));

  // Stash.
  server.handle(gitStashListRpc, ({ repoPath }) => gitStashList(run, repoPath));
  server.handle(gitStashPushRpc, ({ repoPath, message, paths }) =>
    gitStashPush(run, repoPath, message, paths),
  );
  server.handle(gitStashApplyRpc, ({ repoPath, index, drop }) =>
    gitStashApply(run, repoPath, index, drop),
  );
  server.handle(gitStashDropRpc, ({ repoPath, index }) => gitStashDrop(run, repoPath, index));

  // Merge / rebase / cherry-pick.
  server.handle(gitSequenceStateRpc, ({ repoPath }) => gitSequenceState(run, repoPath));
  server.handle(gitMergeRpc, ({ repoPath, ref, noFf }) => gitMerge(run, repoPath, ref, noFf));
  server.handle(gitRebaseRpc, ({ repoPath, ref }) => gitRebase(run, repoPath, ref));
  server.handle(gitCherryPickRpc, ({ repoPath, hashes }) => gitCherryPick(run, repoPath, hashes));
  server.handle(gitSequenceActionRpc, ({ repoPath, sequence, action }) =>
    gitSequenceAction(run, repoPath, sequence, action),
  );
  server.handle(gitConflictResolveRpc, ({ repoPath, path, take }) =>
    gitConflictResolve(run, repoPath, path, take),
  );

  // History actions.
  server.handle(gitResetRpc, ({ repoPath, hash, mode }) => gitReset(run, repoPath, hash, mode));
  server.handle(gitRevertRpc, ({ repoPath, hash }) => gitRevert(run, repoPath, hash));
  server.handle(gitBranchRenameRpc, ({ repoPath, name, newName }) =>
    gitBranchRename(run, repoPath, name, newName),
  );
  return () => {
    unsubscribe();
  };
}
