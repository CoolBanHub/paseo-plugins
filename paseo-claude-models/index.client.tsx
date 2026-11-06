import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { ModelsScreen } from "./client/ModelsScreen";

// The plugin's whole UI lives in one standalone screen with a sidebar entry
// (like lark-bot's center), instead of a host settings pane: the wide layout
// fits the provider list and its editor side by side.
const SCREEN_ID = "claude-models";

function SidebarEntry({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Boxes"
      label="自定义模型"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const stops = [
    client.addScreen({ id: SCREEN_ID, title: "自定义模型", Component: ModelsScreen }),
    client.addSidebarHeaderItem({ id: SCREEN_ID, title: "自定义模型", Component: SidebarEntry }),
    client.addCommandCenterItem({
      id: "open-claude-models",
      title: "打开自定义模型",
      icon: "Boxes",
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
