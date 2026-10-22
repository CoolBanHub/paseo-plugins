const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  module._compile(compiled.outputText, filename);
};

const {
  zcodeCatalogCacheKey,
  resolvePluginSourceRoot,
} = require("../server/zcode-catalog-key.ts");

function makePluginTree(root) {
  fs.mkdirSync(path.join(root, "server"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"version":"0.1.0"}');
  fs.writeFileSync(path.join(root, "index.server.ts"), "export default function contribute() {}\n");
  fs.writeFileSync(path.join(root, "server", "zcode-provider.ts"), "export const labels = ['en'];\n");
}

test("catalog cache key moves with plugin sources, CLI identity, and stays stable otherwise", async (t) => {
  const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-key-test-"));
  const cliPath = path.join(pluginRoot, "zcode.cjs");
  t.after(() => fs.rmSync(pluginRoot, { recursive: true, force: true }));
  makePluginTree(pluginRoot);
  fs.writeFileSync(cliPath, "module.exports = {};\n");

  const key = () => zcodeCatalogCacheKey({ cliPath, pluginRoot });
  assert.equal(await key(), await key(), "same inputs produce the same key");

  const beforeSources = await key();
  fs.writeFileSync(path.join(pluginRoot, "server", "zcode-provider.ts"), "export const labels = ['zh'];\n");
  assert.notEqual(await key(), beforeSources, "plugin source edits invalidate the cached catalog");

  const beforeCli = await key();
  fs.writeFileSync(cliPath, "module.exports = { updated: true };\n");
  assert.notEqual(await key(), beforeCli, "CLI updates invalidate the cached model catalog");

  // The old implementation returned the constant "zcode-local" forever.
  assert.notEqual(await key(), "zcode-local");
});

test("source root resolves from the daemon config and env override", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-home-test-"));
  const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-root-test-"));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(pluginRoot, { recursive: true, force: true });
    delete process.env.ZCODE_PLUGIN_ROOT;
  });
  makePluginTree(pluginRoot);
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ plugins: { zcode: { source: "directory", path: pluginRoot, enabled: true } } }),
  );

  assert.equal(resolvePluginSourceRoot("zcode", home), pluginRoot, "directory plugins resolve via config.json");

  process.env.ZCODE_PLUGIN_ROOT = pluginRoot;
  assert.equal(resolvePluginSourceRoot("zcode", home), pluginRoot, "env override wins");

  delete process.env.ZCODE_PLUGIN_ROOT;
  assert.equal(
    resolvePluginSourceRoot("zcode", path.join(home, "missing")),
    undefined,
    "missing config degrades to no source root",
  );
});
