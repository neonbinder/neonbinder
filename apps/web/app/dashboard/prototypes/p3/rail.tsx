import type { ReactNode } from "react";
import "@/app/collection/final/cards/cards.css";
import type { BuildingSet, DashboardData, SmartBinderSummary } from "../_shared/data";
import { CardTile, Thumb } from "./entries";
import { plural } from "./timeline";

/**
 * NEO-464 prototype 3 ("Feed") — the standing things beside the timeline:
 * what is close, what is wanted, which binders caught cards, loose ends.
 * They are not events, so they keep still while the feed scrolls past.
 */

function RailSection({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="border-t-2 border-rule pt-4">
      <h2 id={id} className="text-lg font-bold text-ink">
        {title}
      </h2>
      {note && <p className="text-sm text-ink-3">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** "#3, #6, #9, #12 +4 more". */
function needLine(numbers: readonly string[], show = 4): string {
  const head = numbers
    .slice(0, show)
    .map((n) => `#${n}`)
    .join(", ");
  const rest = numbers.length - show;
  return rest > 0 ? `${head} +${rest} more` : head;
}

function BubbleBoard({ set }: { set: BuildingSet }) {
  return (
    <li className="mc-led shadow-offset rounded-2xl border border-rule p-3.5">
      <p className="text-sm font-bold leading-tight text-ink">{set.setLabel}</p>
      <div className="mt-2 flex items-end justify-between gap-3">
        <p>
          <span className="mc-percent block text-5xl text-neon-blue-text">{set.need}</span>
          <span className="text-xs text-ink-2">{set.need === 1 ? "card to go" : "cards to go"}</span>
        </p>
        <p className="text-right">
          <span className="block text-2xl font-bold tabular-nums text-ink">{set.percent}%</span>
          <span className="text-xs text-ink-3">
            {set.have} of {set.total}
          </span>
        </p>
      </div>
      <span aria-hidden="true" className="feed-meter mt-2 block h-1.5 overflow-hidden rounded-full">
        <span className="block h-full rounded-full" style={{ width: `${set.percent}%` }} />
      </span>
      {set.neededNumbers.length > 0 && (
        <p className="mt-2 text-sm text-ink-2">
          <span className="font-medium text-ink">Need:</span> {needLine(set.neededNumbers)}
        </p>
      )}
    </li>
  );
}

function SmartBinderRow({ binder }: { binder: SmartBinderSummary }) {
  const thumbs = binder.newCards.slice(0, 4);
  const more = binder.newCount - thumbs.length;
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-baseline justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-bold text-ink">{binder.name}</p>
        {binder.checklist && (
          <p className="shrink-0 text-xs tabular-nums text-ink-2">{binder.checklist.percent}% of the checklist</p>
        )}
      </div>
      <p className="truncate text-xs text-ink-3">{binder.ruleText}</p>
      {binder.newCount > 0 ? (
        <>
          <p className="mt-1.5 text-sm font-medium text-neon-green-text">{binder.newCount} new since your last visit</p>
          <ul className="mt-1.5 flex items-center gap-1.5">
            {thumbs.map((c) => (
              <li key={c.id}>
                <Thumb card={c} className="w-10" />
              </li>
            ))}
            {more > 0 && (
              <li className="pl-1 text-xs font-medium text-ink-3">
                <span aria-hidden="true">+{more}</span>
                <span className="sr-only">and {more} more</span>
              </li>
            )}
          </ul>
        </>
      ) : (
        <p className="mt-1.5 text-sm text-ink-3">Nothing new since your last visit.</p>
      )}
    </li>
  );
}

export default function Rail({ data }: { data: DashboardData }) {
  const { building, wantList, smartBinders, unlistedBoxes, tradePile } = data;
  return (
    <div className="flex flex-col gap-8">
      {building.length > 0 && (
        <RailSection id="feed-bubble" title="On the Bubble" note="Your sets, fewest cards to go first.">
          <ol className="space-y-3">
            {building.map((s) => (
              <BubbleBoard key={s.setId} set={s} />
            ))}
          </ol>
        </RailSection>
      )}

      {wantList.length > 0 && (
        <RailSection id="feed-chase" title="Most Wanted" note="The chase, top of the list first.">
          <ol className="grid grid-cols-3 gap-x-3 gap-y-4">
            {wantList.slice(0, 5).map((c) => (
              <li key={c.id} className="min-w-0">
                <CardTile
                  card={{ ...c, setLabel: `${c.setLabel} #${c.cardNumber}` }}
                  extra={c.forBinder ? `For ${c.forBinder}` : null}
                />
              </li>
            ))}
          </ol>
        </RailSection>
      )}

      {smartBinders.length > 0 && (
        <RailSection id="feed-binders" title="Binders Filling Up">
          <ul className="divide-y divide-rule">
            {smartBinders.map((b) => (
              <SmartBinderRow key={b.id} binder={b} />
            ))}
          </ul>
        </RailSection>
      )}

      {(unlistedBoxes.length > 0 || tradePile.count > 0) && (
        <RailSection id="feed-loose" title="Loose Ends">
          <ul className="space-y-3 text-sm">
            {unlistedBoxes.map((b) => (
              <li key={b.id} className="flex items-baseline justify-between gap-3">
                <span className="text-ink">{b.name}</span>
                <span className="text-ink-2">{plural(b.unlisted, "card")} not listed yet</span>
              </li>
            ))}
            {tradePile.count > 0 && (
              <li>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-ink">Trade pile</span>
                  <span className="text-ink-2">{plural(tradePile.count, "card")} up for trade</span>
                </div>
                <ul className="mt-2 flex gap-1.5">
                  {tradePile.cards.slice(0, 5).map((c) => (
                    <li key={c.id}>
                      <Thumb card={c} className="w-10" />
                    </li>
                  ))}
                </ul>
              </li>
            )}
          </ul>
        </RailSection>
      )}
    </div>
  );
}
