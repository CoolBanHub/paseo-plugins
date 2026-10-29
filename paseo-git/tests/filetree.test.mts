import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDirTree, collectAllPaths, collectFiles } from "../client/filetree.ts";

test("buildDirTree 根文件直出、目录分组并压缩单链", () => {
  const tree = buildDirTree([
    { path: "README.md", value: 1 },
    { path: "src/main.ts", value: 2 },
    { path: "src/util/helper.ts", value: 3 },
    { path: "docs/deep/nested/page.md", value: 4 },
  ]);
  assert.deepEqual(tree.rootFiles.map((file) => file.path), ["README.md"]);
  assert.deepEqual(tree.dirs.map((dir) => dir.name), ["docs/deep/nested", "src"]);
  const src = tree.dirs.find((dir) => dir.path === "src");
  assert.ok(src);
  assert.deepEqual(src.files.map((file) => file.name), ["main.ts"]);
  assert.deepEqual(src.dirs.map((dir) => dir.name), ["util"]);
});

test("buildDirTree 混合目录不压缩并按字母排序", () => {
  const tree = buildDirTree([
    { path: "zeta.txt", value: 1 },
    { path: "src/a.ts", value: 2 },
    { path: "src/b.ts", value: 3 },
    { path: "only/deep/file.ts", value: 4 },
  ]);
  assert.deepEqual(tree.rootFiles.map((file) => file.path), ["zeta.txt"]);
  assert.deepEqual(tree.dirs.map((dir) => dir.name), ["only/deep", "src"]);
  const src = tree.dirs.find((dir) => dir.path === "src");
  assert.ok(src);
  assert.deepEqual(src.files.map((file) => file.name), ["a.ts", "b.ts"]);
});

test("collectFiles 展开子目录全部文件", () => {
  const tree = buildDirTree([
    { path: "a/one.txt", value: 1 },
    { path: "a/sub/two.txt", value: 2 },
    { path: "b/three.txt", value: 3 },
  ]);
  const a = tree.dirs.find((dir) => dir.path === "a");
  assert.ok(a);
  assert.deepEqual(collectFiles(a).map((file) => file.path), ["a/one.txt", "a/sub/two.txt"]);
  assert.deepEqual(collectAllPaths(tree).sort(), ["a/one.txt", "a/sub/two.txt", "b/three.txt"]);
});
