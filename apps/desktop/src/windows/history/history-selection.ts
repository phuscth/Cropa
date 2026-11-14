/** Add the id to the selection, or remove it when it is already there. */
export function toggleId(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * Add every id from `anchor` to `id` (inclusive, in list order) to the selection. Without an
 * anchor in the list, it falls back to a plain toggle of `id`.
 */
export function selectRange(
  selected: ReadonlySet<string>,
  ids: readonly string[],
  anchor: string | undefined,
  id: string,
): Set<string> {
  const from = anchor === undefined ? -1 : ids.indexOf(anchor);
  const to = ids.indexOf(id);
  if (from === -1 || to === -1) return toggleId(selected, id);
  const next = new Set(selected);
  for (const between of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(between);
  return next;
}
