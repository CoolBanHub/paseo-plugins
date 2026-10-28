import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createZcodeProvider } from "./server/zcode-provider";
import { createZcodeUsageSource, discoverUsageAccounts } from "./server/zcode-usage";
import { readHiddenUsageAccounts, writeHiddenUsageAccounts } from "./server/usage-account-store";
import { listUsageAccountsRpc, saveUsageAccountsRpc } from "./shared/usage-accounts";
import type { UsageAccountView } from "./shared/usage-accounts";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createZcodeProvider());
  server.registerUsageSource(createZcodeUsageSource({ hiddenAccounts: () => readHiddenUsageAccounts() }));

  // Settings screen state: every discovered plan, with whether it is reported.
  const accountViews = (): UsageAccountView[] => {
    const hidden = new Set(readHiddenUsageAccounts());
    return discoverUsageAccounts().map((account) => ({
      key: account.key,
      label: account.label,
      kind: account.kind,
      reported: !hidden.has(account.key),
    }));
  };

  server.handle(listUsageAccountsRpc, async () => {
    try {
      return { ok: true, error: null, accounts: accountViews() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), accounts: [] };
    }
  });

  // Hidden = discovered but not reported; newly discovered accounts stay visible.
  server.handle(saveUsageAccountsRpc, async (input) => {
    try {
      const reported = new Set(input.reportedKeys);
      const hidden = discoverUsageAccounts()
        .filter((account) => !reported.has(account.key))
        .map((account) => account.key);
      await writeHiddenUsageAccounts(hidden);
      return { ok: true, error: null, accounts: accountViews() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), accounts: accountViews() };
    }
  });

  return () => {};
}
