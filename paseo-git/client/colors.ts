/**
 * Palette shared by graph lanes, ref badges and file-status colors. Lane
 * colors follow the IntelliJ IDEA commit graph; file statuses mirror the
 * JetBrains VCS colors. All are medium tones readable on light and dark hosts.
 */
export const LANE_COLORS = [
  "#3a8ee6",
  "#c75450",
  "#59a869",
  "#e5c07b",
  "#b07cd8",
  "#2aa198",
  "#d19a66",
  "#56b6c2",
] as const;

/** JetBrains-style file status colors (added/modified/deleted/renamed/conflict). */
export const STATUS_COLORS = {
  added: "#6a8759",
  modified: "#6897bb",
  deleted: "#6c6c6c",
  renamed: "#b9b462",
  conflict: "#d1675a",
} as const;

/** Ref badge colors, IDEA Git Log style: local green, remote purple, tag gold, HEAD red. */
export const REF_COLORS = {
  local: "#59a869",
  remote: "#b07cd8",
  tag: "#e5c07b",
  head: "#c75450",
} as const;

/** Status letter → color kind (A/? → added, M/T → modified, R/C → renamed, U-family → conflict). */
export function statusColorOf(status: string): string {
  if (status.startsWith("A") || status.startsWith("?")) return STATUS_COLORS.added;
  if (status.startsWith("D")) return STATUS_COLORS.deleted;
  if (status.startsWith("R") || status.startsWith("C")) return STATUS_COLORS.renamed;
  if (status.startsWith("U") || status.length === 2) return STATUS_COLORS.conflict;
  return STATUS_COLORS.modified;
}

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
