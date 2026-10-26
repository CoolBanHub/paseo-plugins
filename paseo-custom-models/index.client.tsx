import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ProviderSettingsScreen } from "./client/ProviderSettingsScreen";

// Everything the plugin does is configured in one host-level settings screen:
// providers, keys and the model list that joins the Claude model picker.
export default function contribute(client: PluginClientContext) {
  const removeSettings = client.addSettingsScreen({
    id: "custom-models",
    title: "自定义模型",
    icon: "Boxes",
    Component: ProviderSettingsScreen,
  });

  return () => {
    removeSettings();
  };
}
