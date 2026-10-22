import { useState, type ReactNode } from "react";
import { Platform, Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PluginHostProps } from "@getpaseo/plugin/client";

export type PanelTheme = PluginHostProps["theme"];

export interface HoverState {
  hovered: boolean;
  pressed: boolean;
}

/**
 * Pressable plus a typed hover state. RN 0.81's style callback only declares
 * `pressed`; react-native-web also reports hover, so we track it explicitly
 * through onHoverIn/onHoverOut.
 */
export function HoverPressable({
  onPress,
  onHoverIn,
  onHoverOut,
  style,
  ...rest
}: {
  onPress?: () => void;
  onHoverIn?: () => void;
  onHoverOut?: () => void;
  style?: (state: HoverState) => StyleProp<ViewStyle>;
} & Omit<React.ComponentProps<typeof Pressable>, "onPress" | "onHoverIn" | "onHoverOut" | "style">) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      {...rest}
      onPress={onPress}
      onHoverIn={(event) => {
        setHovered(true);
        onHoverIn?.();
      }}
      onHoverOut={(event) => {
        setHovered(false);
        onHoverOut?.();
      }}
      style={style === undefined ? undefined : ({ pressed }) => style({ hovered, pressed })}
    />
  );
}

export function IconButton({
  icon,
  label,
  theme,
  size = 15,
  disabled = false,
  active = false,
  onPress,
}: {
  icon: string;
  label: string;
  theme: PanelTheme;
  size?: number;
  disabled?: boolean;
  active?: boolean;
  onPress: () => void;
}) {
  const color = disabled ? theme.colors.foregroundMuted : theme.colors.foreground;
  return (
    <HoverPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ hovered, pressed }) => ({
        width: 26,
        height: 26,
        borderRadius: 6,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.45 : 1,
        backgroundColor: pressed
          ? theme.colors.surface2
          : hovered || active
            ? theme.colors.surface2
            : "transparent",
      })}
    >
      <Icon name={icon} size={size} color={color} />
    </HoverPressable>
  );
}

export function Chip({
  label,
  color,
  background,
  theme,
  fontSize = 9,
  maxWidth,
  onPress,
}: {
  label: string;
  color: string;
  background?: string;
  theme: PanelTheme;
  fontSize?: number;
  maxWidth?: number;
  onPress?: () => void;
}) {
  const body = (
    <Text
      numberOfLines={1}
      style={{
        color,
        fontSize,
        fontFamily: MONO_FONT,
        paddingHorizontal: 4,
        paddingVertical: 1,
      }}
    >
      {label}
    </Text>
  );
  const container = {
    borderRadius: 4,
    backgroundColor: background ?? "transparent",
    borderWidth: background ? 0 : 1,
    borderColor: color,
    maxWidth,
    flexShrink: 0,
  } as const;
  if (onPress) {
    return (
      <HoverPressable accessibilityRole="button" onPress={onPress} style={() => container}>
        {body}
      </HoverPressable>
    );
  }
  return <View style={container}>{body}</View>;
}

export function SectionHeader({
  title,
  count,
  theme,
  expanded,
  onToggle,
}: {
  title: string;
  count?: number;
  theme: PanelTheme;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <HoverPressable
      accessibilityRole="button"
      accessibilityLabel={`${title}（${count ?? 0}）`}
      onPress={onToggle}
      style={({ hovered }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 2,
        paddingVertical: 4,
        paddingHorizontal: 6,
        backgroundColor: hovered ? theme.colors.surface1 : "transparent",
        borderRadius: 4,
      })}
    >
      <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={12} color={theme.colors.foregroundMuted} />
      <Text style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "600" }}>{title}</Text>
      {typeof count === "number" ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>{count}</Text>
      ) : null}
    </HoverPressable>
  );
}

export function MetaRow({
  label,
  theme,
  children,
}: {
  label: string;
  theme: PanelTheme;
  children: ReactNode;
}) {
  return (
    <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, width: 58, flexShrink: 0 }}>
        {label}
      </Text>
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  );
}

// A single family string only matches one platform's lookup, so pick explicitly.
export const MONO_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
});

export function StatText({
  value,
  kind,
  theme,
}: {
  value: number;
  kind: "add" | "del";
  theme: PanelTheme;
}) {
  if (value <= 0) return null;
  return (
    <Text
      style={{
        fontSize: 10,
        fontFamily: MONO_FONT,
        color: kind === "add" ? theme.colors.statusSuccess : theme.colors.statusDanger,
      }}
    >
      {kind === "add" ? `+${value}` : `−${value}`}
    </Text>
  );
}
