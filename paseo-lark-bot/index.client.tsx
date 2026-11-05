import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BotSettingsScreen } from "./client/BotSettingsScreen.tsx";

// The bot runs entirely host-side; the client only contributes the settings
// screen that binds Feishu chats to Paseo providers.
export default function contribute(client: PluginClientContext) {
  return client.addSettingsScreen({
    id: "lark-bot",
    title: "飞书机器人",
    icon: "MessageCircle",
    Component: BotSettingsScreen,
  });
}
