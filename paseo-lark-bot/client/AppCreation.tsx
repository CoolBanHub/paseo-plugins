import { useCallback, useEffect, useRef, useState } from "react";
import { Image, Text, View } from "react-native";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import {
  larkBotAppCreationRpc,
  type LarkBotAppCreation,
} from "../shared/contracts.ts";
import { PrimaryButton, colors } from "./widgets.tsx";

/**
 * "Scan with Feishu to create a new app" section on the credentials page.
 * Owns the RPC + polling; the parent owns the settings save that clears the
 * plugin's old credentials and switches the event consumers to the new app.
 */
export function AppCreationSection({
  currentAppId,
  storedAppId,
  onCreated,
}: {
  /** App ID lark-cli currently uses (from the status RPC). */
  currentAppId: string | null;
  /** App ID saved/typed in the plugin settings; both override lark-cli. */
  storedAppId: string;
  /** Clear plugin credentials + save; resolves true once the switch is saved. */
  onCreated(appId: string): Promise<boolean>;
}) {
  const toast = useToast();
  const rpc = useRpc(larkBotAppCreationRpc);
  const [creation, setCreation] = useState<LarkBotAppCreation | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [activating, setActivating] = useState(false);
  const [activated, setActivated] = useState<boolean | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const handledRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await rpc({ action: "status" });
      if (!mountedRef.current) return;
      setCreation(next);
      setLoadError(null);
    } catch (error) {
      if (!mountedRef.current) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setQrFailed(false);
  }, [creation?.url]);

  // Poll while the CLI is waiting for the user's scan; the device flow ends
  // with a success/error state and the interval stops.
  useEffect(() => {
    if (creation?.state !== "starting" && creation?.state !== "waiting") return;
    const timer = setInterval(() => {
      void refresh();
    }, 1_500);
    return () => clearInterval(timer);
  }, [creation?.state, refresh]);

  const activate = useCallback(
    async (appId: string) => {
      setActivating(true);
      setActivated(null);
      try {
        const ok = await onCreated(appId);
        if (mountedRef.current) setActivated(ok);
      } catch {
        if (mountedRef.current) setActivated(false);
      } finally {
        if (mountedRef.current) setActivating(false);
      }
    },
    [onCreated],
  );

  // Automatically switch to the new app once per created App ID. The parent's
  // save may re-render this component; handledRef prevents a second save.
  useEffect(() => {
    if (creation?.state !== "success" || !creation.appId) return;
    if (handledRef.current === creation.appId) return;
    handledRef.current = creation.appId;
    void activate(creation.appId);
  }, [activate, creation?.appId, creation?.state]);

  const start = useCallback(async () => {
    setBusy(true);
    setConfirming(false);
    setActivated(null);
    handledRef.current = null;
    try {
      const next = await rpc({ action: "start" });
      if (!mountedRef.current) return;
      setCreation(next);
      if (next.state === "error" && next.error) toast.error(next.error);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [rpc, toast]);

  const cancel = useCallback(async () => {
    setBusy(true);
    try {
      const next = await rpc({ action: "cancel" });
      if (!mountedRef.current) return;
      setCreation(next);
      setConfirming(false);
      setActivated(null);
      handledRef.current = null;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [rpc, toast]);

  const copyLink = useCallback(async () => {
    const url = creation?.url;
    if (!url) return;
    try {
      await copyText(url);
      toast.show("链接已复制，可在浏览器或飞书中打开");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [creation?.url, toast]);

  const openLink = useCallback(() => {
    const url = creation?.url;
    if (!url) return;
    void openExternalUrl(url).catch((error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    });
  }, [creation?.url, toast]);

  const needsConfirm = Boolean(currentAppId || storedAppId.trim());
  const requestStart = useCallback(() => {
    if (needsConfirm && !confirming) {
      setConfirming(true);
      return;
    }
    void start();
  }, [confirming, needsConfirm, start]);

  if (creation === null) {
    return (
      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 13, color: colors().foregroundMuted }}>
          {loadError ? `读取创建状态失败：${loadError}` : "正在读取创建状态…"}
        </Text>
        {loadError ? <PrimaryButton label="重试" subtle onPress={() => void refresh()} /> : null}
      </View>
    );
  }

  const state = creation.state;

  return (
    <View style={{ gap: 10 }}>
      <Text style={{ fontSize: 13, color: colors().foreground, lineHeight: 19 }}>
        没有飞书应用时，用飞书扫码即可自动创建一个带机器人能力、长连接事件订阅和常用权限的
        PersonalAgent 应用。创建成功后插件会自动改用新应用。
      </Text>

      {needsConfirm ? (
        <Text style={{ fontSize: 12, color: colors().statusWarning, lineHeight: 18 }}>
          注意：创建会替换 lark-cli 当前的默认应用配置，其他 profile 也会被清除。这台机器上已有应用在用请先确认。
        </Text>
      ) : null}

      {state === "starting" ? (
        <>
          <Text style={{ fontSize: 13, color: colors().foregroundMuted }}>正在启动飞书应用创建…</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <PrimaryButton label="取消" subtle onPress={() => void cancel()} disabled={busy} />
          </View>
        </>
      ) : state === "waiting" ? (
        <>
          {creation.qrDataUrl && !qrFailed ? (
            <Image
              source={{ uri: creation.qrDataUrl }}
              style={{ width: 220, height: 220, alignSelf: "center", borderRadius: 8, backgroundColor: "#fff" }}
              resizeMode="contain"
              accessibilityLabel="飞书扫码创建应用二维码"
              onError={() => setQrFailed(true)}
            />
          ) : (
            <Text style={{ fontSize: 12, color: colors().statusDanger }}>
              二维码无法显示，请打开下面的链接完成创建。
            </Text>
          )}
          <Text style={{ fontSize: 12, color: colors().foregroundMuted, textAlign: "center" }}>
            用飞书扫描二维码并确认创建；二维码 10 分钟内有效。
          </Text>
          <Text selectable style={{ fontSize: 11, color: colors().foregroundMuted }}>
            {creation.url}
          </Text>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            <PrimaryButton label="复制链接" subtle onPress={() => void copyLink()} />
            <PrimaryButton label="在浏览器打开" subtle onPress={openLink} />
            <PrimaryButton label="取消" subtle onPress={() => void cancel()} disabled={busy} />
          </View>
        </>
      ) : state === "success" ? (
        <>
          <Text style={{ fontSize: 13, color: colors().statusSuccess }}>
            已创建应用 {creation.appId}
          </Text>
          {activating ? (
            <Text style={{ fontSize: 12, color: colors().foregroundMuted }}>
              正在清空插件内旧凭证、保存当前设置并切换…
            </Text>
          ) : activated === true ? (
            <Text style={{ fontSize: 12, color: colors().foregroundMuted }}>
              已切换并保存，事件监听正在重启。可在「运行状态」确认当前应用。
            </Text>
          ) : activated === false ? (
            <Text style={{ fontSize: 12, color: colors().statusDanger, lineHeight: 18 }}>
              新应用已创建，但自动切换失败（设置可能被其他端修改）。请重试，或手动清空上方 App ID / Secret 后保存。
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {activated === false ? (
              <PrimaryButton
                label="重试切换"
                onPress={() => {
                  if (creation.appId) void activate(creation.appId);
                }}
                disabled={activating}
              />
            ) : null}
            <PrimaryButton label="完成" subtle onPress={() => void cancel()} disabled={activating || busy} />
          </View>
        </>
      ) : (
        <>
          {state === "error" && creation.error ? (
            <Text style={{ fontSize: 12, color: colors().statusDanger, lineHeight: 18 }}>{creation.error}</Text>
          ) : null}
          {confirming ? (
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              <PrimaryButton label="继续创建（替换现有配置）" danger onPress={() => void start()} disabled={busy} />
              <PrimaryButton label="取消" subtle onPress={() => setConfirming(false)} />
            </View>
          ) : (
            <PrimaryButton
              label={needsConfirm ? "扫码创建新应用（替换现有配置）" : "扫码创建新应用"}
              onPress={requestStart}
              disabled={busy}
            />
          )}
          <Text style={{ fontSize: 11, color: colors().foregroundMuted }}>
            会调用本机 lark-cli 的 `config init --new`；整个过程约 1 分钟。
          </Text>
        </>
      )}
    </View>
  );
}
