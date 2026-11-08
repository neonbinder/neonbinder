import { daysAgoLabel, type AdditionBatch, type CompletedSet, type DashboardData, type UnshippedSale } from "../_shared/data";

/**
 * NEO-464 prototype 3 ("Feed") — the fixture folded into one timeline,
 * newest day first. Each stop is a day that something happened on: cards
 * came in, an order sold, a checklist got finished.
 *
 * Time is only ever what the fixture says: a batch's own label ("Tuesday"),
 * else `daysAgoLabel` ("2 days ago"). No dates are made up here.
 *
 * Orders to ship are NOT drawn in the stops as rows: they are one list,
 * oldest first, pinned at the head of the feed. A stop only notes that an
 * order sold that day (`sold`), so the timeline still tells the whole story.
 */

export interface FeedStop {
  key: string;
  /** "Today", "Yesterday", "Tuesday", "2 days ago". */
  label: string;
  daysAgo: number;
  /** The checklist finished that day, if it was this one. */
  completed: CompletedSet | null;
  batches: AdditionBatch[];
  /** Orders that sold that day and are still to ship. */
  sold: UnshippedSale[];
}

/**
 * The day a completed checklist belongs to: the day of the batch that brought
 * in its last card. Null when no batch holds it (it then leads the feed).
 */
export function completedDay(done: CompletedSet, batches: readonly AdditionBatch[]): number | null {
  const batch = batches.find((b) => b.cards.some((c) => c.id === done.lastCard.id));
  return batch ? batch.daysAgo : null;
}

export function buildFeed(data: DashboardData): { stops: FeedStop[]; looseMilestone: CompletedSet | null } {
  const days = new Map<number, FeedStop>();
  const stopFor = (daysAgo: number): FeedStop => {
    let stop = days.get(daysAgo);
    if (!stop) {
      stop = { key: `day-${daysAgo}`, label: daysAgoLabel(daysAgo), daysAgo, completed: null, batches: [], sold: [] };
      days.set(daysAgo, stop);
    }
    return stop;
  };

  for (const batch of data.additions) {
    const stop = stopFor(batch.daysAgo);
    stop.batches.push(batch);
    // The batch names its own day ("Tuesday", "Last weekend"): that wins over a count.
    stop.label = batch.whenLabel;
  }
  for (const sale of data.sales?.unshipped ?? []) stopFor(sale.daysSinceSold).sold.push(sale);

  let looseMilestone: CompletedSet | null = null;
  if (data.justCompleted) {
    const day = completedDay(data.justCompleted, data.additions);
    if (day === null) looseMilestone = data.justCompleted;
    else stopFor(day).completed = data.justCompleted;
  }

  const stops = [...days.values()].sort((a, b) => a.daysAgo - b.daysAgo);
  return { stops, looseMilestone };
}

/** Cards that came in since the last visit (what the greeting counts). */
export function cardsSinceLastVisit(batches: readonly AdditionBatch[]): number {
  return batches.filter((b) => b.sinceLastVisit).reduce((n, b) => n + b.cards.length, 0);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
