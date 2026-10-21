import { useId } from "react";
import { RunGlyph, SleeveStrip, type RunLineKind } from "@/components/modules/RunLedger";
import {
  cardLabel,
  getCard,
  getSet,
  leadTeam,
  playerNames,
  printRunLabel,
  setLabel,
  teamTextColor,
  variantLabel,
  type Copy,
} from "../_shared/data";
import { PANEL, RING, cardsWord, money } from "./ui";

/**
 * NEO-350 prototype 4 — the register tape beside the omnibox.
 *
 * The Jason-approved run-ledger look (RunLedger / ParallelBuildPanel): one
 * line per add, a glyph per state that the line's own words repeat, and a
 * sleeve strip that fills like a binder page. Newest on top, because the
 * dealer's eyes are on the card they just keyed.
 */

export type LedgerState = "adding" | "added" | "undone";

export interface LedgerEntry {
  key: string;
  /** The copy as it was added; Put back restores exactly this. */
  copy: Copy;
  state: LedgerState;
  /** Copies of this card owned right after the add. */
  haveAfter: number;
}

const KIND: Record<LedgerState, RunLineKind> = {
  adding: "building",
  added: "built",
  undone: "skipped",
};

/** The ledger sits on slate-950: dark-only tones (the defaults are bi-themed). */
const GLYPH_TONES: Record<RunLineKind, string> = {
  waiting: "text-slate-400",
  building: "text-[#00C2FF] motion-safe:animate-spin",
  built: "text-[#00D558]",
  skipped: "text-slate-400",
  blocked: "text-amber-300",
  stopped: "text-slate-400",
  failed: "text-pink-300",
  unfinished: "text-amber-300",
};
const SLEEVE_TONES: Record<RunLineKind, string> = {
  waiting: "border-slate-500 bg-transparent",
  building: "border-[#00C2FF] bg-[#00C2FF]/40 motion-safe:animate-pulse",
  built: "border-[#00D558] bg-[#00D558]",
  skipped: "border-slate-600 bg-slate-700/40",
  blocked: "border-amber-400 bg-amber-400",
  stopped: "border-slate-600 bg-slate-700/40",
  failed: "border-pink-400 bg-[#FF2E9A]",
  unfinished: "border-amber-400 bg-transparent",
};

export function ledgerTally(entries: LedgerEntry[]) {
  const live = entries.filter((e) => e.state !== "undone");
  const cards = live.reduce((n, e) => n + e.copy.quantity, 0);
  const cost = live.reduce((n, e) => n + (e.copy.costBasis ?? 0), 0);
  const sets = new Set(live.map((e) => getCard(e.copy.cardId).setId)).size;
  return { cards, cost, sets };
}

export default function Ledger({
  entries,
  onUndo,
  onPutBack,
  onClear,
}: {
  entries: LedgerEntry[];
  onUndo: (key: string) => void;
  onPutBack: (key: string) => void;
  onClear: () => void;
}) {
  const headingId = useId();
  const { cards, cost, sets } = ledgerTally(entries);
  const newestFirst = [...entries].reverse();

  return (
    <section aria-labelledby={headingId} className={`${PANEL} flex min-h-0 flex-col`}>
      <div className="border-b border-slate-800 px-3 pb-2 pt-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 id={headingId} className="text-base font-bold text-white">
            This session
          </h2>
          {entries.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className={`rounded-sm text-xs text-slate-400 underline-offset-2 hover:text-white hover:underline ${RING}`}
            >
              Start a new stack
            </button>
          )}
        </div>
        <p className="mt-1 text-2xl font-bold tabular-nums text-white">
          {cardsWord(cards)}
        </p>
        <p className="text-xs text-slate-400">
          {sets === 0
            ? "Nothing keyed yet."
            : `${sets} set${sets === 1 ? "" : "s"}${cost > 0 ? `, ${money(cost)} in cost` : ""}`}
        </p>
        {entries.length > 0 && (
          <SleeveStrip
            items={entries.slice(-36).map((e) => ({
              key: e.key,
              kind: KIND[e.state],
              title: cardLabel(getCard(e.copy.cardId)),
            }))}
            tones={SLEEVE_TONES}
            more={Math.max(0, entries.length - 36)}
            moreClassName="text-[10px] leading-[14px] text-slate-400"
          />
        )}
      </div>

      {entries.length === 0 ? (
        <p className="px-3 py-4 text-sm text-slate-400">
          Every card you key lands here with an Undo. Grab the next card off the stack.
        </p>
      ) : (
        <ol className="min-h-0 flex-1 divide-y divide-slate-800/80 overflow-y-auto">
          {newestFirst.map((e) => (
            <LedgerLine key={e.key} entry={e} onUndo={onUndo} onPutBack={onPutBack} />
          ))}
        </ol>
      )}
    </section>
  );
}

function LedgerLine({
  entry,
  onUndo,
  onPutBack,
}: {
  entry: LedgerEntry;
  onUndo: (key: string) => void;
  onPutBack: (key: string) => void;
}) {
  const card = getCard(entry.copy.cardId);
  const team = leadTeam(card);
  const run = printRunLabel(card);
  const undone = entry.state === "undone";
  const name = `#${card.cardNumber} ${playerNames(card)}`;
  const where = `${setLabel(getSet(card.setId))}, ${variantLabel(card.variantPath)}`;

  return (
    <li className="flex items-start gap-2 px-3 py-2">
      <RunGlyph kind={KIND[entry.state]} tones={GLYPH_TONES} />
      <div className={`min-w-0 flex-1 ${undone ? "opacity-70" : ""}`}>
        <p className="truncate text-sm font-medium text-slate-100">
          <span className={undone ? "line-through" : undefined}>{name}</span>
          {entry.copy.quantity > 1 && (
            <span className="ml-1 tabular-nums text-slate-300">×{entry.copy.quantity}</span>
          )}
        </p>
        <p className="truncate text-xs text-slate-400">
          <span style={{ color: teamTextColor(team, "#020617") }}>{team.name}</span>
          {" · "}
          {where}
          {run ? ` ${run}` : ""}
        </p>
        <p className="text-xs text-slate-400">
          {entry.state === "adding"
            ? "Filing…"
            : undone
              ? "Undone"
              : entry.haveAfter > entry.copy.quantity
                ? `Dupe: you have ${entry.haveAfter} now`
                : "New to the collection"}
          {entry.copy.forSale ? ", in For Sale" : ""}
        </p>
      </div>
      {undone ? (
        <button
          type="button"
          onClick={() => onPutBack(entry.key)}
          aria-label={`Put back ${cardLabel(card)}`}
          className={`shrink-0 rounded-md border border-slate-600 px-2 py-1 text-xs font-medium text-slate-200 hover:border-slate-400 min-h-11 sm:min-h-6 ${RING}`}
        >
          Put back
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onUndo(entry.key)}
          disabled={entry.state === "adding"}
          aria-label={`Undo ${cardLabel(card)}`}
          className={`shrink-0 rounded-md border border-slate-600 px-2 py-1 text-xs font-medium text-slate-200 hover:border-neon-pink hover:text-white disabled:opacity-50 min-h-11 sm:min-h-6 ${RING}`}
        >
          Undo
        </button>
      )}
    </li>
  );
}
