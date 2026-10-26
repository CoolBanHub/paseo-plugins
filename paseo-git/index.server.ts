import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  gitBranchCreate,
  gitBranchDelete,
  gitBranches,
  gitCheckout,
  gitCommit,
  gitFetch,
  gitLog,
  gitPaths,
  gitPull,
  gitPush,
  gitStatus,
  gitTagCreate,
  gitTagDelete,
  gitTags,
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
  gitBranchesRpc,
  gitCheckoutRpc,
  gitCommitRpc,
  gitFetchRpc,
  gitLogRpc,
  gitPathsRpc,
  gitPullRpc,
  gitPushRpc,
  gitStatusRpc,
  gitTagCreateRpc,
  gitTagDeleteRpc,
  gitTagsRpc,
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
  server.handle(gitPushRpc, ({ repoPath, setUpstream }) => gitPush(run, repoPath, setUpstream));
  return () => {
    unsubscribe();
  };
}
