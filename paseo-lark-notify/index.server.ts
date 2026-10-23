import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createNotifier } from "./server/notifier.ts";
import { DEFAULT_NOTIFY_VALUES, larkNotifySettings } from "./server/settings.ts";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(larkNotifySettings);
  const notifier = createNotifier({
    readValues: async () => {
      const state = await settings.read();
      return state.status === "ready" ? state.values : DEFAULT_NOTIFY_VALUES;
    },
  });

  const offPermission = server.on("agent.permission_requested", (event) => {
    void notifier.handlePermission(event);
  });
  const offClosed = server.on("agent.closed", (event) => {
    void notifier.handleClosed(event);
  });

  return () => {
    offPermission();
    offClosed();
  };
}
