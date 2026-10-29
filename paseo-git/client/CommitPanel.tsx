import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { Icon, ScrollView, TextInput, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { mixWithBackground, statusColorOf } from "./colors";
import { ContextMenuModal, MenuButton, type MenuItem } from "./ContextMenu";
import { DiffView, type DiffRequest } from "./DiffView";
import { ConfirmDialog } from "./dialogs";
import { basename, dirname, formatRelativeTime } from "./format";
import { buildDirTree, collectAllPaths, type TreeDir } from "./filetree";
import { HoverPressable, IconButton, MONO_FONT, type PanelTheme } from "./parts";
import {
  gitChangesRpc,
  gitCommitCreateRpc,
  gitConflictResolveRpc,
  gitRecentMessagesRpc,
  gitRollbackFileRpc,
  gitStashApplyRpc,
  gitStashDropRpc,
  gitStashListRpc,
  gitStashPushRpc,
  gitStageRpc,
  gitUnstageRpc,
} from "../shared/contracts";
import type { ChangeEntry, ChangesResult, StashEntry, StashListResult } from "../shared/types";

/**
 * The working-tree tab (IDEA's Commit panel): grouped & checked files on the
 * left, the message area with amend/recent/commit actions on the right, plus
 * a stash sub-tab. File rows carry the ⋯ menu that replaces JGC's context
 * menus; conflicts get inline ours/theirs resolution.
 */

const entryKey = (entry: ChangeEntry): string => `${entry.staged ? "s" : "w"}:${entry.path}`;

function statusLetter(entry: ChangeEntry): string {
  if (entry.untracked) return "U";
  if (entry.conflict) return "C";
  if (entry.status.startsWith("R")) return "R";
  return entry.status[0] ?? "M";
}

interface ChangeGroups {
  conflicts: ChangeEntry[];
  staged: ChangeEntry[];
  unstaged: ChangeEntry[];
  untracked: ChangeEntry[];
}

function groupChanges(entries: readonly ChangeEntry[]): ChangeGroups {
  const groups: ChangeGroups = { conflicts: [], staged: [], unstaged: [], untracked: [] };
  for (const entry of entries) {
    if (entry.conflict) groups.conflicts.push(entry);
    else if (entry.untracked) groups.untracked.push(entry);
    else if (entry.staged) groups.staged.push(entry);
    else groups.unstaged.push(entry);
  }
  return groups;
}

export function CommitPanel({
  theme,
  repoPath,
  compact,
  refreshKey,
  onMutated,
  onCommitAndPush,
}: {
  theme: PanelTheme;
  repoPath: string | null;
  compact: boolean;
  /** Bumped by the parent whenever the repo state may have moved. */
  refreshKey: number;
  /** Notify the parent to refresh status/log/sequence state. */
  onMutated: () => void;
  onCommitAndPush: () => void;
}) {
  const toast = useToast();
  const changesRpc = useRpc(gitChangesRpc);
  const stageRpc = useRpc(gitStageRpc);
  const unstageRpc = useRpc(gitUnstageRpc);
  const commitRpc = useRpc(gitCommitCreateRpc);
  const recentRpc = useRpc(gitRecentMessagesRpc);
  const stashListRpc = useRpc(gitStashListRpc);
  const stashPushRpc = useRpc(gitStashPushRpc);
  const stashApplyRpc = useRpc(gitStashApplyRpc);
  const stashDropRpc = useRpc(gitStashDropRpc);
  const rollbackRpc = useRpc(gitRollbackFileRpc);
  const resolveRpc = useRpc(gitConflictResolveRpc);

  const [changes, setChanges] = useState<ChangesResult | null>(null);
  const [stashes, setStashes] = useState<StashListResult | null>(null);
  const [recentMessages, setRecentMessages] = useState<string[]>([]);
  const [subTab, setSubTab] = useState<"changes" | "stash">("changes");
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const knownKeysRef = useRef<Set<string>>(new Set());
  const [groupByDir, setGroupByDir] = useState(true);
  const [showUntracked, setShowUntracked] = useState(true);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const [expandedStashes, setExpandedStashes] = useState<Set<number>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);

  const [diffRequest, setDiffRequest] = useState<DiffRequest | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<ChangeEntry | null>(null);
  const [stashConfirm, setStashConfirm] = useState<null | { kind: "drop"; stash: StashEntry }>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (!repoPath) return;
      if (!quiet) setLoading(true);
      try {
        const [nextChanges, nextStashes] = await Promise.all([
          changesRpc({ repoPath }),
          stashListRpc({ repoPath }),
        ]);
        setChanges(nextChanges);
        setStashes(nextStashes);
        if (!nextChanges.ok && !quiet) {
          toast.error(nextChanges.error?.split("\n")[0] ?? "读取改动失败");
        }
      } catch (err) {
        if (!quiet) toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repoPath],
  );

  useEffect(() => {
    void load();
    if (repoPath) {
      recentRpc({ repoPath })
        .then((result) => setRecentMessages(result.ok ? result.messages : []))
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath, refreshKey]);

  // Keep the checked set in sync: new entries default to checked, gone ones drop.
  useEffect(() => {
    if (!changes?.ok) return;
    const keys = new Set(changes.entries.map(entryKey));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const key of [...next]) {
        if (!keys.has(key)) next.delete(key);
      }
      for (const key of keys) {
        if (!knownKeysRef.current.has(key)) next.add(key);
      }
      knownKeysRef.current = keys;
      return next;
    });
  }, [changes]);

  const groups = useMemo(
    () => groupChanges(changes?.ok ? changes.entries : []),
    [changes],
  );

  const runAction = useCallback(
    async (busyKey: string, fallbackError: string, invoke: () => Promise<{ ok: boolean; error: string | null; message: string | null }>) => {
      if (!repoPath) return;
      setBusy(busyKey);
      try {
        const result = await invoke();
        if (result.ok) {
          if (result.message) toast.show(result.message, { variant: "success" });
          await load(true);
          onMutated();
        } else {
          toast.error(result.error ?? fallbackError);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repoPath, load, onMutated, toast],
  );

  const checkedPaths = useMemo(() => {
    if (!changes?.ok) return [];
    const paths = new Set<string>();
    for (const entry of changes.entries) {
      if (selected.has(entryKey(entry))) paths.add(entry.path);
    }
    return [...paths];
  }, [changes, selected]);

  const stage = (paths: string[], all = false) =>
    runAction("stage", "暂存失败", () => stageRpc({ repoPath: repoPath ?? "", paths, all }));
  const unstage = (paths: string[], all = false) =>
    runAction("unstage", "取消暂存失败", () => unstageRpc({ repoPath: repoPath ?? "", paths, all }));

  const rollback = (entry: ChangeEntry) =>
    runAction("rollback", "回滚失败", () => rollbackRpc({ repoPath: repoPath ?? "", path: entry.path }));

  const resolveConflict = (entry: ChangeEntry, take: "ours" | "theirs") =>
    runAction("resolve", "解决冲突失败", () =>
      resolveRpc({ repoPath: repoPath ?? "", path: entry.path, take }),
    );

  const doCommit = useCallback(
    async (andPush: boolean) => {
      if (!repoPath) return;
      const note = message.trim() || (amend ? (recentMessages[0] ?? "") : "");
      if (note.length === 0) {
        toast.error("请填写提交信息");
        return;
      }
      setBusy("commit");
      try {
        const result = await commitRpc({ repoPath, message: note, paths: checkedPaths, amend });
        if (result.ok) {
          toast.show(result.message ?? "已创建提交", { variant: "success" });
          setMessage("");
          setAmend(false);
          await load(true);
          onMutated();
          if (andPush) onCommitAndPush();
        } else {
          toast.error(result.error ?? "提交失败");
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [amend, checkedPaths, load, message, onCommitAndPush, onMutated, recentMessages, repoPath, toast],
  );

  const stashChecked = () =>
    runAction("stash", "贮藏失败", () =>
      stashPushRpc({ repoPath: repoPath ?? "", message: "", paths: checkedPaths }),
    );

  const stashAll = () =>
    runAction("stash", "贮藏失败", () => stashPushRpc({ repoPath: repoPath ?? "", message: "", paths: [] }));

  const openDiff = (entry: ChangeEntry) => {
    const mode: DiffRequest["mode"] =
      entry.conflict || entry.untracked ? "head" : entry.staged ? "staged" : "worktree";
    setDiffRequest({ mode, ref: "", path: entry.path });
    setDiffOpen(true);
  };

  const fileMenu = (entry: ChangeEntry): MenuItem[] => {
    const items: MenuItem[] = [
      { key: "diff", label: "查看差异", icon: "FileDiff", onPress: () => openDiff(entry) },
      { key: "-", label: "", onPress: () => undefined },
    ];
    if (entry.conflict) {
      items.push(
        { key: "ours", label: "采用本方（ours）", icon: "ShieldCheck", onPress: () => resolveConflict(entry, "ours") },
        { key: "theirs", label: "采用对方（theirs）", icon: "Shield", onPress: () => resolveConflict(entry, "theirs") },
      );
    } else if (entry.staged) {
      items.push({ key: "unstage", label: "取消暂存", icon: "CircleDashed", onPress: () => unstage([entry.path]) });
    } else {
      items.push({ key: "stage", label: "暂存", icon: "CirclePlus", onPress: () => stage([entry.path]) });
    }
    items.push(
      { key: "-", label: "", onPress: () => undefined },
      { key: "rollback", label: entry.untracked ? "删除文件…" : "回滚改动…", icon: "Undo2", danger: true, onPress: () => setRollbackTarget(entry) },
      { key: "copy", label: "复制路径", icon: "Copy", onPress: () => void copyText(entry.path).catch(() => undefined) },
    );
    return items;
  };

  const stashMenu = (stash: StashEntry): MenuItem[] => [
    { key: "apply", label: `恢复 ${stash.label}（保留贮藏）`, icon: "PackageOpen", onPress: () => applyStash(stash.index, false) },
    { key: "pop", label: `恢复 ${stash.label} 并删除`, icon: "PackageCheck", onPress: () => applyStash(stash.index, true) },
    { key: "-", label: "", onPress: () => undefined },
    { key: "drop", label: `删除 ${stash.label}…`, icon: "Trash2", danger: true, onPress: () => setStashConfirm({ kind: "drop", stash }) },
  ];

  const applyStash = (index: number, drop: boolean) =>
    runAction("stash-apply", "恢复贮藏失败", () => stashApplyRpc({ repoPath: repoPath ?? "", index, drop }));

  const toggleSelect = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectMany = (entries: readonly ChangeEntry[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const entry of entries) {
        const key = entryKey(entry);
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  const toggleDir = (path: string) => {
    setCollapsedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleStash = (index: number) => {
    setExpandedStashes((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const toggleGroup = (key: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const visibleGroups: { key: string; title: string; entries: ChangeEntry[] }[] = [];
  if (groups.conflicts.length > 0) visibleGroups.push({ key: "conflicts", title: "合并冲突", entries: groups.conflicts });
  if (groups.staged.length > 0) visibleGroups.push({ key: "staged", title: "已暂存", entries: groups.staged });
  if (groups.unstaged.length > 0) visibleGroups.push({ key: "unstaged", title: "未暂存改动", entries: groups.unstaged });
  if (showUntracked && groups.untracked.length > 0) visibleGroups.push({ key: "untracked", title: "未跟踪文件", entries: groups.untracked });

  const nothingToShow = visibleGroups.length === 0 && !loading;

  return (
    <View style={{ flex: 1, flexDirection: compact ? "column" : "row", backgroundColor: theme.colors.surface0, minWidth: 0 }}>
      {/* File list */}
      <View style={{ flex: compact ? 1 : 2, minWidth: 0, borderRightWidth: compact ? 0 : 1, borderRightColor: theme.colors.border, borderBottomWidth: compact ? 1 : 0, borderBottomColor: theme.colors.border }}>
        {/* Sub-tab + toolbar — wraps instead of overflowing on narrow panels */}
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            columnGap: 4,
            rowGap: 2,
            paddingHorizontal: 6,
            paddingVertical: 3,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.border,
          }}
        >
          <SubTab theme={theme} label="改动" active={subTab === "changes"} onPress={() => setSubTab("changes")} />
          <SubTab theme={theme} label={`贮藏${stashes?.ok && stashes.stashes.length > 0 ? ` ${stashes.stashes.length}` : ""}`} active={subTab === "stash"} onPress={() => setSubTab("stash")} />
          <View style={{ marginLeft: "auto", flexDirection: "row", gap: 0 }}>
            {subTab === "changes" ? (
              <>
                <IconButton icon="ListTree" label="按目录分组" theme={theme} size={13} active={groupByDir} onPress={() => setGroupByDir((v) => !v)} />
                <IconButton icon="Eye" label="显示未跟踪文件" theme={theme} size={13} active={showUntracked} onPress={() => setShowUntracked((v) => !v)} />
                <IconButton icon="CirclePlus" label="全部暂存" theme={theme} size={13} disabled={busy !== null} onPress={() => stage([], true)} />
                <IconButton icon="CircleDashed" label="全部取消暂存" theme={theme} size={13} disabled={busy !== null} onPress={() => unstage([], true)} />
              </>
            ) : (
              <>
                <IconButton icon="Package" label="贮藏勾选文件" theme={theme} size={13} disabled={busy !== null || checkedPaths.length === 0} onPress={stashChecked} />
                <IconButton icon="PackageOpen" label="贮藏全部改动" theme={theme} size={13} disabled={busy !== null} onPress={stashAll} />
              </>
            )}
            <IconButton icon="RotateCw" label="刷新" theme={theme} size={13} disabled={busy !== null} onPress={() => void load()} />
            {busy !== null ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
          </View>
        </View>

        {subTab === "changes" ? (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 10 }}>
            {loading && changes === null ? (
              <View style={{ padding: 16, alignItems: "center" }}>
                <ActivityIndicator color={theme.colors.foregroundMuted} />
              </View>
            ) : null}
            {nothingToShow ? (
              <View style={{ padding: 18, alignItems: "center", gap: 6 }}>
                <Icon name="CheckCircle2" size={18} color={theme.colors.statusSuccess} />
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>工作区干净，没有待提交的改动</Text>
              </View>
            ) : null}
            {visibleGroups.map((group) => {
              const collapsed = collapsedGroups.has(group.key);
              const checkedCount = group.entries.filter((entry) => selected.has(entryKey(entry))).length;
              return (
                <View key={group.key}>
                  <GroupHeader
                    theme={theme}
                    title={group.title}
                    count={group.entries.length}
                    checked={checkedCount}
                    onToggle={() => toggleGroup(group.key)}
                    onSelectAll={() => selectMany(group.entries, checkedCount < group.entries.length)}
                    action={
                      group.key === "staged" ? (
                        <IconButton icon="CircleDashed" label="取消整组暂存" theme={theme} size={12} disabled={busy !== null} onPress={() => unstage(group.entries.map((entry) => entry.path))} />
                      ) : group.key !== "conflicts" ? (
                        <IconButton icon="CirclePlus" label="暂存整组" theme={theme} size={12} disabled={busy !== null} onPress={() => stage(group.entries.map((entry) => entry.path))} />
                      ) : undefined
                    }
                  />
                  {!collapsed ? (
                    <ChangeGroupBody
                      theme={theme}
                      group={group}
                      selected={selected}
                      groupByDir={groupByDir}
                      collapsedDirs={collapsedDirs}
                      onToggleDir={toggleDir}
                      onToggle={toggleSelect}
                      onOpenDiff={openDiff}
                      menuFor={fileMenu}
                    />
                  ) : null}
                </View>
              );
            })}
          </ScrollView>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 10 }}>
            {stashes?.ok && stashes.stashes.length === 0 ? (
              <View style={{ padding: 18, alignItems: "center", gap: 6 }}>
                <Icon name="PackageOpen" size={18} color={theme.colors.foregroundMuted} />
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>没有贮藏条目</Text>
              </View>
            ) : null}
            {stashes?.ok
              ? stashes.stashes.map((stash) => {
                  const expanded = expandedStashes.has(stash.index);
                  return (
                    <View key={stash.label} style={{ marginHorizontal: 6, marginTop: 6, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border, overflow: "hidden" }}>
                      <HoverPressable
                        accessibilityRole="button"
                        accessibilityLabel={`贮藏 ${stash.subject}`}
                        onPress={() => toggleStash(stash.index)}
                        style={({ hovered }) => ({
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 6,
                          paddingHorizontal: 8,
                          paddingVertical: 6,
                          backgroundColor: hovered ? theme.colors.surface1 : theme.colors.surface0,
                        })}
                      >
                        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={12} color={theme.colors.foregroundMuted} />
                        <Icon name="Package" size={12} color={theme.colors.accent} />
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 11 }}>
                            {stash.subject}
                          </Text>
                          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9 }}>
                            {stash.label} · {formatRelativeTime(stash.date)} · {stash.files.length} 个文件
                          </Text>
                        </View>
                        <MenuButton theme={theme} label={`贮藏 ${stash.label} 的操作`} items={stashMenu(stash)} size={12} />
                      </HoverPressable>
                      {expanded ? (
                        <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, paddingVertical: 2 }}>
                          {stash.files.map((file) => (
                            <View key={file.path} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 3 }}>
                              <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: statusColorOf(file.status), alignItems: "center", justifyContent: "center" }}>
                                <Text style={{ color: theme.colors.surface0, fontSize: 8, fontWeight: "700" }}>{file.status}</Text>
                              </View>
                              <Text numberOfLines={1} ellipsizeMode="middle" style={{ color: theme.colors.foreground, fontSize: 10.5, fontFamily: MONO_FONT, flex: 1 }}>
                                {file.path}
                              </Text>
                            </View>
                          ))}
                        </View>
                      ) : null}
                    </View>
                  );
                })
              : null}
          </ScrollView>
        )}
      </View>

      {/* Message area: side column when wide, compact footer when stacked. */}
      <View
        style={{
          flex: compact ? 0 : 1,
          flexShrink: compact ? 0 : undefined,
          minWidth: compact ? undefined : 260,
          maxWidth: compact ? undefined : 340,
          padding: 8,
          gap: compact ? 6 : 8,
          justifyContent: "flex-start",
          backgroundColor: compact ? theme.colors.surface1 : "transparent",
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <HoverPressable
            accessibilityRole="button"
            accessibilityLabel="修正上一提交（amend）"
            onPress={() => {
              setAmend((value) => {
                if (!value && message.trim().length === 0 && recentMessages[0]) {
                  setMessage(recentMessages[0]);
                }
                return !value;
              });
            }}
            style={({ hovered }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 5,
              paddingHorizontal: 6,
              paddingVertical: 3,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: amend ? theme.colors.accent : theme.colors.border,
              backgroundColor: amend ? mixWithBackground(theme.colors.accent, theme.colors.surface0, 0.85) : hovered ? theme.colors.surface1 : "transparent",
            })}
          >
            <View
              style={{
                width: 12,
                height: 12,
                borderRadius: 3,
                borderWidth: 1,
                borderColor: amend ? theme.colors.accent : theme.colors.border,
                backgroundColor: amend ? theme.colors.accent : "transparent",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {amend ? <Icon name="Check" size={8} color={theme.colors.accentForeground} /> : null}
            </View>
            <Text style={{ color: theme.colors.foreground, fontSize: 10.5 }}>修正上一提交</Text>
          </HoverPressable>
          <HoverPressable
            accessibilityRole="button"
            accessibilityLabel="最近提交信息"
            onPress={() => setRecentOpen(true)}
            style={({ hovered }) => ({
              paddingHorizontal: 6,
              paddingVertical: 3,
              borderRadius: 6,
              backgroundColor: hovered ? theme.colors.surface1 : "transparent",
            })}
          >
            <Icon name="History" size={13} color={theme.colors.foregroundMuted} />
          </HoverPressable>
          <Text style={{ marginLeft: "auto", color: theme.colors.foregroundMuted, fontSize: 9.5 }}>
            勾选 {checkedPaths.length} 个文件
          </Text>
        </View>

        <TextInput
          value={message}
          onChangeText={setMessage}
          placeholder="提交信息…"
          placeholderTextColor={theme.colors.foregroundMuted}
          multiline
          style={{
            color: theme.colors.foreground,
            fontSize: 11.5,
            fontFamily: MONO_FONT,
            backgroundColor: theme.colors.surface1,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: theme.colors.border,
            paddingHorizontal: 8,
            paddingVertical: 6,
            minHeight: compact ? 56 : 96,
            maxHeight: compact ? 120 : undefined,
            textAlignVertical: "top",
            flex: compact ? 0 : undefined,
          }}
        />

        <View style={{ flexDirection: "row", gap: 8 }}>
          <CommitButton
            theme={theme}
            label={amend ? "修正提交" : "提交"}
            icon="Check"
            disabled={busy !== null}
            onPress={() => void doCommit(false)}
          />
          <CommitButton
            theme={theme}
            label="提交并推送"
            icon="CloudUpload"
            ghost
            disabled={busy !== null}
            onPress={() => void doCommit(true)}
          />
        </View>
      </View>

      <DiffView theme={theme} open={diffOpen} onOpenChange={setDiffOpen} repoPath={repoPath} request={diffRequest} />

      <ContextMenuModal
        theme={theme}
        open={recentOpen}
        onOpenChange={setRecentOpen}
        title="最近提交信息"
        items={recentMessages.slice(0, 10).map((text, index) => ({
          key: `msg-${index}`,
          label: text,
          icon: "MessageSquareText",
          onPress: () => setMessage(text),
        }))}
      />

      <ConfirmDialog
        theme={theme}
        open={rollbackTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRollbackTarget(null);
        }}
        title={rollbackTarget?.untracked ? "删除文件" : "回滚改动"}
        message={
          rollbackTarget?.untracked
            ? `确定删除未跟踪文件 ${rollbackTarget.path} 吗？文件将从磁盘移除，不可恢复。`
            : `确定回滚 ${rollbackTarget?.path ?? ""} 吗？该文件的未提交改动将丢失。`
        }
        detail={rollbackTarget?.path}
        mono
        confirmLabel={rollbackTarget?.untracked ? "删除" : "回滚"}
        danger
        onConfirm={() => {
          if (rollbackTarget) rollback(rollbackTarget);
        }}
      />

      <ConfirmDialog
        theme={theme}
        open={stashConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setStashConfirm(null);
        }}
        title="删除贮藏"
        message={`确定删除 ${stashConfirm?.stash.label ?? ""} 吗？`}
        detail={stashConfirm?.stash.subject}
        confirmLabel="删除"
        danger
        onConfirm={() => {
          if (stashConfirm) {
            runAction("stash-drop", "删除贮藏失败", () => stashDropRpc({ repoPath: repoPath ?? "", index: stashConfirm.stash.index }));
          }
        }}
      />
    </View>
  );
}

function SubTab({ theme, label, active, onPress }: { theme: PanelTheme; label: string; active: boolean; onPress: () => void }) {
  return (
    <HoverPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ hovered }) => ({
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
        backgroundColor: active ? theme.colors.surface2 : hovered ? theme.colors.surface1 : "transparent",
      })}
    >
      <Text style={{ color: active ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 11, fontWeight: active ? "600" : "400" }}>
        {label}
      </Text>
    </HoverPressable>
  );
}

function GroupHeader({
  theme,
  title,
  count,
  checked,
  onToggle,
  onSelectAll,
  action,
}: {
  theme: PanelTheme;
  title: string;
  count: number;
  checked: number;
  onToggle: () => void;
  onSelectAll: () => void;
  action?: React.ReactNode;
}) {
  const state = checked === 0 ? "none" : checked === count ? "all" : "some";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 6, paddingVertical: 2, marginTop: 4 }}>
      <HoverPressable
        accessibilityRole="button"
        accessibilityLabel={`${title}（${count}）`}
        onPress={onToggle}
        style={({ hovered }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 3,
          flex: 1,
          minWidth: 0,
          paddingVertical: 3,
          borderRadius: 4,
          backgroundColor: hovered ? theme.colors.surface1 : "transparent",
        })}
      >
        <Icon name="ChevronDown" size={12} color={theme.colors.foregroundMuted} />
        <TriCheckbox theme={theme} state={state} onPress={onSelectAll} />
        <Text style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "600" }}>{title}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>{count}</Text>
      </HoverPressable>
      {action}
    </View>
  );
}

function TriCheckbox({ theme, state, onPress }: { theme: PanelTheme; state: "none" | "some" | "all"; onPress: () => void }) {
  return (
    <HoverPressable
      accessibilityRole="button"
      accessibilityLabel={state === "all" ? "取消全选" : "全选"}
      onPress={onPress}
      hitSlop={4}
      style={() => ({
        width: 13,
        height: 13,
        borderRadius: 3,
        borderWidth: 1,
        borderColor: state === "none" ? theme.colors.border : theme.colors.accent,
        backgroundColor: state === "all" ? theme.colors.accent : "transparent",
        alignItems: "center",
        justifyContent: "center",
      })}
    >
      {state === "all" ? <Icon name="Check" size={9} color={theme.colors.accentForeground} /> : null}
      {state === "some" ? <View style={{ width: 7, height: 7, borderRadius: 2, backgroundColor: theme.colors.accent }} /> : null}
    </HoverPressable>
  );
}

function ChangeGroupBody({
  theme,
  group,
  selected,
  groupByDir,
  collapsedDirs,
  onToggleDir,
  onToggle,
  onOpenDiff,
  menuFor,
}: {
  theme: PanelTheme;
  group: { key: string; title: string; entries: ChangeEntry[] };
  selected: Set<string>;
  groupByDir: boolean;
  collapsedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onToggle: (key: string) => void;
  onOpenDiff: (entry: ChangeEntry) => void;
  menuFor: (entry: ChangeEntry) => MenuItem[];
}) {
  if (!groupByDir) {
    return (
      <View>
        {group.entries.map((entry) => (
          <ChangeFileRow
            key={entryKey(entry)}
            theme={theme}
            entry={entry}
            checked={selected.has(entryKey(entry))}
            onToggle={() => onToggle(entryKey(entry))}
            onOpen={() => onOpenDiff(entry)}
            menu={menuFor(entry)}
          />
        ))}
      </View>
    );
  }
  const tree = buildDirTree(group.entries.map((entry) => ({ path: entry.path, value: entry })));
  const renderDir = (dir: TreeDir<ChangeEntry>, depth: number): React.ReactNode => {
    const dirEntries = collectAllPaths({ rootFiles: [], dirs: [dir] }).map(
      (path) => group.entries.find((entry) => entry.path === path)!,
    );
    const dirChecked = dirEntries.filter((entry) => selected.has(entryKey(entry))).length;
    const expanded = !collapsedDirs.has(dir.path);
    return (
      <View key={dir.path}>
        <HoverPressable
          accessibilityRole="button"
          accessibilityLabel={`目录 ${dir.name}`}
          onPress={() => onToggleDir(dir.path)}
          style={({ hovered }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingHorizontal: 8,
            paddingVertical: 3,
            marginLeft: 8 + depth * 12,
            borderRadius: 4,
            backgroundColor: hovered ? theme.colors.surface1 : "transparent",
          })}
        >
          <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={11} color={theme.colors.foregroundMuted} />
          <Icon name="Folder" size={11} color={theme.colors.foregroundMuted} />
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 10.5, fontFamily: MONO_FONT, flexShrink: 1 }}>
            {dir.name}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9, opacity: 0.7 }}>
            {dirChecked}/{dirEntries.length}
          </Text>
        </HoverPressable>
        {expanded ? (
          <View>
            {dir.files.map((file) => (
              <ChangeFileRow
                key={entryKey(file.value)}
                theme={theme}
                entry={file.value}
                checked={selected.has(entryKey(file.value))}
                onToggle={() => onToggle(entryKey(file.value))}
                onOpen={() => onOpenDiff(file.value)}
                menu={menuFor(file.value)}
                depth={depth + 1}
              />
            ))}
            {dir.dirs.map((child) => renderDir(child, depth + 1))}
          </View>
        ) : null}
      </View>
    );
  };
  return (
    <View>
      {tree.rootFiles.map((file) => (
        <ChangeFileRow
          key={entryKey(file.value)}
          theme={theme}
          entry={file.value}
          checked={selected.has(entryKey(file.value))}
          onToggle={() => onToggle(entryKey(file.value))}
          onOpen={() => onOpenDiff(file.value)}
          menu={menuFor(file.value)}
        />
      ))}
      {tree.dirs.map((dir) => renderDir(dir, 0))}
    </View>
  );
}

function ChangeFileRow({
  theme,
  entry,
  checked,
  onToggle,
  onOpen,
  menu,
  depth = 0,
}: {
  theme: PanelTheme;
  entry: ChangeEntry;
  checked: boolean;
  onToggle: () => void;
  onOpen: () => void;
  menu: MenuItem[];
  depth?: number;
}) {
  const color = statusColorOf(entry.status);
  const letter = statusLetter(entry);
  return (
    <HoverPressable
      accessibilityRole="button"
      accessibilityLabel={`文件 ${entry.path}`}
      onPress={onOpen}
      style={({ hovered }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 8,
        paddingVertical: 3,
        marginLeft: 20 + depth * 12,
        marginRight: 6,
        borderRadius: 4,
        backgroundColor: hovered ? theme.colors.surface1 : "transparent",
      })}
    >
      <HoverPressable
        accessibilityRole="button"
        accessibilityLabel={checked ? "取消勾选" : "勾选"}
        onPress={onToggle}
        hitSlop={4}
        style={() => ({
          width: 13,
          height: 13,
          borderRadius: 3,
          borderWidth: 1,
          borderColor: checked ? theme.colors.accent : theme.colors.border,
          backgroundColor: checked ? theme.colors.accent : "transparent",
          alignItems: "center",
          justifyContent: "center",
        })}
      >
        {checked ? <Icon name="Check" size={9} color={theme.colors.accentForeground} /> : null}
      </HoverPressable>
      <View
        style={{
          width: 14,
          height: 14,
          borderRadius: 3,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: color,
        }}
      >
        <Text style={{ color: theme.colors.surface0, fontSize: 8.5, fontWeight: "700" }}>{letter}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 10.5, fontFamily: MONO_FONT }}>
          {basename(entry.path)}
        </Text>
        <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 9.5, flexShrink: 1, opacity: 0.8 }}>
          {dirname(entry.path) !== "." ? dirname(entry.path) : ""}
          {entry.oldPath ? ` ← ${entry.oldPath}` : ""}
        </Text>
      </View>
      {entry.conflict ? <Icon name="TriangleAlert" size={11} color={color} /> : null}
      <MenuButton theme={theme} label={`文件 ${basename(entry.path)} 的操作`} items={menu} size={12} />
    </HoverPressable>
  );
}

function CommitButton({
  theme,
  label,
  icon,
  ghost = false,
  disabled = false,
  onPress,
}: {
  theme: PanelTheme;
  label: string;
  icon: string;
  ghost?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <HoverPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ hovered }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        flex: 1,
        paddingVertical: 7,
        borderRadius: 6,
        opacity: disabled ? 0.5 : hovered ? 0.88 : 1,
        backgroundColor: ghost ? "transparent" : theme.colors.accent,
        borderWidth: ghost ? 1 : 0,
        borderColor: theme.colors.border,
      })}
    >
      <Icon name={icon} size={13} color={ghost ? theme.colors.foreground : theme.colors.accentForeground} />
      <Text
        style={{
          color: ghost ? theme.colors.foreground : theme.colors.accentForeground,
          fontSize: 11.5,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
    </HoverPressable>
  );
}
