import { useMemo } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { hashStringColor, laneColor, mixWithBackground } from "./colors";
import { formatShortTime } from "./format";
import { HoverPressable, MONO_FONT, type PanelTheme } from "./parts";
import { computeGraph, type GraphRow } from "./graph";
import type { CommitSummary } from "../shared/types";

const ROW_H = 34;
const LANE_W = 12;
const GRAPH_PAD = 8;
const TIME_W = 78;
const HASH_W = 52;
const AUTHOR_W = 108;

export function graphWidth(laneCount: number): number {
  return Math.min(168, GRAPH_PAD * 2 + Math.max(1, laneCount) * LANE_W);
}

function laneX(lane: number): number {
  return GRAPH_PAD + lane * LANE_W + LANE_W / 2;
}

/** Line segments for one row of the graph, in absolute row coordinates. */
export function rowSegments(
  row: GraphRow,
): {
  verticals: { lane: number; top: number; height: number }[];
  horizontals: { fromLane: number; toLane: number; y: number }[];
  diagonals: { fromLane: number; toLane: number; fromY: number; toY: number }[];
} {
  const midY = ROW_H / 2;
  const verticals: { lane: number; top: number; height: number }[] = [];
  const horizontals: { fromLane: number; toLane: number; y: number }[] = [];
  const diagonals: { fromLane: number; toLane: number; fromY: number; toY: number }[] = [];

  // Pass-through lanes: entering the row and continuing below. A terminated
  // root shifts right-hand lanes left, drawn as a half-vertical + bar join.
  for (const [topIndex, hash] of row.topLanes.entries()) {
    if (topIndex === row.nodeLane) continue;
    const bottomIndex = row.bottomLanes.indexOf(hash);
    if (bottomIndex === topIndex || bottomIndex === -1) {
      verticals.push({ lane: topIndex, top: 0, height: ROW_H });
    } else {
      verticals.push({ lane: topIndex, top: 0, height: midY });
      verticals.push({ lane: bottomIndex, top: midY, height: ROW_H - midY });
      horizontals.push({
        fromLane: Math.min(topIndex, bottomIndex),
        toLane: Math.max(topIndex, bottomIndex),
        y: midY,
      });
    }
  }

  // Edges from this row's node down to the next row.
  for (const edge of row.edges) {
    if (edge.from === edge.to) {
      const startY = row.isNew ? midY : 0;
      verticals.push({ lane: edge.to, top: startY, height: ROW_H - startY });
    } else {
      diagonals.push({ fromLane: edge.from, toLane: edge.to, fromY: midY, toY: ROW_H });
    }
  }
  return { verticals, horizontals, diagonals };
}

function GraphCell({ row, theme }: { row: GraphRow; theme: PanelTheme }) {
  const { verticals, horizontals, diagonals } = rowSegments(row);
  return (
    <View style={{ width: "100%", height: ROW_H }}>
      {verticals.map((segment, index) => (
        <View
          key={`v${index}`}
          style={{
            position: "absolute",
            left: laneX(segment.lane) - 1,
            top: segment.top,
            width: 2,
            height: segment.height,
            backgroundColor: laneColor(segment.lane),
          }}
        />
      ))}
      {horizontals.map((segment, index) => {
        const x1 = laneX(segment.fromLane);
        const x2 = laneX(segment.toLane) + 1;
        return (
          <View
            key={`h${index}`}
            style={{
              position: "absolute",
              left: x1,
              top: segment.y - 1,
              width: Math.max(2, x2 - x1),
              height: 2,
              backgroundColor: laneColor(segment.toLane),
            }}
          />
        );
      })}
      {diagonals.map((segment, index) => {
        const x1 = laneX(segment.fromLane);
        const x2 = laneX(segment.toLane);
        const y1 = segment.fromY;
        const y2 = segment.toY;
        const dx = x2 - x1;
        const dy = y2 - y1;
        const length = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx);
        return (
          <View
            key={`d${index}`}
            style={{
              position: "absolute",
              left: x1 + dx / 2 - length / 2,
              top: y1 + dy / 2 - 1,
              width: length,
              height: 2,
              backgroundColor: laneColor(segment.fromLane),
              transform: [{ rotate: `${angle}rad` }],
            }}
          />
        );
      })}
      <View
        style={{
          position: "absolute",
          left: laneX(row.nodeLane) - 4,
          top: ROW_H / 2 - 4,
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: laneColor(row.nodeLane),
          borderWidth: 1.5,
          borderColor: theme.colors.surface0,
        }}
      />
    </View>
  );
}

function refChipStyle(ref: string, theme: PanelTheme): { label: string; color: string; background: string | null } | null {
  if (ref === "HEAD") return { label: "HEAD", color: theme.colors.accentForeground, background: theme.colors.accent };
  if (ref.startsWith("HEAD -> ")) {
    return { label: ref.slice("HEAD -> ".length), color: theme.colors.accentForeground, background: theme.colors.accent };
  }
  if (ref.startsWith("tag: ")) {
    return { label: ref.slice("tag: ".length), color: theme.colors.statusSuccess, background: mixWithBackground(theme.colors.statusSuccess, theme.colors.surface0, 0.82) };
  }
  if (ref.includes("/")) {
    return { label: ref, color: theme.colors.foregroundMuted, background: theme.colors.surface2 };
  }
  return { label: ref, color: theme.colors.statusWarning, background: mixWithBackground(theme.colors.statusWarning, theme.colors.surface0, 0.82) };
}

function RefChips({ refs, theme }: { refs: string[]; theme: PanelTheme }) {
  const chips = refs.map((ref) => ({ ref, style: refChipStyle(ref, theme) })).filter((entry) => entry.style !== null);
  if (chips.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", gap: 3, flexShrink: 1, minWidth: 0 }}>
      {chips.slice(0, 3).map(({ ref, style }) => (
        <View
          key={ref}
          style={{
            borderRadius: 4,
            backgroundColor: style?.background ?? "transparent",
            borderWidth: style?.background ? 0 : 1,
            borderColor: style?.color ?? "transparent",
            paddingHorizontal: 4,
            justifyContent: "center",
            maxWidth: 110,
          }}
        >
          <Text numberOfLines={1} style={{ color: style?.color, fontSize: 9, fontFamily: MONO_FONT }}>
            {style?.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function CommitList({
  theme,
  commits,
  selectedHash,
  onSelect,
  loading,
  loadingMore,
  hasMore,
  onLoadMore,
  totalCount,
}: {
  theme: PanelTheme;
  commits: CommitSummary[];
  selectedHash: string | null;
  onSelect: (hash: string) => void;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  totalCount: number;
}) {
  const graph = useMemo(() => computeGraph(commits), [commits]);
  const width = graphWidth(graph.laneCount);

  if (loading && commits.length === 0) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 8 }}>
        <ActivityIndicator color={theme.colors.foregroundMuted} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>加载提交历史…</Text>
      </View>
    );
  }

  if (commits.length === 0) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <Icon name="History" size={20} color={theme.colors.foregroundMuted} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, marginTop: 6 }}>
          没有符合条件的提交
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {/* Column headers */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 4,
          paddingVertical: 3,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
          gap: 6,
        }}
      >
        <View style={{ width }} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9, width: TIME_W }}>提交时间</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9, width: HASH_W }}>提交</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9, flex: 1 }} numberOfLines={1}>
          提交信息 / 分支
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9, width: AUTHOR_W, textAlign: "right" }}>
          作者
        </Text>
      </View>

      {commits.map((commit, index) => {
        const row = graph.rows[index];
        if (!row) return null;
        const authorColor = hashStringColor(commit.authorName);
        const selected = commit.hash === selectedHash;
        return (
          <HoverPressable
            key={commit.hash}
            accessibilityRole="button"
            accessibilityLabel={`提交 ${commit.subject}`}
            onPress={() => onSelect(commit.hash)}
            style={({ hovered, pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              height: ROW_H,
              gap: 6,
              paddingHorizontal: 4,
              backgroundColor: selected
                ? mixWithBackground(theme.colors.accent, theme.colors.surface0, 0.86)
                : pressed || hovered
                  ? theme.colors.surface1
                  : "transparent",
              borderLeftWidth: 2,
              borderLeftColor: selected ? theme.colors.accent : "transparent",
            })}
          >
            <View style={{ width }}>
              <GraphCell row={row} theme={theme} />
            </View>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, width: TIME_W, fontFamily: MONO_FONT }}>
              {formatShortTime(commit.authorDate)}
            </Text>
            <View
              style={{
                width: HASH_W,
                borderRadius: 4,
                backgroundColor: mixWithBackground(authorColor, theme.colors.surface0, 0.85),
                alignItems: "center",
                paddingVertical: 1,
              }}
            >
              <Text style={{ color: authorColor, fontSize: 10, fontFamily: MONO_FONT }}>{commit.shortHash}</Text>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flex: 1, minWidth: 0 }}>
              <RefChips refs={commit.refs} theme={theme} />
              <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 11, flexShrink: 1 }}>
                {commit.subject}
              </Text>
            </View>
            <Text
              numberOfLines={1}
              style={{ color: theme.colors.foregroundMuted, fontSize: 10, width: AUTHOR_W, textAlign: "right" }}
            >
              {commit.authorName}
            </Text>
          </HoverPressable>
        );
      })}

      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", paddingVertical: 8, gap: 10 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
          已加载 {commits.length} / {totalCount > 0 ? `约 ${totalCount}` : "?"} 条
        </Text>
        {hasMore ? (
          loadingMore ? (
            <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
          ) : (
            <HoverPressable
              accessibilityRole="button"
              onPress={onLoadMore}
              style={({ hovered }) => ({
                paddingHorizontal: 10,
                paddingVertical: 4,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: hovered ? theme.colors.surface1 : "transparent",
              })}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 11 }}>加载更多</Text>
            </HoverPressable>
          )
        ) : null}
      </View>
    </View>
  );
}
