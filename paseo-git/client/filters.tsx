import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Dimensions, Text, View } from "react-native";
import { Icon, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { hashStringColor, mixWithBackground } from "./colors";
import { isDateKey } from "./format";
import { HoverPressable, MONO_FONT, type PanelTheme } from "./parts";
import { gitPathsRpc } from "../shared/contracts";
import type { BranchesResult, PathsResult, StatusResult } from "../shared/types";


/** Fit a dialog inside the current window; keeps phones from clipping. */
function dialogWidth(max: number): number {
  const screen = Dimensions.get("window").width;
  return Math.max(240, Math.min(max, screen - 28));
}

function dialogHeight(max: number): number {
  const screen = Dimensions.get("window").height;
  return Math.min(max, Math.max(280, screen * 0.64));
}

/** The pill every filter control in the toolbar is made of. */
export function DropdownChip({
  theme,
  icon,
  label,
  active,
  maxWidth = 190,
  onPress,
}: {
  theme: PanelTheme;
  icon: string;
  label: string;
  active: boolean;
  maxWidth?: number;
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
        gap: 4,
        borderWidth: 1,
        borderColor: active ? theme.colors.accent : theme.colors.border,
        borderRadius: 6,
        paddingHorizontal: 6,
        paddingVertical: 4,
        backgroundColor: active
          ? mixWithBackground(theme.colors.accent, theme.colors.surface0, 0.88)
          : theme.colors.surface1,
        maxWidth,
      })}
    >
      <Icon name={icon} size={11} color={active ? theme.colors.accent : theme.colors.foregroundMuted} />
      <Text
        numberOfLines={1}
        style={{
          color: active ? theme.colors.foreground : theme.colors.foregroundMuted,
          fontSize: 10.5,
          flexShrink: 1,
        }}
      >
        {label}
      </Text>
      <Icon name="ChevronDown" size={11} color={theme.colors.foregroundMuted} />
    </HoverPressable>
  );
}

function ClearButton({ theme, label, onPress }: { theme: PanelTheme; label: string; onPress: () => void }) {
  return (
    <HoverPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      style={({ hovered }) => ({
        width: 18,
        height: 18,
        borderRadius: 4,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: hovered ? theme.colors.surface2 : "transparent",
      })}
    >
      <Icon name="X" size={11} color={theme.colors.foregroundMuted} />
    </HoverPressable>
  );
}

function OptionRow({
  theme,
  icon,
  label,
  detail,
  color,
  selected,
  onPress,
  trailing,
}: {
  theme: PanelTheme;
  icon?: string;
  label: string;
  detail?: string;
  color?: string;
  selected: boolean;
  onPress: () => void;
  trailing?: boolean;
}) {
  const tint = color ?? theme.colors.foregroundMuted;
  return (
    <HoverPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ hovered }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 8,
        paddingVertical: 6,
        borderRadius: 6,
        backgroundColor: selected
          ? mixWithBackground(tint, theme.colors.surface0, 0.86)
          : hovered
            ? theme.colors.surface1
            : "transparent",
      })}
    >
      {icon ? (
        <Icon name={icon} size={12} color={tint} />
      ) : (
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tint }} />
      )}
      <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 11, flex: 1 }}>
        {label}
      </Text>
      {detail ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontFamily: MONO_FONT }}>{detail}</Text>
      ) : null}
      {selected ? <Icon name="Check" size={12} color={theme.colors.accent} /> : null}
      {trailing && !selected ? <Icon name="ChevronRight" size={12} color={theme.colors.foregroundMuted} /> : null}
    </HoverPressable>
  );
}

// ---------------------------------------------------------------------------
// branch scope
// ---------------------------------------------------------------------------

export function BranchScopeDropdown({
  theme,
  branches,
  status,
  scope,
  onChange,
}: {
  theme: PanelTheme;
  branches: BranchesResult | null;
  status: StatusResult | null;
  scope: string;
  onChange: (ref: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const match = (name: string) => needle.length === 0 || name.toLowerCase().includes(needle);
  const locals = (branches?.locals ?? []).filter((branch) => match(branch.shortName));
  const remotes = (branches?.remotes ?? []).filter((branch) => match(branch.shortName));
  const label =
    scope === "ALL" ? "所有分支" : scope.replace(/^refs\/(heads|remotes)\//, "");

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
      <DropdownChip
        theme={theme}
        icon="GitBranch"
        label={label}
        active={scope !== "ALL"}
        onPress={() => {
          setQuery("");
          setOpen(true);
        }}
      />
      {scope !== "ALL" ? (
        <ClearButton theme={theme} label="清除分支筛选" onPress={() => onChange("ALL")} />
      ) : null}

      <Modal
        open={open}
        onOpenChange={setOpen}
        title="按分支筛选"
        icon={<Icon name="GitBranch" size={16} color={theme.colors.accent} />}
      >
        <Modal.Content scrollable>
          <View style={{ paddingVertical: 6, gap: 8, width: dialogWidth(440) }}>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="搜索分支…"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{
                color: theme.colors.foreground,
                fontSize: 11,
                backgroundColor: theme.colors.surface1,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: theme.colors.border,
                paddingHorizontal: 8,
                paddingVertical: 5,
              }}
            />
            <View style={{ gap: 2 }}>
              <OptionRow
                theme={theme}
                icon="GitMerge"
                label="所有分支"
                detail={`${(branches?.locals.length ?? 0) + (branches?.remotes.length ?? 0)} 个引用`}
                selected={scope === "ALL"}
                onPress={() => {
                  onChange("ALL");
                  setOpen(false);
                }}
              />
              {locals.length > 0 ? (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, paddingHorizontal: 8, paddingTop: 6 }}>
                  本地（{locals.length}）
                </Text>
              ) : null}
              {locals.map((branch) => (
                <OptionRow
                  key={branch.name}
                  theme={theme}
                  label={branch.shortName}
                  color={hashStringColor(branch.name)}
                  detail={branch.isCurrent ? "当前" : branch.ahead ? `↑${branch.ahead}${branch.behind ? ` ↓${branch.behind}` : ""}` : undefined}
                  selected={scope === branch.name}
                  onPress={() => {
                    onChange(branch.name);
                    setOpen(false);
                  }}
                />
              ))}
              {remotes.length > 0 ? (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, paddingHorizontal: 8, paddingTop: 6 }}>
                  远程（{remotes.length}）
                </Text>
              ) : null}
              {remotes.map((branch) => (
                <OptionRow
                  key={branch.name}
                  theme={theme}
                  label={branch.shortName}
                  color={hashStringColor(branch.name)}
                  selected={scope === branch.name}
                  onPress={() => {
                    onChange(branch.name);
                    setOpen(false);
                  }}
                />
              ))}
              {locals.length === 0 && remotes.length === 0 ? (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, paddingVertical: 6 }}>
                  {status?.ok === false ? "读取分支失败" : "没有匹配的分支"}
                </Text>
              ) : null}
            </View>
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}

// ---------------------------------------------------------------------------
// author
// ---------------------------------------------------------------------------

export function AuthorDropdown({
  theme,
  authors,
  value,
  onChange,
}: {
  theme: PanelTheme;
  authors: readonly (readonly [string, number])[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const filtered = authors.filter(([name]) => needle.length === 0 || name.toLowerCase().includes(needle));
  const active = value.length > 0;
  const color = active ? hashStringColor(value) : theme.colors.foregroundMuted;

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
      <HoverPressable
        accessibilityRole="button"
        accessibilityLabel={`按作者筛选（当前：${value || "全部"}）`}
        onPress={() => {
          setQuery("");
          setOpen(true);
        }}
        style={({ hovered }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          borderWidth: 1,
          borderColor: active ? color : theme.colors.border,
          borderRadius: 6,
          paddingHorizontal: 6,
          paddingVertical: 4,
          backgroundColor: active
            ? mixWithBackground(color, theme.colors.surface0, 0.85)
            : hovered
              ? theme.colors.surface2
              : theme.colors.surface1,
          maxWidth: 190,
        })}
      >
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />
        <Text
          numberOfLines={1}
          style={{ color: active ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 10.5, flexShrink: 1 }}
        >
          {active ? value : "作者"}
        </Text>
        <Icon name="ChevronDown" size={11} color={theme.colors.foregroundMuted} />
      </HoverPressable>
      {active ? <ClearButton theme={theme} label="清除作者筛选" onPress={() => onChange("")} /> : null}

      <Modal
        open={open}
        onOpenChange={setOpen}
        title="按作者筛选"
        icon={<Icon name="User" size={16} color={theme.colors.accent} />}
      >
        <Modal.Content scrollable>
          <View style={{ paddingVertical: 6, gap: 8, width: dialogWidth(420) }}>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="搜索作者…"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{
                color: theme.colors.foreground,
                fontSize: 11,
                backgroundColor: theme.colors.surface1,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: theme.colors.border,
                paddingHorizontal: 8,
                paddingVertical: 5,
              }}
            />
            <View style={{ gap: 2 }}>
              <OptionRow
                theme={theme}
                label="全部作者"
                detail={`${authors.reduce((sum, [, count]) => sum + count, 0)} 条`}
                selected={!active}
                onPress={() => {
                  onChange("");
                  setOpen(false);
                }}
              />
              {filtered.map(([name, count]) => (
                <OptionRow
                  key={name}
                  theme={theme}
                  label={name}
                  detail={`${count} 条`}
                  color={hashStringColor(name)}
                  selected={value === name}
                  onPress={() => {
                    onChange(name);
                    setOpen(false);
                  }}
                />
              ))}
              {filtered.length === 0 ? (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, paddingVertical: 6 }}>
                  没有匹配的作者（列表来自已加载的提交）
                </Text>
              ) : null}
            </View>
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}

// ---------------------------------------------------------------------------
// date range with calendar
// ---------------------------------------------------------------------------

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function formatDay(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDay(key: string): Date | null {
  if (!isDateKey(key)) return null;
  const date = new Date(`${key}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

interface CalendarCell {
  key: string;
  day: number;
  inMonth: boolean;
}

function monthCells(year: number, month: number): CalendarCell[] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7; // Monday-first
  const start = new Date(year, month, 1 - offset);
  const cells: CalendarCell[] = [];
  for (let i = 0; i < 42; i += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({
      key: formatDay(date),
      day: date.getDate(),
      inMonth: date.getMonth() === month,
    });
  }
  return cells;
}

export function DateRangeDropdown({
  theme,
  from,
  to,
  onFrom,
  onTo,
}: {
  theme: PanelTheme;
  from: string;
  to: string;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(() => {
    const anchor = parseDay(from) ?? new Date();
    return { year: anchor.getFullYear(), month: anchor.getMonth() };
  });

  const active = from.length > 0 || to.length > 0;
  const cells = useMemo(() => monthCells(cursor.year, cursor.month), [cursor]);
  const todayKey = formatDay(new Date());

  const setRange = (nextFrom: string, nextTo: string) => {
    onFrom(nextFrom);
    onTo(nextTo);
  };

  const shiftMonth = (delta: number) => {
    setCursor((current) => {
      const date = new Date(current.year, current.month + delta, 1);
      return { year: date.getFullYear(), month: date.getMonth() };
    });
  };

  const pickDay = (key: string) => {
    if (!from || (from && to)) {
      onFrom(key);
      onTo("");
      return;
    }
    if (key < from) {
      onFrom(key);
      return;
    }
    onTo(key === from ? from : key);
  };

  const preset = (days: number | "thisMonth") => {
    const today = new Date();
    if (days === "thisMonth") {
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      setRange(formatDay(first), todayKey);
    } else if (days === 0) {
      setRange(todayKey, todayKey);
    } else {
      const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - days);
      setRange(formatDay(start), todayKey);
    }
  };

  const label = active
    ? `${from ? from.slice(5) : "…"} ~ ${to ? to.slice(5) : "…"}`
    : "日期";

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
      <DropdownChip
        theme={theme}
        icon="Calendar"
        label={label}
        active={active}
        onPress={() => {
          const anchor = parseDay(from) ?? new Date();
          setCursor({ year: anchor.getFullYear(), month: anchor.getMonth() });
          setOpen(true);
        }}
      />
      {active ? <ClearButton theme={theme} label="清除日期筛选" onPress={() => setRange("", "")} /> : null}

      <Modal
        open={open}
        onOpenChange={setOpen}
        title="按日期筛选（本地时间）"
        icon={<Icon name="Calendar" size={16} color={theme.colors.accent} />}
      >
        <Modal.Content scrollable={false}>
          <View style={{ paddingVertical: 8, gap: 10, width: dialogWidth(330) }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {(
                [
                  ["今天", 0],
                  ["昨天", 1],
                  ["最近 7 天", 6],
                  ["最近 30 天", 29],
                  ["本月", "thisMonth" as const],
                ] as const
              ).map(([title, days]) => (
                <HoverPressable
                  key={title}
                  accessibilityRole="button"
                  accessibilityLabel={title}
                  onPress={() => preset(days)}
                  style={({ hovered }) => ({
                    paddingHorizontal: 9,
                    paddingVertical: 4,
                    borderRadius: 6,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                    backgroundColor: hovered ? theme.colors.surface1 : "transparent",
                  })}
                >
                  <Text style={{ color: theme.colors.foreground, fontSize: 10.5 }}>{title}</Text>
                </HoverPressable>
              ))}
            </View>

            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <HoverPressable
                accessibilityRole="button"
                accessibilityLabel="上个月"
                onPress={() => shiftMonth(-1)}
                style={({ hovered }) => ({
                  width: 26,
                  height: 26,
                  borderRadius: 6,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: hovered ? theme.colors.surface1 : "transparent",
                })}
              >
                <Icon name="ChevronLeft" size={14} color={theme.colors.foregroundMuted} />
              </HoverPressable>
              <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
                {cursor.year} 年 {cursor.month + 1} 月
              </Text>
              <HoverPressable
                accessibilityRole="button"
                accessibilityLabel="下个月"
                onPress={() => shiftMonth(1)}
                style={({ hovered }) => ({
                  width: 26,
                  height: 26,
                  borderRadius: 6,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: hovered ? theme.colors.surface1 : "transparent",
                })}
              >
                <Icon name="ChevronRight" size={14} color={theme.colors.foregroundMuted} />
              </HoverPressable>
            </View>

            <View>
              <View style={{ flexDirection: "row" }}>
                {WEEKDAYS.map((weekday) => (
                  <View key={weekday} style={{ flex: 1, alignItems: "center", paddingVertical: 3 }}>
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>{weekday}</Text>
                  </View>
                ))}
              </View>
              {Array.from({ length: 6 }, (_, week) => (
                <View key={week} style={{ flexDirection: "row" }}>
                  {cells.slice(week * 7, week * 7 + 7).map((cell) => {
                    const isFrom = cell.key === from && from.length > 0;
                    const isTo = cell.key === to && to.length > 0;
                    const inRange =
                      from.length > 0 && to.length > 0 && cell.key > from && cell.key < to;
                    const isToday = cell.key === todayKey;
                    const filled = isFrom || isTo;
                    return (
                      <HoverPressable
                        key={cell.key}
                        accessibilityRole="button"
                        accessibilityLabel={cell.key}
                        disabled={!cell.inMonth}
                        onPress={() => pickDay(cell.key)}
                        style={() => ({
                          flex: 1,
                          aspectRatio: 46 / 34,
                          alignItems: "center",
                          justifyContent: "center",
                          borderRadius: 6,
                          opacity: cell.inMonth ? 1 : 0.25,
                          backgroundColor: filled
                            ? theme.colors.accent
                            : inRange
                              ? mixWithBackground(theme.colors.accent, theme.colors.surface0, 0.82)
                              : "transparent",
                          borderWidth: isToday && !filled ? 1 : 0,
                          borderColor: theme.colors.accent,
                        })}
                      >
                        <Text
                          style={{
                            color: filled
                              ? theme.colors.accentForeground
                              : cell.inMonth
                                ? theme.colors.foreground
                                : theme.colors.foregroundMuted,
                            fontSize: 11,
                            fontFamily: MONO_FONT,
                          }}
                        >
                          {cell.day}
                        </Text>
                      </HoverPressable>
                    );
                  })}
                </View>
              ))}
            </View>

            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
                先点起始日，再点结束日；单日只点一次后重复点当天即可
              </Text>
              <HoverPressable
                accessibilityRole="button"
                onPress={() => setOpen(false)}
                style={({ hovered }) => ({
                  paddingHorizontal: 14,
                  paddingVertical: 6,
                  borderRadius: 6,
                  backgroundColor: theme.colors.accent,
                  opacity: hovered ? 0.85 : 1,
                })}
              >
                <Text style={{ color: theme.colors.accentForeground, fontSize: 11 }}>完成</Text>
              </HoverPressable>
            </View>
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}

// ---------------------------------------------------------------------------
// path browser
// ---------------------------------------------------------------------------

export function PathDropdown({
  theme,
  repoPath,
  value,
  onChange,
}: {
  theme: PanelTheme;
  repoPath: string | null;
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState("");
  const [result, setResult] = useState<PathsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [manual, setManual] = useState("");
  const pathsRpc = useRpc(gitPathsRpc);

  const load = useCallback(
    async (target: string) => {
      if (!repoPath) return;
      setLoading(true);
      try {
        const next = await pathsRpc({ repoPath, dir: target });
        setResult(next);
        if (next.ok) setDir(next.dir);
      } catch {
        setResult({ ok: false, error: "读取目录失败", dir: target, dirs: [], files: [] });
      } finally {
        setLoading(false);
      }
    },
    [pathsRpc, repoPath],
  );

  useEffect(() => {
    if (open && result === null) {
      void load("");
    }
  }, [load, open, result]);

  const crumbs = dir.length > 0 ? dir.split("/") : [];
  const select = (path: string) => {
    onChange(path);
    setOpen(false);
  };

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
      <DropdownChip
        theme={theme}
        icon="Folder"
        label={value.length > 0 ? value : "路径"}
        active={value.trim().length > 0}
        onPress={() => {
          setManual("");
          setOpen(true);
          if (result === null) void load("");
        }}
      />
      {value.trim().length > 0 ? (
        <ClearButton theme={theme} label="清除路径筛选" onPress={() => onChange("")} />
      ) : null}

      <Modal
        open={open}
        onOpenChange={setOpen}
        title="按路径筛选"
        icon={<Icon name="Folder" size={16} color={theme.colors.accent} />}
      >
        <Modal.Content scrollable={false}>
          <View style={{ paddingVertical: 8, gap: 8, width: dialogWidth(390), height: dialogHeight(430) }}>
            {/* breadcrumb */}
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 2 }}>
              <HoverPressable
                accessibilityRole="button"
                accessibilityLabel="仓库根目录"
                onPress={() => void load("")}
                style={({ hovered }) => ({
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  borderRadius: 4,
                  backgroundColor: hovered ? theme.colors.surface1 : "transparent",
                })}
              >
                <Text style={{ color: theme.colors.accent, fontSize: 11 }}>仓库根目录</Text>
              </HoverPressable>
              {crumbs.map((crumb, index) => (
                <View key={crumbs.slice(0, index + 1).join("/")} style={{ flexDirection: "row", alignItems: "center" }}>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}> / </Text>
                  <HoverPressable
                    accessibilityRole="button"
                    accessibilityLabel={crumb}
                    onPress={() => void load(crumbs.slice(0, index + 1).join("/"))}
                    style={({ hovered }) => ({
                      paddingHorizontal: 6,
                      paddingVertical: 2,
                      borderRadius: 4,
                      backgroundColor: hovered ? theme.colors.surface1 : "transparent",
                    })}
                  >
                    <Text style={{ color: theme.colors.accent, fontSize: 11, fontFamily: MONO_FONT }}>{crumb}</Text>
                  </HoverPressable>
                </View>
              ))}
              {dir.length > 0 ? (
                <HoverPressable
                  accessibilityRole="button"
                  accessibilityLabel={`选定当前目录 ${dir}`}
                  onPress={() => select(dir)}
                  style={({ hovered }) => ({
                    marginLeft: 6,
                    paddingHorizontal: 8,
                    paddingVertical: 2,
                    borderRadius: 4,
                    borderWidth: 1,
                    borderColor: theme.colors.accent,
                    backgroundColor: hovered ? mixWithBackground(theme.colors.accent, theme.colors.surface0, 0.85) : "transparent",
                  })}
                >
                  <Text style={{ color: theme.colors.accent, fontSize: 10 }}>选定此目录</Text>
                </HoverPressable>
              ) : null}
            </View>

            <View
              style={{
                flex: 1,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface1,
                padding: 4,
              }}
            >
              {loading ? (
                <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                  <ActivityIndicator color={theme.colors.foregroundMuted} />
                </View>
              ) : result?.ok ? (
                <ModalList theme={theme} result={result} onLoad={load} onSelect={select} />
              ) : (
                <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 8 }}>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                    {result?.error ?? "读取目录失败"}
                  </Text>
                </View>
              )}
            </View>

            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <TextInput
                value={manual}
                onChangeText={setManual}
                placeholder="或手动输入路径，如 src/"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={{
                  color: theme.colors.foreground,
                  fontSize: 11,
                  fontFamily: MONO_FONT,
                  backgroundColor: theme.colors.surface1,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  paddingHorizontal: 8,
                  paddingVertical: 5,
                  flex: 1,
                  minWidth: 0,
                }}
              />
              <HoverPressable
                accessibilityRole="button"
                accessibilityLabel="应用手动输入的路径"
                disabled={manual.trim().length === 0}
                onPress={() => select(manual.trim())}
                style={({ hovered }) => ({
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 6,
                  backgroundColor: theme.colors.accent,
                  opacity: hovered ? 0.85 : 1,
                })}
              >
                <Text style={{ color: theme.colors.accentForeground, fontSize: 11 }}>应用</Text>
              </HoverPressable>
            </View>
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}

function ModalList({
  theme,
  result,
  onLoad,
  onSelect,
}: {
  theme: PanelTheme;
  result: PathsResult;
  onLoad: (dir: string) => void;
  onSelect: (path: string) => void;
}) {
  return (
    <ModalScrollView>
      <View style={{ gap: 1 }}>
        {result.dirs.map((name) => {
          const fullPath = result.dir.length > 0 ? `${result.dir}/${name}` : name;
          return (
            <View key={fullPath} style={{ flexDirection: "row", alignItems: "center" }}>
              <View style={{ flex: 1 }}>
                <OptionRow
                  theme={theme}
                  icon="Folder"
                  label={name}
                  selected={false}
                  onPress={() => onSelect(fullPath)}
                />
              </View>
              <HoverPressable
                accessibilityRole="button"
                accessibilityLabel={`进入 ${name}`}
                onPress={() => onLoad(fullPath)}
                hitSlop={4}
                style={({ hovered }) => ({
                  width: 24,
                  height: 24,
                  borderRadius: 4,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: hovered ? theme.colors.surface2 : "transparent",
                })}
              >
                <Icon name="ChevronRight" size={13} color={theme.colors.foregroundMuted} />
              </HoverPressable>
            </View>
          );
        })}
        {result.files.map((name) => (
          <OptionRow
            key={name}
            theme={theme}
            icon="FileText"
            label={name}
            selected={false}
            onPress={() => onSelect(result.dir.length > 0 ? `${result.dir}/${name}` : name)}
          />
        ))}
        {result.dirs.length === 0 && result.files.length === 0 ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, padding: 8 }}>
            此目录下没有跟踪的文件
          </Text>
        ) : null}
      </View>
    </ModalScrollView>
  );
}

function ModalScrollView({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 4 }}>
      {children}
    </ScrollView>
  );
}
