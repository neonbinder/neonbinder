import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon, PlusIcon } from "@heroicons/react/24/outline";
import { FOCUS } from "../../prototypes/p3/classes";
import { haveShort, isComplete, totalKnown } from "../catalog/format";
import { copiesByCard } from "../catalog/home";
import { LoadingNote, SkeletonBars, SkeletonPips } from "../catalog/Skeleton";
import { setLabel, variantLabel } from "../data/labels";
import {
  useBuildingSets,
  useCollectionStore,
  useCopiesInVariant,
  useSetSummary,
  useVariantCards,
  useVariantCompletion,
} from "../data/store";
import type { SetId, SetRef, Variant } from "../data/types";
import { ParamLink } from "../mode";
import { useMyCards } from "./context";
import SetPicker from "./SetPicker";

/**
 * NEO-350 / NEO-358 — "Sets I'm building": one LED board per set. The base
 * percentage is the big number; under it, one strip per checklist of the
 * set (base, each insert, each parallel). Base shows its bulbs, one per
 * card; every other strip shows its count and loads its bulbs only when
 * opened, so a board never reads a whole set's cards.
 *
 * `returnTo`: the set whose wall the collector just left; its board takes
 * focus so the keyboard lands where it was.
 */
export default function Scoreboard({ returnTo }: { returnTo: SetId | null }) {
  const building = useBuildingSets();
  const [picking, setPicking] = useState(false);
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!returnTo || !building) return;
    root.current?.querySelector<HTMLElement>(`[data-board="${CSS.escape(returnTo)}"]`)?.focus();
  }, [returnTo, building]);

  return (
    <section ref={root} aria-labelledby="mc-board-heading">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="mc-board-heading" className="text-xl font-bold text-ink">
          Sets I&apos;m building
        </h2>
        <p className="text-sm text-ink-3">{building ? `${building.length} on the board` : ""}</p>
      </div>

      <ul className="mt-3 grid gap-4 md:grid-cols-2">
        {building === undefined ? (
          <li aria-busy="true" className="mc-led shadow-offset min-h-40 rounded-2xl border border-rule p-4">
            <SkeletonBars rows={4} />
            <LoadingNote>Firing up the scoreboard…</LoadingNote>
          </li>
        ) : (
          building.map((set) => (
            <li key={set.id}>
              <ScoreCard set={set} />
            </li>
          ))
        )}
        <li>
          <button
            type="button"
            onClick={() => setPicking(true)}
            className={`flex size-full min-h-40 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-control p-6 text-ink-2 hover:border-neon-blue hover:text-ink ${FOCUS}`}
          >
            <PlusIcon aria-hidden="true" className="size-8 text-neon-blue-text" />
            <span className="text-base font-bold">Start building a set</span>
            <span className="text-sm text-ink-3">
              {building?.length === 0
                ? "Nothing on the board yet. Pick a set and light it up."
                : "Put another checklist on the board."}
            </span>
          </button>
        </li>
      </ul>

      {picking && <SetPicker onClose={() => setPicking(false)} />}
    </section>
  );
}

/** The set's Base checklist: the variant of kind base, else its first. */
export function baseOf(variants: readonly Variant[]): Variant | null {
  return variants.find((v) => v.kind === "base") ?? variants[0] ?? null;
}

function ScoreCard({ set }: { set: SetRef }) {
  const { scopedName } = useMyCards();
  const summary = useSetSummary(set.id);
  const base = summary ? baseOf(summary.variants) : null;
  const completion = useVariantCompletion(base?.id ?? null);
  const label = setLabel(set);
  const complete = completion ? isComplete(completion) : false;
  const known = completion ? totalKnown(completion) : true;
  // No checklist on the set (the catalog hides every row known to hold no
  // cards), so there is no base to count: a settled board, never a skeleton.
  const empty = summary?.variants.length === 0;

  return (
    <article className="mc-led shadow-offset relative flex h-full flex-col gap-3 rounded-2xl border border-rule p-4 transition-colors focus-within:border-selection hover:border-selection has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4 has-[:focus-visible]:outline-focus">
      <div>
        <p className="text-xs text-ink-3">
          {set.sport.name}, {set.brand.name}
          {scopedName && <span className="text-neon-blue-text">, in {scopedName}</span>}
        </p>
        <h3 className="text-lg font-bold leading-tight text-ink">
          <ParamLink
            search={{ tab: "cards", set: set.id }}
            data-board={set.id}
            className="after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none"
          >
            {label}
          </ParamLink>
        </h3>
      </div>

      {summary === null ? (
        <p className="text-sm text-ink-2">This set is no longer in the catalog. Your cards stay put.</p>
      ) : empty ? (
        <p className="text-sm text-ink-2">No cards in this set yet. It&apos;s still in the shrink-wrap!</p>
      ) : (
        <>
          <div className="flex items-end justify-between gap-3">
            {completion ? (
              <p>
                <span
                  className={`mc-percent block text-6xl ${complete ? "text-neon-green-text" : "text-neon-blue-text"}`}
                  data-complete={complete}
                >
                  {known ? `${completion.percent}%` : completion.owned}
                </span>
                <span className="text-xs text-ink-2">
                  {complete ? "Base set complete!" : known ? "of the base set" : "base cards owned"}
                </span>
              </p>
            ) : (
              <SkeletonBars rows={2} className="w-24" />
            )}
            {completion && known && (
              <dl className="flex gap-4 text-right">
                <div>
                  <dt className="text-xs text-ink-3">Have</dt>
                  <dd className="text-2xl font-bold tabular-nums text-ink">{completion.owned}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-3">Need</dt>
                  <dd className="text-2xl font-bold tabular-nums text-ink">{completion.total - completion.owned}</dd>
                </div>
              </dl>
            )}
          </div>

          {summary ? (
            <ul aria-label={`${label} by row`} className="flex flex-col gap-2">
              {summary.variants.map((v) => (
                <VariantStrip key={v.id} variant={v} setLabelText={label} startOpen={v.id === base?.id} />
              ))}
            </ul>
          ) : (
            <SkeletonPips />
          )}
        </>
      )}
    </article>
  );
}

function printRun(v: Variant): string | null {
  return v.printRun === null ? null : v.printRun === 1 ? "1/1" : `/${v.printRun}`;
}

/**
 * One checklist's strip on a board. Base starts open; the rest open on
 * request, and only then read their cards (the demo, which holds every card
 * in memory, opens them all). The Show / Hide button is a disclosure that
 * stays put either way; the bulbs carry a spoken count, since a reader cannot
 * see which are lit.
 */
function VariantStrip({ variant, setLabelText, startOpen }: { variant: Variant; setLabelText: string; startOpen: boolean }) {
  const { isWanted } = useMyCards();
  const { kind } = useCollectionStore();
  const [open, setOpen] = useState(startOpen || kind === "demo");
  const completion = useVariantCompletion(variant.id);
  const cards = useVariantCards(open ? variant.id : null);
  const copies = useCopiesInVariant(open ? variant.id : null);
  const owned = useMemo(() => copiesByCard(copies), [copies]);
  const name = variantLabel(variant);
  const run = printRun(variant);
  const word = open ? "Hide the cards" : "Show the cards";
  const lit = cards && copies ? cards.filter((c) => owned.has(c.id)).length : 0;
  // NEO-358: spoken base first, like "Have 2 of 300"; variations after.
  const baseCards = cards ? cards.filter((c) => !c.isVariation) : [];
  const litBase = copies ? baseCards.filter((c) => owned.has(c.id)).length : 0;
  const starred = cards && copies ? cards.filter((c) => !owned.has(c.id) && isWanted(c.id)).length : 0;

  return (
    <li className="grid grid-cols-[7.5rem_1fr_auto] items-center gap-2 text-xs">
      <span className="truncate text-ink-2" title={name}>
        {name}
        {run && <span className="text-ink-3"> {run}</span>}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {open &&
          (cards && copies ? (
            <span className="flex flex-wrap gap-[3px]">
              <span className="sr-only">
                {`${litBase} of ${baseCards.length} lit up${
                  cards.length > baseCards.length ? `, ${lit} of ${cards.length} with variations` : ""
                }${starred > 0 ? `, ${starred} on your Want List` : ""}.`}
              </span>
              {cards.map((c) =>
                owned.has(c.id) ? (
                  <span key={c.id} aria-hidden="true" className="pip pip-owned" />
                ) : isWanted(c.id) ? (
                  <span key={c.id} aria-hidden="true" className="pip pip-want" />
                ) : (
                  <span key={c.id} aria-hidden="true" className="pip pip-missing" />
                ),
              )}
            </span>
          ) : (
            <SkeletonPips count={Math.min(variant.baseCardCount || 12, 40)} />
          ))}
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${word}, ${name} of ${setLabelText}`}
          onClick={() => setOpen(!open)}
          className={`relative z-10 inline-flex min-h-8 w-fit items-center gap-1 rounded-md px-1.5 text-ink-3 hover:text-neon-blue-text ${FOCUS}`}
        >
          <ChevronDownIcon
            aria-hidden="true"
            className={`size-3.5 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
          />
          {word}
        </button>
      </span>
      <span className="tabular-nums text-ink-2">
        {completion ? (
          totalKnown(completion) ? (
            <>
              {completion.owned}
              <span className="text-ink-3">/{completion.total}</span>
            </>
          ) : (
            haveShort(completion)
          )
        ) : (
          <span className="text-ink-3">…</span>
        )}
      </span>
    </li>
  );
}
