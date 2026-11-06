import { useState, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";

/**
 * Shared widgets for the plugin's screen. The host hands each render a fresh
 * theme; resolve it once per render through module state (BotCenter pattern),
 * so deep components read colors() instead of threading theme props.
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

export const MONO_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  macos: "SF Mono",
  default: "ui-monospace, monospace",
}) as string | undefined;

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

/** "1000000" → "1M 窗口", "204800" → "200k 窗口"; raw when nothing divides. */
export function formatWindow(window: number): string {
  if (window % 1_000_000 === 0) return `${window / 1_000_000}M 窗口`;
  if (window % 1024 === 0) return `${window / 1024}k 窗口`;
  if (window % 1_000 === 0) return `${window / 1_000}k 窗口`;
  return `${window} 窗口`;
}

export function ModelChip({ label }: { label: string }) {
  return (
    <View style={{ backgroundColor: colors().surface2, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 }}>
      <Text numberOfLines={1} style={{ color: colors().foreground, fontSize: 11, fontFamily: MONO_FONT }}>
        {label}
      </Text>
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      style={[{
        backgroundColor: colors().surface1,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: colors().border,
        padding: 16,
        gap: 10,
      }, style]}
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

export function FieldLabel({ text }: { text: string }) {
  return <Text style={{ fontSize: 12, color: colors().foregroundMuted }}>{text}</Text>;
}

export function inputStyle(extra?: StyleProp<TextStyle>): StyleProp<TextStyle> {
  return [{
    borderWidth: 1,
    borderColor: colors().border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    color: colors().foreground,
    fontSize: 13,
    backgroundColor: colors().surface0,
  }, extra];
}

/** Labelled controlled input, the workhorse of the editor forms. */
export function TextField({
  label, hint, value, onChangeText, placeholder, secureTextEntry, multiline, mono, numberOfLines,
}: {
  label?: string;
  hint?: string;
  value: string;
  onChangeText(text: string): void;
  placeholder?: string;
  secureTextEntry?: boolean;
  multiline?: boolean;
  mono?: boolean;
  numberOfLines?: number;
}) {
  return (
    <View style={{ gap: 4 }}>
      {label ? <FieldLabel text={label} /> : null}
      <TextInput
        value={value}
        placeholder={placeholder}
        placeholderTextColor={colors().foregroundMuted}
        onChangeText={onChangeText}
        secureTextEntry={secureTextEntry}
        multiline={multiline}
        numberOfLines={multiline ? numberOfLines ?? 3 : undefined}
        autoCapitalize="none"
        autoCorrect={false}
        style={inputStyle({
          fontFamily: mono ? MONO_FONT : undefined,
          minHeight: multiline ? 64 : undefined,
          textAlignVertical: multiline ? "top" : undefined,
        })}
      />
      {hint ? <Text style={{ fontSize: 11, color: colors().foregroundMuted }}>{hint}</Text> : null}
    </View>
  );
}

/** Select-one pill group for small option sets (protocol, auth header, aliases). */
export function ChoicePill({
  label, active, onPress,
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
  label, onPress, disabled, subtle, danger,
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
