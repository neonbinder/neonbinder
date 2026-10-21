import { useEffect, useRef, useState } from "react";
import { ChevronLeftIcon, PrinterIcon } from "@heroicons/react/24/outline";
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
} from "../_shared/data";
import Chip from "./Chip";
import { FOCUS, PRIMARY_BUTTON, QUIET_BUTTON } from "./classes";
import { useP3 } from "./context";
import { printRunText, variantFilterOf, variantKey } from "./wallModel";

/**
 * NEO-350 prototype 3 — "Take it to the show": the want list for the sets on
 * the board, compact enough for a phone and printable on one sheet. At the
 * show, "Got it" lights the card up on the wall (with Undo).
 */

export default function NeedList({ onlySet, focusOnMount }: { onlySet?: SetId; focusOnMount: boolean }) {
  const api = useP3();
  const { store } = api;
  const building = store.state.buildingSetIds;
  const [chosen, setChosen] = useState<SetId[]>(() => (onlySet ? [onlySet] : building));
  const heading = useRef<HTMLHeadingElement>(null);
  const listRoot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusOnMount) heading.current?.focus();
  }, [focusOnMount]);

  const sets = building.filter((id) => chosen.includes(id));
  const total = sets.reduce((n, id) => n + store.completion(id).missing.length, 0);

  function gotIt(cardId: string) {
    // Keep the keyboard where it was: the next "Got it" button, else the heading.
    const buttons = [...(listRoot.current?.querySelectorAll<HTMLButtonElement>("button[data-need]") ?? [])];
    const i = buttons.findIndex((b) => b.dataset.need === cardId);
    const next = buttons[i + 1] ?? buttons[i - 1];
    const nextKey = next?.dataset.need;
    api.addOne(getCard(cardId), "need list");
    requestAnimationFrame(() => {
      const el = nextKey
        ? listRoot.current?.querySelector<HTMLButtonElement>(`button[data-need="${CSS.escape(nextKey)}"]`)
        : null;
      (el ?? heading.current)?.focus();
    });
  }

  return (
    <section aria-labelledby="p3-needs-heading">
      <button
        type="button"
        onClick={() => api.go("home")}
        className={`mb-3 inline-flex min-h-11 items-center gap-1 rounded-md pr-2 text-sm text-slate-300 hover:text-white sm:min-h-8 ${FOCUS}`}
      >
        <ChevronLeftIcon aria-hidden="true" className="size-4" />
        All my sets
      </button>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2
            id="p3-needs-heading"
            ref={heading}
            tabIndex={-1}
            className="text-2xl font-bold text-white focus:outline-none"
          >
            Take it to the show
          </h2>
          <p className="mt-1 text-sm text-slate-300">
            {total} {total === 1 ? "card" : "cards"} to hunt. Print it, or keep this page open on your phone and hit
            “Got it” at the table.
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

      <div ref={listRoot} data-p3-print className="mt-5">
        <p className="hidden text-sm print:block">
          Need list, printed {todayIso()}. Tick them off as you go.
        </p>
        {sets.length === 0 && (
          <p className="rounded-lg border border-dashed border-slate-700 p-6 text-center text-sm text-slate-300">
            Pick a set above to see what you still need.
          </p>
        )}
        {sets.map((id) => {
          const set = getSet(id);
          const whole = store.completion(id);
          return (
            <section key={id} aria-label={setLabel(set)} className="mb-6 break-inside-avoid-page">
              <h3 className="border-b border-slate-700 pb-1 text-lg font-bold text-white">
                {setLabel(set)}{" "}
                <span className="text-sm font-normal text-slate-400">
                  need {whole.missing.length} of {whole.total}
                </span>
              </h3>
              {whole.missing.length === 0 && (
                <p className="mt-2 text-sm text-neon-green">Every card on this checklist is in hand. Radical!</p>
              )}
              {set.variants.map((v) => {
                const missing = store.completion(id, variantFilterOf(v)).missing;
                if (missing.length === 0) return null;
                const run = printRunText(v);
                return (
                  <div key={variantKey(v)} className="mt-3">
                    <h4 className="text-sm font-bold text-slate-200">
                      {variantLabel(v.path)}
                      {run && ` ${run}`} <span className="font-normal text-slate-400">({missing.length})</span>
                    </h4>
                    <ul className="p3-print-columns mt-1 sm:columns-2 lg:columns-3">
                      {missing.map((c) => (
                        <li
                          key={c.id}
                          className="flex min-h-11 break-inside-avoid items-center gap-2 border-b border-slate-900 py-0.5 text-sm sm:min-h-8 print:min-h-0 print:border-b-0"
                        >
                          <span aria-hidden="true" className="hidden size-3 shrink-0 border print:inline-block" />
                          <span className="w-10 shrink-0 font-bold tabular-nums text-white">#{c.cardNumber}</span>
                          <span className="min-w-0 flex-1 truncate text-slate-200">
                            {playerNames(c)}
                            {c.variation ? ` (${c.variation})` : ""}{" "}
                            <span style={{ color: teamTextColor(leadTeam(c), "#000000") }}>{leadTeam(c).name}</span>
                          </span>
                          <button
                            type="button"
                            data-need={c.id}
                            aria-label={`Got it: ${variantLabel(v.path)} #${c.cardNumber} ${playerNames(c)}`}
                            onClick={() => gotIt(c.id)}
                            className={`p3-noprint min-h-11 shrink-0 rounded-md border border-neon-green px-2 text-xs font-bold text-neon-green hover:bg-neon-green hover:text-black sm:min-h-7 ${FOCUS}`}
                          >
                            Got it
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>

      <div className="mt-2 p3-noprint">
        <button type="button" onClick={() => api.go("home")} className={QUIET_BUTTON}>
          Back to the board
        </button>
      </div>
    </section>
  );
}
