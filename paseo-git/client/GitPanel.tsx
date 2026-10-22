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
import { BranchPane } from "./BranchPane";
import { CommitList } from "./CommitList";
import { CommitDetails } from "./CommitDetails";
import { isDateKey, localDateKey } from "./format";
import {
  AuthorDropdown,
  BranchScopeDropdown,
  DateRangeDropdown,
  PathDropdown,
} from "./filters";
import { HoverPressable, MONO_FONT, type PanelTheme } from "./parts";
import {
  gitBranchesRpc,
  gitCheckoutRpc,
  gitCommitRpc,
  gitFetchRpc,
  gitLogRpc,
  gitPullRpc,
  gitStatusRpc,
} from "../shared/contracts";
import type { BranchesResult, CommitDetail, CommitSummary, LogResult, StatusResult } from "../shared/types";

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

  const [status, setStatus] = useState<StatusResult | null>(null);
  const [branches, setBranches] = useState<BranchesResult | null>(null);
  const [log, setLog] = useState<LogResult | null>(null);
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
  const repoPathRef = useRef<string | null>(null);

  const refresh = useCallback(
    async (options: { quiet?: boolean } = {}) => {
      const repoPath = repoPathRef.current;
      if (!repoPath) return;
      if (!options.quiet) setBusy("refresh");
      try {
        const [nextStatus, nextBranches] = await Promise.all([
          statusRpc({ repoPath }),
          branchesRpc({ repoPath }),
        ]);
        setStatus(nextStatus);
        setBranches(nextBranches);
        if (nextStatus.ok) {
          const nextLog = await logRpc({ repoPath, ref: scope, limit: PAGE_SIZE, skip: 0, path: pathFilter });
          setLog(nextLog);
        }
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
    [branchesRpc, logRpc, pathFilter, scope, statusRpc, toast],
  );

  useEffect(() => {
    repoPathRef.current = directory ?? null;
    if (directory) {
      void refresh();
    } else {
      setStatus(null);
      setBranches(null);
      setLog(null);
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

  const branchPane = directory ? (
    <BranchPane
      theme={theme}
      directory={directory}
      status={status}
      branches={branches}
      scope={scope}
      busy={busy}
      onSelectScope={(ref) => {
        setScope((current) => (current === ref ? "ALL" : ref));
        setShowBranchesModal(false);
      }}
      onCheckout={onCheckout}
      onFetch={onFetch}
      onPull={onPull}
      onRefresh={() => void refresh()}
    />
  ) : null;

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: theme.colors.surface0, minWidth: 0 }}>
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

          <DateRangeDropdown
            theme={theme}
            from={dateFrom}
            to={dateTo}
            onFrom={setDateFrom}
            onTo={setDateTo}
          />

          <PathDropdown
            theme={theme}
            repoPath={directory}
            value={pathFilter}
            onChange={setPathFilter}
          />

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
            {busy !== null ? (
              <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
            ) : null}
          </View>
        </View>

        {/* Main area */}
        {notARepo ? (
          <EmptyState theme={theme} directory={directory ?? ""} />
        ) : (
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
              />
            </ScrollView>
            {selectedHash ? (
              <CommitDetails
                theme={theme}
                detail={detail}
                loading={detailLoading}
                onClose={() => setSelectedHash(null)}
              />
            ) : null}
          </View>
        )}
      </View>
    </View>
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
