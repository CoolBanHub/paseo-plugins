import { useCallback, useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsSection } from "@getpaseo/plugin/client/ui";
import {
  listUsageAccountsRpc,
  saveUsageAccountsRpc,
  type UsageAccountView,
} from "../shared/usage-accounts";

/**
 * Host-level settings screen listing every coding-plan account found on this
 * machine. Accounts switched off are not reported to Paseo's usage view, so
 * their bars disappear from the usage summary on the next usage query.
 */

const KIND_LABEL: Record<UsageAccountView["kind"], string> = {
  account: "账号套餐",
  apikey: "API key 套餐",
};

function AccountRow({
  account, busy, theme, onToggle,
}: {
  account: UsageAccountView;
  busy: boolean;
  theme: PluginSurfaceProps["theme"];
  onToggle(reported: boolean): void;
}) {
  return (
    <View
      accessibilityLabel={`${account.reported ? "隐藏" : "显示"} ${account.label}`}
      style={{
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 10,
        padding: 12,
        opacity: account.reported ? 1 : 0.55,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View
          accessibilityLabel={account.reported ? "显示中" : "已隐藏"}
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: account.reported ? theme.colors.statusSuccess : theme.colors.foregroundMuted,
          }}
        />
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600", flexShrink: 1 }}>
          {account.label}
        </Text>
        <View style={{ flex: 1 }} />
        <Switch
          accessibilityLabel={`${account.reported ? "隐藏" : "显示"} ${account.label}`}
          value={account.reported}
          disabled={busy}
          onValueChange={onToggle}
          trackColor={{ true: theme.colors.accent, false: theme.colors.surface2 }}
          thumbColor={theme.colors.foreground}
        />
      </View>
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11, marginTop: 6 }}>
        {KIND_LABEL[account.kind]} · {account.reported ? "显示在用量里" : "已从用量里隐藏"}
      </Text>
    </View>
  );
}

export function UsageSettingsScreen({ theme }: PluginSurfaceProps) {
  const toast = useToast();
  const listRpc = useRpc(listUsageAccountsRpc);
  const saveRpc = useRpc(saveUsageAccountsRpc);

  const [accounts, setAccounts] = useState<UsageAccountView[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const result = await listRpc({});
      if (result.ok) setAccounts(result.accounts);
      else toast.error(`读取套餐列表失败：${result.error ?? "未知错误"}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [listRpc, toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggle = useCallback(async (account: UsageAccountView, reported: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const reportedKeys = accounts
        .filter((entry) => (entry.key === account.key ? reported : entry.reported))
        .map((entry) => entry.key);
      const result = await saveRpc({ reportedKeys });
      if (result.ok) {
        setAccounts(result.accounts);
        toast.show(reported ? `已显示 ${account.label}` : `已隐藏 ${account.label}，其用量条将在下次刷新后消失`);
      } else {
        toast.error(`保存失败：${result.error ?? "未知错误"}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [accounts, busy, saveRpc, toast]);

  return (
    <SettingsSection
      title="ZCode 用量显示"
      info="选择哪些智谱 coding plan 出现在 Paseo 的用量显示里（侧边栏与设置中的进度条）。改动立即保存，下一次用量查询即生效；新发现的套餐默认显示"
    >
      <View style={{ gap: 8, marginTop: 4 }}>
        {accounts.map((account) => (
          <AccountRow
            key={account.key}
            account={account}
            busy={busy}
            theme={theme}
            onToggle={(value) => { void toggle(account, value); }}
          />
        ))}
        {accounts.length === 0 ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            未发现任何智谱 coding plan。先在 ZCode 桌面版登录 BigModel 账号，或把 API key 套餐配置为个人 Provider
          </Text>
        ) : null}
      </View>
    </SettingsSection>
  );
}
