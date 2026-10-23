import { useEffect, useRef, useState } from "react";
import { ChevronLeftIcon, PrinterIcon } from "@heroicons/react/24/outline";
import { StarIcon } from "@heroicons/react/20/solid";
import {
  getCard,
  getSet,
  leadTeam,
  playerNames,
  setLabel,
  teamTextColor,
  todayIso,
  variantLabel,
  type SetId,
} from "../../prototypes/_shared/data";
import Chip from "../../prototypes/p3/Chip";
import { FOCUS, PRIMARY_BUTTON, QUIET_BUTTON } from "../../prototypes/p3/classes";
import { printRunText, variantFilterOf, variantKey } from "../../prototypes/p3/wallModel";
import { useLiverySurface } from "../../prototypes/p1/ui";
import { useMyCards } from "./context";
import { wantedFirst } from "./model";

/**
 * NEO-350 — "Take it to the show": what's missing from the sets on the board,
 * compact enough for a phone and printable on one sheet. Cards on your Want
 * List lead each row, starred. At the show, "Got it" lights the card up on
 * the wall and files it in the target binder (with Undo).
 */
export default function NeedList({ onlySet, focusOnMount }: { onlySet?: SetId; focusOnMount: boolean }) {
  const api = useMyCards();
  const page = useLiverySurface("surface");
  const { store, scopedName } = api;
  const building = store.state.buildingSetIds;
  const [chosen, setChosen] = useState<SetId[]>(() => (onlySet ? [onlySet] : building));
  const heading = useRef<HTMLHeadingElement>(null);
  const listRoot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusOnMount) heading.current?.focus();
  }, [focusOnMount]);

  const sets = building.filter((id) => chosen.includes(id));
  const missingIn = (id: SetId) => store.completionInScope(id).missing;
  const total = sets.reduce((n, id) => n + missingIn(id).length, 0);
  const wantedCount = sets.reduce((n, id) => n + missingIn(id).filter((c) => store.isWanted(c.id)).length, 0);

  function gotIt(cardId: string) {
    // Keep the keyboard where it was: the next "Got it" button, else the heading.
    const buttons = [...(listRoot.current?.querySelectorAll<HTMLButtonElement>("button[data-need]") ?? [])];
    const i = buttons.findIndex((b) => b.dataset.need === cardId);
    const next = buttons[i + 1] ?? buttons[i - 1];
    const nextKey = next?.dataset.need;
    api.addOne(getCard(cardId));
    requestAnimationFrame(() => {
      const el = nextKey
        ? listRoot.current?.querySelector<HTMLButtonElement>(`button[data-need="${CSS.escape(nextKey)}"]`)
        : null;
      (el ?? heading.current)?.focus();
    });
  }

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
          <h2
            id="mc-needs-heading"
            ref={heading}
            tabIndex={-1}
            className="text-2xl font-bold text-ink focus:outline-none"
          >
            Take it to the show
          </h2>
          <p className="mt-1 text-sm text-ink-2">
            {total} {total === 1 ? "card" : "cards"} to hunt
            {scopedName ? ` for ${scopedName}` : ""}
            {wantedCount > 0 && (
              <>
                , {wantedCount} starred <StarIcon aria-hidden="true" className="inline size-3.5 text-neon-yellow-text" /> from
                your Want List
              </>
            )}
            . Print it, or keep this page open on your phone and hit “Got it” at the table.
          </p>
        </div>
        <button type="button" onClick={() => window.print()} className={PRIMARY_BUTTON}>
          <PrinterIcon aria-hidden="true" className="size-4" />
          Print it
        </button>
      </div>

      {building.length > 1 && (
        <div role="group" aria-label="Sets on this list" className="mt-4 flex flex-wrap gap-1.5">
          {building.map((id) => (
            <Chip
              key={id}
              pressed={chosen.includes(id)}
              onClick={() =>
                setChosen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
              }
            >
              {setLabel(getSet(id))}
            </Chip>
          ))}
        </div>
      )}

      <div ref={listRoot} data-mc-print className="mt-5">
        <p className="hidden text-sm print:block">
          Need list{scopedName ? ` for ${scopedName}` : ""}, printed {todayIso()}. ★ is on your Want List. Tick them
          off as you go.
        </p>
        {sets.length === 0 && (
          <p className="rounded-lg border border-dashed border-rule-strong p-6 text-center text-sm text-ink-2">
            {building.length === 0
              ? "No sets on the board yet. Start building one and its needs land here."
              : "Pick a set above to see what you still need."}
          </p>
        )}
        {sets.map((id) => {
          const set = getSet(id);
          const whole = store.completionInScope(id);
          return (
            <section key={id} aria-label={setLabel(set)} className="mb-6 break-inside-avoid-page">
              <h3 className="border-b border-rule-strong pb-1 text-lg font-bold text-ink">
                {setLabel(set)}{" "}
                <span className="text-sm font-normal text-ink-3">
                  need {whole.missing.length} of {whole.total}
                </span>
              </h3>
              {whole.missing.length === 0 && (
                <p className="mt-2 text-sm text-neon-green-text">Every card on this checklist is in hand. Radical!</p>
              )}
              {set.variants.map((v) => {
                const missing = wantedFirst(
                  store.completionInScope(id, variantFilterOf(v)).missing,
                  store.isWanted,
                );
                if (missing.length === 0) return null;
                const run = printRunText(v);
                return (
                  <div key={variantKey(v)} className="mt-3">
                    <h4 className="text-sm font-bold text-ink-2">
                      {variantLabel(v.path)}
                      {run && ` ${run}`} <span className="font-normal text-ink-3">({missing.length})</span>
                    </h4>
                    <ul className="mc-print-columns mt-1 sm:columns-2 lg:columns-3">
                      {missing.map((c) => {
                        const wanted = store.isWanted(c.id);
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
                              {c.variation ? ` (${c.variation})` : ""}{" "}
                              <span style={{ color: teamTextColor(leadTeam(c), page) }}>{leadTeam(c).name}</span>
                            </span>
                            <button
                              type="button"
                              data-need={c.id}
                              aria-label={`Got it: ${variantLabel(v.path)} #${c.cardNumber} ${playerNames(c)}${
                                c.variation ? `, ${c.variation} variation` : ""
                              }`}
                              onClick={() => gotIt(c.id)}
                              className={`mc-noprint min-h-11 shrink-0 rounded-md border border-neon-green-text px-2 text-xs font-bold text-neon-green-text hover:bg-neon-green hover:text-on-neon-green sm:min-h-7 ${FOCUS}`}
                            >
                              Got it
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>

      <div className="mc-noprint mt-2">
        <button type="button" onClick={() => api.go("home")} className={QUIET_BUTTON}>
          Back to the board
        </button>
      </div>
    </section>
  );
}
