import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import { createDshConnector } from "./server/dsh-acp";
import { dshCatalogCacheKey } from "./server/dsh-catalog";
import { DSH_SETTINGS, type PermissionMode } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  // dsh's permission preset is fixed per process; Paseo spawns a fresh dsh
  // process per session, so this host-scoped setting takes effect for every
  // new session without restarting anything.
  const settings = server.registerSettings(DSH_SETTINGS);

  let permissionMode: PermissionMode | undefined;
  const applyState = (state: { status: string; values?: { permissionMode?: PermissionMode } }) => {
    permissionMode = state.status === "ready" ? state.values?.permissionMode : undefined;
  };
  void settings.read().then(applyState, () => undefined);
  settings.subscribe(applyState);

  const acpProvider = runAcpProvider({
      id: "dsh",
      label: "dsh",
      description: "DeepSeek coding agent (dsh) running locally through its ACP interface.",
      icon: "dsh.svg",
      // npx resolution plus first-run acp profile initialization can exceed
      // the 10s default.
      acpOptions: { startupTimeoutMs: 60_000 },
      connector: createDshConnector(
        (message, detail) =>
          console.log(`[dsh] ${message}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)),
        () => permissionMode,
      ),
    });

  server.registerProvider({
    ...acpProvider,
    getCatalogCacheKey: (options) => dshCatalogCacheKey(options),
  });
  return () => {};
}
