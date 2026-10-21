import type { CSSProperties } from "react";
import { describeRule, getSet, setLabel } from "../../prototypes/_shared/data";
import {
  type LayoutMode,
  type PileFilters,
  type SortKey,
  type ViewKey,
} from "../../prototypes/p2/model";
import type { CollectionBinder, CollectionStore } from "../store";
import { binderTally } from "./model";

/**
 * The open binder's furniture, from prototype 2's page: the layout toggle,
 * the master pile's sort and filters, the inside front cover (name, tally,
 * a few lines of how-to) and its phone-width summary. Plus one thing p2
 * never needed: the scope line saying what Checklists and My Cards look
 * through now that this binder is open.
 */

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]";

export function ModeToggle({ mode, onChange }: { mode: LayoutMode; onChange: (m: LayoutMode) => void }) {
  const btn = (m: LayoutMode, label: string) => (
    <button
      type="button"
      aria-pressed={mode === m}
      onClick={() => onChange(m)}
      className={`min-h-10 rounded-md px-3 text-sm font-medium ${FOCUS} ${
        mode === m ? "bg-neon-blue text-black" : "text-slate-200 hover:text-white"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label="How to show this binder" className="flex rounded-lg border border-slate-600 bg-slate-900 p-0.5">
      {btn("pockets", "Lay out like my real binder")}
      {btn("stack", "Just a stack")}
    </div>
  );
}

export function PileTools({
  sort,
  onSort,
  filters,
  onFilters,
}: {
  sort: SortKey;
  onSort: (s: SortKey) => void;
  filters: PileFilters;
  onFilters: (f: PileFilters) => void;
}) {
  const toggle = (key: keyof PileFilters, label: string) => (
    <button
      type="button"
      aria-pressed={filters[key]}
      onClick={() => onFilters({ ...filters, [key]: !filters[key] })}
      className={`min-h-10 rounded-md border px-3 text-sm font-medium ${FOCUS} ${
        filters[key] ? "border-neon-blue bg-neon-blue text-black" : "border-slate-600 text-slate-200 hover:text-white"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2 text-sm text-slate-300">
        Sort
        <select
          value={sort}
          onChange={(e) => onSort(e.target.value as SortKey)}
          className={`min-h-10 rounded-md border border-slate-600 bg-slate-900 px-2 text-sm text-slate-100 ${FOCUS}`}
        >
          <option value="checklist">Checklist order</option>
          <option value="newest">Newest first</option>
          <option value="player">Player, A to Z</option>
        </select>
      </label>
      <div role="group" aria-label="Only show" className="flex flex-wrap gap-2">
        {toggle("graded", "Graded")}
        {toggle("forSale", "For sale")}
        {toggle("rookies", "Rookies")}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The cover and its summary
// ---------------------------------------------------------------------------

interface Summary {
  have: number | null;
  need: number | null;
  cards: number | null;
}

function summaryFor(view: ViewKey, binder: CollectionBinder | undefined, store: CollectionStore): Summary {
  const { copies } = store.state;
  if (view.kind === "set") {
    const c = store.completion(view.setId);
    return { have: c.owned, need: c.total - c.owned, cards: null };
  }
  if (view.kind === "all") {
    return { have: null, need: null, cards: copies.reduce((n, c) => n + c.quantity, 0) };
  }
  if (!binder) return { have: null, need: null, cards: 0 };
  if (binder.system === "want") {
    const landed = store.wantCardIds.filter((id) => store.ownedCount(id) > 0).length;
    return { have: landed, need: store.wantCardIds.length - landed, cards: null };
  }
  const count = binderTally(binder, copies);
  return { have: count.have ?? null, need: count.need ?? null, cards: count.cards };
}

function Tally({ have, need, cards, want }: Summary & { want: boolean }) {
  if (have !== null && need !== null) {
    const total = have + need;
    return (
      <div>
        <p className="text-lg font-bold text-white tabular-nums">
          {want ? `${need} to chase, ${have} landed` : `${have} have, ${need} need`}
        </p>
        <div aria-hidden="true" className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-800">
          <div
            className={`h-full rounded-full ${want ? "bg-neon-pink" : "bg-neon-green"}`}
            style={{ width: `${total ? (have / total) * 100 : 0}%` }}
          />
        </div>
      </div>
    );
  }
  return (
    <p className="text-lg font-bold text-white tabular-nums">
      {cards} {cards === 1 ? "card" : "cards"}
    </p>
  );
}

function blurb(view: ViewKey, binder: CollectionBinder | undefined, mode: LayoutMode): string[] {
  if (view.kind === "set") {
    return [
      "Every card in the set, in checklist order. Each insert starts a fresh page.",
      "Got one? Hit Add on its sleeve.",
    ];
  }
  if (view.kind === "all") {
    return [
      "Every card you own, one pocket per copy. A yellow tag means it's for sale.",
      "Press a card to pull it out of the sleeve and see the details.",
    ];
  }
  if (!binder) return [];
  if (binder.system === "want") {
    return [
      "Cards you're chasing, grouped by the binder they're for.",
      "Land one? Press its sleeve to add it.",
      "While this is open, the pack adds to your Want List.",
    ];
  }
  const lines: string[] = [];
  if (binder.description) lines.push(binder.description);
  if (binder.kind === "smart") {
    lines.push(`Fills itself: ${describeRule(binder.rule)}.`);
    if (mode === "pockets") lines.push("Empty sleeves are your needs. Got one? Press it.");
  } else if (mode === "pockets") {
    lines.push("Drag a card from the pack into any pocket, or press an empty pocket to fill that one.");
  } else {
    lines.push("Drag a card from the pack onto the binder to file it here.");
  }
  return lines;
}

export function viewTitle(view: ViewKey, binder: CollectionBinder | undefined): string {
  if (view.kind === "binder") return binder?.name ?? "Binder";
  if (view.kind === "set") return setLabel(getSet(view.setId));
  return "All my cards";
}

export function Cover({
  view,
  binder,
  store,
  mode,
}: {
  view: ViewKey;
  binder: CollectionBinder | undefined;
  store: CollectionStore;
  mode: LayoutMode;
}) {
  const t = summaryFor(view, binder, store);
  const want = binder?.system === "want";
  return (
    <div className="flex h-full flex-col gap-3 text-sm text-slate-300">
      <p
        aria-hidden="true"
        className="neon-header !text-[26px] leading-tight text-white"
        style={
          {
            textShadow: want ? "0 0 14px rgba(255,46,154,0.7)" : "0 0 14px rgba(0,194,255,0.6)",
          } as CSSProperties
        }
      >
        {viewTitle(view, binder)}
      </p>
      <Tally {...t} want={want} />
      {blurb(view, binder, mode).map((line) => (
        <p key={line}>{line}</p>
      ))}
      <p className="mt-auto text-xs text-slate-400">PageUp and PageDown turn the pages.</p>
    </div>
  );
}

export function MobileSummary({
  view,
  binder,
  store,
  mode,
}: {
  view: ViewKey;
  binder: CollectionBinder | undefined;
  store: CollectionStore;
  mode: LayoutMode;
}) {
  const t = summaryFor(view, binder, store);
  return (
    <div className="mb-3 space-y-1 text-sm text-slate-300">
      <Tally {...t} want={binder?.system === "want"} />
      <p>{blurb(view, binder, mode)[0]}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// What the rest of the page is looking through
// ---------------------------------------------------------------------------

export function scopeText(view: ViewKey, binder: CollectionBinder | undefined): string | null {
  if (view.kind === "set") return null;
  if (view.kind === "all") return "Checklists and My Cards are looking through everything.";
  if (!binder) return null;
  if (binder.system === "want") {
    return "Checklists and My Cards are looking through everything, with your wants lit up.";
  }
  if (binder.kind === "smart") {
    return `${binder.name} fills itself, so Checklists and My Cards look through everything.`;
  }
  return `Checklists and My Cards are looking through ${binder.name}.`;
}

export function ScopeLine({ text, onGo }: { text: string; onGo: () => void }) {
  return (
    <p className="mb-3 text-sm text-slate-300">
      <span aria-hidden="true" className="nb-scope-dot mr-2 align-middle" />
      {text}{" "}
      <button
        type="button"
        onClick={onGo}
        className={`rounded-sm text-neon-blue underline underline-offset-2 hover:text-white ${FOCUS}`}
      >
        Open Checklists
      </button>
    </p>
  );
}
