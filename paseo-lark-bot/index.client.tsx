import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BotCenterSurface } from "./client/BotCenter.tsx";

// The bot runs entirely host-side; the client contributes a standalone
// management surface with a sidebar entry, like team-work's admin screens.
export default function contribute(client: PluginClientContext) {
  const stops = [
    client.addSurface("lark-bot", BotCenterSurface),
    client.addSidebarItem({ id: "lark-bot", title: "飞书机器人", icon: "MessageCircle", surface: "lark-bot" }),
    client.addCommandCenterItem({
      id: "open-lark-bot",
      title: "打开飞书机器人",
      icon: "MessageCircle",
      context: "global",
      onSelect({ openSurface }) {
        openSurface("lark-bot");
      },
    }),
  ];
  return () => {
    for (const stop of stops.reverse()) stop();
  };
}
