/**
 * Commit-graph lane assignment (gitgraph.js style). Rows are computed once
 * per loaded page; the row renderer derives line segments from the lane
 * positions entering and leaving each row.
 */

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
