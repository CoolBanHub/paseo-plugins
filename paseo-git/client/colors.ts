/** Fixed palette shared by the graph lanes and author chips; medium tones that stay readable on light and dark hosts. */
export const LANE_COLORS = [
  "#4f8ef7",
  "#e06c75",
  "#98c379",
  "#e5c07b",
  "#c678dd",
  "#56b6c2",
  "#ec8ed0",
  "#7f96c8",
] as const;

export function laneColor(lane: number): string {
  return LANE_COLORS[((lane % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length];
}

export function hashStringColor(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  }
  return LANE_COLORS[Math.abs(hash) % LANE_COLORS.length];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseHex(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function toHexChannels(r: number, g: number, b: number): string {
  const part = (value: number) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** Mix `color` toward `background`; weight 0 keeps the color, 1 returns the background. */
export function mixWithBackground(color: string, background: string, weight: number): string {
  const [r1, g1, b1] = parseHex(color);
  const [r2, g2, b2] = parseHex(background);
  const w = clamp(weight, 0, 1);
  return toHexChannels(
    r1 + (r2 - r1) * w,
    g1 + (g2 - g1) * w,
    b1 + (b2 - b1) * w,
  );
}
