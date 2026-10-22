import { useEffect, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { Icon, Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { mixWithBackground } from "./colors";
import { dialogWidth } from "./filters";
import { HoverPressable, MONO_FONT, type PanelTheme } from "./parts";

/** Modal-based create/confirm dialogs shared by the branch pane sections. */

const inputStyle = (theme: PanelTheme) => ({
  color: theme.colors.foreground,
  fontSize: 11,
  fontFamily: MONO_FONT,
  backgroundColor: theme.colors.surface1,
  borderRadius: 6,
  borderWidth: 1,
  borderColor: theme.colors.border,
  paddingHorizontal: 8,
  paddingVertical: 5,
});

function Field({
  theme,
  label,
  hint,
  children,
}: {
  theme: PanelTheme;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <View style={{ gap: 3 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>{label}</Text>
      {children}
      {hint ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9.5 }}>{hint}</Text>
      ) : null}
    </View>
  );
}

function DialogButton({
  theme,
  label,
  onPress,
  kind = "primary",
  disabled = false,
}: {
  theme: PanelTheme;
  label: string;
  onPress: () => void;
  kind?: "primary" | "ghost" | "danger";
  disabled?: boolean;
}) {
  const tint =
    kind === "danger"
      ? theme.colors.statusDanger
      : kind === "primary"
        ? theme.colors.accent
        : theme.colors.foreground;
  return (
    <HoverPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ hovered }) => ({
        paddingHorizontal: 14,
        paddingVertical: 6,
        borderRadius: 6,
        alignItems: "center",
        opacity: disabled ? 0.45 : hovered ? 0.85 : 1,
        backgroundColor:
          kind === "ghost"
            ? "transparent"
            : kind === "danger"
              ? mixWithBackground(tint, theme.colors.surface0, 0.2)
              : theme.colors.accent,
        borderWidth: kind === "ghost" ? 1 : 0,
        borderColor: theme.colors.border,
      })}
    >
      <Text
        style={{
          color: kind === "primary" ? theme.colors.accentForeground : tint,
          fontSize: 11,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
    </HoverPressable>
  );
}

function DialogFooter({ theme, children }: { theme: PanelTheme; children: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 8 }}>
      {children}
    </View>
  );
}

// ---------------------------------------------------------------------------
// confirm
// ---------------------------------------------------------------------------

export function ConfirmDialog({
  theme,
  open,
  onOpenChange,
  title,
  message,
  detail,
  mono,
  confirmLabel = "确认",
  forceLabel,
  danger = false,
  onConfirm,
}: {
  theme: PanelTheme;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  message: string;
  /** Second muted line, e.g. the branch/path the action targets. */
  detail?: string;
  /** Render the detail in the mono font (paths, refs). */
  mono?: boolean;
  confirmLabel?: string;
  /** When provided, show a "force" toggle and pass its state to onConfirm. */
  forceLabel?: string;
  danger?: boolean;
  onConfirm: (force: boolean) => void;
}) {
  const [force, setForce] = useState(false);
  useEffect(() => {
    if (open) setForce(false);
  }, [open]);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      icon={<Icon name={danger ? "TriangleAlert" : "Check"} size={16} color={danger ? theme.colors.statusDanger : theme.colors.accent} />}
    >
      <Modal.Content scrollable={false}>
        <View style={{ paddingVertical: 6, gap: 10, width: dialogWidth(360) }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 11.5, lineHeight: 17 }}>{message}</Text>
          {detail ? (
            <Text
              numberOfLines={2}
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 10.5,
                fontFamily: mono ? MONO_FONT : undefined,
              }}
            >
              {detail}
            </Text>
          ) : null}

          {forceLabel ? (
            <HoverPressable
              accessibilityRole="button"
              accessibilityLabel={forceLabel}
              onPress={() => setForce((value) => !value)}
              style={({ hovered }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingHorizontal: 8,
                paddingVertical: 5,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: hovered ? theme.colors.surface1 : "transparent",
              })}
            >
              <View
                style={{
                  width: 13,
                  height: 13,
                  borderRadius: 3,
                  borderWidth: 1,
                  borderColor: force ? theme.colors.statusDanger : theme.colors.border,
                  backgroundColor: force
                    ? mixWithBackground(theme.colors.statusDanger, theme.colors.surface0, 0.25)
                    : "transparent",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {force ? <Icon name="Check" size={9} color={theme.colors.statusDanger} /> : null}
              </View>
              <Text style={{ color: theme.colors.foreground, fontSize: 10.5 }}>{forceLabel}</Text>
            </HoverPressable>
          ) : null}

          <DialogFooter theme={theme}>
            <DialogButton theme={theme} label="取消" kind="ghost" onPress={() => onOpenChange(false)} />
            <DialogButton
              theme={theme}
              label={confirmLabel}
              kind={danger ? "danger" : "primary"}
              onPress={() => {
                onOpenChange(false);
                onConfirm(force);
              }}
            />
          </DialogFooter>
        </View>
      </Modal.Content>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// branch create
// ---------------------------------------------------------------------------

export function BranchCreateDialog({
  theme,
  open,
  onOpenChange,
  onCreate,
}: {
  theme: PanelTheme;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string, startPoint: string, checkout: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [startPoint, setStartPoint] = useState("HEAD");
  const [checkout, setCheckout] = useState(true);
  useEffect(() => {
    if (open) {
      setName("");
      setStartPoint("HEAD");
      setCheckout(true);
    }
  }, [open]);

  const trimmed = name.trim();
  const ready = trimmed.length > 0 && !trimmed.startsWith("-");

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="新建分支"
      icon={<Icon name="GitBranch" size={16} color={theme.colors.accent} />}
    >
      <Modal.Content scrollable={false}>
        <View style={{ paddingVertical: 6, gap: 10, width: dialogWidth(380) }}>
          <Field theme={theme} label="分支名">
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="如 feature/login"
              placeholderTextColor={theme.colors.foregroundMuted}
              autoFocus
              style={inputStyle(theme)}
            />
          </Field>
          <Field theme={theme} label="起点" hint="分支或提交，默认当前 HEAD">
            <TextInput
              value={startPoint}
              onChangeText={setStartPoint}
              placeholder="HEAD"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={inputStyle(theme)}
            />
          </Field>
          <HoverPressable
            accessibilityRole="button"
            accessibilityLabel="创建后检出该分支"
            onPress={() => setCheckout((value) => !value)}
            style={({ hovered }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingHorizontal: 8,
              paddingVertical: 5,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: hovered ? theme.colors.surface1 : "transparent",
            })}
          >
            <View
              style={{
                width: 13,
                height: 13,
                borderRadius: 3,
                borderWidth: 1,
                borderColor: checkout ? theme.colors.accent : theme.colors.border,
                backgroundColor: checkout ? theme.colors.accent : "transparent",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {checkout ? <Icon name="Check" size={9} color={theme.colors.accentForeground} /> : null}
            </View>
            <Text style={{ color: theme.colors.foreground, fontSize: 10.5 }}>创建后检出该分支</Text>
          </HoverPressable>
          <DialogFooter theme={theme}>
            <DialogButton theme={theme} label="取消" kind="ghost" onPress={() => onOpenChange(false)} />
            <DialogButton
              theme={theme}
              label="创建"
              disabled={!ready}
              onPress={() => {
                onOpenChange(false);
                onCreate(trimmed, startPoint.trim() || "HEAD", checkout);
              }}
            />
          </DialogFooter>
        </View>
      </Modal.Content>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// tag create
// ---------------------------------------------------------------------------

export function TagCreateDialog({
  theme,
  open,
  onOpenChange,
  defaultRef,
  onCreate,
}: {
  theme: PanelTheme;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultRef: string;
  onCreate: (name: string, ref: string, message: string) => void;
}) {
  const [name, setName] = useState("");
  const [ref, setRef] = useState(defaultRef);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (open) {
      setName("");
      setRef(defaultRef);
      setMessage("");
    }
  }, [open, defaultRef]);

  const trimmed = name.trim();
  const ready = trimmed.length > 0 && !trimmed.startsWith("-");

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="新建标签"
      icon={<Icon name="Tag" size={16} color={theme.colors.accent} />}
    >
      <Modal.Content scrollable={false}>
        <View style={{ paddingVertical: 6, gap: 10, width: dialogWidth(380) }}>
          <Field theme={theme} label="标签名">
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="如 v1.2.0"
              placeholderTextColor={theme.colors.foregroundMuted}
              autoFocus
              style={inputStyle(theme)}
            />
          </Field>
          <Field theme={theme} label="目标" hint="分支、标签或提交，默认当前 HEAD">
            <TextInput
              value={ref}
              onChangeText={setRef}
              placeholder="HEAD"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={inputStyle(theme)}
            />
          </Field>
          <Field theme={theme} label="说明" hint="留空创建轻量标签；填写则创建附注标签">
            <TextInput
              value={message}
              onChangeText={setMessage}
              placeholder="发布说明…"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={inputStyle(theme)}
            />
          </Field>
          <DialogFooter theme={theme}>
            <DialogButton theme={theme} label="取消" kind="ghost" onPress={() => onOpenChange(false)} />
            <DialogButton
              theme={theme}
              label="创建"
              disabled={!ready}
              onPress={() => {
                onOpenChange(false);
                onCreate(trimmed, ref.trim() || "HEAD", message.trim());
              }}
            />
          </DialogFooter>
        </View>
      </Modal.Content>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// worktree add
// ---------------------------------------------------------------------------

export function WorktreeAddDialog({
  theme,
  open,
  onOpenChange,
  parentDir,
  onAdd,
}: {
  theme: PanelTheme;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Directory the folder name resolves into (repo's parent). */
  parentDir: string;
  onAdd: (path: string, newBranch: string, ref: string) => void;
}) {
  const [folder, setFolder] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [ref, setRef] = useState("HEAD");
  useEffect(() => {
    if (open) {
      setFolder("");
      setNewBranch("");
      setRef("HEAD");
    }
  }, [open]);

  const trimmed = folder.trim();
  const ready = trimmed.length > 0 && !trimmed.includes("..");
  const preview = ready ? `${parentDir}/${trimmed.replace(/\/+$/, "")}` : `${parentDir}/…`;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="添加 Worktree"
      icon={<Icon name="Split" size={16} color={theme.colors.accent} />}
    >
      <Modal.Content scrollable={false}>
        <View style={{ paddingVertical: 6, gap: 10, width: dialogWidth(400) }}>
          <Field theme={theme} label="目录" hint={`相对路径以仓库同级目录为基准；也可粘贴绝对路径。将创建于 ${preview}`}>
            <TextInput
              value={folder}
              onChangeText={setFolder}
              placeholder="如 myapp-feature"
              placeholderTextColor={theme.colors.foregroundMuted}
              autoFocus
              style={inputStyle(theme)}
            />
          </Field>
          <Field
            theme={theme}
            label="新分支名"
            hint="留空则直接检出下方起点（检出已占用分支会被 git 拒绝）"
          >
            <TextInput
              value={newBranch}
              onChangeText={setNewBranch}
              placeholder="如 feature/login"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={inputStyle(theme)}
            />
          </Field>
          <Field theme={theme} label="起点">
            <TextInput
              value={ref}
              onChangeText={setRef}
              placeholder="HEAD"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={inputStyle(theme)}
            />
          </Field>
          <DialogFooter theme={theme}>
            <DialogButton theme={theme} label="取消" kind="ghost" onPress={() => onOpenChange(false)} />
            <DialogButton
              theme={theme}
              label="添加"
              disabled={!ready}
              onPress={() => {
                onOpenChange(false);
                onAdd(trimmed, newBranch.trim(), ref.trim());
              }}
            />
          </DialogFooter>
        </View>
      </Modal.Content>
    </Modal>
  );
}
