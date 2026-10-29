import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import {
  Icon,
  Modal,
  ScrollView,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/react-native";
import { useRpc, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { BranchPane, type BranchActions } from "./BranchPane";
import { CommitList, type CommitActions } from "./CommitList";
import { CommitDetails } from "./CommitDetails";
import { CommitPanel } from "./CommitPanel";
import { ConfirmDialog } from "./dialogs";
import { isDateKey, localDateKey } from "./format";
import {
  AuthorDropdown,
  BranchScopeDropdown,
  DateRangeDropdown,
  PathDropdown,
} from "./filters";
import { HoverPressable, MONO_FONT, type PanelTheme } from "./parts";
import {
  gitBranchCreateRpc,
  gitBranchDeleteRpc,
  gitBranchRenameRpc,
  gitBranchesRpc,
  gitCheckoutRpc,
  gitCherryPickRpc,
  gitCommitRpc,
  gitFetchRpc,
  gitLogRpc,
  gitMergeRpc,
  gitPullRpc,
  gitPushRpc,
  gitRebaseRpc,
  gitResetRpc,
  gitRevertRpc,
  gitSequenceActionRpc,
  gitSequenceStateRpc,
  gitStatusRpc,
  gitTagCreateRpc,
  gitTagDeleteRpc,
  gitTagsRpc,
  gitWorktreeAddRpc,
  gitWorktreePruneRpc,
  gitWorktreeRemoveRpc,
  gitWorktreesRpc,
} from "../shared/contracts";
import type {
  ActionResult,
  BranchesResult,
  CommitDetail,
  CommitSummary,
  LogResult,
  SequenceState,
  StatusResult,
  TagsResult,
  WorktreesResult,
} from "../shared/types";

const PAGE_SIZE = 300;
const AUTO_REFRESH_MS = 45_000;

export function GitPanel({ theme, workspaceId, layout }: PluginWorkspacePanelProps) {
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const toast = useToast();
  const statusRpc = useRpc(gitStatusRpc);
  const branchesRpc = useRpc(gitBranchesRpc);
  const logRpc = useRpc(gitLogRpc);
  const commitRpc = useRpc(gitCommitRpc);
  const checkoutRpc = useRpc(gitCheckoutRpc);
  const fetchRpc = useRpc(gitFetchRpc);
  const pullRpc = useRpc(gitPullRpc);
  const pushRpc = useRpc(gitPushRpc);
  const tagsRpc = useRpc(gitTagsRpc);
  const tagCreateRpc = useRpc(gitTagCreateRpc);
  const tagDeleteRpc = useRpc(gitTagDeleteRpc);
  const branchCreateRpc = useRpc(gitBranchCreateRpc);
  const branchDeleteRpc = useRpc(gitBranchDeleteRpc);
  const branchRenameRpc = useRpc(gitBranchRenameRpc);
  const worktreesRpc = useRpc(gitWorktreesRpc);
  const worktreeAddRpc = useRpc(gitWorktreeAddRpc);
  const worktreeRemoveRpc = useRpc(gitWorktreeRemoveRpc);
  const worktreePruneRpc = useRpc(gitWorktreePruneRpc);
  const mergeRpc = useRpc(gitMergeRpc);
  const rebaseRpc = useRpc(gitRebaseRpc);
  const cherryPickRpc = useRpc(gitCherryPickRpc);
  const sequenceStateRpc = useRpc(gitSequenceStateRpc);
  const sequenceActionRpc = useRpc(gitSequenceActionRpc);
  const resetRpc = useRpc(gitResetRpc);
  const revertRpc = useRpc(gitRevertRpc);

  const [mainTab, setMainTab] = useState<"log" | "changes">("log");
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [branches, setBranches] = useState<BranchesResult | null>(null);
  const [tags, setTags] = useState<TagsResult | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreesResult | null>(null);
  const [log, setLog] = useState<LogResult | null>(null);
  const [sequence, setSequence] = useState<SequenceState | null>(null);
  const [scope, setScope] = useState<string>("ALL");
  const [search, setSearch] = useState("");
  const [authorFilter, setAuthorFilter] = useState<string>("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [pathFilter, setPathFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showBranchesModal, setShowBranchesModal] = useState(false);
  const [commitRefreshKey, setCommitRefreshKey] = useState(0);
  /** Branch name while asking whether to push -u origin after an upstream-less push. */
  const [pushSetupBranch, setPushSetupBranch] = useState<string | null>(null);
  const [hardResetTarget, setHardResetTarget] = useState<string | null>(null);
  const repoPathRef = useRef<string | null>(null);

  const refresh = useCallback(
    async (options: { quiet?: boolean } = {}) => {
      const repoPath = repoPathRef.current;
      if (!repoPath) return;
      if (!options.quiet) setBusy("refresh");
      try {
        const [nextStatus, nextBranches, nextTags, nextWorktrees, nextSequence] = await Promise.all([
          statusRpc({ repoPath }),
          branchesRpc({ repoPath }),
          tagsRpc({ repoPath }),
          worktreesRpc({ repoPath }),
          sequenceStateRpc({ repoPath }),
        ]);
        setStatus(nextStatus);
        setBranches(nextBranches);
        setTags(nextTags);
        setWorktrees(nextWorktrees);
        setSequence(nextSequence.ok ? nextSequence : null);
        if (nextStatus.ok) {
          const nextLog = await logRpc({ repoPath, ref: scope, limit: PAGE_SIZE, skip: 0, path: pathFilter });
          setLog(nextLog);
        }
        setCommitRefreshKey((key) => key + 1);
        if (!options.quiet && (!nextStatus.ok || !nextBranches.ok)) {
          const message = nextStatus.error ?? nextBranches.error ?? "读取仓库状态失败";
          if (/not a git repository/i.test(message)) {
            // stay quiet in the header; the empty state explains it
          } else {
            toast.error(message.split("\n")[0] ?? message);
          }
        }
      } catch (err) {
        if (!options.quiet) {
          toast.error(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!options.quiet) setBusy(null);
      }
    },
    [branchesRpc, logRpc, pathFilter, scope, sequenceStateRpc, statusRpc, tagsRpc, toast, worktreesRpc],
  );

  useEffect(() => {
    repoPathRef.current = directory ?? null;
    if (directory) {
      void refresh();
    } else {
      setStatus(null);
      setBranches(null);
      setTags(null);
      setWorktrees(null);
      setLog(null);
      setSequence(null);
    }
    // scope intentionally excluded: changing scope reloads below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directory]);

  useEffect(() => {
    const repoPath = repoPathRef.current;
    if (!repoPath || status?.ok !== true) return;
    setBusy("refresh");
    logRpc({ repoPath, ref: scope, limit: PAGE_SIZE, skip: 0, path: pathFilter })
      .then(setLog)
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, pathFilter]);

  useEffect(() => {
    const timer = setInterval(() => {
      void refresh({ quiet: true });
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!selectedHash) {
      setDetail(null);
      return;
    }
    const repoPath = repoPathRef.current;
    if (!repoPath) return;
    let cancelled = false;
    setDetailLoading(true);
    commitRpc({ repoPath, hash: selectedHash })
      .then((result) => {
        if (!cancelled) {
          setDetail(result.ok ? result : null);
          if (!result.ok && result.error) toast.error(result.error.split("\n")[0] ?? result.error);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) toast.error(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [commitRpc, selectedHash, toast]);

  const afterMutation = useCallback(() => {
    setSelectedHash(null);
    setDetail(null);
    void refresh();
  }, [refresh]);

  const onCheckout = useCallback(
    async (ref: string) => {
      const repoPath = repoPathRef.current;
      if (!repoPath) return;
      setBusy("checkout");
      try {
        const result = await checkoutRpc({ repoPath, ref });
        if (result.ok) {
          setShowBranchesModal(false);
          toast.show(result.message ?? `已切换到 ${ref}`, { variant: "success" });
          afterMutation();
        } else {
          toast.error(result.error ?? "检出失败");
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [afterMutation, checkoutRpc, toast],
  );

  const onFetch = useCallback(async () => {
    const repoPath = repoPathRef.current;
    if (!repoPath) return;
    setBusy("fetch");
    try {
      const result = await fetchRpc({ repoPath });
      if (result.ok) {
        toast.show(result.message ?? "已获取远端更新", { variant: "success" });
        afterMutation();
      } else {
        toast.error(result.error ?? "获取失败");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [afterMutation, fetchRpc, toast]);

  const onPull = useCallback(async () => {
    const repoPath = repoPathRef.current;
    if (!repoPath) return;
    setBusy("pull");
    try {
      const result = await pullRpc({ repoPath });
      if (result.ok) {
        toast.show(result.message ?? "拉取完成", { variant: "success" });
        afterMutation();
      } else {
        toast.error(result.error ?? "拉取失败");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [afterMutation, pullRpc, toast]);

  const onPush = useCallback(
    async (setUpstream: boolean) => {
      const repoPath = repoPathRef.current;
      if (!repoPath) return;
      setBusy("push");
      try {
        const result = await pushRpc({ repoPath, setUpstream });
        if (result.ok) {
          setPushSetupBranch(null);
          toast.show(result.message ?? "推送完成", { variant: "success" });
          afterMutation();
        } else if (result.needsUpstream) {
          setPushSetupBranch(status?.currentBranch ?? "");
        } else {
          toast.error(result.error ?? "推送失败");
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [afterMutation, pushRpc, status, toast],
  );

  /** Shared toast/refresh plumbing for the write actions (branch/tag/worktree/history). */
  const runAction = useCallback(
    async (busyKey: string, fallbackError: string, invoke: () => Promise<ActionResult>) => {
      const repoPath = repoPathRef.current;
      if (!repoPath) return;
      setBusy(busyKey);
      try {
        const result = await invoke();
        if (result.ok) {
          if (result.message) toast.show(result.message, { variant: "success" });
          afterMutation();
        } else {
          toast.error(result.error ?? fallbackError);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [afterMutation, toast],
  );

  const onCreateBranch = useCallback(
    (name: string, startPoint: string, checkout: boolean) => {
      void runAction("branch-create", "创建分支失败", async () => {
        const repoPath = repoPathRef.current;
        if (!repoPath) throw new Error("工作区不可用");
        return branchCreateRpc({ repoPath, name, startPoint, checkout });
      });
    },
    [branchCreateRpc, runAction],
  );

  const onDeleteBranch = useCallback(
    (name: string, force: boolean) => {
      void runAction("branch-delete", "删除分支失败", async () => {
        const repoPath = repoPathRef.current;
        if (!repoPath) throw new Error("工作区不可用");
        return branchDeleteRpc({ repoPath, name, force });
      });
    },
    [branchDeleteRpc, runAction],
  );

  const onCreateTag = useCallback(
    (name: string, ref: string, message: string) => {
      void runAction("tag-create", "创建标签失败", async () => {
        const repoPath = repoPathRef.current;
        if (!repoPath) throw new Error("工作区不可用");
        return tagCreateRpc({ repoPath, name, ref, message });
      });
    },
    [runAction, tagCreateRpc],
  );

  const onDeleteTag = useCallback(
    (name: string) => {
      void runAction("tag-delete", "删除标签失败", async () => {
        const repoPath = repoPathRef.current;
        if (!repoPath) throw new Error("工作区不可用");
        return tagDeleteRpc({ repoPath, name });
      });
    },
    [runAction, tagDeleteRpc],
  );

  const onAddWorktree = useCallback(
    (path: string, newBranch: string, ref: string) => {
      void runAction("worktree-add", "添加 worktree 失败", async () => {
        const repoPath = repoPathRef.current;
        if (!repoPath) throw new Error("工作区不可用");
        return worktreeAddRpc({ repoPath, path, newBranch, ref });
      });
    },
    [runAction, worktreeAddRpc],
  );

  const onRemoveWorktree = useCallback(
    (path: string, force: boolean) => {
      void runAction("worktree-remove", "移除 worktree 失败", async () => {
        const repoPath = repoPathRef.current;
        if (!repoPath) throw new Error("工作区不可用");
        return worktreeRemoveRpc({ repoPath, path, force });
      });
    },
    [runAction, worktreeRemoveRpc],
  );

  const onPruneWorktrees = useCallback(() => {
    void runAction("worktree-prune", "清理失败", async () => {
      const repoPath = repoPathRef.current;
      if (!repoPath) throw new Error("工作区不可用");
      return worktreePruneRpc({ repoPath });
    });
  }, [runAction, worktreePruneRpc]);

  const onLoadMore = useCallback(async () => {
    const repoPath = repoPathRef.current;
    if (!repoPath || !log?.ok || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await logRpc({
        repoPath,
        ref: scope,
        limit: PAGE_SIZE,
        skip: log.commits.length,
        path: pathFilter,
      });
      if (next.ok) {
        setLog({ ...next, commits: [...log.commits, ...next.commits] });
      } else if (next.error) {
        toast.error(next.error.split("\n")[0] ?? next.error);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, log, logRpc, pathFilter, scope, toast]);

  const branchActions: BranchActions = useMemo(
    () => ({
      onCheckout,
      onMerge: (ref) => {
        void runAction("merge", "合并失败", async () => {
          const repoPath = repoPathRef.current;
          if (!repoPath) throw new Error("工作区不可用");
          return mergeRpc({ repoPath, ref, noFf: false });
        });
      },
      onRebaseOnto: (ref) => {
        void runAction("rebase", "变基失败", async () => {
          const repoPath = repoPathRef.current;
          if (!repoPath) throw new Error("工作区不可用");
          return rebaseRpc({ repoPath, ref });
        });
      },
      onCreateBranchFrom: () => undefined, // handled inside BranchPane via its own dialog state
      onRenameBranch: (name, newName) => {
        void runAction("branch-rename", "重命名失败", async () => {
          const repoPath = repoPathRef.current;
          if (!repoPath) throw new Error("工作区不可用");
          return branchRenameRpc({ repoPath, name, newName });
        });
      },
      onDeleteBranch: (branch) => onDeleteBranch(branch.shortName, false),
    }),
    [branchRenameRpc, mergeRpc, onCheckout, onDeleteBranch, rebaseRpc, runAction],
  );

  const commitActions: CommitActions = useMemo(
    () => ({
      onCherryPick: (hash) => {
        void runAction("cherry-pick", "拣选失败", async () => {
          const repoPath = repoPathRef.current;
          if (!repoPath) throw new Error("工作区不可用");
          return cherryPickRpc({ repoPath, hashes: [hash] });
        });
      },
      onCheckoutCommit: (hash) => onCheckout(hash),
      onReset: (hash, mode) => {
        if (mode === "hard") {
          setHardResetTarget(hash);
          return;
        }
        void runAction(`reset-${mode}`, "重置失败", async () => {
          const repoPath = repoPathRef.current;
          if (!repoPath) throw new Error("工作区不可用");
          return resetRpc({ repoPath, hash, mode });
        });
      },
      onRevert: (hash) => {
        void runAction("revert", "还原失败", async () => {
          const repoPath = repoPathRef.current;
          if (!repoPath) throw new Error("工作区不可用");
          return revertRpc({ repoPath, hash });
        });
      },
      onCreateBranchHere: () => undefined, // BranchPane owns the dialog
      onCreateTagHere: () => undefined, // BranchPane owns the dialog
    }),
    [cherryPickRpc, onCheckout, resetRpc, revertRpc, runAction],
  );

  const onSequenceAction = useCallback(
    (action: "continue" | "skip" | "abort") => {
      const kind = sequence?.kind;
      if (!kind || kind === "none") return;
      void runAction(`seq-${action}`, "操作失败", async () => {
        const repoPath = repoPathRef.current;
        if (!repoPath) throw new Error("工作区不可用");
        return sequenceActionRpc({ repoPath, sequence: kind, action });
      });
    },
    [runAction, sequence, sequenceActionRpc],
  );

  const visibleCommits = useMemo(() => {
    const commits = log?.ok ? log.commits : [];
    const needle = search.trim().toLowerCase();
    const from = dateFrom.trim();
    const to = dateTo.trim();
    return commits.filter((commit) => {
      if (authorFilter.length > 0 && commit.authorName !== authorFilter) return false;
      if (from.length > 0 || to.length > 0) {
        const key = localDateKey(commit.authorDate);
        if (key.length === 0) return false;
        if (from.length > 0 && isDateKey(from) && key < from) return false;
        if (to.length > 0 && isDateKey(to) && key > to) return false;
      }
      if (needle.length === 0) return true;
      return (
        commit.subject.toLowerCase().includes(needle) ||
        commit.authorName.toLowerCase().includes(needle) ||
        commit.authorEmail.toLowerCase().includes(needle) ||
        commit.hash.toLowerCase().startsWith(needle) ||
        commit.shortHash.toLowerCase().startsWith(needle)
      );
    });
  }, [authorFilter, dateFrom, dateTo, log, search]);

  const authors = useMemo(() => {
    const commits = log?.ok ? log.commits : [];
    const counts = new Map<string, number>();
    for (const commit of commits) {
      counts.set(commit.authorName, (counts.get(commit.authorName) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [log]);

  const notARepo = status !== null && !status.ok && /not a git repository/i.test(status.error ?? "");
  const loading = status === null && directory !== null;
  const dirtyCount = status?.ok ? status.staged + status.unstaged + status.untracked : 0;
  const sequenceActive = sequence?.ok === true && sequence.kind !== "none" ? sequence : null;

  const branchPane = directory ? (
    <BranchPane
      theme={theme}
      directory={directory}
      status={status}
      branches={branches}
      tags={tags}
      worktrees={worktrees}
      scope={scope}
      busy={busy}
      onSelectScope={(ref) => {
        setScope((current) => (current === ref ? "ALL" : ref));
        setShowBranchesModal(false);
      }}
      onFetch={onFetch}
      onPull={onPull}
      onPush={onPush}
      onRefresh={() => void refresh()}
      onCreateBranch={onCreateBranch}
      onDeleteBranch={onDeleteBranch}
      onCreateTag={onCreateTag}
      onDeleteTag={onDeleteTag}
      onAddWorktree={onAddWorktree}
      onRemoveWorktree={onRemoveWorktree}
      onPruneWorktrees={onPruneWorktrees}
      actions={branchActions}
      onOpenChanges={() => setMainTab("changes")}
    />
  ) : null;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0, minWidth: 0 }}>
      {/* Top tabs: log / working tree */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 2,
          paddingHorizontal: 6,
          minHeight: 30,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        }}
      >
        <MainTab theme={theme} label="日志" icon="History" active={mainTab === "log"} onPress={() => setMainTab("log")} />
        <MainTab
          theme={theme}
          label="改动"
          icon="FileDiff"
          badge={dirtyCount > 0 ? dirtyCount : undefined}
          active={mainTab === "changes"}
          onPress={() => setMainTab("changes")}
        />
        {sequenceActive ? (
          <SequenceBanner theme={theme} sequence={sequenceActive} busy={busy !== null} onAction={onSequenceAction} />
        ) : null}
        <View style={{ marginLeft: "auto", minWidth: 20, alignItems: "center", paddingRight: 4 }}>
          {busy !== null && !sequenceActive ? (
            <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
          ) : null}
        </View>
      </View>

      <View style={{ flex: 1, flexDirection: "row", minWidth: 0 }}>
        {layout.compact ? (
          <Modal open={showBranchesModal} onOpenChange={setShowBranchesModal} title="分支" icon={<Icon name="GitBranch" size={16} color={theme.colors.accent} />}>
            <Modal.Content scrollable={false} style={{ flex: 1 }}>
              {branchPane}
            </Modal.Content>
          </Modal>
        ) : (
          <View style={{ width: 248, borderRightWidth: 1, borderRightColor: theme.colors.border }}>{branchPane}</View>
        )}

        <View style={{ flex: 1, flexDirection: "column", minWidth: 0 }}>
          {mainTab === "changes" ? (
            <CommitPanel
              theme={theme}
              repoPath={directory}
              compact={layout.compact}
              refreshKey={commitRefreshKey}
              onMutated={() => void refresh({ quiet: true })}
              onCommitAndPush={() => void onPush(false)}
            />
          ) : notARepo ? (
            <EmptyState theme={theme} directory={directory ?? ""} />
          ) : (
            <>
              {/* Toolbar — filters sit inline, like IDEA's Git Log filter bar */}
              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  alignItems: "center",
                  columnGap: 6,
                  rowGap: 4,
                  paddingHorizontal: 8,
                  paddingVertical: 5,
                  borderBottomWidth: 1,
                  borderBottomColor: theme.colors.border,
                }}
              >
                {layout.compact ? (
                  <HoverPressable
                    accessibilityRole="button"
                    accessibilityLabel="查看分支"
                    onPress={() => setShowBranchesModal(true)}
                    style={({ hovered }) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 4,
                      paddingHorizontal: 8,
                      paddingVertical: 4,
                      borderRadius: 6,
                      borderWidth: 1,
                      borderColor: theme.colors.border,
                      backgroundColor: hovered ? theme.colors.surface1 : "transparent",
                    })}
                  >
                    <Icon name="GitBranch" size={12} color={theme.colors.accent} />
                    <Text style={{ color: theme.colors.foreground, fontSize: 11, fontFamily: MONO_FONT }} numberOfLines={1}>
                      {status?.currentBranch ?? (status?.detached ? "分离头指针" : "…")}
                    </Text>
                  </HoverPressable>
                ) : null}

                <BranchScopeDropdown
                  theme={theme}
                  branches={branches}
                  tags={tags}
                  status={status}
                  scope={scope}
                  onChange={(ref) => setScope(ref)}
                />

                <AuthorDropdown
                  theme={theme}
                  authors={authors}
                  value={authorFilter}
                  onChange={(value) => setAuthorFilter(value === authorFilter ? "" : value)}
                />

                <DateRangeDropdown theme={theme} from={dateFrom} to={dateTo} onFrom={setDateFrom} onTo={setDateTo} />

                <PathDropdown theme={theme} repoPath={directory} value={pathFilter} onChange={setPathFilter} />

                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                    borderRadius: 6,
                    paddingHorizontal: 6,
                    paddingVertical: 4,
                    backgroundColor: theme.colors.surface1,
                    flex: 1,
                    minWidth: 130,
                    maxWidth: 230,
                  }}
                >
                  <Icon name="Search" size={11} color={theme.colors.foregroundMuted} />
                  <TextInput
                    value={search}
                    onChangeText={setSearch}
                    placeholder="搜索提交 / 作者 / 哈希…"
                    placeholderTextColor={theme.colors.foregroundMuted}
                    style={{
                      color: theme.colors.foreground,
                      fontSize: 11,
                      paddingVertical: 1,
                      flex: 1,
                      minWidth: 0,
                    }}
                  />
                </View>

                <View style={{ marginLeft: "auto", minWidth: 20, alignItems: "center" }}>
                  {busy !== null ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
                </View>
              </View>

              {/* Main area */}
              <View style={{ flex: 1, flexDirection: "column", minWidth: 0 }}>
                <ScrollView style={{ flex: 1 }} contentContainerStyle={{ minWidth: 560 }}>
                  <CommitList
                    theme={theme}
                    commits={visibleCommits}
                    selectedHash={selectedHash}
                    onSelect={setSelectedHash}
                    loading={loading}
                    loadingMore={loadingMore}
                    hasMore={log?.ok ? log.hasMore : false}
                    onLoadMore={onLoadMore}
                    totalCount={log?.ok ? log.commits.length : 0}
                    actions={commitActions}
                  />
                </ScrollView>
                {selectedHash ? (
                  <CommitDetails
                    theme={theme}
                    detail={detail}
                    loading={detailLoading}
                    onClose={() => setSelectedHash(null)}
                    repoPath={directory}
                  />
                ) : null}
              </View>
            </>
          )}
        </View>
      </View>

      <ConfirmDialog
        theme={theme}
        open={pushSetupBranch !== null}
        onOpenChange={(open) => {
          if (!open) setPushSetupBranch(null);
        }}
        title="建立上游并推送"
        message={`分支 ${pushSetupBranch || ""} 没有上游分支，是否推送到 origin 并建立跟踪？`}
        detail={`git push -u origin ${pushSetupBranch || ""}`}
        mono
        confirmLabel="推送"
        onConfirm={() => void onPush(true)}
      />

      <ConfirmDialog
        theme={theme}
        open={hardResetTarget !== null}
        onOpenChange={(open) => {
          if (!open) setHardResetTarget(null);
        }}
        title="硬重置"
        message={`确定硬重置到 ${hardResetTarget?.slice(0, 8) ?? ""} 吗？该提交之后的所有提交将从当前分支消失，未提交改动也将丢弃。`}
        detail={hardResetTarget ?? ""}
        mono
        confirmLabel="硬重置"
        danger
        onConfirm={() => {
          const target = hardResetTarget;
          setHardResetTarget(null);
          if (target) {
            void runAction("reset-hard", "重置失败", async () => {
              const repoPath = repoPathRef.current;
              if (!repoPath) throw new Error("工作区不可用");
              return resetRpc({ repoPath, hash: target, mode: "hard" });
            });
          }
        }}
      />
    </View>
  );
}

function MainTab({
  theme,
  label,
  icon,
  badge,
  active,
  onPress,
}: {
  theme: PanelTheme;
  label: string;
  icon: string;
  badge?: number;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <HoverPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ hovered }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
        backgroundColor: active ? theme.colors.surface2 : hovered ? theme.colors.surface1 : "transparent",
      })}
    >
      <Icon name={icon} size={12} color={active ? theme.colors.foreground : theme.colors.foregroundMuted} />
      <Text style={{ color: active ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 11, fontWeight: active ? "600" : "400" }}>
        {label}
      </Text>
      {typeof badge === "number" ? (
        <View
          style={{
            backgroundColor: theme.colors.accent,
            borderRadius: 7,
            minWidth: 14,
            paddingHorizontal: 3,
            height: 14,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: theme.colors.accentForeground, fontSize: 8.5, fontWeight: "700" }}>
            {badge > 99 ? "99+" : badge}
          </Text>
        </View>
      ) : null}
    </HoverPressable>
  );
}

function SequenceBanner({
  theme,
  sequence,
  busy,
  onAction,
}: {
  theme: PanelTheme;
  sequence: SequenceState;
  busy: boolean;
  onAction: (action: "continue" | "skip" | "abort") => void;
}) {
  const labels: Record<string, string> = {
    merge: "正在合并",
    rebase: "正在变基",
    cherryPick: "正在拣选",
  };
  const kinds: Record<string, "merge" | "rebase" | "cherryPick"> = {
    merge: "merge",
    rebase: "rebase",
    cherryPick: "cherryPick",
  };
  const kind = kinds[sequence.kind] ?? "merge";
  let text = labels[sequence.kind] ?? "操作进行中";
  if (sequence.branch) text += ` ${sequence.branch}`;
  if (sequence.kind === "rebase" && sequence.step !== null && sequence.total !== null) {
    text += `（${sequence.step}/${sequence.total}）`;
  }
  if (sequence.conflicts.length > 0) text += ` · ${sequence.conflicts.length} 个未解决冲突`;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        marginLeft: 8,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
        backgroundColor: mixAccent(theme),
        borderWidth: 1,
        borderColor: theme.colors.statusWarning,
        maxWidth: 380,
        flexShrink: 1,
      }}
    >
      <Icon name="TriangleAlert" size={12} color={theme.colors.statusWarning} />
      <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 10.5, flexShrink: 1 }}>
        {text}
      </Text>
      <BannerButton theme={theme} label="继续" icon="Play" color={theme.colors.statusSuccess} disabled={busy} onPress={() => onAction("continue")} />
      {kind !== "merge" ? (
        <BannerButton theme={theme} label="跳过" icon="SkipForward" color={theme.colors.statusWarning} disabled={busy} onPress={() => onAction("skip")} />
      ) : null}
      <BannerButton theme={theme} label="中止" icon="Square" color={theme.colors.statusDanger} disabled={busy} onPress={() => onAction("abort")} />
    </View>
  );
}

function mixAccent(theme: PanelTheme): string {
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  const a = theme.colors.statusWarning.replace("#", "");
  const s = theme.colors.surface0.replace("#", "");
  const mix = (i: number) => Math.round(Number.parseInt(a.slice(i, i + 2), 16) * 0.12 + Number.parseInt(s.slice(i, i + 2), 16) * 0.88);
  return `#${hex(mix(0))}${hex(mix(2))}${hex(mix(4))}`;
}

function BannerButton({
  theme,
  label,
  icon,
  color,
  disabled,
  onPress,
}: {
  theme: PanelTheme;
  label: string;
  icon: string;
  color: string;
  disabled: boolean;
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
        gap: 3,
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 5,
        opacity: disabled ? 0.5 : hovered ? 0.85 : 1,
        borderWidth: 1,
        borderColor: color,
      })}
    >
      <Icon name={icon} size={10} color={color} />
      <Text style={{ color, fontSize: 10, fontWeight: "600" }}>{label}</Text>
    </HoverPressable>
  );
}

function EmptyState({ theme, directory }: { theme: PanelTheme; directory: string }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 8 }}>
      <Icon name="Folder" size={22} color={theme.colors.foregroundMuted} />
      <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
        当前工作区不是 Git 仓库
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: MONO_FONT }}>
        {directory}
      </Text>
    </View>
  );
}
