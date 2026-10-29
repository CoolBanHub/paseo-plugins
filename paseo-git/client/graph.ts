/**
 * Commit-graph lane assignment (gitgraph.js style). Rows are computed once
 * per loaded page; the row renderer derives line segments from the lane
 * positions entering and leaving each row.
 */

export const ROW_H = 28;
export const LANE_W = 10;
export const GRAPH_PAD = 6;

export function laneX(lane: number): number {
  return GRAPH_PAD + lane * LANE_W + LANE_W / 2;
}

export function graphWidth(laneCount: number): number {
  return Math.min(180, GRAPH_PAD * 2 + Math.max(1, laneCount) * LANE_W);
}

export interface GraphEdge {
  from: number;
  to: number;
  kind: "first" | "merge";
}

export interface GraphRow {
  nodeLane: number;
  /** True when the commit was not present in the incoming lanes (branch head). */
  isNew: boolean;
  /** Hashes expected at the top edge of the row, by lane. */
  topLanes: readonly string[];
  /** Hashes expected at the bottom edge of the row, by lane. */
  bottomLanes: readonly string[];
  /** Connections from this row's node down to the next row. */
  edges: readonly GraphEdge[];
}

export interface GraphModel {
  rows: readonly GraphRow[];
  laneCount: number;
}

export interface GraphCommit {
  hash: string;
  parents: readonly string[];
}

export function computeGraph(commits: readonly GraphCommit[]): GraphModel {
  const rows: GraphRow[] = [];
  let lanes: string[] = [];
  let laneCount = 0;

  for (const commit of commits) {
    let nodeLane = lanes.indexOf(commit.hash);
    const isNew = nodeLane === -1;
    if (isNew) {
      nodeLane = lanes.length;
      lanes = [...lanes, commit.hash];
    }
    const topLanes = [...lanes];
    const bottom = [...lanes];
    const edges: GraphEdge[] = [];

    if (commit.parents.length === 0) {
      // Root commit: its lane terminates here.
      bottom.splice(nodeLane, 1);
    } else {
      const first = commit.parents[0];
      const existing = bottom.indexOf(first);
      if (existing !== -1 && existing !== nodeLane) {
        // First parent already expected in another lane: this lane merges in.
        bottom.splice(nodeLane, 1);
        edges.push({ from: nodeLane, to: existing, kind: "first" });
      } else {
        bottom[nodeLane] = first;
        edges.push({ from: nodeLane, to: nodeLane, kind: "first" });
      }
      for (const parent of commit.parents.slice(1)) {
        let lane = bottom.indexOf(parent);
        if (lane === -1) {
          bottom.push(parent);
          lane = bottom.length - 1;
        }
        edges.push({ from: nodeLane, to: lane, kind: "merge" });
      }
    }

    rows.push({ nodeLane, isNew, topLanes, bottomLanes: bottom, edges });
    laneCount = Math.max(laneCount, topLanes.length, bottom.length);
    lanes = bottom;
  }

  return { rows, laneCount };
}

/**
 * Line segments for one row, in absolute row coordinates. Edges follow the
 * IDEA shape: a vertical stub out of the node, then a diagonal whose height
 * equals the lane distance (capped at half a row) touching the row's bottom
 * edge. Pass-through lanes that shift lanes after a terminated root get a
 * vertical plus diagonal pair across the middle.
 */
export function rowSegments(
  row: GraphRow,
): {
  verticals: { lane: number; top: number; height: number }[];
  diagonals: { fromLane: number; toLane: number; fromY: number; toY: number }[];
} {
  const midY = ROW_H / 2;
  const verticals: { lane: number; top: number; height: number }[] = [];
  const diagonals: { fromLane: number; toLane: number; fromY: number; toY: number }[] = [];

  for (const [topIndex, hash] of row.topLanes.entries()) {
    if (topIndex === row.nodeLane) continue;
    const bottomIndex = row.bottomLanes.indexOf(hash);
    verticals.push({ lane: topIndex, top: 0, height: ROW_H });
    if (bottomIndex !== -1 && bottomIndex !== topIndex) {
      const dx = Math.abs(laneX(bottomIndex) - laneX(topIndex));
      const dy = Math.min(dx, ROW_H / 2 - 2);
      verticals.push({ lane: bottomIndex, top: ROW_H - dy, height: dy });
      diagonals.push({ fromLane: topIndex, toLane: bottomIndex, fromY: ROW_H - dy, toY: ROW_H });
    }
  }

  for (const edge of row.edges) {
    if (edge.from === edge.to) {
      const startY = row.isNew ? midY : 0;
      verticals.push({ lane: edge.to, top: startY, height: ROW_H - startY });
    } else {
      const dx = Math.abs(laneX(edge.to) - laneX(edge.from));
      const dy = Math.min(dx, ROW_H - midY);
      const stubTop = row.isNew ? midY : 0;
      if (ROW_H - dy > stubTop) {
        verticals.push({ lane: edge.from, top: stubTop, height: ROW_H - dy - stubTop });
      }
      diagonals.push({ fromLane: edge.from, toLane: edge.to, fromY: ROW_H - dy, toY: ROW_H });
    }
  }
  return { verticals, diagonals };
}
