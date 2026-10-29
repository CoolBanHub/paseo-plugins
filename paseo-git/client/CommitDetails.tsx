import { useMemo, useRef, useState } from "react";
import { ActivityIndicator, PanResponder, Text, View } from "react-native";
import { Icon, copyText, ScrollView } from "@getpaseo/plugin/client/react-native";
import { mixWithBackground, statusColorOf } from "./colors";
import { DiffView, type DiffRequest } from "./DiffView";
import { formatFullTime, formatRelativeTime } from "./format";
import { buildDirTree, type TreeDir } from "./filetree";
import { HoverPressable, MONO_FONT, StatText, type PanelTheme } from "./parts";
import type { CommitDetail, CommitFile } from "../shared/types";

function ScrollViewFlex({ children }: { children: React.ReactNode }) {
  return <ScrollView style={{ flex: 1 }}>{children}</ScrollView>;
}

export function CommitDetails({
  theme,
  detail,
  loading,
  onClose,
  repoPath,
  heightPct = 42,
  panelHeight = 0,
  onHeightPct,
}: {
  theme: PanelTheme;
  detail: CommitDetail | null;
  loading: boolean;
  onClose: () => void;
  repoPath: string | null;
  /** Share of the panel height; drag the top edge to change it. */
  heightPct?: number;
  panelHeight?: number;
  onHeightPct?: (pct: number) => void;
}) {
  const [diffRequest, setDiffRequest] = useState<DiffRequest | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);

  // Drag handle on the top edge: dragging up grows the details pane.
  const pctRef = useRef(heightPct);
  pctRef.current = heightPct;
  const dragStartRef = useRef({ pct: heightPct, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [pan] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (_event, gesture) => {
        dragStartRef.current = { pct: pctRef.current, y: gesture.y0 };
        setDragging(true);
      },
      onPanResponderMove: (_event, gesture) => {
        if (!onHeightPct || panelHeight <= 0) return;
        // Moving up (negative dy) increases the pane share.
        const startPx = (dragStartRef.current.pct / 100) * panelHeight;
        const pct = ((startPx - (dragStartRef.current.y + gesture.dy)) / panelHeight) * 100;
        onHeightPct(Math.max(22, Math.min(72, pct)));
      },
      onPanResponderRelease: () => setDragging(false),
      onPanResponderTerminate: () => setDragging(false),
    }),
  );

  return (
    <View
      style={{
        height: `${heightPct}%`,
        minHeight: 130,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
      }}
    >
      {onHeightPct ? (
        <View {...pan.panHandlers} style={{ height: 7, justifyContent: "center", alignItems: "center" }}>
          <View
            style={{
              width: 36,
              height: 3,
              borderRadius: 2,
              backgroundColor: dragging ? theme.colors.accent : theme.colors.border,
            }}
          />
        </View>
      ) : null}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        }}
      >
        <Icon name="FileText" size={13} color={theme.colors.foregroundMuted} />
        <Text
          numberOfLines={1}
          style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600", flex: 1 }}
        >
          {detail?.subject ?? (loading ? "加载提交详情…" : "提交详情")}
        </Text>
        {detail ? (
          <HoverPressable
            accessibilityRole="button"
            accessibilityLabel="复制完整哈希"
            onPress={() => {
              void copyText(detail.hash).catch(() => undefined);
            }}
            style={({ hovered }) => ({
              paddingHorizontal: 6,
              paddingVertical: 2,
              borderRadius: 4,
              backgroundColor: hovered ? theme.colors.surface2 : "transparent",
            })}
          >
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontFamily: MONO_FONT }}>
              {detail.shortHash} ⧉
            </Text>
          </HoverPressable>
        ) : null}
        <HoverPressable
          accessibilityRole="button"
          accessibilityLabel="关闭详情"
          onPress={onClose}
          style={({ hovered }) => ({
            width: 22,
            height: 22,
            borderRadius: 4,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: hovered ? theme.colors.surface2 : "transparent",
          })}
        >
          <Icon name="X" size={13} color={theme.colors.foregroundMuted} />
        </HoverPressable>
      </View>

      {loading && !detail ? (
        <View style={{ padding: 16, alignItems: "center" }}>
          <ActivityIndicator color={theme.colors.foregroundMuted} />
        </View>
      ) : null}

      {detail ? (
        <DetailBody
          theme={theme}
          detail={detail}
          onOpenDiff={(path) => {
            setDiffRequest({ mode: "commit", ref: detail.hash, path });
            setDiffOpen(true);
          }}
        />
      ) : !loading ? (
        <View style={{ padding: 14 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            点击上方任意提交查看详情：作者、时间、改动文件与增删行数。
          </Text>
        </View>
      ) : null}

      <DiffView theme={theme} open={diffOpen} onOpenChange={setDiffOpen} request={diffRequest} repoPath={repoPath} />
    </View>
  );
}

function DetailBody({
  theme,
  detail,
  onOpenDiff,
}: {
  theme: PanelTheme;
  detail: CommitDetail;
  onOpenDiff: (path: string) => void;
}) {
  const files = detail.files;
  const tree = useMemo(
    () => buildDirTree(files.map((file) => ({ path: file.path, value: file }))),
    [files],
  );

  const renderFile = (file: CommitFile, depth: number) => (
    <HoverPressable
      key={`${file.status}-${file.path}`}
      accessibilityRole="button"
      accessibilityLabel={`查看 ${file.path} 的差异`}
      onPress={() => onOpenDiff(file.path)}
      style={({ hovered }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingVertical: 2,
        paddingHorizontal: 4,
        marginLeft: depth * 12,
        borderRadius: 4,
        backgroundColor: hovered ? theme.colors.surface1 : "transparent",
      })}
    >
      <View
        style={{
          width: 14,
          height: 14,
          borderRadius: 3,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: statusColorOf(file.status),
        }}
      >
        <Text style={{ color: theme.colors.surface0, fontSize: 9, fontWeight: "700" }}>{file.status}</Text>
      </View>
      <Text
        numberOfLines={1}
        ellipsizeMode="middle"
        selectable
        style={{ color: theme.colors.foreground, fontSize: 10.5, fontFamily: MONO_FONT, flex: 1 }}
      >
        {file.path}
        {file.oldPath ? `  ← ${file.oldPath}` : ""}
      </Text>
      {file.binary ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9 }}>二进制</Text>
      ) : (
        <View style={{ flexDirection: "row", gap: 4 }}>
          <StatText value={file.additions ?? 0} kind="add" theme={theme} />
          <StatText value={file.deletions ?? 0} kind="del" theme={theme} />
        </View>
      )}
    </HoverPressable>
  );

  const renderDir = (dir: TreeDir<CommitFile>, depth: number): React.ReactNode => (
    <View key={dir.path}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 2, marginLeft: depth * 12, paddingHorizontal: 4 }}>
        <Icon name="Folder" size={11} color={theme.colors.foregroundMuted} />
        <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontFamily: MONO_FONT, flexShrink: 1 }}>
          {dir.name}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9, opacity: 0.7 }}>
          {dir.files.length + dir.dirs.length}
        </Text>
      </View>
      {dir.files.map((file) => renderFile(file.value, depth + 1))}
      {dir.dirs.map((child) => renderDir(child, depth + 1))}
    </View>
  );

  return (
    <ScrollViewFlex>
      <View style={{ padding: 10, gap: 8 }}>
        {/* Compact identity block: hash + parents on one line, author and
            dates on the next; saves three rows versus the label/value list. */}
        <View style={{ gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <View
              style={{
                borderRadius: 4,
                backgroundColor: mixWithBackground(theme.colors.accent, theme.colors.surface0, 0.82),
                paddingHorizontal: 5,
                paddingVertical: 1,
              }}
            >
              <Text style={{ color: theme.colors.accent, fontSize: 10, fontFamily: MONO_FONT, fontWeight: "700" }}>
                {detail.shortHash}
              </Text>
            </View>
            <Text
              selectable
              numberOfLines={1}
              style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontFamily: MONO_FONT, flexShrink: 1 }}
            >
              {detail.hash}
            </Text>
            <HoverPressable
              accessibilityRole="button"
              accessibilityLabel="复制完整哈希"
              onPress={() => {
                void copyText(detail.hash).catch(() => undefined);
              }}
              style={({ hovered }) => ({
                paddingHorizontal: 4,
                paddingVertical: 1,
                borderRadius: 4,
                backgroundColor: hovered ? theme.colors.surface2 : "transparent",
              })}
            >
              <Icon name="Copy" size={11} color={theme.colors.foregroundMuted} />
            </HoverPressable>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontFamily: MONO_FONT }}>
              父 {detail.parents.length > 0 ? detail.parents.map((parent) => parent.slice(0, 8)).join(" ") : "（根提交）"}
            </Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 10.5, flexShrink: 1 }}>
              {detail.authorName}
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}> &lt;{detail.authorEmail}&gt;</Text>
            </Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontFamily: MONO_FONT }}>
              {formatFullTime(detail.authorDate)}（{formatRelativeTime(detail.authorDate)}）
            </Text>
            {detail.committerDate !== detail.authorDate ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontFamily: MONO_FONT }}>
                提交于 {formatFullTime(detail.committerDate)}
              </Text>
            ) : null}
          </View>
        </View>

        {detail.body.length > 0 ? (
          <View
            style={{
              backgroundColor: theme.colors.surface1,
              borderRadius: 6,
              padding: 8,
              borderWidth: 1,
              borderColor: theme.colors.border,
            }}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 11, lineHeight: 16 }}>{detail.body}</Text>
          </View>
        ) : null}

        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "600" }}>
            改动文件 {files.length}
          </Text>
          <StatText value={detail.totalAdditions} kind="add" theme={theme} />
          <StatText value={detail.totalDeletions} kind="del" theme={theme} />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9.5, marginLeft: "auto" }}>点击文件查看差异</Text>
        </View>

        <View style={{ gap: 2 }}>
          {tree.rootFiles.map((file) => renderFile(file.value, 0))}
          {tree.dirs.map((dir) => renderDir(dir, 0))}
        </View>
      </View>
    </ScrollViewFlex>
  );
}
