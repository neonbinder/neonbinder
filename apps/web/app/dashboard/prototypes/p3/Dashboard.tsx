import { useMemo, type ReactNode } from "react";
import { useDashboard } from "../_shared/persona";
import type { DashboardData } from "../_shared/data";
import { BatchEntry, IntakeEntry, MilestoneEntry, ShipEntry, SoldEntry } from "./entries";
import Rail from "./rail";
import { buildFeed, cardsSinceLastVisit, plural, type FeedStop } from "./timeline";
import "./feed.css";

/**
 * NEO-464 — dashboard prototype 3, "Feed": what changed since you left.
 *
 * One timeline, newest first, down a lit spine. It opens with what is
 * waiting on you right now (orders to ship, oldest first; scans in intake),
 * then steps back a day at a time: cards that came in, grouped by when they
 * arrived; orders that sold; a checklist finished. The standing things (sets
 * close to done, the chase, smart binders, loose ends) sit in a rail beside
 * it on desktop and after it on a phone.
 *
 * Nothing here navigates: the only controls are in-view tweaks (show a
 * batch's other cards, replay the celebration), so nothing goes in the URL
 * beyond the page's own `?as=`.
 */
export default function Dashboard() {
  const data = useDashboard();
  const { stops, looseMilestone } = useMemo(() => buildFeed(data), [data]);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-3xl font-bold leading-tight text-ink sm:text-4xl">Welcome back, slugger.</h1>
        <p className="mt-2 max-w-prose text-base text-ink-2">{summary(data)}</p>
      </header>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-10">
        <div className="min-w-0">
          <Stop label="Right now" headingId="feed-now">
            {data.sales && <ShipEntry sales={data.sales} />}
            <IntakeEntry intake={data.intake} />
            {looseMilestone && <MilestoneEntry done={looseMilestone} />}
          </Stop>
          {stops.map((stop) => (
            <Stop key={stop.key} label={stop.label} headingId={`feed-${stop.key}`} tally={tally(stop)}>
              {stop.completed && <MilestoneEntry done={stop.completed} />}
              {stop.batches.map((b) => (
                <BatchEntry key={b.id} batch={b} />
              ))}
              {stop.sold.length > 0 && <SoldEntry sold={stop.sold} />}
            </Stop>
          ))}
          <p className="border-l-2 border-dashed border-rule pb-2 pl-6 text-sm text-ink-3">
            That&rsquo;s the lot. Older news lives in your binders.
          </p>
        </div>

        <aside aria-label="Sets, the chase and binders" className="min-w-0">
          <Rail data={data} />
        </aside>
      </div>
    </div>
  );
}

/**
 * One day on the spine. On a phone the day's name sits on the spine above its
 * entries; from md up it moves to its own column and sticks while the day
 * scrolls by.
 */
function Stop({
  label,
  headingId,
  tally,
  children,
}: {
  label: string;
  headingId: string;
  tally?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={headingId} className="md:grid md:grid-cols-[7.5rem_minmax(0,1fr)] md:gap-x-5">
      <div className="relative border-l-2 border-rule pb-4 pl-6 md:border-l-0 md:pb-0 md:pl-0">
        <span
          aria-hidden="true"
          className="feed-day-node absolute -left-[9px] top-2 size-4 rounded-full border-2 border-control md:hidden"
        />
        <div className="md:sticky md:top-4 md:pt-0.5 md:text-right">
          <h2 id={headingId} className="text-2xl font-bold leading-tight tracking-tight text-ink md:text-xl">
            {label}
          </h2>
          {tally && <p className="text-xs text-ink-3">{tally}</p>}
        </div>
      </div>
      <div className="flex flex-col gap-7 border-l-2 border-rule pb-10 pl-6">{children}</div>
    </section>
  );
}

/** "13 cards in, 1 order sold": what a day held, under its name. */
function tally(stop: FeedStop): string {
  const cards = stop.batches.reduce((n, b) => n + b.cards.length, 0);
  const parts: string[] = [];
  if (cards > 0) parts.push(`${plural(cards, "card")} in`);
  if (stop.sold.length > 0) parts.push(`${plural(stop.sold.length, "order")} sold`);
  if (stop.completed) parts.push("1 set done");
  return parts.join(", ");
}

/** The greeting's second line: the headline of what changed. No values, ever. */
function summary(data: DashboardData): string {
  const cards = cardsSinceLastVisit(data.additions);
  const parts: string[] = [];
  if (cards > 0) parts.push(`${plural(cards, "card")} came in since your last visit`);
  if (data.justCompleted) parts.push(`you finished ${data.justCompleted.label}`);
  if (data.sales && data.sales.unshipped.length > 0) {
    parts.push(`${plural(data.sales.unshipped.length, "order")} ${data.sales.unshipped.length === 1 ? "is" : "are"} waiting to ship`);
  }
  if (parts.length === 0) return "Quiet since you left. Go pull something.";
  const sentence = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}
