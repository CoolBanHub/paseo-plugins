import { useMemo, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { hashStringColor } from "./colors";
import { basename, formatRelativeTime } from "./format";
import { Chip, HoverPressable, IconButton, MONO_FONT, SectionHeader, type PanelTheme } from "./parts";
import type { BranchesResult, StatusResult } from "../shared/types";

export function BranchPane({
  theme,
  directory,
  status,
  branches,
  scope,
  busy,
  onSelectScope,
  onCheckout,
  onFetch,
  onPull,
  onRefresh,
}: {
  theme: PanelTheme;
  directory: string;
  status: StatusResult | null;
  branches: BranchesResult | null;
  scope: string;
  busy: string | null;
  onSelectScope: (ref: string) => void;
  onCheckout: (ref: string) => void;
  onFetch: () => void;
  onPull: () => void;
  onRefresh: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [localsExpanded, setLocalsExpanded] = useState(true);
  const [remotesExpanded, setRemotesExpanded] = useState(true);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const match = (name: string) => needle.length === 0 || name.toLowerCase().includes(needle);
    return {
      locals: (branches?.locals ?? []).filter((branch) => match(branch.shortName)),
      remotes: (branches?.remotes ?? []).filter((branch) => match(branch.shortName)),
    };
  }, [branches, filter]);

  const dirtyTotal = (status?.staged ?? 0) + (status?.unstaged ?? 0) + (status?.untracked ?? 0);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View style={{ paddingHorizontal: 8, paddingTop: 8, paddingBottom: 6, gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon name="Folder" size={13} color={theme.colors.foregroundMuted} />
          <Text
            numberOfLines={1}
            style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600", flexShrink: 1 }}
          >
            {basename(status?.root ?? directory)}
          </Text>
          <View style={{ flexDirection: "row", marginLeft: "auto", gap: 2 }}>
            {busy === "fetch" ? (
              <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
            ) : (
              <IconButton icon="RefreshCw" label="获取远端更新" theme={theme} onPress={onFetch} />
            )}
            <IconButton
              icon="Download"
              label="拉取并快进"
              theme={theme}
              disabled={busy !== null}
              onPress={onPull}
            />
            <IconButton
              icon="RotateCw"
              label="刷新"
              theme={theme}
              disabled={busy !== null}
              onPress={onRefresh}
            />
          </View>
        </View>

        {status?.ok ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <Icon name="GitBranch" size={12} color={theme.colors.accent} />
            <Text
              numberOfLines={1}
              style={{
                color: theme.colors.foreground,
                fontSize: 11,
                fontFamily: MONO_FONT,
                flexShrink: 1,
              }}
            >
              {status.detached ? `(${(status.head ?? "").slice(0, 8)} 分离头指针)` : status.currentBranch}
            </Text>
            {status.ahead !== null && status.ahead > 0 ? (
              <Text style={{ color: theme.colors.statusSuccess, fontSize: 10, fontFamily: MONO_FONT }}>
                ↑{status.ahead}
              </Text>
            ) : null}
            {status.behind !== null && status.behind > 0 ? (
              <Text style={{ color: theme.colors.statusWarning, fontSize: 10, fontFamily: MONO_FONT }}>
                ↓{status.behind}
              </Text>
            ) : null}
            {dirtyTotal > 0 ? (
              <Chip
                label={`${dirtyTotal} 处改动`}
                color={theme.colors.foregroundMuted}
                theme={theme}
                fontSize={9}
              />
            ) : null}
          </View>
        ) : null}

        <TextInput
          value={filter}
          onChangeText={setFilter}
          placeholder="筛选分支…"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={{
            color: theme.colors.foreground,
            fontSize: 11,
            backgroundColor: theme.colors.surface1,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: theme.colors.border,
            paddingHorizontal: 8,
            paddingVertical: 4,
          }}
        />
      </View>

      <BranchScroll
        theme={theme}
        locals={filtered.locals}
        remotes={filtered.remotes}
        scope={scope}
        currentBranch={status?.currentBranch ?? null}
        detached={status?.detached ?? false}
        head={status?.head ?? null}
        localsExpanded={localsExpanded}
        remotesExpanded={remotesExpanded}
        onToggleLocals={() => setLocalsExpanded((value) => !value)}
        onToggleRemotes={() => setRemotesExpanded((value) => !value)}
        onSelectScope={onSelectScope}
        onCheckout={onCheckout}
      />
    </View>
  );
}

function BranchScroll({
  theme,
  locals,
  remotes,
  scope,
  currentBranch,
  detached,
  head,
  localsExpanded,
  remotesExpanded,
  onToggleLocals,
  onToggleRemotes,
  onSelectScope,
  onCheckout,
}: {
  theme: PanelTheme;
  locals: BranchesResult["locals"];
  remotes: BranchesResult["remotes"];
  scope: string;
  currentBranch: string | null;
  detached: boolean;
  head: string | null;
  localsExpanded: boolean;
  remotesExpanded: boolean;
  onToggleLocals: () => void;
  onToggleRemotes: () => void;
  onSelectScope: (ref: string) => void;
  onCheckout: (ref: string) => void;
}) {
  if (locals.length === 0 && remotes.length === 0) {
    return (
      <View style={{ padding: 12 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          没有匹配的分支
        </Text>
      </View>
    );
  }
  return (
    <ScrollView
      style={{ flex: 1, paddingHorizontal: 2 }}
      contentContainerStyle={{ paddingBottom: 8 }}
    >
      <SectionHeader
        title="本地"
        count={locals.length}
        theme={theme}
        expanded={localsExpanded}
        onToggle={onToggleLocals}
      />
      {localsExpanded
        ? locals.map((branch) => (
            <BranchRow
              key={branch.name}
              theme={theme}
              shortName={branch.shortName}
              fullName={branch.name}
              date={branch.date}
              isCurrent={branch.isCurrent}
              ahead={branch.ahead}
              behind={branch.behind}
              isScope={scope === branch.name || (branch.isCurrent && scope === "HEAD")}
              detachedHead={detached && head !== null && branch.hash === head}
              onSelect={() => onSelectScope(branch.name)}
              onCheckout={() => onCheckout(branch.shortName)}
            />
          ))
        : null}

      <View style={{ height: 4 }} />
      <SectionHeader
        title="远程"
        count={remotes.length}
        theme={theme}
        expanded={remotesExpanded}
        onToggle={onToggleRemotes}
      />
      {remotesExpanded
        ? remotes.map((branch) => (
            <BranchRow
              key={branch.name}
              theme={theme}
              shortName={branch.shortName}
              fullName={branch.name}
              date={branch.date}
              isCurrent={false}
              ahead={null}
              behind={null}
              isScope={scope === branch.name}
              detachedHead={false}
              remote
              onSelect={() => onSelectScope(branch.name)}
              onCheckout={() => onCheckout(branch.shortName)}
            />
          ))
        : null}
      <View style={{ height: 8 }} />
    </ScrollView>
  );
}

function BranchRow({
  theme,
  shortName,
  fullName,
  date,
  isCurrent,
  ahead,
  behind,
  isScope,
  detachedHead,
  remote = false,
  onSelect,
  onCheckout,
}: {
  theme: PanelTheme;
  shortName: string;
  fullName: string;
  date: string;
  isCurrent: boolean;
  ahead: number | null;
  behind: number | null;
  isScope: boolean;
  detachedHead: boolean;
  remote?: boolean;
  onSelect: () => void;
  onCheckout: () => void;
}) {
  const color = hashStringColor(fullName);
  return (
    <HoverPressable
      accessibilityRole="button"
      accessibilityLabel={`分支 ${shortName}`}
      onPress={onSelect}
      style={({ hovered, pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
        marginLeft: 6,
        backgroundColor: pressed
          ? theme.colors.surface2
          : hovered || isScope
            ? theme.colors.surface1
            : "transparent",
      })}
    >
      <View
        style={{
          width: 7,
          height: 7,
          borderRadius: 4,
          backgroundColor: color,
          flexShrink: 0,
        }}
      />
      <View style={{ flexDirection: "column", flexShrink: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={{
            color: theme.colors.foreground,
            fontSize: 11,
            fontFamily: MONO_FONT,
          }}
        >
          {shortName}
          {detachedHead ? " (HEAD)" : ""}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9 }}>
          {formatRelativeTime(date)}
        </Text>
      </View>
      {isCurrent ? (
        <Icon name="Check" size={12} color={theme.colors.accent} />
      ) : (
        <>
          {ahead !== null && ahead > 0 ? (
            <Text style={{ color: theme.colors.statusSuccess, fontSize: 9, fontFamily: MONO_FONT }}>
              ↑{ahead}
            </Text>
          ) : null}
          {behind !== null && behind > 0 ? (
            <Text style={{ color: theme.colors.statusWarning, fontSize: 9, fontFamily: MONO_FONT }}>
              ↓{behind}
            </Text>
          ) : null}
          <IconButton icon="LogIn" label={`检出 ${shortName}`} theme={theme} size={13} onPress={onCheckout} />
        </>
      )}
    </HoverPressable>
  );
}
