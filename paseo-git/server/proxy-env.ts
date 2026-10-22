import type { GitProxyValues } from "../shared/settings";

/**
 * Derive the environment variables that make git's network transports use
 * the configured proxy. Empty object = direct connection (the daemon's own
 * environment is then passed through untouched).
 *
 * - HTTP(S) remotes: curl-style proxy variables; libcurl also accepts
 *   socks5:// URLs in these.
 * - SSH remotes (opt-in): GIT_SSH_COMMAND tunneling through `nc`, which
 *   supports HTTP CONNECT and SOCKS5 on both macOS and Linux (OpenBSD nc).
 *
 * The URL check mirrors `isValidProxyUrl` in shared/settings.ts (which the
 * schema already enforces) rather than importing it: runtime cross-module
 * imports here would need `.ts` extensions for the node test runner while
 * the daemon loader expects extensionless ones.
 */

const PROXY_PROTOCOLS = new Set(["http:", "https:", "socks5:"]);
const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
  "socks5:": "1080",
};

function parseProxyUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return PROXY_PROTOCOLS.has(parsed.protocol) && parsed.hostname.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function sshProxyCommand(proxyUrl: string): string {
  const parsed = parseProxyUrl(proxyUrl);
  if (parsed === null) throw new Error(`无效的代理地址: ${proxyUrl}`);
  const port = parsed.port || DEFAULT_PORTS[parsed.protocol] || "8080";
  const proxyType = parsed.protocol === "socks5:" ? "5" : "connect";
  return `nc -X ${proxyType} -x ${parsed.hostname}:${port} %h %p`;
}

export function proxyEnvFromValues(values: GitProxyValues): Record<string, string> {
  const url = values.proxyUrl.trim();
  if (url === "" || parseProxyUrl(url) === null) return {};

  const env: Record<string, string> = {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    ALL_PROXY: url,
    http_proxy: url,
    https_proxy: url,
  };
  if (values.sshAlsoProxy) {
    env.GIT_SSH_COMMAND = sshProxyCommand(url);
  }
  return env;
}
