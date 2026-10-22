import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsInput,
  type SettingsInputHandle,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import {
  gitProxySettingsRpc,
  gitProxyValuesSchema,
  isValidProxyUrl,
  PROXY_URL_HINT,
} from "../shared/settings";

/**
 * Host-level proxy settings for git network operations. Saving takes effect
 * on the next fetch/pull — the daemon re-derives the git environment
 * whenever the settings revision changes.
 */
export function ProxySettingsScreen(_props: PluginSurfaceProps) {
  const toast = useToast();
  const readRpc = useRpc(gitProxySettingsRpc.read);
  const writeRpc = useRpc(gitProxySettingsRpc.write);
  // The SDK input is uncontrolled (initialValue only seeds mount); the handle
  // syncs stored values into the field after async loads.
  const inputRef = useRef<SettingsInputHandle | null>(null);

  const [revision, setRevision] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{ proxyUrl: string; sshAlsoProxy: boolean }>({
    proxyUrl: "",
    sshAlsoProxy: false,
  });
  const [proxyUrl, setProxyUrl] = useState("");
  const [sshAlsoProxy, setSshAlsoProxy] = useState(false);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      const result = await readRpc({});
      if (result.status === "ready") {
        setRevision(result.revision);
        // The generic settings RPC returns untyped JSON; re-parse for the fields.
        const parsed = gitProxyValuesSchema.safeParse(result.values ?? {});
        const values = parsed.success
          ? { proxyUrl: parsed.data.proxyUrl ?? "", sshAlsoProxy: Boolean(parsed.data.sshAlsoProxy) }
          : { proxyUrl: "", sshAlsoProxy: false };
        setLoaded(values);
        inputRef.current?.replaceText(values.proxyUrl);
        setSshAlsoProxy(values.sshAlsoProxy);
        if (!parsed.success) {
          toast.error(`已保存的代理设置无效，已按直连处理：${parsed.error.issues[0]?.message ?? ""}`);
        }
      } else if (result.status === "invalid") {
        setRevision(result.revision);
        setLoaded({ proxyUrl: "", sshAlsoProxy: false });
        inputRef.current?.replaceText("");
        setSshAlsoProxy(false);
        toast.error(`已保存的代理设置无效，已按直连处理：${result.error}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [readRpc, toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const trimmed = proxyUrl.trim();
  const urlValid = isValidProxyUrl(trimmed);
  const dirty = trimmed !== loaded.proxyUrl.trim() || sshAlsoProxy !== loaded.sshAlsoProxy;

  const save = useCallback(async () => {
    if (revision === null || !urlValid || saving) return;
    setSaving(true);
    try {
      const result = await writeRpc({
        revision,
        values: { proxyUrl: trimmed, sshAlsoProxy },
      });
      if (result.status === "saved") {
        setRevision(result.revision);
        setLoaded({ proxyUrl: trimmed, sshAlsoProxy });
        toast.show(trimmed === "" ? "已保存：git 直连" : `已保存代理 ${trimmed}`);
      } else if (result.status === "conflict") {
        toast.error("设置已被其他端修改，已重新加载，请再次保存");
        await reload();
      } else {
        toast.error(`保存失败：${result.error}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [reload, revision, saving, sshAlsoProxy, toast, trimmed, urlValid, writeRpc]);

  return (
    <SettingsSection
      title="Git 网络代理"
      info={`获取/拉取远端（如 GitHub）时代理，留空直连。格式：${PROXY_URL_HINT}`}
    >
      <SettingsInput
        ref={inputRef}
        label="代理地址"
        placeholder="http://127.0.0.1:7897"
        onChangeText={setProxyUrl}
        error={urlValid ? null : `地址需形如 ${PROXY_URL_HINT}`}
      />
      <SettingsSwitch
        label="SSH 远程也走代理"
        hint="git@github.com 这类 SSH 远端通过 nc 经代理连接；仅支持 http/socks5 代理"
        value={sshAlsoProxy}
        onValueChange={setSshAlsoProxy}
      />
      <SettingsAction
        label="应用"
        actionLabel={saving ? "保存中…" : "保存"}
        onPress={save}
        disabled={!urlValid || !dirty || revision === null || saving}
      />
    </SettingsSection>
  );
}
