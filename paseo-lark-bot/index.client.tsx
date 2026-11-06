import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { BotCenterSurface } from "./client/BotCenter.tsx";

// The bot runs entirely host-side; the client contributes a standalone
// management screen with a sidebar entry, like team-work's admin screens.
const SCREEN_ID = "lark-bot";

function SidebarEntry({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="MessageCircle"
      label="飞书机器人"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const stops = [
    client.addScreen({ id: SCREEN_ID, title: "飞书机器人", Component: BotCenterSurface }),
    client.addSidebarHeaderItem({ id: SCREEN_ID, title: "飞书机器人", Component: SidebarEntry }),
    client.addCommandCenterItem({
      id: "open-lark-bot",
      title: "打开飞书机器人",
      icon: "MessageCircle",
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: SCREEN_ID });
      },
    }),
  ];
  return () => {
    for (const stop of stops.reverse()) stop();
  };
}
