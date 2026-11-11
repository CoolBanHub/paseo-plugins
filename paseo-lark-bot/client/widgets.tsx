import { useState, type ReactNode } from "react";
import { Pressable, Switch, Text, TextInput, View, type StyleProp, type ViewStyle } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";

/**
 * Shared widgets for the bot center screen. The host hands each render a
 * fresh theme; resolve it once per render through module state like
 * team-work's design.tsx.
 */

let palette: PluginTheme["colors"] | null = null;
export function applyTheme(theme: PluginTheme): void {
  palette = theme.colors;
}
export function colors(): PluginTheme["colors"] {
  return palette ?? {
    surface0: "#f7f7f8",
    surface1: "#ffffff",
    surface2: "#f0f0f2",
    border: "#e3e3e6",
    foreground: "#1b1b1f",
    foregroundMuted: "#6d6d78",
    accent: "#3b5bfd",
    accentForeground: "#ffffff",
    statusSuccess: "#1f9d55",
    statusWarning: "#b7791f",
    statusDanger: "#d24545",
  };
}

/** Pressable plus a typed hover state (RN's style callback only reports pressed). */
export function HoverPressable({
  onPress, style, children, ...rest
}: {
  onPress?: () => void;
  style?: (state: { hovered: boolean; pressed: boolean }) => StyleProp<ViewStyle>;
  children?: ReactNode | ((state: { hovered: boolean; pressed: boolean }) => ReactNode);
} & Omit<React.ComponentProps<typeof Pressable>, "onPress" | "style" | "children">) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      {...rest}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={style === undefined ? undefined : ({ pressed }) => style({ hovered, pressed })}
    >
      {typeof children === "function"
        ? (state: { pressed: boolean }) => children({ hovered, pressed: state.pressed })
        : children}
    </Pressable>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return (
    <View
      style={{
        backgroundColor: colors().surface1,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: colors().border,
        padding: 16,
        gap: 10,
      }}
    >
      {children}
    </View>
  );
}

export function CardTitle({ text, hint }: { text: string; hint?: string }) {
  return (
    <View>
      <Text style={{ fontSize: 15, fontWeight: "700", color: colors().foreground }}>{text}</Text>
      {hint ? <Text style={{ fontSize: 12, color: colors().foregroundMuted, marginTop: 2 }}>{hint}</Text> : null}
    </View>
  );
}

export function InfoRow({ label, value, muted = true }: { label: string; value: string; muted?: boolean }) {
  return (
    <View style={{ flexDirection: "row", gap: 10 }}>
      <Text style={{ color: colors().foregroundMuted, fontSize: 13, width: 110 }}>{label}</Text>
      <Text style={{ color: muted ? colors().foreground : colors().statusDanger, fontSize: 13, flex: 1 }}>{value}</Text>
    </View>
  );
}

export function FieldLabel({ text }: { text: string }) {
  return <Text style={{ fontSize: 12, color: colors().foregroundMuted }}>{text}</Text>;
}

/** Hairline separating sections inside one card. */
export function Divider() {
  return <View style={{ height: 1, backgroundColor: colors().border }} />;
}

/** Label on the left, numeric input on the right — compact one-line field. */
export function NumberField({
  label,
  hint,
  value,
  onChange,
  suffix,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange(value: number): void;
  suffix?: string;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 13, color: colors().foreground }}>{label}</Text>
        {hint ? (
          <Text style={{ fontSize: 12, color: colors().foregroundMuted, marginTop: 1 }}>{hint}</Text>
        ) : null}
      </View>
      <TextInput
        value={String(value)}
        keyboardType="number-pad"
        onChangeText={(text) => {
          const parsed = Number.parseInt(text, 10);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
        style={inputStyle({ width: 96, textAlign: "right" })}
      />
      {suffix ? <Text style={{ fontSize: 12, color: colors().foregroundMuted }}>{suffix}</Text> : null}
    </View>
  );
}

export function inputStyle(extra?: object): object {
  return {
    borderWidth: 1,
    borderColor: colors().border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    color: colors().foreground,
    fontSize: 13,
    backgroundColor: colors().surface0,
    ...extra,
  };
}

/**
 * Settings-style choice row: label on the left, current value on the right,
 * chevron at the end. The pill picker and hint render below the row only
 * while expanded, keeping the card a scannable list when collapsed.
 */
export function SelectRow({
  label,
  value,
  tone = "default",
  expanded,
  onPress,
  children,
}: {
  label: string;
  value: string;
  tone?: "default" | "muted" | "warning" | "danger";
  expanded: boolean;
  onPress(): void;
  children?: ReactNode;
}) {
  const c = colors();
  const valueColor =
    tone === "warning"
      ? c.statusWarning
      : tone === "danger"
        ? c.statusDanger
        : tone === "muted"
          ? c.foregroundMuted
          : c.foreground;
  return (
    <View style={{ gap: 8 }}>
      <HoverPressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        style={({ hovered }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingVertical: 4,
          paddingHorizontal: 4,
          borderRadius: 6,
          backgroundColor: hovered ? c.surface2 : "transparent",
        })}
      >
        <Text style={{ fontSize: 13, fontWeight: "500", color: c.foreground }}>{label}</Text>
        <Text
          numberOfLines={1}
          style={{ fontSize: 12, color: valueColor, flex: 1, textAlign: "right" }}
        >
          {value}
        </Text>
        <Text style={{ fontSize: 11, color: c.foregroundMuted, width: 12, textAlign: "center" }}>
          {expanded ? "▾" : "▸"}
        </Text>
      </HoverPressable>
      {expanded && children ? <View style={{ gap: 8 }}>{children}</View> : null}
    </View>
  );
}

export function ToggleRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 13, color: colors().foreground }}>{label}</Text>
        {hint ? <Text style={{ fontSize: 12, color: colors().foregroundMuted, marginTop: 1 }}>{hint}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: colors().accent, false: colors().surface2 }}
        thumbColor={colors().surface1}
      />
    </View>
  );
}

export function ChoicePill({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress(): void;
}) {
  const c = colors();
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: active ? c.accent : c.border,
        backgroundColor: active ? c.accent : c.surface1,
      }}
    >
      <Text style={{ fontSize: 12, color: active ? c.accentForeground : c.foreground }}>{label}</Text>
    </Pressable>
  );
}

export function Pill({ text, tone }: { text: string; tone: "success" | "warning" | "danger" | "muted" }) {
  const c = colors();
  const color = tone === "success" ? c.statusSuccess : tone === "warning" ? c.statusWarning : tone === "danger" ? c.statusDanger : c.foregroundMuted;
  return (
    <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: c.surface2 }}>
      <Text style={{ fontSize: 12, color }}>{text}</Text>
    </View>
  );
}

export function PrimaryButton({
  label,
  onPress,
  disabled,
  subtle,
  danger,
}: {
  label: string;
  onPress(): void;
  disabled?: boolean;
  subtle?: boolean;
  danger?: boolean;
}) {
  const c = colors();
  const idle = danger ? c.statusDanger : subtle ? c.surface2 : c.accent;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: disabled ? c.surface2 : idle,
        borderWidth: 1,
        borderColor: disabled ? c.border : idle,
      }}
    >
      <Text style={{ fontSize: 13, color: disabled ? c.foregroundMuted : subtle ? c.foreground : c.accentForeground }}>
        {label}
      </Text>
    </Pressable>
  );
}
