import { useState } from "react";
import {
  getSet,
  setLabel,
  teamNames,
  variantLabel,
  type Card,
} from "../_shared/data";
import type { PrototypeStore } from "../_shared/usePrototypeStore";
import type { Notify } from "./notice";
import {
  CHIP,
  CHIP_OFF,
  CHIP_ON,
  FOCUS,
  OUTLINE_BUTTON,
  QUIET_BUTTON,
  liveryOn,
  shortCardName,
} from "./ui";

interface Group {
  key: string;
  title: string;
  subtitle: string;
  cards: Card[];
  onStop?: () => void;
}

const PAPER = "#020617";

/** Cards grouped by set (then insert / parallel), in checklist order. */
function bySet(cards: Card[]): { title: string; cards: Card[] }[] {
  const groups = new Map<string, Card[]>();
  for (const c of cards) {
    const key = `${c.setId}|${c.variantPath.type}|${c.variantPath.name ?? ""}`;
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }
  return [...groups.values()].map((list) => {
    const c = list[0];
    const set = setLabel(getSet(c.setId));
    return { title: c.variantPath.name ? `${set} ${variantLabel(c.variantPath)}` : set, cards: list };
  });
}

/**
 * The want list: every card still to chase, from the sets being built and
 * the smart binders, laid out like the printed checklist a collector folds
 * into a pocket on show day. Tap a card to add it.
 */
export default function WantList({
  store,
  notify,
  onOpen,
  onFindCards,
}: {
  store: PrototypeStore;
  notify: Notify;
  onOpen: (card: Card, list: Card[]) => void;
  onFindCards: () => void;
}) {
  const [extras, setExtras] = useState(false);

  const builds: Group[] = store.state.buildingSetIds.map((setId) => {
    const set = getSet(setId);
    const c = extras ? store.completion(setId) : store.completion(setId, { type: "Base" });
    return {
      key: `build-${setId}`,
      title: setLabel(set),
      subtitle: `Need ${c.missing.length} of ${c.total}${extras ? "" : " base"}`,
      cards: c.missing,
      onStop: () => {
        store.toggleBuilding(setId);
        notify(`Stopped building ${setLabel(set)}`, () => store.toggleBuilding(setId));
      },
    };
  });
  const smart: Group[] = store.state.binders
    .filter((b) => b.kind === "smart")
    .map((b) => {
      const cards = store.binderCards(b);
      const missing = cards.filter((c) => store.ownedCount(c.id) === 0);
      return {
        key: `binder-${b.id}`,
        title: b.name,
        subtitle: `Need ${missing.length} of ${cards.length}`,
        cards: missing,
      };
    })
    .filter((g) => g.cards.length > 0);

  const distinct = new Set([...builds, ...smart].flatMap((g) => g.cards.map((c) => c.id)));

  const copyList = async () => {
    const lines: string[] = [];
    for (const g of [...builds, ...smart]) {
      lines.push(`${g.title} (${g.subtitle})`);
      for (const s of bySet(g.cards)) {
        if (s.title !== g.title) lines.push(`  ${s.title}`);
        for (const c of s.cards) lines.push(`  [ ] ${shortCardName(c)}, ${teamNames(c)}`);
      }
      lines.push("");
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      notify("Want list copied. Paste it anywhere.");
    } catch {
      notify("Couldn't reach the clipboard here. Try again from a regular tab.");
    }
  };

  const section = (heading: string, groups: Group[], empty: string) => (
    <section className="space-y-3">
      <h3 className="text-base font-semibold text-slate-100">{heading}</h3>
      {groups.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-700 px-3 py-2 text-sm text-slate-400">{empty}</p>
      ) : (
        groups.map((g) => (
          <article
            key={g.key}
            aria-label={g.title}
            className="rounded-lg border border-slate-800 bg-slate-950 p-4 sm:p-5"
          >
            <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-dashed border-slate-700 pb-2">
              <h4 className="text-lg font-semibold text-slate-100">{g.title}</h4>
              <span className="flex items-baseline gap-3">
                <span className="text-sm text-slate-300 tabular-nums">{g.subtitle}</span>
                {g.onStop && (
                  <button
                    type="button"
                    onClick={g.onStop}
                    className={QUIET_BUTTON}
                    aria-label={`Stop building ${g.title}`}
                  >
                    Stop building
                  </button>
                )}
              </span>
            </header>
            {g.cards.length === 0 ? (
              <p className="pt-3 text-sm text-slate-300">Set complete. Totally rad.</p>
            ) : (
              bySet(g.cards).map((s) => (
                <div key={s.title} className="pt-3">
                  {s.title !== g.title && <p className="pb-1 text-sm font-medium text-slate-300">{s.title}</p>}
                  <ul className="columns-1 gap-x-6 sm:columns-2 xl:columns-3">
                    {s.cards.map((card) => (
                      <li key={card.id} className="break-inside-avoid">
                        <button
                          type="button"
                          onClick={() => onOpen(card, g.cards)}
                          className={`flex min-h-8 w-full items-baseline gap-2 rounded-sm px-1 py-0.5 text-left text-sm hover:bg-slate-900 ${FOCUS}`}
                        >
                          <span aria-hidden="true" className="relative top-0.5 h-3.5 w-3.5 shrink-0 rounded-[2px] border border-slate-400" />
                          <span className="w-10 shrink-0 text-right font-mono tabular-nums text-slate-400">
                            {card.cardNumber}
                          </span>
                          <span className="min-w-0 truncate text-slate-100">
                            {shortCardName(card).replace(/^#\S+ /, "")}
                          </span>
                          <span className="min-w-0 shrink truncate text-xs" style={{ color: liveryOn(card, PAPER) }}>
                            {teamNames(card)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </article>
        ))
      )}
    </section>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Want List</h2>
          <p className="text-sm text-slate-300">
            {distinct.size} {distinct.size === 1 ? "card" : "cards"} to chase. Tap one when you land it.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-pressed={extras}
            onClick={() => setExtras((v) => !v)}
            className={`${CHIP} ${extras ? CHIP_ON : CHIP_OFF}`}
          >
            Include inserts and parallels
          </button>
          <button type="button" onClick={() => void copyList()} className={OUTLINE_BUTTON}>
            Copy as text
          </button>
        </div>
      </div>
      {section(
        "Set builds",
        builds,
        "Not building any sets. Open a checklist in Find Cards and press Building this set.",
      )}
      {section("From your smart binders", smart, "Your smart binders are full. Nice.")}
      {builds.length === 0 && (
        <button type="button" onClick={onFindCards} className={OUTLINE_BUTTON}>
          Go to Find Cards
        </button>
      )}
    </div>
  );
}
