/** Minimal shape of timeline.refetch() entries returned by the daemon. */
export interface TimelineEntryLike {
  item?: {
    type?: string;
    text?: string;
  };
}

/** Latest assistant text in a refetched timeline page, if any. */
export function lastAssistantText(entries: readonly TimelineEntryLike[] | undefined): string | null {
  for (let index = (entries?.length ?? 0) - 1; index >= 0; index -= 1) {
    const item = entries?.[index]?.item;
    if (item?.type === "assistant_message" && item.text?.trim()) return item.text.trim();
  }
  return null;
}
