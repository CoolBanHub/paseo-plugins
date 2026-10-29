import { useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { hashStringColor } from "./colors";
import { MenuButton } from "./ContextMenu";
import { BranchCreateDialog, ConfirmDialog, TagCreateDialog, TextInputDialog, WorktreeAddDialog } from "./dialogs";
import { basename, dirname, formatRelativeTime } from "./format";
import { buildDirTree, collectAllPaths, type FileTree } from "./filetree";
import { Chip, HoverPressable, IconButton, MONO_FONT, SectionHeader, type PanelTheme } from "./parts";
import type {
  BranchEntry,
  BranchesResult,
  LocalBranchEntry,
  StatusResult,
  TagEntry,
  TagsResult,
  WorktreeEntry,
  WorktreesResult,
} from "../shared/types";

export interface BranchActions {
  onCheckout: (ref: string) => void;
  onMerge: (ref: string) => void;
  onRebaseOnto: (ref: string) => void;
  onCreateBranchFrom: (startPoint: string) => void;
  onRenameBranch: (name: string, newName: string) => void;
  onDeleteBranch: (branch: LocalBranchEntry) => void;
}

export function BranchPane({
  theme,
  directory,
  status,
  branches,
  tags,
  worktrees,
  scope,
  busy,
  onSelectScope,
  onFetch,
  onPull,
  onPush,
  onRefresh,
  onCreateBranch,
  onDeleteBranch,
  onCreateTag,
  onDeleteTag,
  onAddWorktree,
  onRemoveWorktree,
  onPruneWorktrees,
  actions,
  onOpenChanges,
}: {
  theme: PanelTheme;
  directory: string;
  status: StatusResult | null;
  branches: BranchesResult | null;
  tags: TagsResult | null;
  worktrees: WorktreesResult | null;
  scope: string;
  busy: string | null;
  onSelectScope: (ref: string) => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: (setUpstream: boolean) => void;
  onRefresh: () => void;
  onCreateBranch: (name: string, startPoint: string, checkout: boolean) => void;
  onDeleteBranch: (name: string, force: boolean) => void;
  onCreateTag: (name: string, ref: string, message: string) => void;
  onDeleteTag: (name: string) => void;
  onAddWorktree: (path: string, newBranch: string, ref: string) => void;
  onRemoveWorktree: (path: string, force: boolean) => void;
  onPruneWorktrees: () => void;
  /** Log-side ⋯ menu actions (merge/rebase/rename/create-from). */
  actions: BranchActions;
  /** Open the working-tree tab from the change-count chip. */
  onOpenChanges: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [localsExpanded, setLocalsExpanded] = useState(true);
  const [remotesExpanded, setRemotesExpanded] = useState(true);
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [worktreesExpanded, setWorktreesExpanded] = useState(false);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());

  const [showCreateBranch, setShowCreateBranch] = useState(false);
  const [createBranchFrom, setCreateBranchFrom] = useState<string | null>(null);
  const [showCreateTag, setShowCreateTag] = useState(false);
  const [tagFromCommit, setTagFromCommit] = useState<string | null>(null);
  const [showAddWorktree, setShowAddWorktree] = useState(false);
  const [deleteBranchTarget, setDeleteBranchTarget] = useState<LocalBranchEntry | null>(null);
  const [renameTarget, setRenameTarget] = useState<LocalBranchEntry | null>(null);
  const [deleteTagTarget, setDeleteTagTarget] = useState<TagEntry | null>(null);
  const [removeWorktreeTarget, setRemoveWorktreeTarget] = useState<WorktreeEntry | null>(null);

  const needle = filter.trim().toLowerCase();
  const matches = (name: string) => needle.length === 0 || name.toLowerCase().includes(needle);

  const currentBranch = (branches?.locals ?? []).find((branch) => branch.isCurrent) ?? null;
  const filteredLocals = useMemo(
    () => (branches?.locals ?? []).filter((branch) => matches(branch.shortName)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [branches, filter],
  );
  const filteredRemotes = useMemo(
    () => (branches?.remotes ?? []).filter((branch) => matches(branch.shortName)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [branches, filter],
  );
  const filteredTags = useMemo(
    () => (tags?.tags ?? []).filter((tag) => matches(tag.shortName)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tags, filter],
  );
  const filteredWorktrees = useMemo(
    () => (worktrees?.worktrees ?? []).filter((worktree) => matches(worktreeLabel(worktree))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [worktrees, filter],
  );

  // Group branches into a collapsed directory tree (IDEA's branch tree).
  const localTree = useMemo(
    () => buildDirTree(filteredLocals.filter((b) => !b.isCurrent).map((b) => ({ path: b.shortName, value: b }))),
    [filteredLocals],
  );
  const remoteTree = useMemo(
    () => buildDirTree(filteredRemotes.map((b) => ({ path: b.shortName, value: b }))),
    [filteredRemotes],
  );

  const dirtyTotal = (status?.staged ?? 0) + (status?.unstaged ?? 0) + (status?.untracked ?? 0);
  const worktreeParent = dirname(status?.root ?? directory);

  const toggleDir = (path: string) => {
    setCollapsedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const branchMenu = (branch: LocalBranchEntry) => [
    { key: "checkout", label: `检出 ${branch.shortName}`, icon: "LogIn", disabled: branch.isCurrent, onPress: () => actions.onCheckout(branch.shortName) },
    { key: "-", label: "", onPress: () => undefined },
    { key: "new-from", label: "从此分支新建…", icon: "GitBranch", onPress: () => setCreateBranchFrom(branch.name) },
    { key: "merge", label: `合并 ${branch.shortName} 到当前分支`, icon: "GitMerge", disabled: branch.isCurrent, onPress: () => actions.onMerge(branch.shortName) },
    { key: "rebase", label: `将当前分支变基到 ${branch.shortName}`, icon: "CornerRightUp", disabled: branch.isCurrent, onPress: () => actions.onRebaseOnto(branch.shortName) },
    { key: "-", label: "", onPress: () => undefined },
    { key: "rename", label: "重命名…", icon: "PenLine", disabled: branch.isCurrent, onPress: () => setRenameTarget(branch) },
    { key: "delete", label: `删除 ${branch.shortName}`, icon: "Trash2", danger: true, disabled: branch.isCurrent, onPress: () => setDeleteBranchTarget(branch) },
    { key: "-", label: "", onPress: () => undefined },
    { key: "pull", label: "更新（拉取）", icon: "Download", disabled: !branch.isCurrent, onPress: onPull },
    { key: "push", label: "推送…", icon: "Upload", disabled: !branch.isCurrent, onPress: () => onPush(false) },
  ];

  const remoteMenu = (branch: BranchEntry) => [
    { key: "new-from", label: `从 ${branch.shortName} 新建分支…`, icon: "GitBranch", onPress: () => setCreateBranchFrom(branch.name) },
    { key: "merge", label: `合并 ${branch.shortName} 到当前分支`, icon: "GitMerge", onPress: () => actions.onMerge(branch.shortName) },
    { key: "rebase", label: `将当前分支变基到 ${branch.shortName}`, icon: "CornerRightUp", onPress: () => actions.onRebaseOnto(branch.shortName) },
  ];

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
            <IconButton icon="Download" label="拉取并快进" theme={theme} disabled={busy !== null} onPress={onPull} />
            <IconButton icon="Upload" label="推送当前分支" theme={theme} disabled={busy !== null} onPress={() => onPush(false)} />
            <IconButton icon="RotateCw" label="刷新" theme={theme} disabled={busy !== null} onPress={onRefresh} />
          </View>
        </View>

        {status?.ok ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <Icon name="GitBranch" size={12} color={theme.colors.accent} />
            <Text
              numberOfLines={1}
              style={{ color: theme.colors.foreground, fontSize: 11, fontFamily: MONO_FONT, flexShrink: 1 }}
            >
              {status.detached ? `(${(status.head ?? "").slice(0, 8)} 分离头指针)` : status.currentBranch}
            </Text>
            {status.ahead !== null && status.ahead > 0 ? (
              <Text style={{ color: theme.colors.statusSuccess, fontSize: 10, fontFamily: MONO_FONT }}>↑{status.ahead}</Text>
            ) : null}
            {status.behind !== null && status.behind > 0 ? (
              <Text style={{ color: theme.colors.accent, fontSize: 10, fontFamily: MONO_FONT }}>↓{status.behind}</Text>
            ) : null}
            {dirtyTotal > 0 ? (
              <Chip label={`${dirtyTotal} 处改动`} color={theme.colors.foregroundMuted} theme={theme} fontSize={9} onPress={onOpenChanges} />
            ) : null}
          </View>
        ) : null}

        <TextInput
          value={filter}
          onChangeText={setFilter}
          placeholder="筛选分支 / 标签 / worktree…"
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

      <ScrollView style={{ flex: 1, paddingHorizontal: 2 }} contentContainerStyle={{ paddingBottom: 8 }}>
        {localTree.rootFiles.length + localTree.dirs.length + (currentBranch ? 1 : 0) + remoteTree.rootFiles.length + remoteTree.dirs.length + filteredTags.length + filteredWorktrees.length === 0 ? (
          <View style={{ padding: 12 }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>没有匹配的分支</Text>
          </View>
        ) : null}

        <SectionRow theme={theme} title="本地" count={filteredLocals.length} expanded={localsExpanded} onToggle={() => setLocalsExpanded((v) => !v)}>
          <IconButton icon="Plus" label="新建分支" theme={theme} size={13} disabled={busy !== null} onPress={() => setCreateBranchFrom(null)} />
        </SectionRow>
        {localsExpanded ? (
          <>
            {currentBranch && matches(currentBranch.shortName) ? (
              <BranchRow
                theme={theme}
                branch={currentBranch}
                isScope={scope === currentBranch.name}
                detachedHead={status?.detached === true}
                onSelect={() => onSelectScope(currentBranch.name)}
                menuItems={branchMenu(currentBranch)}
              />
            ) : null}
            <BranchTreeSection
              theme={theme}
              tree={localTree}
              scope={scope}
              head={status?.head ?? null}
              detached={status?.detached ?? false}
              collapsedDirs={collapsedDirs}
              onToggleDir={toggleDir}
              onSelectScope={onSelectScope}
              menuFor={(branch) => ("isCurrent" in branch ? branchMenu(branch) : remoteMenu(branch))}
            />
          </>
        ) : null}

        <View style={{ height: 4 }} />
        <SectionRow theme={theme} title="远程" count={filteredRemotes.length} expanded={remotesExpanded} onToggle={() => setRemotesExpanded((v) => !v)} />
        {remotesExpanded ? (
          <BranchTreeSection
            theme={theme}
            tree={remoteTree}
            scope={scope}
            head={null}
            detached={false}
            collapsedDirs={collapsedDirs}
            onToggleDir={toggleDir}
            onSelectScope={onSelectScope}
            menuFor={(branch) => remoteMenu(branch)}
            remote
          />
        ) : null}

        <View style={{ height: 4 }} />
        <SectionRow theme={theme} title="标签" count={filteredTags.length} expanded={tagsExpanded} onToggle={() => setTagsExpanded((v) => !v)}>
          <IconButton icon="Plus" label="新建标签" theme={theme} size={13} disabled={busy !== null} onPress={() => setTagFromCommit(null)} />
        </SectionRow>
        {tagsExpanded
          ? filteredTags.map((tag) => (
              <TagRow
                key={tag.name}
                theme={theme}
                tag={tag}
                isScope={scope === tag.name}
                busy={busy !== null}
                onSelect={() => onSelectScope(tag.name)}
                onCheckout={() => actions.onCheckout(tag.shortName)}
                onDelete={() => setDeleteTagTarget(tag)}
              />
            ))
          : null}

        <View style={{ height: 4 }} />
        <SectionRow theme={theme} title="Worktrees" count={filteredWorktrees.length} expanded={worktreesExpanded} onToggle={() => setWorktreesExpanded((v) => !v)}>
          <IconButton icon="Eraser" label="清理失效的 worktree 记录" theme={theme} size={13} disabled={busy !== null} onPress={onPruneWorktrees} />
          <IconButton icon="Plus" label="添加 Worktree" theme={theme} size={13} disabled={busy !== null} onPress={() => setShowAddWorktree(true)} />
        </SectionRow>
        {worktreesExpanded
          ? filteredWorktrees.map((worktree) => (
              <WorktreeRow
                key={worktree.path}
                theme={theme}
                worktree={worktree}
                busy={busy !== null}
                onRemove={worktree.isMain ? undefined : () => setRemoveWorktreeTarget(worktree)}
              />
            ))
          : null}
      </ScrollView>

      <BranchCreateDialog
        theme={theme}
        open={showCreateBranch || createBranchFrom !== null}
        onOpenChange={(open) => {
          if (!open) {
            setShowCreateBranch(false);
            setCreateBranchFrom(null);
          }
        }}
        defaultStartPoint={createBranchFrom ?? "HEAD"}
        onCreate={(name, startPoint, checkout) => onCreateBranch(name, startPoint, checkout)}
      />
      <TagCreateDialog
        theme={theme}
        open={showCreateTag || tagFromCommit !== null}
        onOpenChange={(open) => {
          if (!open) {
            setShowCreateTag(false);
            setTagFromCommit(null);
          }
        }}
        defaultRef={tagFromCommit ?? "HEAD"}
        onCreate={(name, ref, message) => onCreateTag(name, ref, message)}
      />
      <TextInputDialog
        theme={theme}
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
        title="重命名分支"
        icon="PenLine"
        label="新分支名"
        initial={renameTarget?.shortName ?? ""}
        hint={`当前名：${renameTarget?.shortName ?? ""}`}
        confirmLabel="重命名"
        onConfirm={(value) => {
          if (renameTarget) actions.onRenameBranch(renameTarget.shortName, value);
        }}
      />
      <WorktreeAddDialog
        theme={theme}
        open={showAddWorktree}
        onOpenChange={setShowAddWorktree}
        parentDir={worktreeParent}
        onAdd={(path, newBranch, ref) => onAddWorktree(path, newBranch, ref)}
      />

      <ConfirmDialog
        theme={theme}
        open={deleteBranchTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteBranchTarget(null);
        }}
        title="删除分支"
        message={`确定删除分支 ${deleteBranchTarget?.shortName ?? ""} 吗？`}
        detail={deleteBranchTarget?.upstream ? `上游：${deleteBranchTarget.upstream}` : undefined}
        mono
        confirmLabel="删除"
        danger
        forceLabel="强制删除未合并提交"
        onConfirm={(force) => {
          if (deleteBranchTarget) onDeleteBranch(deleteBranchTarget.shortName, force);
        }}
      />
      <ConfirmDialog
        theme={theme}
        open={deleteTagTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTagTarget(null);
        }}
        title="删除标签"
        message={`确定删除标签 ${deleteTagTarget?.shortName ?? ""} 吗？仅删除本地引用，不影响提交。`}
        detail={deleteTagTarget ? (deleteTagTarget.annotated ? "附注标签" : "轻量标签") : undefined}
        mono
        confirmLabel="删除"
        danger
        onConfirm={() => {
          if (deleteTagTarget) onDeleteTag(deleteTagTarget.shortName);
        }}
      />
      <ConfirmDialog
        theme={theme}
        open={removeWorktreeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveWorktreeTarget(null);
        }}
        title="移除 Worktree"
        message={`确定移除 worktree ${removeWorktreeTarget ? basename(removeWorktreeTarget.path) : ""} 吗？目录将从磁盘删除。`}
        detail={removeWorktreeTarget?.path}
        mono
        confirmLabel="移除"
        danger
        forceLabel="强制移除（含未提交改动）"
        onConfirm={(force) => {
          if (removeWorktreeTarget) onRemoveWorktree(removeWorktreeTarget.path, force);
        }}
      />
    </View>
  );
}

function worktreeLabel(worktree: WorktreeEntry): string {
  if (worktree.branch) return worktree.branch.replace(/^refs\/heads\//, "");
  return basename(worktree.path);
}

/** Section header with trailing action buttons (create / prune). */
function SectionRow({
  theme,
  title,
  count,
  expanded,
  onToggle,
  children,
}: {
  theme: PanelTheme;
  title: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <SectionHeader theme={theme} title={title} count={count} expanded={expanded} onToggle={onToggle} />
      </View>
      {children}
    </View>
  );
}

function BranchTreeSection({
  theme,
  tree,
  scope,
  head,
  detached,
  collapsedDirs,
  onToggleDir,
  onSelectScope,
  menuFor,
  remote = false,
}: {
  theme: PanelTheme;
  tree: FileTree<LocalBranchEntry | BranchEntry>;
  scope: string;
  head: string | null;
  detached: boolean;
  collapsedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onSelectScope: (ref: string) => void;
  menuFor: (branch: LocalBranchEntry | BranchEntry) => { key: string; label: string; onPress: () => void }[];
  remote?: boolean;
}) {
  const renderDir = (dir: (typeof tree.dirs)[number], depth: number): ReactNode => {
    const collapsed = collapsedDirs.has(dir.path);
    const all = collectAllPaths({ rootFiles: [], dirs: [dir] });
    return (
      <View key={dir.path}>
        <HoverPressable
          accessibilityRole="button"
          accessibilityLabel={`目录 ${dir.name}`}
          onPress={() => onToggleDir(dir.path)}
          style={({ hovered }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: 4,
            marginLeft: 6 + depth * 10,
            backgroundColor: hovered ? theme.colors.surface1 : "transparent",
          })}
        >
          <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} size={11} color={theme.colors.foregroundMuted} />
          <Icon name="Folder" size={11} color={theme.colors.foregroundMuted} />
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 10.5, fontFamily: MONO_FONT, flexShrink: 1 }}>
            {dir.name}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9, opacity: 0.7 }}>{all.length}</Text>
        </HoverPressable>
        {!collapsed ? (
          <View>
            {dir.files.map((file) => {
              const branch = file.value;
              const local = "isCurrent" in branch ? branch : null;
              return (
                <BranchRow
                  key={branch.name}
                  theme={theme}
                  branch={branch as LocalBranchEntry}
                  isScope={scope === branch.name}
                  detachedHead={detached && head !== null && branch.hash === head}
                  remote={!local}
                  depth={depth + 1}
                  onSelect={() => onSelectScope(branch.name)}
                  menuItems={menuFor(branch)}
                />
              );
            })}
            {dir.dirs.map((child) => renderDir(child, depth + 1))}
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View>
      {tree.rootFiles.map((file) => {
        const branch = file.value;
        return (
          <BranchRow
            key={branch.name}
            theme={theme}
            branch={branch as LocalBranchEntry}
            isScope={scope === branch.name}
            detachedHead={detached && head !== null && branch.hash === head}
            remote={!("isCurrent" in branch)}
            onSelect={() => onSelectScope(branch.name)}
            menuItems={menuFor(branch)}
          />
        );
      })}
      {tree.dirs.map((dir) => renderDir(dir, 0))}
    </View>
  );
}

function BranchRow({
  theme,
  branch,
  isScope,
  detachedHead,
  remote = false,
  depth = 0,
  onSelect,
  menuItems,
}: {
  theme: PanelTheme;
  branch: LocalBranchEntry;
  isScope: boolean;
  detachedHead: boolean;
  remote?: boolean;
  depth?: number;
  onSelect: () => void;
  menuItems: { key: string; label: string; onPress: () => void }[];
}) {
  const color = hashStringColor(branch.name);
  const ahead = !remote && !branch.isCurrent ? branch.ahead : null;
  const behind = !remote && !branch.isCurrent ? branch.behind : null;
  return (
    <HoverPressable
      accessibilityRole="button"
      accessibilityLabel={`分支 ${branch.shortName}`}
      onPress={onSelect}
      style={({ hovered, pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
        marginLeft: 6 + depth * 10,
        backgroundColor: pressed
          ? theme.colors.surface2
          : hovered || isScope
            ? theme.colors.surface1
            : "transparent",
      })}
    >
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color, flexShrink: 0 }} />
      <View style={{ flexDirection: "column", flexShrink: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={{
            color: theme.colors.foreground,
            fontSize: 11,
            fontFamily: MONO_FONT,
            fontWeight: branch.isCurrent ? "700" : "400",
          }}
        >
          {branch.shortName}
          {detachedHead ? " (HEAD)" : ""}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9 }}>
          {formatRelativeTime(branch.date)}
          {branch.isCurrent && branch.upstream ? ` · ${branch.upstream}` : ""}
        </Text>
      </View>
      {branch.isCurrent ? (
        <Icon name="Check" size={12} color={theme.colors.accent} />
      ) : (
        <>
          {ahead !== null && ahead > 0 ? (
            <Text style={{ color: theme.colors.statusSuccess, fontSize: 9, fontFamily: MONO_FONT }}>↑{ahead}</Text>
          ) : null}
          {behind !== null && behind > 0 ? (
            <Text style={{ color: theme.colors.accent, fontSize: 9, fontFamily: MONO_FONT }}>↓{behind}</Text>
          ) : null}
        </>
      )}
      <MenuButton theme={theme} label={`分支 ${branch.shortName} 的操作`} items={menuItems} size={12} />
    </HoverPressable>
  );
}

function TagRow({
  theme,
  tag,
  isScope,
  busy,
  onSelect,
  onCheckout,
  onDelete,
}: {
  theme: PanelTheme;
  tag: TagEntry;
  isScope: boolean;
  busy: boolean;
  onSelect: () => void;
  onCheckout: () => void;
  onDelete: () => void;
}) {
  const color = hashStringColor(tag.name);
  return (
    <HoverPressable
      accessibilityRole="button"
      accessibilityLabel={`标签 ${tag.shortName}`}
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
      <Icon name="Tag" size={11} color={color} />
      <View style={{ flexDirection: "column", flexShrink: 1, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 11, fontFamily: MONO_FONT, flexShrink: 1 }}>
            {tag.shortName}
          </Text>
          {tag.annotated ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 8.5 }}>附注</Text> : null}
        </View>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9 }} numberOfLines={1}>
          {formatRelativeTime(tag.date)} · {tag.subject}
        </Text>
      </View>
      <IconButton icon="LogIn" label={`检出标签 ${tag.shortName}`} theme={theme} size={13} disabled={busy} onPress={onCheckout} />
      <IconButton icon="Trash2" label={`删除标签 ${tag.shortName}`} theme={theme} size={13} disabled={busy} onPress={onDelete} />
    </HoverPressable>
  );
}

function WorktreeRow({
  theme,
  worktree,
  busy,
  onRemove,
}: {
  theme: PanelTheme;
  worktree: WorktreeEntry;
  busy: boolean;
  onRemove?: () => void;
}) {
  const branchShort = worktree.branch ? worktree.branch.replace(/^refs\/heads\//, "") : null;
  const color = hashStringColor(worktree.branch ?? worktree.path);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, paddingVertical: 4, marginLeft: 6 }}>
      <Icon name="Folder" size={11} color={color} />
      <View style={{ flexDirection: "column", flexShrink: 1, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 11, fontFamily: MONO_FONT, flexShrink: 1 }}>
            {basename(worktree.path)}
          </Text>
          {worktree.isMain ? <Chip label="主" color={theme.colors.accent} theme={theme} fontSize={8.5} /> : null}
          {worktree.bare ? <Chip label="bare" color={theme.colors.foregroundMuted} theme={theme} fontSize={8.5} /> : null}
        </View>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9 }} numberOfLines={1}>
          {worktree.detached || !worktree.branch ? `分离 ${worktree.head.slice(0, 8)}` : branchShort}
        </Text>
      </View>
      {onRemove ? (
        <IconButton icon="Trash2" label={`移除 worktree ${basename(worktree.path)}`} theme={theme} size={13} disabled={busy} onPress={onRemove} />
      ) : null}
    </View>
  );
}
