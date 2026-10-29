import { useMemo, useRef, useState } from "react";
import { ActivityIndicator, PanResponder, Text, View } from "react-native";
import { Icon, copyText } from "@getpaseo/plugin/client/react-native";
import { REF_COLORS, laneColor, mixWithBackground } from "./colors";
import { formatShortTime } from "./format";
import { HoverPressable, MONO_FONT, type PanelTheme } from "./parts";
import { ContextMenuModal, MenuButton, type MenuItem } from "./ContextMenu";
import { ROW_H, computeGraph, graphWidth, laneX, rowSegments, type GraphRow } from "./graph";
import type { CommitSummary } from "../shared/types";

const MIN_COL_W = 40;

export interface CommitActions {
  onCherryPick: (hash: string) => void;
  onCheckoutCommit: (hash: string) => void;
  onReset: (hash: string, mode: "soft" | "mixed" | "hard") => void;
  onRevert: (hash: string) => void;
  onCreateBranchHere: (hash: string) => void;
  onCreateTagHere: (hash: string) => void;
}

function GraphCell({
  row,
  theme,
  isHead,
  isMerge,
}: {
  row: GraphRow;
  theme: PanelTheme;
  isHead: boolean;
  isMerge: boolean;
}) {
  const { verticals, diagonals } = rowSegments(row);
  const color = laneColor(row.nodeLane);
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
            height: Math.max(1, segment.height),
            backgroundColor: laneColor(segment.lane),
          }}
        />
      ))}
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
      {isHead ? (
        <View
          style={{
            position: "absolute",
            left: laneX(row.nodeLane) - 6,
            top: ROW_H / 2 - 6,
            width: 12,
            height: 12,
            borderRadius: 6,
            borderWidth: 1.5,
            borderColor: color,
            opacity: 0.5,
          }}
        />
      ) : null}
      {isMerge ? (
        // Merge commit: IDEA-style ring with a core dot.
        <View
          style={{
            position: "absolute",
            left: laneX(row.nodeLane) - 4,
            top: ROW_H / 2 - 4,
            width: 8,
            height: 8,
            borderRadius: 4,
            borderWidth: 1.5,
            borderColor: color,
            backgroundColor: theme.colors.surface0,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <View style={{ width: 3, height: 3, borderRadius: 1.5, backgroundColor: color }} />
        </View>
      ) : (
        <View
          style={{
            position: "absolute",
            left: laneX(row.nodeLane) - 3.5,
            top: ROW_H / 2 - 3.5,
            width: 7,
            height: 7,
            borderRadius: 3.5,
            backgroundColor: color,
            borderWidth: 1.5,
            borderColor: theme.colors.surface0,
          }}
        />
      )}
    </View>
  );
}

/** Dangling lanes on the last row: history continues below the loaded page. */
function StubCell({ row, knownHashes }: { row: GraphRow; knownHashes: Set<string> }) {
  const stubs = row.bottomLanes
    .map((hash, lane) => ({ hash, lane }))
    .filter((stub) => !knownHashes.has(stub.hash));
  if (stubs.length === 0) return null;
  return (
    <>
      {stubs.map((stub) => (
        <View
          key={stub.hash}
          style={{
            position: "absolute",
            left: laneX(stub.lane) - 3,
            top: ROW_H - 7,
            width: 6,
            height: 6,
            backgroundColor: laneColor(stub.lane),
            transform: [{ rotate: "0.785rad" }],
          }}
        />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// ref badges: merge local "main" with remote "origin/main" into one chip
// ---------------------------------------------------------------------------

interface RefBadge {
  label: string;
  kind: "local" | "remote" | "both";
}

export function buildRefBadges(refs: readonly string[]): { isHead: boolean; branches: RefBadge[]; tags: string[] } {
  const locals = new Set<string>();
  const remotes = new Set<string>();
  const tags: string[] = [];
  let isHead = false;
  for (const ref of refs) {
    if (ref === "HEAD") {
      isHead = true;
      continue;
    }
    if (ref.startsWith("HEAD -> ")) {
      isHead = true;
      locals.add(ref.slice("HEAD -> ".length));
      continue;
    }
    if (ref.startsWith("tag: ")) {
      tags.push(ref.slice("tag: ".length));
      continue;
    }
    if (ref.includes("/")) {
      remotes.add(ref);
    } else {
      locals.add(ref);
    }
  }
  const badges: RefBadge[] = [];
  for (const name of locals) {
    const remote = [...remotes].find((candidate) => candidate.endsWith(`/${name}`));
    if (remote) {
      badges.push({ label: name, kind: "both" });
      remotes.delete(remote);
    } else {
      badges.push({ label: name, kind: "local" });
    }
  }
  for (const name of remotes) {
    badges.push({ label: name, kind: "remote" });
  }
  return { isHead, branches: badges, tags };
}

function RefBadges({ refs, theme }: { refs: string[]; theme: PanelTheme }) {
  const { isHead, branches, tags } = useMemo(() => buildRefBadges(refs), [refs]);
  const chips = branches.slice(0, 3);
  if (!isHead && chips.length === 0 && tags.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", gap: 3, flexShrink: 1, minWidth: 0, alignItems: "center" }}>
      {isHead ? (
        <View
          style={{
            borderRadius: 4,
            backgroundColor: mixWithBackground(REF_COLORS.head, theme.colors.surface0, 0.78),
            paddingHorizontal: 4,
            justifyContent: "center",
          }}
        >
          <Text style={{ color: REF_COLORS.head, fontSize: 9, fontFamily: MONO_FONT, fontWeight: "700" }}>HEAD</Text>
        </View>
      ) : null}
      {chips.map((chip) => (
        <View
          key={chip.label}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 3,
            borderRadius: 4,
            backgroundColor: mixWithBackground(
              chip.kind === "remote" ? REF_COLORS.remote : REF_COLORS.local,
              theme.colors.surface0,
              0.82,
            ),
            paddingHorizontal: 4,
            paddingVertical: 0.5,
            justifyContent: "center",
            maxWidth: 130,
          }}
        >
          <View style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: REF_COLORS.local }} />
          {chip.kind !== "local" ? (
            <View style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: REF_COLORS.remote }} />
          ) : null}
          <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 9, fontFamily: MONO_FONT }}>
            {chip.label}
          </Text>
        </View>
      ))}
      {tags.slice(0, 2).map((tag) => (
        <View
          key={tag}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 3,
            borderRadius: 4,
            backgroundColor: mixWithBackground(REF_COLORS.tag, theme.colors.surface0, 0.82),
            paddingHorizontal: 4,
            paddingVertical: 0.5,
            maxWidth: 110,
          }}
        >
          <Icon name="Tag" size={8} color={REF_COLORS.tag} />
          <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 9, fontFamily: MONO_FONT }}>
            {tag}
          </Text>
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// column resize handle (mouse drag via PanResponder)
// ---------------------------------------------------------------------------

function ColumnResizeHandle({
  theme,
  width,
  onChange,
}: {
  theme: PanelTheme;
  width: number;
  min: number;
  onChange: (next: number) => void;
}) {
  const [active, setActive] = useState(false);
  // Snapshot the width at drag start: the responder closure is created once,
  // so it must read the live value through a ref rather than the stale prop.
  const widthRef = useRef(width);
  widthRef.current = width;
  const startRef = useRef(width);
  const [pan] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        startRef.current = widthRef.current;
        setActive(true);
      },
      onPanResponderMove: (_event, gesture) => {
        onChange(startRef.current + gesture.dx);
      },
      onPanResponderRelease: () => setActive(false),
      onPanResponderTerminate: () => setActive(false),
    }),
  );
  return (
    <View
      {...pan.panHandlers}
      style={{
        width: 9,
        marginLeft: -5,
        height: 22,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <View
        style={{
          width: 2,
          height: active ? 16 : 10,
          borderRadius: 1,
          backgroundColor: active ? theme.colors.accent : theme.colors.border,
        }}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

interface ColumnWidths {
  time: number;
  hash: number;
  author: number;
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
  actions,
  widthMode = "full",
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
  actions: CommitActions;
  /** Narrow panels drop the author (medium) and time (narrow) columns to keep
   *  the message readable; explicit column toggles only apply when full. */
  widthMode?: "full" | "medium" | "narrow";
}) {
  const graph = useMemo(() => computeGraph(commits), [commits]);
  const width = graphWidth(graph.laneCount);
  const [colWidths, setColWidths] = useState<ColumnWidths>({ time: 82, hash: 54, author: 96 });
  const [columnToggles, setColumnToggles] = useState({ time: true, hash: true, author: true });
  const [columnsMenu, setColumnsMenu] = useState(false);
  const showColumns = {
    time: widthMode === "full" ? columnToggles.time : widthMode === "medium",
    hash: columnToggles.hash,
    author: widthMode === "full" ? columnToggles.author : false,
  };

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

  const knownHashes = new Set(commits.map((commit) => commit.hash));
  const columnItems: MenuItem[] = [
    { key: "time", label: "时间", icon: "Clock", disabled: widthMode !== "full", onPress: () => setColumnToggles((s) => ({ ...s, time: !s.time })) },
    { key: "hash", label: "哈希", icon: "Hash", onPress: () => setColumnToggles((s) => ({ ...s, hash: !s.hash })) },
    { key: "author", label: "作者", icon: "User", disabled: widthMode !== "full", onPress: () => setColumnToggles((s) => ({ ...s, author: !s.author })) },
  ];

  return (
    <View style={{ flex: 1 }}>
      {/* Column headers with drag-to-resize handles + visibility menu */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 4,
          height: 24,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
          gap: 6,
        }}
      >
        <View style={{ width }} />
        {showColumns.time ? (
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9, width: colWidths.time }}>时间</Text>
            <ColumnResizeHandle
              theme={theme}
              width={colWidths.time}
              min={60}
              onChange={(next) => setColWidths((s) => ({ ...s, time: Math.max(60, Math.min(160, next)) }))}
            />
          </View>
        ) : null}
        {showColumns.hash ? (
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9, width: colWidths.hash }}>哈希</Text>
            <ColumnResizeHandle
              theme={theme}
              width={colWidths.hash}
              min={MIN_COL_W}
              onChange={(next) => setColWidths((s) => ({ ...s, hash: Math.max(MIN_COL_W, Math.min(120, next)) }))}
            />
          </View>
        ) : null}
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9, flex: 1 }} numberOfLines={1}>
          提交信息 / 分支
        </Text>
        {showColumns.author ? (
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9, width: colWidths.author, textAlign: "right" }}>
              作者
            </Text>
            <ColumnResizeHandle
              theme={theme}
              width={colWidths.author}
              min={MIN_COL_W}
              onChange={(next) => setColWidths((s) => ({ ...s, author: Math.max(MIN_COL_W, Math.min(200, next)) }))}
            />
          </View>
        ) : null}
        <View style={{ width: 22 }} />
        <HoverPressable
          accessibilityRole="button"
          accessibilityLabel="列显示选项"
          onPress={() => setColumnsMenu(true)}
          style={({ hovered }) => ({
            width: 20,
            height: 20,
            borderRadius: 4,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: hovered ? theme.colors.surface2 : "transparent",
          })}
        >
          <Icon name="Settings2" size={12} color={theme.colors.foregroundMuted} />
        </HoverPressable>
      </View>

      {commits.map((commit, index) => {
        const row = graph.rows[index];
        if (!row) return null;
        const selected = commit.hash === selectedHash;
        const isMerge = commit.parents.length >= 2;
        const { isHead } = buildRefBadges(commit.refs);
        const isLast = index === commits.length - 1;
        const menuItems: MenuItem[] = [
          { key: "copy", label: `复制哈希 ${commit.shortHash}`, icon: "Copy", onPress: () => void copyText(commit.hash).catch(() => undefined) },
          { key: "-", label: "", onPress: () => undefined },
          { key: "cherry", label: "Cherry-pick 到当前分支", icon: "GitCommitHorizontal", onPress: () => actions.onCherryPick(commit.hash) },
          { key: "checkout", label: "检出此提交（分离头指针）", icon: "LogIn", onPress: () => actions.onCheckoutCommit(commit.hash) },
          { key: "-", label: "", onPress: () => undefined },
          { key: "reset-soft", label: "重置到此处 · 保留改动（soft）", icon: "Undo2", onPress: () => actions.onReset(commit.hash, "soft") },
          { key: "reset-mixed", label: "重置到此处 · 保留工作区（mixed）", icon: "Undo2", onPress: () => actions.onReset(commit.hash, "mixed") },
          { key: "reset-hard", label: "重置到此处 · 丢弃改动（hard）", icon: "Trash2", danger: true, onPress: () => actions.onReset(commit.hash, "hard") },
          { key: "revert", label: "还原此提交（revert）", icon: "History", onPress: () => actions.onRevert(commit.hash) },
          { key: "-", label: "", onPress: () => undefined },
          { key: "branch", label: "在此提交新建分支…", icon: "GitBranch", onPress: () => actions.onCreateBranchHere(commit.hash) },
          { key: "tag", label: "在此提交新建标签…", icon: "Tag", onPress: () => actions.onCreateTagHere(commit.hash) },
        ];
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
              <GraphCell row={row} theme={theme} isHead={isHead} isMerge={isMerge} />
              {isLast ? <StubCell row={row} knownHashes={knownHashes} /> : null}
            </View>
            {showColumns.time ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, width: colWidths.time, fontFamily: MONO_FONT }}>
                {formatShortTime(commit.authorDate)}
              </Text>
            ) : null}
            {showColumns.hash ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, width: colWidths.hash, fontFamily: MONO_FONT }}>
                {commit.shortHash}
              </Text>
            ) : null}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flex: 1, minWidth: 0 }}>
              <RefBadges refs={commit.refs} theme={theme} />
              <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 11, flexShrink: 1 }}>
                {commit.subject}
              </Text>
            </View>
            {showColumns.author ? (
              <Text
                numberOfLines={1}
                style={{ color: theme.colors.foregroundMuted, fontSize: 10, width: colWidths.author, textAlign: "right" }}
              >
                {commit.authorName}
              </Text>
            ) : null}
            <MenuButton theme={theme} label={`提交 ${commit.shortHash} 的操作`} items={menuItems} size={13} />
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

      <ContextMenuModal
        theme={theme}
        open={columnsMenu}
        onOpenChange={setColumnsMenu}
        title="显示列"
        items={columnItems.map((item) => ({
          ...item,
          label: `${showColumns[item.key as keyof typeof showColumns] ? "✓ " : "　"}${item.label}`,
        }))}
      />
    </View>
  );
}
