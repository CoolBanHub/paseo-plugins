import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import { createDshConnector } from "./server/dsh-acp";
import { dshCatalogCacheKey } from "./server/dsh-catalog";
import { dshPtcTransformer } from "./server/ptc-present";
import { dshToolTransformer } from "./server/tool-present";
import { dshEventTransformer } from "./server/dsh-events";
import { currentDshSessionLaunchContext, withDshSessionLaunchContext } from "./server/session-launch-context";
import { withDshHistoryReplay } from "./server/history-replay";
import { withDshQuestions } from "./server/dsh-questions";
import { dshSubagentTransformer, withDshSubagents } from "./server/dsh-subagents";

export default function contribute(server: PluginServerContext) {
  const log = (message: string, detail?: unknown) =>
    console.log(`[dsh] ${message}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600));
  const acpProvider = runAcpProvider({
    id: "dsh",
    label: "dsh",
    description: "DeepSeek coding agent (dsh) running locally through its ACP interface.",
    icon: "dsh.svg",
    // npx resolution plus first-run acp profile initialization can exceed
    // the 10s default.
    acpOptions: { startupTimeoutMs: 60_000 },
    transformers: [dshPtcTransformer, dshToolTransformer, dshEventTransformer, dshSubagentTransformer],
    connector: createDshConnector(log, currentDshSessionLaunchContext),
  });

  // Subagents sit outside history replay: a reopened parent adopts its
  // children only after its own restored rows have gone out.
  const provider = withDshSessionLaunchContext({
    ...acpProvider,
    getCatalogCacheKey: async (options) => dshCatalogCacheKey(options),
  });
  server.registerProvider(withDshQuestions(withDshSubagents(withDshHistoryReplay(provider), { log })));
  return () => {};
}
