import { ActivityIndicator, Text, View } from "react-native";
import { Icon, copyText, ScrollView } from "@getpaseo/plugin/client/react-native";
import { formatFullTime, formatRelativeTime } from "./format";
import { HoverPressable, MetaRow, MONO_FONT, StatText, type PanelTheme } from "./parts";
import type { CommitDetail } from "../shared/types";

function ScrollViewFlex({ children }: { children: React.ReactNode }) {
  return <ScrollView style={{ flex: 1 }}>{children}</ScrollView>;
}

const STATUS_COLORS: Record<string, "success" | "danger" | "warning" | "accent"> = {
  A: "success",
  M: "warning",
  D: "danger",
  R: "accent",
  C: "accent",
  T: "warning",
  U: "danger",
};

function statusColor(status: string, theme: PanelTheme): string {
  const kind = STATUS_COLORS[status] ?? "warning";
  if (kind === "success") return theme.colors.statusSuccess;
  if (kind === "danger") return theme.colors.statusDanger;
  if (kind === "accent") return theme.colors.accent;
  return theme.colors.statusWarning;
}

export function CommitDetails({
  theme,
  detail,
  loading,
  onClose,
}: {
  theme: PanelTheme;
  detail: CommitDetail | null;
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <View
      style={{
        height: "42%",
        minHeight: 140,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
      }}
    >
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
        <DetailBody theme={theme} detail={detail} />
      ) : !loading ? (
        <View style={{ padding: 14 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            点击上方任意提交查看详情：作者、时间、改动文件与增删行数。
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function DetailBody({ theme, detail }: { theme: PanelTheme; detail: CommitDetail }) {
  const files = detail.files;
  return (
    <ScrollViewFlex>
      <View style={{ padding: 10, gap: 8 }}>
        <View style={{ gap: 4 }}>
          <MetaRow label="哈希" theme={theme}>
            <Text selectable style={{ color: theme.colors.foreground, fontSize: 11, fontFamily: MONO_FONT }}>
              {detail.hash}
            </Text>
          </MetaRow>
          <MetaRow label="父提交" theme={theme}>
            <Text style={{ color: theme.colors.foreground, fontSize: 11, fontFamily: MONO_FONT }}>
              {detail.parents.length > 0 ? detail.parents.map((parent) => parent.slice(0, 9)).join("  ") : "（根提交）"}
            </Text>
          </MetaRow>
          <MetaRow label="作者" theme={theme}>
            <Text style={{ color: theme.colors.foreground, fontSize: 11 }}>
              {detail.authorName}{" "}
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>&lt;{detail.authorEmail}&gt;</Text>
            </Text>
          </MetaRow>
          <MetaRow label="作者时间" theme={theme}>
            <Text style={{ color: theme.colors.foreground, fontSize: 11, fontFamily: MONO_FONT }}>
              {formatFullTime(detail.authorDate)}
              <Text style={{ color: theme.colors.foregroundMuted }}>（{formatRelativeTime(detail.authorDate)}）</Text>
            </Text>
          </MetaRow>
          <MetaRow label="提交时间" theme={theme}>
            <Text style={{ color: theme.colors.foreground, fontSize: 11, fontFamily: MONO_FONT }}>
              {formatFullTime(detail.committerDate)}
            </Text>
          </MetaRow>
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
            <Text style={{ color: theme.colors.foreground, fontSize: 11, lineHeight: 16 }}>
              {detail.body}
            </Text>
          </View>
        ) : null}

        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "600" }}>
            改动文件 {files.length}
          </Text>
          <StatText value={detail.totalAdditions} kind="add" theme={theme} />
          <StatText value={detail.totalDeletions} kind="del" theme={theme} />
        </View>

        <View style={{ gap: 2 }}>
          {files.map((file) => (
            <View
              key={`${file.status}-${file.path}`}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingVertical: 2,
                paddingHorizontal: 4,
                borderRadius: 4,
              }}
            >
              <View
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: statusColor(file.status, theme),
                }}
              >
                <Text style={{ color: theme.colors.surface0, fontSize: 9, fontWeight: "700" }}>
                  {file.status}
                </Text>
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
            </View>
          ))}
        </View>
      </View>
    </ScrollViewFlex>
  );
}
