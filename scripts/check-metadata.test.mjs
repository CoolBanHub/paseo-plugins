import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkRepository } from "./check-metadata.mjs";

function json(root, path, value) {
  writeFileSync(join(root, path), JSON.stringify(value));
}

function update(root, path, change) {
  const value = JSON.parse(readFileSync(join(root, path), "utf8"));
  change(value);
  json(root, path, value);
}

function addPlugin(root, id) {
  const directory = `paseo-${id}`;
  mkdirSync(join(root, directory));
  const pkg = {
    name: id,
    version: "0.1.0",
    files: ["paseo-plugin.json", "OVERVIEW.md", "index.client.tsx", "index.server.ts"],
    engines: { node: ">=22.15.0" },
    dependencies: { zod: "^4.4.3" },
    devDependencies: { "@getpaseo/plugin": "0.12.0" },
  };
  json(root, `${directory}/package.json`, pkg);
  json(root, `${directory}/package-lock.json`, { name: id, version: pkg.version, packages: { "": pkg } });
  json(root, `${directory}/paseo-plugin.json`, { id, name: "测试插件", requirements: { paseo: ">=0.11.4" } });
  writeFileSync(join(root, directory, "OVERVIEW.md"), "Paseo >= 0.11.4\nNode >=22.15.0\n");
  for (const entry of ["index.client.tsx", "index.server.ts"]) writeFileSync(join(root, directory, entry), "");
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "paseo-metadata-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, ".node-version"), "22.19.0\n");
  writeFileSync(join(root, "README.md"), "# 测试\n\n<!-- plugin-requirements:start -->\n<!-- plugin-requirements:end -->\n");
  addPlugin(root, "example");
  checkRepository(root, { write: true });
  return root;
}

test("允许开发 SDK 高于声明的最低宿主版本", (t) => {
  assert.deepEqual(checkRepository(fixture(t)), ["paseo-example"]);
});

test("新增插件自动进入矩阵，并要求更新 README", (t) => {
  const root = fixture(t);
  addPlugin(root, "another");
  assert.throws(() => checkRepository(root), /README 环境表过期/);
  assert.deepEqual(checkRepository(root, { write: true }), ["paseo-another", "paseo-example"]);
  assert.deepEqual(checkRepository(root), ["paseo-another", "paseo-example"]);
});

test("拒绝 README 中过期的环境要求", (t) => {
  const root = fixture(t);
  const path = join(root, "README.md");
  writeFileSync(path, readFileSync(path, "utf8").replace(">=0.11.4", ">=0.12.0"));
  assert.throws(() => checkRepository(root), /README 环境表过期/);
});

test("拒绝 OVERVIEW 与 manifest 的宿主要求不一致", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "paseo-example/OVERVIEW.md"), "Paseo >=0.12.0\nNode >=22.15.0\n");
  assert.throws(() => checkRepository(root), /OVERVIEW 的 Paseo 要求不一致/);
});

test("拒绝锁文件中遗漏的运行依赖声明", (t) => {
  const root = fixture(t);
  update(root, "paseo-example/package-lock.json", (lock) => { delete lock.packages[""].dependencies; });
  assert.throws(() => checkRepository(root), /锁文件 dependencies 声明过期/);
});

test("拒绝缺少显示名称或重复 ID 的插件", (t) => {
  const root = fixture(t);
  update(root, "paseo-example/paseo-plugin.json", (manifest) => { delete manifest.name; });
  assert.throws(() => checkRepository(root), /缺少显示名称/);
  update(root, "paseo-example/paseo-plugin.json", (manifest) => { manifest.name = "测试插件"; });
  addPlugin(root, "z-duplicate");
  update(root, "paseo-z-duplicate/paseo-plugin.json", (manifest) => { manifest.id = "example"; });
  assert.throws(() => checkRepository(root), /插件 id 重复/);
});

test("拒绝低于插件 Node 要求的开发环境及过期的 Node 说明", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, ".node-version"), "22.14.0\n");
  assert.throws(() => checkRepository(root), /Node 要求高于 .node-version/);
  writeFileSync(join(root, ".node-version"), "22.19.0\n");
  writeFileSync(join(root, "paseo-example/OVERVIEW.md"), "Paseo >=0.11.4\nNode >=18.0.0\n");
  assert.throws(() => checkRepository(root), /OVERVIEW 的 Node 要求不一致/);
});

test("拒绝遗漏插件入口的打包清单", (t) => {
  const root = fixture(t);
  update(root, "paseo-example/package.json", (pkg) => { pkg.files = pkg.files.filter((entry) => entry !== "index.server.ts"); });
  assert.throws(() => checkRepository(root), /打包清单缺少 index.server.ts/);
});
