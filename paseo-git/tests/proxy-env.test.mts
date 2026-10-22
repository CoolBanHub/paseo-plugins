import assert from "node:assert/strict";
import { test } from "node:test";
import { proxyEnvFromValues, sshProxyCommand } from "../server/proxy-env.ts";
import { gitProxySettings, isValidProxyUrl } from "../shared/settings.ts";

test("isValidProxyUrl 接受 http/https/socks5 与空串", () => {
  assert.equal(isValidProxyUrl(""), true);
  assert.equal(isValidProxyUrl("http://127.0.0.1:7897"), true);
  assert.equal(isValidProxyUrl("https://proxy.corp.example:8443"), true);
  assert.equal(isValidProxyUrl("socks5://192.168.1.2:1080"), true);
});

test("isValidProxyUrl 拒绝非法地址", () => {
  assert.equal(isValidProxyUrl("127.0.0.1:7897"), false, "缺少协议");
  assert.equal(isValidProxyUrl("ftp://127.0.0.1:21"), false, "不支持的协议");
  assert.equal(isValidProxyUrl("http://"), false, "缺少主机");
  assert.equal(isValidProxyUrl("not a url"), false);
});

test("设置 schema 缺省值为直连且校验地址格式", () => {
  const values = gitProxySettings.schema.parse({});
  assert.deepEqual(values, { proxyUrl: "", sshAlsoProxy: false });
  assert.deepEqual(gitProxySettings.schema.parse({ proxyUrl: "http://p:1" }), {
    proxyUrl: "http://p:1",
    sshAlsoProxy: false,
  });
  assert.throws(() => gitProxySettings.schema.parse({ proxyUrl: "127.0.0.1:7897" }), /代理地址/);
});

test("proxyEnvFromValues 空地址与非法地址都返回直连", () => {
  assert.deepEqual(proxyEnvFromValues({ proxyUrl: "", sshAlsoProxy: false }), {});
  assert.deepEqual(proxyEnvFromValues({ proxyUrl: "   ", sshAlsoProxy: true }), {});
  assert.deepEqual(proxyEnvFromValues({ proxyUrl: "127.0.0.1:7897", sshAlsoProxy: false }), {});
});

test("http 代理映射为 curl 代理变量，默认不含 SSH 命令", () => {
  const env = proxyEnvFromValues({ proxyUrl: "http://127.0.0.1:7897", sshAlsoProxy: false });
  assert.equal(env.HTTP_PROXY, "http://127.0.0.1:7897");
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7897");
  assert.equal(env.ALL_PROXY, "http://127.0.0.1:7897");
  assert.equal(env.http_proxy, "http://127.0.0.1:7897");
  assert.equal(env.https_proxy, "http://127.0.0.1:7897");
  assert.equal("GIT_SSH_COMMAND" in env, false);
});

test("开启 SSH 走代理时按协议生成 nc 命令", () => {
  const http = proxyEnvFromValues({ proxyUrl: "http://127.0.0.1:7897", sshAlsoProxy: true });
  assert.equal(http.GIT_SSH_COMMAND, "nc -X connect -x 127.0.0.1:7897 %h %p");

  const socks = proxyEnvFromValues({ proxyUrl: "socks5://192.168.1.2:1080", sshAlsoProxy: true });
  assert.equal(socks.GIT_SSH_COMMAND, "nc -X 5 -x 192.168.1.2:1080 %h %p");

  assert.equal(sshProxyCommand("http://proxy.example"), "nc -X connect -x proxy.example:80 %h %p");
  assert.equal(sshProxyCommand("socks5://proxy.example"), "nc -X 5 -x proxy.example:1080 %h %p");
});
