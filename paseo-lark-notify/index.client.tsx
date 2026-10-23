import type { PluginClientContext } from "@getpaseo/plugin/client";

// Notifications run entirely on the host; the client contributes no UI.
export default function contribute(_client: PluginClientContext) {
  return () => {};
}
