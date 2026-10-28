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

const { reportedUsageAccounts } = require("../server/zcode-usage.ts");
const {
  readHiddenUsageAccounts,
  writeHiddenUsageAccounts,
  usageAccountDataDirectory,
} = require("../server/usage-account-store.ts");
const { saveUsageAccountsRpc } = require("../shared/usage-accounts.ts");

const ACCOUNTS = [
  { key: "key-bigmodel", label: "智谱 BigModel 账号套餐", kind: "account", input: { kind: "account", providerId: "bigmodel" } },
  { key: "key-binglm", label: "binglm（智谱 API key 套餐）", kind: "apikey", input: { kind: "apikey", providerId: "binglm" } },
];

test("hidden accounts are filtered from the reported list", () => {
  assert.deepEqual(
    reportedUsageAccounts(ACCOUNTS, []).map((account) => account.key),
    ["key-bigmodel", "key-binglm"],
    "no hidden keys keeps every account",
  );
  assert.deepEqual(
    reportedUsageAccounts(ACCOUNTS, ["key-bigmodel"]).map((account) => account.key),
    ["key-binglm"],
    "a hidden key drops only that account",
  );
  assert.deepEqual(reportedUsageAccounts(ACCOUNTS, ["key-unknown"]), ACCOUNTS, "unknown keys change nothing");
  assert.deepEqual(reportedUsageAccounts([], ["key-bigmodel"]), [], "no accounts stay no accounts");
});

test("hidden usage accounts persist under the plugin data directory", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-usage-home-"));
  const directory = path.join(home, "plugin-data", "zcode");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  assert.deepEqual(readHiddenUsageAccounts(directory), [], "missing file reads as nothing hidden");

  await writeHiddenUsageAccounts(["key-bigmodel"], directory);
  assert.deepEqual(readHiddenUsageAccounts(directory), ["key-bigmodel"], "round trip keeps the hidden keys");

  const parsed = JSON.parse(fs.readFileSync(path.join(directory, "usage-accounts.json"), "utf8"));
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.hidden, ["key-bigmodel"]);

  fs.writeFileSync(path.join(directory, "usage-accounts.json"), "{not json");
  assert.deepEqual(readHiddenUsageAccounts(directory), [], "a corrupt file degrades to nothing hidden");

  fs.writeFileSync(path.join(directory, "usage-accounts.json"), JSON.stringify({ version: 1, hidden: ["a", "a", 3, null] }));
  assert.deepEqual(readHiddenUsageAccounts(directory), ["a"], "invalid entries are dropped and deduped");
});

test("the data directory follows PASEO_HOME", () => {
  const previous = process.env.PASEO_HOME;
  try {
    process.env.PASEO_HOME = "/tmp/paseo-home-test";
    assert.equal(usageAccountDataDirectory(), path.join("/tmp/paseo-home-test", "plugin-data", "zcode"));
    process.env.PASEO_HOME = "";
    assert.equal(usageAccountDataDirectory(), path.join(os.homedir(), ".paseo", "plugin-data", "zcode"));
    assert.equal(usageAccountDataDirectory("/tmp/elsewhere"), "/tmp/elsewhere", "an explicit directory wins");
  } finally {
    if (previous === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous;
  }
});

test("the save contract takes a bounded list of reported keys", () => {
  assert.deepEqual(saveUsageAccountsRpc.input.parse({ reportedKeys: ["key-bigmodel"] }), { reportedKeys: ["key-bigmodel"] });
  assert.deepEqual(saveUsageAccountsRpc.input.parse({ reportedKeys: [] }), { reportedKeys: [] }, "hiding everything is allowed");
  assert.throws(() => saveUsageAccountsRpc.input.parse({ reportedKeys: [""] }), "empty keys are rejected");
  assert.throws(() => saveUsageAccountsRpc.input.parse({ reportedKeys: [3] }), "non-string keys are rejected");
  assert.throws(() => saveUsageAccountsRpc.input.parse({}), "the field is required");
});
