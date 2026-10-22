import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import { createDshConnector } from "./server/dsh-acp";
import { dshCatalogCacheKey } from "./server/dsh-catalog";
import { dshPtcTransformer } from "./server/ptc-present";
import { currentDshSessionLaunchContext, withDshSessionLaunchContext } from "./server/session-launch-context";

export default function contribute(server: PluginServerContext) {
  const acpProvider = runAcpProvider({
    id: "dsh",
    label: "dsh",
    description: "DeepSeek coding agent (dsh) running locally through its ACP interface.",
    icon: "dsh.svg",
    // npx resolution plus first-run acp profile initialization can exceed
    // the 10s default.
    acpOptions: { startupTimeoutMs: 60_000 },
    transformers: [dshPtcTransformer],
    connector: createDshConnector(
      (message, detail) =>
        console.log(`[dsh] ${message}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)),
      currentDshSessionLaunchContext,
    ),
  });

  server.registerProvider(withDshSessionLaunchContext({
    ...acpProvider,
    getCatalogCacheKey: async (options) => dshCatalogCacheKey(options),
  }));
  return () => {};
}
