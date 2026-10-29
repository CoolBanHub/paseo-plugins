import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { dialogWidth } from "./filters";
import { HoverPressable, type PanelTheme } from "./parts";

/**
 * The ⋯ button + modal menu pair that stands in for JGC's right-click
 * context menus (RN panels have no contextmenu event).
 */

export interface MenuItem {
  key: string;
  label: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  onPress: () => void;
}

export function MenuButton({
  theme,
  label,
  items,
  size = 14,
}: {
  theme: PanelTheme;
  /** Accessibility label, e.g. "分支 main 的操作". */
  label: string;
  items: MenuItem[];
  size?: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <HoverPressable
        accessibilityRole="button"
        accessibilityLabel={label}
        hitSlop={4}
        onPress={() => setOpen(true)}
        style={({ hovered }) => ({
          width: 22,
          height: 22,
          borderRadius: 5,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: hovered ? theme.colors.surface2 : "transparent",
        })}
      >
        <Icon name="MoreHorizontal" size={size} color={theme.colors.foregroundMuted} />
      </HoverPressable>
      <ContextMenuModal theme={theme} open={open} onOpenChange={setOpen} title={label} items={items} />
    </>
  );
}

export function ContextMenuModal({
  theme,
  open,
  onOpenChange,
  title,
  items,
}: {
  theme: PanelTheme;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  items: MenuItem[];
}) {
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setPendingKey(null);
  }, [open]);

  const run = (item: MenuItem) => {
    setPendingKey(item.key);
    onOpenChange(false);
    // Let the modal close before the action fires its own busy/toast state.
    setImmediate(item.onPress);
  };

  const sections: MenuItem[][] = [];
  for (const item of items) {
    if (item.key === "-") {
      if (sections.length > 0 && sections[sections.length - 1]!.length > 0) sections.push([]);
      continue;
    }
    if (sections.length === 0) sections.push([]);
    sections[sections.length - 1]!.push(item);
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} icon={<Icon name="MoreHorizontal" size={16} color={theme.colors.accent} />}>
      <Modal.Content scrollable={false}>
        <View style={{ paddingVertical: 4, gap: 2, width: dialogWidth(320) }}>
          {sections.map((section, sectionIndex) => (
            <View key={sectionIndex} style={sectionIndex > 0 ? { borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 4, marginTop: 2 } : undefined}>
              {section.map((item) => {
                const tint = item.danger ? theme.colors.statusDanger : theme.colors.foreground;
                return (
                  <HoverPressable
                    key={item.key}
                    accessibilityRole="button"
                    accessibilityLabel={item.label}
                    disabled={item.disabled || pendingKey !== null}
                    onPress={() => run(item)}
                    style={({ hovered }) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 8,
                      paddingHorizontal: 8,
                      paddingVertical: 6,
                      borderRadius: 6,
                      opacity: item.disabled ? 0.45 : 1,
                      backgroundColor: hovered && !item.disabled ? theme.colors.surface1 : "transparent",
                    })}
                  >
                    {item.icon ? <Icon name={item.icon} size={13} color={item.danger ? theme.colors.statusDanger : theme.colors.foregroundMuted} /> : <View style={{ width: 13 }} />}
                    <Text style={{ color: tint, fontSize: 11.5, flex: 1 }}>{item.label}</Text>
                  </HoverPressable>
                );
              })}
            </View>
          ))}
        </View>
      </Modal.Content>
    </Modal>
  );
}
