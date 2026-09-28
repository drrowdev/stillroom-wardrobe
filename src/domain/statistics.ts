// I13 wear statistics. Pure and free of runtime imports so the app, the wardrobe sorts, the item page and the
// normal-session tests all count with this one function.

export type WearDay = { itemId: string | null; localDate: string; state: 'worn' | 'planned'; deleted: boolean };
export type WearSummary = { count: number; lastWorn: string | null };
export type StatisticsItem = {
  id: string; title: string; lifecycle: string; purchasePrice: string | null; currency: string;
  category: string; purchaseDate: string | null;
};
export type ItemStatistics = {
  id: string; title: string; active: boolean; count: number; lastWorn: string | null;
  price: string | null; currency: string; category: string; purchaseDate: string | null;
  // Price ÷ worn days, unrounded. Null when the price is unknown or the item has not been worn.
  costPerWear: number | null;
};
export type Statistics = {
  items: ItemStatistics[];
  mostWorn: ItemStatistics[];
  leastWorn: ItemStatistics[];
  unworn: ItemStatistics[];
  currencies: string[];
  unpriced: number;
};

const listLength = 5;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
function validDate(iso: string): boolean {
  if (!datePattern.test(iso) || iso.startsWith('0000')) return false;
  const date = new Date(`${iso}T12:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso;
}

// A wear count is the number of distinct local dates on non-deleted worn looks containing the item. Plans never count,
// and two looks with the same garment on one day count once. Last worn is the latest such date.
export function wearSummaries(itemIds: readonly string[], days: Iterable<WearDay>): Map<string, WearSummary> {
  const dates = new Map(itemIds.map(id => [id, new Set<string>()]));
  for (const day of days) {
    if (!validDate(day.localDate)) throw new Error('Invalid wear date');
    if (day.state === 'worn' && !day.deleted && day.itemId !== null) dates.get(day.itemId)?.add(day.localDate);
  }
  return new Map([...dates].map(([id, set]) => [id, { count: set.size, lastWorn: [...set].sort().at(-1) ?? null }]));
}

// Cost per wear from the stored two-decimal price, computed in cents; rounding happens only when it is displayed.
export function costPerWear(price: string | null, count: number): number | null {
  if (price === null || count <= 0) return null;
  if (!/^\d{1,10}\.\d{2}$/.test(price) || !Number.isSafeInteger(count)) throw new Error('Invalid price');
  return Number(price.replace('.', '')) / count / 100;
}

const byTitle = (a: ItemStatistics, b: ItemStatistics) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
const lastWornOrder = (a: ItemStatistics, b: ItemStatistics) => (a.lastWorn ?? '').localeCompare(b.lastWorn ?? '');

export function buildStatistics(items: readonly StatisticsItem[], summaries: ReadonlyMap<string, WearSummary>): Statistics {
  const rows = items.map((item): ItemStatistics => {
    const summary = summaries.get(item.id) ?? { count: 0, lastWorn: null };
    return {
      id: item.id, title: item.title, active: item.lifecycle === 'active', count: summary.count, lastWorn: summary.lastWorn,
      price: item.purchasePrice, currency: item.currency, category: item.category, purchaseDate: item.purchaseDate,
      costPerWear: costPerWear(item.purchasePrice, summary.count),
    };
  });
  const active = rows.filter(row => row.active);
  const mostWorn = active.filter(row => row.count > 0)
    .sort((a, b) => b.count - a.count || lastWornOrder(b, a) || byTitle(a, b)).slice(0, listLength);
  const shown = new Set(mostWorn.map(row => row.id));
  const leastWorn = active.filter(row => row.count > 0 && !shown.has(row.id))
    .sort((a, b) => a.count - b.count || lastWornOrder(a, b) || byTitle(a, b)).slice(0, listLength);
  return {
    items: rows,
    mostWorn, leastWorn,
    unworn: active.filter(row => row.count === 0).sort(byTitle),
    currencies: [...new Set(rows.filter(row => row.price !== null).map(row => row.currency))].sort(),
    unpriced: rows.filter(row => row.price === null).length,
  };
}

// One currency at a time; amounts in different currencies are never combined. Worn items come first by cost per wear,
// then priced items that have not been worn yet.
export function costTable(statistics: Statistics, currency: string): ItemStatistics[] {
  return statistics.items.filter(row => row.price !== null && row.currency === currency)
    .sort((a, b) => a.costPerWear === null ? b.costPerWear === null ? byTitle(a, b) : 1
      : b.costPerWear === null ? -1 : b.costPerWear - a.costPerWear || byTitle(a, b));
}

export type SpendGroup = { key: string; cents: bigint; count: number };
export type Spending = {
  // Active items only: what is in the wardrobe now.
  total: number; priced: number;
  cents: bigint; count: number;
  // Worn priced items in this currency: their prices over their wear days.
  wornCents: bigint; wears: number;
  byCategory: SpendGroup[]; byMonth: SpendGroup[]; undated: number;
};

function add(groups: Map<string, SpendGroup>, key: string, amount: bigint) {
  const group = groups.get(key) ?? { key, cents: 0n, count: 0 };
  groups.set(key, { key, cents: group.cents + amount, count: group.count + 1 });
}

// Spending in one currency, summed in exact cents. Amounts in different currencies are never combined; an item with
// no price, or no valid purchase date for the monthly view, is counted and reported rather than guessed.
export function spending(statistics: Statistics, currency: string, categoryOrder: readonly string[]): Spending {
  const active = statistics.items.filter(row => row.active);
  const rows = active.filter(row => row.price !== null && row.currency === currency);
  const byCategory = new Map<string, SpendGroup>(), byMonth = new Map<string, SpendGroup>();
  let total = 0n, wornCents = 0n, wears = 0, undated = 0;
  for (const row of rows) {
    if (!/^\d{1,10}\.\d{2}$/.test(row.price!)) throw new Error('Invalid price');
    const amount = BigInt(row.price!.replace('.', ''));
    total += amount;
    if (row.count > 0) { wornCents += amount; wears += row.count; }
    add(byCategory, row.category, amount);
    if (row.purchaseDate !== null && validDate(row.purchaseDate)) add(byMonth, row.purchaseDate.slice(0, 7), amount);
    else undated += 1;
  }
  const rank = (key: string) => { const index = categoryOrder.indexOf(key); return index < 0 ? categoryOrder.length : index; };
  return {
    total: active.length, priced: active.filter(row => row.price !== null).length,
    cents: total, count: rows.length, wornCents, wears,
    byCategory: [...byCategory.values()].sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key)),
    byMonth: [...byMonth.values()].sort((a, b) => b.key.localeCompare(a.key)),
    undated,
  };
}
