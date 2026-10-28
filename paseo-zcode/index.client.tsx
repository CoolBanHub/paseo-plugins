import type { PluginClientContext } from "@getpaseo/plugin/client";
import { UsageSettingsScreen } from "./client/UsageSettingsScreen";

// The ZCode integration is a native provider: sessions appear alongside
// Claude Code and Codex. The one piece of client UI picks which coding-plan
// accounts Paseo's usage view shows.
export default function contribute(client: PluginClientContext) {
  const removeSettings = client.addSettingsScreen({
    id: "zcode-usage",
    title: "ZCode 用量显示",
    icon: "Gauge",
    Component: UsageSettingsScreen,
  });

  return () => {
    removeSettings();
  };
}
