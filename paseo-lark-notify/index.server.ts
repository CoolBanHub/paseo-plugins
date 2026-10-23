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

  const offCreated = server.on("agent.created", (event) => notifier.handleCreated(event));
  const offTurnStarted = server.on("agent.turn_started", (event) => notifier.handleTurnStarted(event));
  const offTurnEnded = server.on("agent.turn_ended", (event) => notifier.handleTurnEnded(event));
  const offPermission = server.on("agent.permission_requested", (event) => {
    void notifier.handlePermission(event);
  });
  const offClosed = server.on("agent.closed", (event) => {
    void notifier.handleClosed(event);
  });

  return () => {
    offCreated();
    offTurnStarted();
    offTurnEnded();
    offPermission();
    offClosed();
  };
}
