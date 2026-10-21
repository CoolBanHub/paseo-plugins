import type { PluginClientContext } from "@getpaseo/plugin/client";

// The ZCode integration is a native provider: sessions appear alongside
// Claude Code and Codex without any custom client UI.
export default function contribute(_client: PluginClientContext) {
  return () => {};
}
