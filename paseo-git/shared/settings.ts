import { defineSettings, settingsRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Host-scoped proxy settings for the git-manager panel. Users on machines
 * without a transparent system proxy fill in their own `http://host:port`
 * (or `socks5://host:port`) address here; the daemon applies it to the git
 * network commands it spawns (fetch / pull / ls-remote).
 *
 * Shared between the settings screen (client) and the runner wiring
 * (server) — must not import from server/ or client/.
 */

export const PROXY_URL_HINT = "http://127.0.0.1:7897 或 socks5://127.0.0.1:1080";

/** Accept http(s)/socks5 proxy URLs with a host; empty string means direct. */
export function isValidProxyUrl(value: string): boolean {
  if (value === "") return true;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "socks5:") &&
      parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

export const gitProxyValuesSchema = z.object({
  /** Proxy address; "" disables proxying (the daemon env is left untouched). */
  proxyUrl: z.string().default(""),
  /** Route SSH remotes (git@…) through the proxy via nc; http(s)/socks5 only. */
  sshAlsoProxy: z.boolean().default(false),
});

export type GitProxyValues = z.output<typeof gitProxyValuesSchema>;

export const gitProxySettings = defineSettings({
  id: "git_manager_proxy",
  scope: "host",
  version: 1,
  schema: gitProxyValuesSchema.refine(
    (values) => isValidProxyUrl(values.proxyUrl.trim()),
    { message: `代理地址需形如 ${PROXY_URL_HINT}`, path: ["proxyUrl"] },
  ),
});

/** read/write contracts handled host-side once registerSettings ran. */
export const gitProxySettingsRpc = settingsRpc(gitProxySettings.id);
