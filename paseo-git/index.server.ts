import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  gitBranches,
  gitCheckout,
  gitCommit,
  gitFetch,
  gitLog,
  gitPaths,
  gitPull,
  gitStatus,
  type GitRun,
} from "./server/git-ops";
import { runGit } from "./server/git-runner";
import { proxyEnvFromValues } from "./server/proxy-env";
import { gitProxySettings } from "./shared/settings";
import {
  gitBranchesRpc,
  gitCheckoutRpc,
  gitCommitRpc,
  gitFetchRpc,
  gitLogRpc,
  gitPathsRpc,
  gitPullRpc,
  gitStatusRpc,
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
  server.handle(gitFetchRpc, ({ repoPath }) => gitFetch(run, repoPath));
  server.handle(gitPullRpc, ({ repoPath }) => gitPull(run, repoPath));
  return () => {
    unsubscribe();
  };
}
