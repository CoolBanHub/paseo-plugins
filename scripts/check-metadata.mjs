import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const start = "<!-- plugin-requirements:start -->";
const end = "<!-- plugin-requirements:end -->";
const versionPattern = /^\d+\.\d+\.\d+$/;

function atLeast(actual, minimum) {
  const left = actual.split(".").map(Number);
  const right = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return true;
}

function minimumVersion(range, label) {
  assert.match(range ?? "", /^>=\d+\.\d+\.\d+$/, `${label} 必须使用 >=x.y.z`);
  return range.slice(2);
}

function sortedEntries(value) {
  return Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right));
}

export function checkRepository(root, { write = false } = {}) {
  const read = (path) => readFileSync(join(root, path), "utf8");
  const json = (path) => JSON.parse(read(path));
  const nodeVersion = read(".node-version").trim();
  assert.match(nodeVersion, versionPattern, ".node-version 必须固定完整版本号");
  const directories = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("paseo-"))
    .map((entry) => entry.name).sort();
  assert.ok(directories.length, "未找到插件目录");

  const ids = new Set();
  const rows = directories.map((directory) => {
    const manifest = json(`${directory}/paseo-plugin.json`);
    const pkg = json(`${directory}/package.json`);
    const lock = json(`${directory}/package-lock.json`);
    const overview = read(`${directory}/OVERVIEW.md`);
    assert.match(manifest.id ?? "", /^[a-z][a-z0-9-]*$/, `${directory} 缺少有效 id`);
    assert.ok(!ids.has(manifest.id), `插件 id 重复：${manifest.id}`);
    ids.add(manifest.id);
    assert.ok(typeof manifest.name === "string" && manifest.name.trim(), `${directory} 缺少显示名称`);
    assert.equal(pkg.name, manifest.id, `${directory} package.name 与插件 id 不一致`);
    assert.match(pkg.version ?? "", versionPattern, `${directory} 缺少有效包版本`);
    assert.equal(lock.name, pkg.name, `${directory} 锁文件名称过期`);
    assert.equal(lock.version, pkg.version, `${directory} 锁文件版本过期`);
    assert.equal(lock.packages?.[""]?.name, pkg.name, `${directory} 锁文件根包名称过期`);
    assert.equal(lock.packages?.[""]?.version, pkg.version, `${directory} 锁文件根包版本过期`);
    for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "engines"]) {
      assert.deepEqual(sortedEntries(lock.packages[""][key]), sortedEntries(pkg[key]), `${directory} 锁文件 ${key} 声明过期`);
    }

    const minimum = minimumVersion(manifest.requirements?.paseo, `${directory} Paseo 要求`);
    const sdk = pkg.devDependencies?.["@getpaseo/plugin"];
    assert.match(sdk ?? "", versionPattern, `${directory} 开发 SDK 必须固定完整版本号`);
    assert.ok(atLeast(sdk, minimum), `${directory} 开发 SDK 低于声明的 Paseo 要求`);
    const documented = [...overview.matchAll(/\bPaseo\s*(?:>=|≥)\s*(\d+\.\d+\.\d+)/g)];
    assert.ok(documented.length && documented.every((match) => match[1] === minimum), `${directory} OVERVIEW 的 Paseo 要求不一致`);
    if (pkg.engines?.node) {
      const minimumNode = minimumVersion(pkg.engines.node, `${directory} Node 要求`);
      assert.ok(atLeast(nodeVersion, minimumNode), `${directory} Node 要求高于 .node-version`);
      const documentedNode = [...overview.matchAll(/\bNode\s*(?:>=|≥)\s*(\d+\.\d+\.\d+)/g)];
      assert.ok(documentedNode.length && documentedNode.every((match) => match[1] === minimumNode), `${directory} OVERVIEW 的 Node 要求不一致`);
    }
    for (const entry of ["index.client.tsx", "index.server.ts", "OVERVIEW.md", "paseo-plugin.json"]) {
      assert.ok(existsSync(join(root, directory, entry)), `${directory} 缺少 ${entry}`);
      assert.ok(pkg.files?.includes(entry), `${directory} 打包清单缺少 ${entry}`);
    }
    return `| [${directory}/](${directory}/) | \`${manifest.id}\` | ${manifest.name.replaceAll("|", "\\|").replaceAll("\n", " ")} | \`${manifest.requirements.paseo}\` | \`${sdk}\` | ${pkg.engines?.node ? `\`${pkg.engines.node}\`` : "—"} |`;
  });

  const readme = read("README.md");
  assert.equal(readme.split(start).length, 2, "README 缺少唯一的环境表开始标记");
  assert.equal(readme.split(end).length, 2, "README 缺少唯一的环境表结束标记");
  const from = readme.indexOf(start);
  const to = readme.indexOf(end) + end.length;
  assert.ok(from < to - end.length, "README 环境表标记顺序错误");
  const block = [start, "| 目录 | 插件 ID | 显示名称 | Paseo 要求 | 开发 SDK | 额外 Node 要求 |", "| --- | --- | --- | --- | --- | --- |", ...rows, end].join("\n");
  const expected = readme.slice(0, from) + block + readme.slice(to);
  if (write) writeFileSync(join(root, "README.md"), expected);
  else assert.equal(readme, expected, "README 环境表过期，请运行 node scripts/check-metadata.mjs --write");
  return directories;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    assert.ok(args.length <= 1 && args.every((arg) => ["--write", "--matrix"].includes(arg)), "用法：node scripts/check-metadata.mjs [--write|--matrix]");
    const plugins = checkRepository(fileURLToPath(new URL("../", import.meta.url)), { write: args.includes("--write") });
    console.log(args.includes("--matrix") ? `plugins=${JSON.stringify(plugins)}` : `元数据检查通过（${plugins.length} 个插件）。`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
