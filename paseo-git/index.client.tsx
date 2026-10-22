import type { PluginClientContext } from "@getpaseo/plugin/client";
import { GitPanel } from "./client/GitPanel";
import { ProxySettingsScreen } from "./client/ProxySettingsScreen";

// The git panel surfaces as a workspace panel (and in the explorer panel
// strip), like IDEA's Git tool window. The command-center entry offers
// keyboard/discoverability access to it. The settings screen holds the
// proxy configuration used by fetch/pull network operations.
export default function contribute(client: PluginClientContext) {
  const removePanel = client.addWorkspacePanel({
    id: "git-manager",
    title: "Git",
    icon: "GitBranch",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: GitPanel,
  });

  const removeSettings = client.addSettingsScreen({
    id: "git-manager-proxy",
    title: "Git 代理",
    icon: "Globe",
    Component: ProxySettingsScreen,
  });

  const removeCommand = client.addCommandCenterItem({
    id: "git-manager-open",
    title: "Git: 打开 Git 面板",
    icon: "GitBranch",
    keywords: ["git", "branch", "log", "commit", "分支", "提交"],
    context: "workspace",
    onSelect(context) {
      context.openPanel("git-manager");
    },
  });

  return () => {
    removeCommand();
    removeSettings();
    removePanel();
  };
}
