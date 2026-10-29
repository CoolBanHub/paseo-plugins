import assert from "node:assert/strict";
import { test } from "node:test";
import { ROW_H, computeGraph, laneX, rowSegments } from "../client/graph.ts";

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

test("rowSegments 生成 IDEA 折线：竖线段 + 底部斜线段", () => {
  const commits = [
    { hash: "m", parents: ["c2", "f"] },
    { hash: "f", parents: ["c1"] },
    { hash: "c2", parents: ["c1"] },
    { hash: "c1", parents: [] },
  ];
  const graph = computeGraph(commits);
  const [mergeRow] = graph.rows;

  // 合并节点：新车道，0→0 竖线从中心开始；0→1 斜线 = 竖线 stub + 斜线
  const merge = rowSegments(mergeRow!);
  const straight = merge.verticals.find((v) => v.lane === 0 && v.top === ROW_H / 2);
  assert.ok(straight, "首父直连竖线从行中心开始");
  assert.equal(straight?.height, ROW_H / 2);

  const diagonal = merge.diagonals.find((d) => d.fromLane === 0 && d.toLane === 1);
  assert.ok(diagonal, "合并边有斜线段");
  assert.equal(diagonal?.toY, ROW_H, "斜线落到行底");
  assert.equal(diagonal?.fromY, ROW_H - Math.abs(laneX(1) - laneX(0)), "相邻车道斜线高度 = 车道间距");

  // 斜线前有竖线 stub（从中心到斜线起点）
  const stub = merge.verticals.find((v) => v.lane === 0 && v.top === ROW_H / 2 && v.height === diagonal!.fromY - ROW_H / 2);
  assert.ok(stub, "斜线起点前有竖线段");
});

test("rowSegments 直连边在非新车道从行顶贯穿", () => {
  const commits = [
    { hash: "c3", parents: ["c2"] },
    { hash: "c2", parents: ["c1"] },
    { hash: "c1", parents: [] },
  ];
  const graph = computeGraph(commits);
  const [, second] = graph.rows;
  const segments = rowSegments(second!);
  const through = segments.verticals.find((v) => v.lane === 0 && v.top === 0);
  assert.ok(through, "非新车道从行顶贯穿");
  assert.equal(through?.height, ROW_H);
  assert.equal(segments.diagonals.length, 0, "线性历史没有斜线");
});
