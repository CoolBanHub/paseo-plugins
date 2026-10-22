import { useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { hashStringColor } from "./colors";
import { BranchCreateDialog, ConfirmDialog, TagCreateDialog, WorktreeAddDialog } from "./dialogs";
import { basename, dirname, formatRelativeTime } from "./format";
import { Chip, HoverPressable, IconButton, MONO_FONT, SectionHeader, type PanelTheme } from "./parts";
import type {
  BranchesResult,
  LocalBranchEntry,
  StatusResult,
  TagEntry,
  TagsResult,
  WorktreeEntry,
  WorktreesResult,
} from "../shared/types";

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
  onCheckout,
  onFetch,
  onPull,
  onRefresh,
  onCreateBranch,
  onDeleteBranch,
  onCreateTag,
  onDeleteTag,
  onAddWorktree,
  onRemoveWorktree,
  onPruneWorktrees,
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
  onCheckout: (ref: string) => void;
  onFetch: () => void;
  onPull: () => void;
  onRefresh: () => void;
  onCreateBranch: (name: string, startPoint: string, checkout: boolean) => void;
  onDeleteBranch: (name: string, force: boolean) => void;
  onCreateTag: (name: string, ref: string, message: string) => void;
  onDeleteTag: (name: string) => void;
  onAddWorktree: (path: string, newBranch: string, ref: string) => void;
  onRemoveWorktree: (path: string, force: boolean) => void;
  onPruneWorktrees: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [localsExpanded, setLocalsExpanded] = useState(true);
  const [remotesExpanded, setRemotesExpanded] = useState(true);
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [worktreesExpanded, setWorktreesExpanded] = useState(false);

  const [showCreateBranch, setShowCreateBranch] = useState(false);
  const [showCreateTag, setShowCreateTag] = useState(false);
  const [showAddWorktree, setShowAddWorktree] = useState(false);
  const [deleteBranchTarget, setDeleteBranchTarget] = useState<LocalBranchEntry | null>(null);
  const [deleteTagTarget, setDeleteTagTarget] = useState<TagEntry | null>(null);
  const [removeWorktreeTarget, setRemoveWorktreeTarget] = useState<WorktreeEntry | null>(null);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const match = (name: string) => needle.length === 0 || name.toLowerCase().includes(needle);
    return {
      locals: (branches?.locals ?? []).filter((branch) => match(branch.shortName)),
      remotes: (branches?.remotes ?? []).filter((branch) => match(branch.shortName)),
      tags: (tags?.tags ?? []).filter((tag) => match(tag.shortName)),
      worktrees: (worktrees?.worktrees ?? []).filter((worktree) => match(worktreeLabel(worktree))),
    };
  }, [branches, filter, tags, worktrees]);

  const dirtyTotal = (status?.staged ?? 0) + (status?.unstaged ?? 0) + (status?.untracked ?? 0);
  const worktreeParent = dirname(status?.root ?? directory);

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

      <BranchScroll
        theme={theme}
        locals={filtered.locals}
        remotes={filtered.remotes}
        tags={filtered.tags}
        worktrees={filtered.worktrees}
        scope={scope}
        currentBranch={status?.currentBranch ?? null}
        detached={status?.detached ?? false}
        head={status?.head ?? null}
        busy={busy}
        localsExpanded={localsExpanded}
        remotesExpanded={remotesExpanded}
        tagsExpanded={tagsExpanded}
        worktreesExpanded={worktreesExpanded}
        onToggleLocals={() => setLocalsExpanded((value) => !value)}
        onToggleRemotes={() => setRemotesExpanded((value) => !value)}
        onToggleTags={() => setTagsExpanded((value) => !value)}
        onToggleWorktrees={() => setWorktreesExpanded((value) => !value)}
        onShowCreateBranch={() => setShowCreateBranch(true)}
        onShowCreateTag={() => setShowCreateTag(true)}
        onShowAddWorktree={() => setShowAddWorktree(true)}
        onPruneWorktrees={onPruneWorktrees}
        onSelectScope={onSelectScope}
        onCheckout={onCheckout}
        onDeleteBranch={(branch) => setDeleteBranchTarget(branch)}
        onDeleteTag={(tag) => setDeleteTagTarget(tag)}
        onRemoveWorktree={(worktree) => setRemoveWorktreeTarget(worktree)}
      />

      <BranchCreateDialog
        theme={theme}
        open={showCreateBranch}
        onOpenChange={setShowCreateBranch}
        onCreate={(name, startPoint, checkout) => onCreateBranch(name, startPoint, checkout)}
      />
      <TagCreateDialog
        theme={theme}
        open={showCreateTag}
        onOpenChange={setShowCreateTag}
        defaultRef="HEAD"
        onCreate={(name, ref, message) => onCreateTag(name, ref, message)}
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
        detail={
          deleteBranchTarget?.ahead
            ? `该分支有 ${deleteBranchTarget.ahead} 个未合并提交，需勾选强制删除`
            : undefined
        }
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

function BranchScroll({
  theme,
  locals,
  remotes,
  tags,
  worktrees,
  scope,
  currentBranch,
  detached,
  head,
  busy,
  localsExpanded,
  remotesExpanded,
  tagsExpanded,
  worktreesExpanded,
  onToggleLocals,
  onToggleRemotes,
  onToggleTags,
  onToggleWorktrees,
  onShowCreateBranch,
  onShowCreateTag,
  onShowAddWorktree,
  onPruneWorktrees,
  onSelectScope,
  onCheckout,
  onDeleteBranch,
  onDeleteTag,
  onRemoveWorktree,
}: {
  theme: PanelTheme;
  locals: BranchesResult["locals"];
  remotes: BranchesResult["remotes"];
  tags: TagEntry[];
  worktrees: WorktreeEntry[];
  scope: string;
  currentBranch: string | null;
  detached: boolean;
  head: string | null;
  busy: string | null;
  localsExpanded: boolean;
  remotesExpanded: boolean;
  tagsExpanded: boolean;
  worktreesExpanded: boolean;
  onToggleLocals: () => void;
  onToggleRemotes: () => void;
  onToggleTags: () => void;
  onToggleWorktrees: () => void;
  onShowCreateBranch: () => void;
  onShowCreateTag: () => void;
  onShowAddWorktree: () => void;
  onPruneWorktrees: () => void;
  onSelectScope: (ref: string) => void;
  onCheckout: (ref: string) => void;
  onDeleteBranch: (branch: LocalBranchEntry) => void;
  onDeleteTag: (tag: TagEntry) => void;
  onRemoveWorktree: (worktree: WorktreeEntry) => void;
}) {
  if (locals.length === 0 && remotes.length === 0 && tags.length === 0 && worktrees.length === 0) {
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
      <SectionRow theme={theme} title="本地" count={locals.length} expanded={localsExpanded} onToggle={onToggleLocals}>
        <IconButton
          icon="Plus"
          label="新建分支"
          theme={theme}
          size={13}
          disabled={busy !== null}
          onPress={onShowCreateBranch}
        />
      </SectionRow>
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
              onDelete={branch.isCurrent ? undefined : () => onDeleteBranch(branch)}
            />
          ))
        : null}

      <View style={{ height: 4 }} />
      <SectionRow theme={theme} title="远程" count={remotes.length} expanded={remotesExpanded} onToggle={onToggleRemotes} />
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

      <View style={{ height: 4 }} />
      <SectionRow theme={theme} title="标签" count={tags.length} expanded={tagsExpanded} onToggle={onToggleTags}>
        <IconButton
          icon="Plus"
          label="新建标签"
          theme={theme}
          size={13}
          disabled={busy !== null}
          onPress={onShowCreateTag}
        />
      </SectionRow>
      {tagsExpanded
        ? tags.map((tag) => (
            <TagRow
              key={tag.name}
              theme={theme}
              tag={tag}
              isScope={scope === tag.name}
              busy={busy !== null}
              onSelect={() => onSelectScope(tag.name)}
              onCheckout={() => onCheckout(tag.shortName)}
              onDelete={() => onDeleteTag(tag)}
            />
          ))
        : null}

      <View style={{ height: 4 }} />
      <SectionRow
        theme={theme}
        title="Worktrees"
        count={worktrees.length}
        expanded={worktreesExpanded}
        onToggle={onToggleWorktrees}
      >
        <IconButton
          icon="Eraser"
          label="清理失效的 worktree 记录"
          theme={theme}
          size={13}
          disabled={busy !== null}
          onPress={onPruneWorktrees}
        />
        <IconButton
          icon="Plus"
          label="添加 Worktree"
          theme={theme}
          size={13}
          disabled={busy !== null}
          onPress={onShowAddWorktree}
        />
      </SectionRow>
      {worktreesExpanded
        ? worktrees.map((worktree) => (
            <WorktreeRow
              key={worktree.path}
              theme={theme}
              worktree={worktree}
              busy={busy !== null}
              onRemove={worktree.isMain ? undefined : () => onRemoveWorktree(worktree)}
            />
          ))
        : null}
      <View style={{ height: 8 }} />
    </ScrollView>
  );
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
  onDelete,
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
  onDelete?: () => void;
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
          {!remote && onDelete ? (
            <IconButton
              icon="Trash2"
              label={`删除分支 ${shortName}`}
              theme={theme}
              size={13}
              onPress={onDelete}
            />
          ) : null}
        </>
      )}
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
          <Text
            numberOfLines={1}
            style={{ color: theme.colors.foreground, fontSize: 11, fontFamily: MONO_FONT, flexShrink: 1 }}
          >
            {tag.shortName}
          </Text>
          {tag.annotated ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 8.5 }}>附注</Text>
          ) : null}
        </View>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9 }} numberOfLines={1}>
          {formatRelativeTime(tag.date)} · {tag.subject}
        </Text>
      </View>
      <IconButton
        icon="LogIn"
        label={`检出标签 ${tag.shortName}`}
        theme={theme}
        size={13}
        disabled={busy}
        onPress={onCheckout}
      />
      <IconButton
        icon="Trash2"
        label={`删除标签 ${tag.shortName}`}
        theme={theme}
        size={13}
        disabled={busy}
        onPress={onDelete}
      />
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
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 8,
        paddingVertical: 4,
        marginLeft: 6,
      }}
    >
      <Icon name="Folder" size={11} color={color} />
      <View style={{ flexDirection: "column", flexShrink: 1, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1, minWidth: 0 }}>
          <Text
            numberOfLines={1}
            style={{ color: theme.colors.foreground, fontSize: 11, fontFamily: MONO_FONT, flexShrink: 1 }}
          >
            {basename(worktree.path)}
          </Text>
          {worktree.isMain ? <Chip label="主" color={theme.colors.accent} theme={theme} fontSize={8.5} /> : null}
          {worktree.bare ? <Chip label="bare" color={theme.colors.foregroundMuted} theme={theme} fontSize={8.5} /> : null}
        </View>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9 }} numberOfLines={1}>
          {worktree.detached || !worktree.branch
            ? `分离 ${worktree.head.slice(0, 8)}`
            : branchShort}
        </Text>
      </View>
      {onRemove ? (
        <IconButton
          icon="Trash2"
          label={`移除 worktree ${basename(worktree.path)}`}
          theme={theme}
          size={13}
          disabled={busy}
          onPress={onRemove}
        />
      ) : null}
    </View>
  );
}
