import type { HistoryItem } from '../../lib/bindings.ts';

export type DayKind = 'today' | 'yesterday' | 'thisWeek' | 'thisYear' | 'older';

export interface DayGroup {
  key: string;
  /** Local midnight of the day; undefined for the group of captures without a time. */
  day: Date | undefined;
  items: HistoryItem[];
}

const DAY_MS = 86_400_000;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Groups by local calendar day in first-appearance order; items without a time go in one
 * group (key 'unknown', day undefined) at the end. Item order inside a group is kept.
 */
export function groupByDay(items: readonly HistoryItem[]): DayGroup[] {
  const groups = new Map<string, DayGroup>();
  const unknown: HistoryItem[] = [];
  for (const item of items) {
    if (item.capturedAt === null) {
      unknown.push(item);
      continue;
    }
    const at = new Date(item.capturedAt);
    const key = `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
    const existing = groups.get(key);
    if (existing) existing.items.push(item);
    else groups.set(key, { key, day: new Date(at.getFullYear(), at.getMonth(), at.getDate()), items: [item] });
  }
  const result = [...groups.values()];
  if (unknown.length > 0) result.push({ key: 'unknown', day: undefined, items: unknown });
  return result;
}

/**
 * How far `day` (local midnight) is from `now`'s local day: 0 is today, 1 yesterday, 2 to 6
 * this week, the same year this year, else older. A day in the future counts as today.
 */
export function describeDay(day: Date, now: Date): DayKind {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const back = Math.round((today.getTime() - day.getTime()) / DAY_MS);
  if (back <= 0) return 'today';
  if (back === 1) return 'yesterday';
  if (back < 7) return 'thisWeek';
  return day.getFullYear() === now.getFullYear() ? 'thisYear' : 'older';
}
