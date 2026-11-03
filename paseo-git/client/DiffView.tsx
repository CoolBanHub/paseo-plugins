import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Text, View, type ScrollView as RNScrollView } from "react-native";
import { Icon, Modal, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { gitDiffRpc } from "../shared/contracts";
import { basename } from "./format";
import { IconButton, MONO_FONT, type PanelTheme } from "./parts";
import type { DiffResult } from "../shared/types";

/**
 * Inline unified-diff viewer shown in a modal — Paseo has no diff editor API,
 * so the panel renders the patch itself (IDEA's diff minus the side-by-side).
 */

type DiffLine =
  | { kind: "hunk"; text: string }
  | { kind: "add"; text: string; newLine: number }
  | { kind: "del"; text: string; oldLine: number }
  | { kind: "context"; text: string; oldLine: number; newLine: number };

export function parseUnifiedDiff(text: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("@@")) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (match) {
        oldLine = Number.parseInt(match[1] ?? "0", 10);
        newLine = Number.parseInt(match[2] ?? "0", 10);
      }
      lines.push({ kind: "hunk", text: raw });
      continue;
    }
    if (raw.startsWith("diff --git") || raw.startsWith("index ") || raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("\\ No newline")) {
      continue;
    }
    if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw.slice(1), newLine: newLine++ });
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "del", text: raw.slice(1), oldLine: oldLine++ });
    } else {
      const body = raw.startsWith(" ") ? raw.slice(1) : raw;
      lines.push({ kind: "context", text: body, oldLine: oldLine++, newLine: newLine++ });
    }
  }
  return lines;
}

export interface DiffRequest {
  mode: "worktree" | "staged" | "head" | "commit" | "stash";
  ref: string;
  path: string;
}

export function DiffView({
  theme,
  open,
  onOpenChange,
  repoPath,
  request,
}: {
  theme: PanelTheme;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoPath: string | null;
  request: DiffRequest | null;
}) {
  const diffRpc = useRpc(gitDiffRpc);
  const [result, setResult] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const hScrollRef = useRef<RNScrollView>(null);
  const [scrollX, setScrollX] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const maxScrollX = Math.max(0, contentWidth - viewportWidth);
  const canScrollX = maxScrollX > 1;
  const scrollStep = Math.max(160, Math.round(viewportWidth * 0.7));

  const scrollDiffBy = (delta: number) => {
    const next = Math.max(0, Math.min(maxScrollX, scrollX + delta));
    hScrollRef.current?.scrollTo({ x: next, animated: true });
    setScrollX(next);
  };

  useEffect(() => {
    if (!open || !repoPath || !request) return;
    let cancelled = false;
    setLoading(true);
    setResult(null);
    setScrollX(0);
    setContentWidth(0);
    hScrollRef.current?.scrollTo({ x: 0, animated: false });
    diffRpc({ repoPath, mode: request.mode, ref: request.ref, path: request.path, maxLines: 2000 })
      .then((next) => {
        if (!cancelled) setResult(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setResult({ ok: false, error: err instanceof Error ? err.message : String(err), text: "", truncated: false, binary: false });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, request?.mode, request?.path, request?.ref, repoPath]);

  const lines = useMemo(() => (result?.ok ? parseUnifiedDiff(result.text) : []), [result]);
  const title = request ? basename(request.path) : "差异";

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`差异 · ${title}`}
      icon={<Icon name="FileDiff" size={16} color={theme.colors.accent} />}
    >
      <Modal.Content scrollable={false}>
        <View style={{ gap: 6 }}>
          {request ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 26 }}>
              <Text
                numberOfLines={1}
                style={{ flex: 1, minWidth: 0, color: theme.colors.foregroundMuted, fontSize: 10, fontFamily: MONO_FONT }}
              >
                {request.path}
              </Text>
              {canScrollX ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9 }}>左右滑动</Text>
                  <IconButton
                    icon="ChevronLeft"
                    label="向左滚动差异"
                    theme={theme}
                    size={12}
                    disabled={scrollX <= 1}
                    onPress={() => scrollDiffBy(-scrollStep)}
                  />
                  <IconButton
                    icon="ChevronRight"
                    label="向右滚动差异"
                    theme={theme}
                    size={12}
                    disabled={scrollX >= maxScrollX - 1}
                    onPress={() => scrollDiffBy(scrollStep)}
                  />
                </View>
              ) : null}
            </View>
          ) : null}
          {loading ? (
            <View style={{ paddingVertical: 24, alignItems: "center", gap: 8 }}>
              <ActivityIndicator color={theme.colors.foregroundMuted} />
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>加载差异…</Text>
            </View>
          ) : null}
          {!loading && result && !result.ok ? (
            <Text style={{ color: theme.colors.statusDanger, fontSize: 11 }}>
              {result.error ?? "无法读取差异"}
            </Text>
          ) : null}
          {!loading && result?.ok && result.binary ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, paddingVertical: 16, textAlign: "center" }}>
              二进制文件，无法展示文本差异
            </Text>
          ) : null}
          {!loading && result?.ok && !result.binary && lines.length === 0 ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, paddingVertical: 16, textAlign: "center" }}>
              没有文本差异（未跟踪文件需先暂存）
            </Text>
          ) : null}
          {!loading && result?.ok && !result.binary && lines.length > 0 ? (
            <View
              style={{
                height: 420,
                alignSelf: "stretch",
                borderRadius: 6,
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface1,
                overflow: "hidden",
              }}
            >
              {/* The host modal caps its width (~520px), so the diff must fit
                  the dialog instead of using a window-derived width. Code lines
                  keep their natural width and scroll horizontally; the arrow
                  controls next to the path make that gesture discoverable. */}
              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 8 }} nestedScrollEnabled>
                <ScrollView
                  ref={hScrollRef}
                  horizontal
                  nestedScrollEnabled
                  scrollEventThrottle={16}
                  onScroll={(event) => setScrollX(event.nativeEvent.contentOffset.x)}
                  onContentSizeChange={(width) => setContentWidth(width)}
                  onLayout={(event) => setViewportWidth(event.nativeEvent.layout.width)}
                  contentContainerStyle={{ minWidth: "100%", alignItems: "flex-start" }}
                >
                  <View style={{ minWidth: "100%" }}>
                    {lines.map((line, index) => (
                      <DiffRow key={index} line={line} theme={theme} />
                    ))}
                  </View>
                </ScrollView>
                {result.truncated ? (
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, paddingVertical: 8, textAlign: "center" }}>
                    差异过长，已截断显示
                  </Text>
                ) : null}
              </ScrollView>
            </View>
          ) : null}
        </View>
      </Modal.Content>
    </Modal>
  );
}

function DiffRow({ line, theme }: { line: DiffLine; theme: PanelTheme }) {
  if (line.kind === "hunk") {
    return (
      <Text
        numberOfLines={1}
        style={{
          alignSelf: "stretch",
          color: theme.colors.foregroundMuted,
          fontSize: 10,
          lineHeight: 15,
          fontFamily: MONO_FONT,
          backgroundColor: theme.colors.surface2,
          paddingVertical: 2,
          paddingHorizontal: 8,
        }}
      >
        {line.text}
      </Text>
    );
  }
  const oldNo = line.kind === "add" ? "" : String(line.oldLine);
  const newNo = line.kind === "del" ? "" : String(line.newLine);
  const background =
    line.kind === "add"
      ? "rgba(106, 135, 89, 0.18)"
      : line.kind === "del"
        ? "rgba(193, 84, 80, 0.16)"
        : "transparent";
  const tint =
    line.kind === "add" ? "#7fb069" : line.kind === "del" ? "#d1675a" : theme.colors.foreground;
  return (
    <View style={{ flexDirection: "row", alignSelf: "stretch", backgroundColor: background }}>
      <Text style={{ width: 44, textAlign: "right", paddingRight: 6, color: theme.colors.foregroundMuted, fontSize: 10, lineHeight: 15, fontFamily: MONO_FONT, opacity: 0.7 }}>
        {oldNo}
      </Text>
      <Text style={{ width: 44, textAlign: "right", paddingRight: 8, color: theme.colors.foregroundMuted, fontSize: 10, lineHeight: 15, fontFamily: MONO_FONT, opacity: 0.7 }}>
        {newNo}
      </Text>
      <Text style={{ width: 12, textAlign: "center", color: tint, fontSize: 10.5, lineHeight: 15, fontFamily: MONO_FONT }}>
        {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
      </Text>
      <Text
        numberOfLines={1}
        style={{ flexShrink: 0, color: tint, fontSize: 10.5, lineHeight: 15, fontFamily: MONO_FONT, paddingRight: 8 }}
      >
        {line.text}
      </Text>
    </View>
  );
}
