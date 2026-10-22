import assert from "node:assert/strict";
import { test } from "node:test";
import { computeGraph } from "../client/graph.ts";

test("线性历史只有一条车道", () => {
  const commits = [
    { hash: "c3", parents: ["c2"] },
    { hash: "c2", parents: ["c1"] },
    { hash: "c1", parents: [] },
  ];
  const graph = computeGraph(commits);
  assert.equal(graph.laneCount, 1);
  for (const row of graph.rows) {
    assert.equal(row.nodeLane, 0);
  }
  assert.equal(graph.rows[0]?.edges.length, 1);
  assert.equal(graph.rows[1]?.edges.length, 1);
  assert.equal(graph.rows[2]?.edges.length, 0, "根提交没有出边");
  assert.deepEqual(graph.rows[2]?.bottomLanes, [], "根提交终止车道");
});

test("分支与合并的边", () => {
  // main: c1 - c2 - m ; feature: c1 - f（date-order 下 m 最先出现）
  const commits = [
    { hash: "m", parents: ["c2", "f"] },
    { hash: "f", parents: ["c1"] },
    { hash: "c2", parents: ["c1"] },
    { hash: "c1", parents: [] },
  ];
  const graph = computeGraph(commits);
  const [m, f, c2, c1] = graph.rows;

  assert.equal(graph.laneCount, 2);

  // m 开辟 0 号车道；first-parent 沿 0 号延续，feature 父提交开到 1 号
  assert.equal(m?.isNew, true);
  assert.equal(m?.nodeLane, 0);
  assert.deepEqual(m?.edges.find((edge) => edge.kind === "first"), { from: 0, to: 0, kind: "first" });
  assert.deepEqual(m?.edges.find((edge) => edge.kind === "merge"), { from: 0, to: 1, kind: "merge" });
  assert.deepEqual(m?.bottomLanes, ["c2", "f"]);

  // f 已被 merge 边预留到 1 号车道，不是新车道
  assert.equal(f?.isNew, false);
  assert.equal(f?.nodeLane, 1);
  assert.deepEqual(f?.bottomLanes, ["c2", "c1"]);

  // c2 的 first-parent 与 1 号车道期待同一个 c1：并线收缩
  assert.deepEqual(c2?.topLanes, ["c2", "c1"]);
  assert.deepEqual(c2?.edges, [{ from: 0, to: 1, kind: "first" }]);
  assert.deepEqual(c2?.bottomLanes, ["c1"]);

  assert.equal(c1?.nodeLane, 0);
  assert.deepEqual(c1?.bottomLanes, [], "根提交终止最后一条车道");
});

test("两个未合并的分支头各自占道", () => {
  const commits = [
    { hash: "a2", parents: ["a1"] },
    { hash: "b2", parents: ["a1"] },
    { hash: "a1", parents: [] },
  ];
  const graph = computeGraph(commits);
  assert.equal(graph.laneCount, 2);
  assert.equal(graph.rows[0]?.nodeLane, 0);
  assert.equal(graph.rows[1]?.nodeLane, 1);
  assert.equal(graph.rows[1]?.isNew, true);
});

test("章鱼合并（三个父提交）", () => {
  const commits = [
    { hash: "m", parents: ["p1", "p2", "p3"] },
    { hash: "p3", parents: [] },
    { hash: "p2", parents: [] },
    { hash: "p1", parents: [] },
  ];
  const graph = computeGraph(commits);
  const [m] = graph.rows;
  assert.equal(graph.laneCount, 3);
  assert.equal(m?.edges.length, 3);
  assert.deepEqual(
    m?.edges.map((edge) => edge.to).sort(),
    [0, 1, 2],
  );
});

test("first-parent 已在别的车道时并线而不重复", () => {
  // date-order 下 f 可能先于 m 出现，两条车道都指向 c2
  const commits = [
    { hash: "m", parents: ["c2"] },
    { hash: "f", parents: ["c2"] },
    { hash: "c2", parents: [] },
  ];
  const graph = computeGraph(commits);
  const [m, f, c2] = graph.rows;

  assert.equal(m?.nodeLane, 0);
  assert.deepEqual(m?.edges, [{ from: 0, to: 0, kind: "first" }]);

  assert.equal(f?.nodeLane, 1);
  assert.equal(f?.isNew, true);
  assert.deepEqual(f?.topLanes, ["c2", "f"]);
  assert.deepEqual(f?.bottomLanes, ["c2"], "f 的车道并线到已有的 c2 车道，不产生重复");
  assert.deepEqual(f?.edges, [{ from: 1, to: 0, kind: "first" }]);

  assert.equal(c2?.nodeLane, 0);
  assert.deepEqual(c2?.bottomLanes, []);
  assert.equal(graph.laneCount, 2);
});
