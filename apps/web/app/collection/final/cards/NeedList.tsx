import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ChevronDownIcon, ChevronLeftIcon, PrinterIcon } from "@heroicons/react/24/outline";
import { StarIcon } from "@heroicons/react/20/solid";
import NeonButton from "@/components/modules/NeonButton";
import Chip from "../../prototypes/p3/Chip";
import { FOCUS, PRIMARY_BUTTON, QUIET_BUTTON } from "../../prototypes/p3/classes";
import { useLiverySurface } from "../../prototypes/p1/ui";
import { isComplete, totalKnown } from "../catalog/format";
import { copiesByCard } from "../catalog/home";
import { LoadingNote, SkeletonBars } from "../catalog/Skeleton";
import { playerNames, setLabel, teamTextColor, variantLabel } from "../data/labels";
import {
  todayIso,
  useBuildingSets,
  useCollectionStore,
  useCopiesInVariant,
  useSetSummary,
  useVariantCards,
  useVariantCompletion,
} from "../data/store";
import type { SetRef, Variant } from "../data/types";
import { useMyCards } from "./context";
import { wantedFirst } from "./model";
import { baseOf } from "./Scoreboard";

/**
 * NEO-350 / NEO-358 — "Take it to the show": what's missing from the sets on
 * the board, compact enough for a phone and printable on one sheet. Each set
 * lists its checklists; Base is open, the rest say how many you need and
 * open on request ("Open every checklist" opens them all before you print).
 * At the show, "Got it" lights the card up on the wall (with Undo).
 */
export default function NeedList({ onlySet, focusOnMount }: { onlySet?: string; focusOnMount: boolean }) {
  const api = useMyCards();
  const building = useBuildingSets();
  const heading = useRef<HTMLHeadingElement>(null);
  const listRoot = useRef<HTMLDivElement>(null);
  const [chosen, setChosen] = useState<string[] | null>(onlySet ? [onlySet] : null);
  const [openAll, setOpenAll] = useState(false);

  useEffect(() => {
    if (focusOnMount) heading.current?.focus();
  }, [focusOnMount]);

  const onBoard = building ?? [];
  const sets = onBoard.filter((s) => chosen === null || chosen.includes(s.id));
  // A need list for a set not on the board still works: it lists just that one.
  const extra = onlySet && building && !onBoard.some((s) => s.id === onlySet) ? onlySet : null;

  return (
    <section aria-labelledby="mc-needs-heading">
      <button
        type="button"
        onClick={() => api.go("home")}
        className={`mb-3 inline-flex min-h-11 items-center gap-1 rounded-md pr-2 text-sm text-ink-2 hover:text-ink sm:min-h-8 ${FOCUS}`}
      >
        <ChevronLeftIcon aria-hidden="true" className="size-4" />
        All my sets
      </button>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="mc-needs-heading" ref={heading} tabIndex={-1} className="text-2xl font-bold text-ink focus:outline-none">
            Take it to the show
          </h2>
          <p className="mt-1 text-sm text-ink-2">
            Every card you still need{api.scopedName ? ` for ${api.scopedName}` : ""}. Print it, or keep this page open on
            your phone and hit “Got it” at the table.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" aria-pressed={openAll} onClick={() => setOpenAll(!openAll)} className={QUIET_BUTTON}>
            Open every checklist
          </button>
          <button type="button" onClick={() => window.print()} className={PRIMARY_BUTTON}>
            <PrinterIcon aria-hidden="true" className="size-4" />
            Print it
          </button>
        </div>
      </div>

      {onBoard.length > 1 && (
        <div role="group" aria-label="Sets on this list" className="mt-4 flex flex-wrap gap-1.5">
          {onBoard.map((s) => {
            const on = chosen === null || chosen.includes(s.id);
            return (
              <Chip
                key={s.id}
                pressed={on}
                onClick={() =>
                  setChosen((prev) => {
                    const now = prev ?? onBoard.map((x) => x.id);
                    return now.includes(s.id) ? now.filter((x) => x !== s.id) : [...now, s.id];
                  })
                }
              >
                {setLabel(s)}
              </Chip>
            );
          })}
        </div>
      )}

      <div ref={listRoot} data-mc-print className="mt-5">
        <p className="hidden text-sm print:block">
          Need list{api.scopedName ? ` for ${api.scopedName}` : ""}, printed {todayIso()}. Tick them off as you go.
        </p>
        {building === undefined ? (
          <div aria-busy="true">
            <SkeletonBars rows={6} />
            <LoadingNote>Pulling your need list…</LoadingNote>
          </div>
        ) : sets.length === 0 && !extra ? (
          <p className="rounded-lg border border-dashed border-rule-strong p-6 text-center text-sm text-ink-2">
            {onBoard.length === 0
              ? "No sets on the board yet. Start building one and its needs land here."
              : "Pick a set above to see what you still need."}
          </p>
        ) : (
          <>
            {sets.map((s) => (
              <SetNeeds key={s.id} setId={s.id} known={s} openAll={openAll} listRoot={listRoot} heading={heading} />
            ))}
            {extra && <SetNeeds setId={extra} openAll={openAll} listRoot={listRoot} heading={heading} />}
          </>
        )}
      </div>

      <div className="mc-noprint mt-2">
        <button type="button" onClick={() => api.go("home")} className={QUIET_BUTTON}>
          Back to the board
        </button>
      </div>
    </section>
  );
}

function SetNeeds({
  setId,
  known,
  openAll,
  listRoot,
  heading,
}: {
  setId: string;
  known?: SetRef;
  openAll: boolean;
  listRoot: RefObject<HTMLDivElement | null>;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const summary = useSetSummary(setId);
  const set = summary?.set ?? known;
  const base = summary ? baseOf(summary.variants) : null;
  const label = set ? setLabel(set) : "This set";
  if (summary === null) {
    return <p className="mb-6 text-sm text-ink-3">{label} is no longer in the catalog.</p>;
  }
  return (
    <section aria-label={label} className="mb-6 break-inside-avoid-page">
      <h3 className="border-b border-rule-strong pb-1 text-lg font-bold text-ink">{label}</h3>
      {summary === undefined ? (
        <SkeletonBars rows={3} className="mt-2" />
      ) : (
        summary.variants.map((v) => (
          <VariantNeeds
            key={v.id}
            variant={v}
            setText={label}
            startOpen={v.id === base?.id || openAll}
            listRoot={listRoot}
            heading={heading}
          />
        ))
      )}
    </section>
  );
}

function VariantNeeds({
  variant,
  setText,
  startOpen,
  listRoot,
  heading,
}: {
  variant: Variant;
  setText: string;
  startOpen: boolean;
  listRoot: RefObject<HTMLDivElement | null>;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const api = useMyCards();
  const page = useLiverySurface("surface");
  const { kind } = useCollectionStore();
  const [opened, setOpened] = useState(false);
  const open = startOpen || opened || kind === "demo";
  const completion = useVariantCompletion(variant.id);
  const cards = useVariantCards(open ? variant.id : null);
  const copies = useCopiesInVariant(open ? variant.id : null);
  const owned = useMemo(() => copiesByCard(copies), [copies]);
  const name = variantLabel(variant);
  const run = variant.printRun === null ? null : variant.printRun === 1 ? "1/1" : `/${variant.printRun}`;
  const missing = cards && copies ? wantedFirst(cards.filter((c) => !owned.has(c.id)), api.isWanted) : null;
  const need = missing?.length ?? (completion && totalKnown(completion) ? completion.total - completion.owned : null);

  if (completion && isComplete(completion) && (!missing || missing.length === 0)) return null;
  if (missing && missing.length === 0) return null;

  function gotIt(cardId: string) {
    const card = missing?.find((c) => c.id === cardId);
    if (!card) return;
    // Keep the keyboard where it was: the next "Got it" button, else the heading.
    const buttons = [...(listRoot.current?.querySelectorAll<HTMLButtonElement>("button[data-need]") ?? [])];
    const i = buttons.findIndex((b) => b.dataset.need === cardId);
    const nextKey = (buttons[i + 1] ?? buttons[i - 1])?.dataset.need;
    api.addOne(card);
    requestAnimationFrame(() => {
      const el = nextKey ? listRoot.current?.querySelector<HTMLButtonElement>(`button[data-need="${CSS.escape(nextKey)}"]`) : null;
      (el ?? heading.current)?.focus();
    });
  }

  return (
    <div className="mt-3">
      <h4 className="flex flex-wrap items-center gap-2 text-sm font-bold text-ink-2">
        <span>
          {name}
          {run && ` ${run}`} {need !== null && <span className="font-normal text-ink-3">(need {need})</span>}
        </span>
        {!open && (
          <button
            type="button"
            aria-expanded={false}
            aria-label={`Show what you need from ${setText} ${name}`}
            onClick={() => setOpened(true)}
            className={`mc-noprint inline-flex min-h-11 items-center gap-1 rounded-md px-1.5 text-xs font-normal text-ink-3 hover:text-neon-blue-text sm:min-h-8 ${FOCUS}`}
          >
            <ChevronDownIcon aria-hidden="true" className="size-3.5" />
            Show them
          </button>
        )}
      </h4>
      {open && !missing && <SkeletonBars rows={2} className="mt-1" />}
      {missing && (
        <ul className="mc-print-columns mt-1 sm:columns-2 lg:columns-3">
          {missing.map((c) => {
            const wanted = api.isWanted(c.id);
            const team = c.teams[0];
            return (
              <li
                key={c.id}
                className="flex min-h-11 break-inside-avoid items-center gap-2 border-b border-rule py-0.5 text-sm sm:min-h-8 print:min-h-0 print:border-b-0"
              >
                <span aria-hidden="true" className="hidden size-3 shrink-0 border print:inline-block" />
                <span className="flex w-12 shrink-0 items-center gap-0.5 font-bold tabular-nums text-ink">
                  {wanted ? (
                    <StarIcon aria-hidden="true" className="size-3.5 shrink-0 text-neon-yellow-text" />
                  ) : (
                    <span aria-hidden="true" className="size-3.5 shrink-0" />
                  )}
                  #{c.cardNumber}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink-2">
                  {wanted && <span className="sr-only">On your Want List: </span>}
                  {playerNames(c)}
                  {c.cardVariation ? ` (${c.cardVariation})` : ""}{" "}
                  {team && <span style={{ color: teamTextColor(team, page) }}>{team.name}</span>}
                </span>
                <NeonButton
                  type="button"
                  outline
                  size="1"
                  data-need={c.id}
                  aria-label={`Got it: ${name} #${c.cardNumber} ${playerNames(c)}${c.cardVariation ? `, ${c.cardVariation} variation` : ""}`}
                  onClick={() => gotIt(c.id)}
                  className="mc-noprint min-h-11 sm:min-h-7"
                >
                  Got it
                </NeonButton>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
