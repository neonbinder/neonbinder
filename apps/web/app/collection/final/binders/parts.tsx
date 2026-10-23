import { spineLabelPrintHref } from "@/lib/print/spine-label-params";
import { type LayoutMode, type PileFilters, type SortKey } from "../../prototypes/p2/model";
import type { CollectionBinder } from "../store";
import { labelOf } from "./label";
import type { OpenView, Tally } from "./openView";
import PrintShopLink from "./PrintShopLink";

/**
 * The open binder's furniture, from prototype 2's page: the layout toggle,
 * the master pile's sort and filters, the inside front cover (name, tally,
 * a few lines of how-to) and its phone-width summary. Plus one thing p2
 * never needed: the scope line saying what Checklists and My Cards look
 * through now that this binder is open. All of it reads the open view's
 * data (`OpenView`); `BinderView.tsx` puts it together.
 */

const FOCUS = "focus-outline";

export function ModeToggle({ mode, onChange }: { mode: LayoutMode; onChange: (m: LayoutMode) => void }) {
  const btn = (m: LayoutMode, label: string) => (
    <button
      type="button"
      aria-pressed={mode === m}
      onClick={() => onChange(m)}
      className={`min-h-10 rounded-md px-3 text-sm font-medium ${FOCUS} ${
        mode === m ? "bg-neon-blue text-on-neon-blue ring-1 ring-inset ring-selection" : "text-ink-2 hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label="How to show this binder" className="flex rounded-lg border border-control bg-field p-0.5">
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
        filters[key] ? "border-selection bg-neon-blue text-on-neon-blue" : "border-control text-ink-2 hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2 text-sm text-ink-2">
        Sort
        <select
          value={sort}
          onChange={(e) => onSort(e.target.value as SortKey)}
          className={`min-h-10 rounded-md border border-control bg-field px-2 text-sm text-ink ${FOCUS}`}
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
// The cover and its summary (what they show comes from `OpenView`)
// ---------------------------------------------------------------------------

function TallyLine({ tally, want }: { tally: Tally; want: boolean }) {
  const { have, need, cards } = tally;
  if (have !== null && need !== null) {
    const total = have + need;
    return (
      <div>
        <p className="text-lg font-bold text-ink tabular-nums">
          {want ? `${need} to chase, ${have} landed` : `${have} have, ${need} need`}
        </p>
        <div aria-hidden="true" className="mt-1.5 h-2 overflow-hidden rounded-full bg-rule">
          <div
            className={`h-full rounded-full ${want ? "bg-neon-pink" : "bg-neon-green"}`}
            style={{ width: `${total ? (have / total) * 100 : 0}%` }}
          />
        </div>
      </div>
    );
  }
  return (
    <p className="text-lg font-bold text-ink tabular-nums">
      {cards} {cards === 1 ? "card" : "cards"}
    </p>
  );
}

/** The cover's small "Edit label" control: restyles the binder's spine. */
export function EditLabelButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Edit label for ${name}`}
      className={`inline-flex min-h-8 items-center self-start rounded-md border border-control px-2.5 text-xs font-medium text-ink hover:border-neon-blue hover:text-ink max-sm:min-h-11 ${FOCUS}`}
    >
      Edit label
    </button>
  );
}

/**
 * The cover's "Print label": the Print Shop's spine-label designer with this
 * binder's name, colours and face filled in. The label it wears, exactly
 * (the collector's pick, else its default), never the shelf's readable swap.
 * In the app it opens a new tab (`PrintShopLink`).
 */
export function PrintLabelLink({ binder }: { binder: CollectionBinder }) {
  return (
    <PrintShopLink
      appHref={spineLabelPrintHref({ name: binder.name, ...labelOf(binder) })}
      aria-label={`Print label for ${binder.name}`}
      className={`inline-flex min-h-8 items-center rounded-md px-1 text-xs font-medium text-neon-blue-text underline underline-offset-2 hover:text-ink max-sm:min-h-11 ${FOCUS}`}
    >
      Print label
    </PrintShopLink>
  );
}

function LabelControls({ binder, onEditLabel }: { binder: CollectionBinder; onEditLabel: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 self-start">
      <EditLabelButton name={binder.name} onClick={onEditLabel} />
      <PrintLabelLink binder={binder} />
    </div>
  );
}

/** The inside front cover: name, label controls when it has a label, tally, how-to. */
export function Cover({ open, onEditLabel }: { open: OpenView; onEditLabel: () => void }) {
  return (
    <div className="flex h-full flex-col gap-3 text-sm text-ink-2">
      <p
        aria-hidden="true"
        className={`neon-header !text-[26px] leading-tight text-ink ${open.want ? "nb-glow-pink" : "nb-glow-blue"}`}
      >
        {open.title}
      </p>
      {open.label && <LabelControls binder={open.label} onEditLabel={onEditLabel} />}
      <TallyLine tally={open.tally} want={open.want} />
      {open.blurb.map((line) => (
        <p key={line}>{line}</p>
      ))}
      <p className="mt-auto text-xs text-ink-3">PageUp and PageDown turn the pages.</p>
    </div>
  );
}

/** The cover's phone-width summary. */
export function MobileSummary({ open, onEditLabel }: { open: OpenView; onEditLabel: () => void }) {
  return (
    <div className="mb-3 space-y-1 text-sm text-ink-2">
      {open.label && (
        <div className="float-right ml-3">
          <LabelControls binder={open.label} onEditLabel={onEditLabel} />
        </div>
      )}
      <TallyLine tally={open.tally} want={open.want} />
      <p>{open.blurb[0]}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// What the rest of the page is looking through
// ---------------------------------------------------------------------------

export function ScopeLine({ text, onGo }: { text: string; onGo: () => void }) {
  return (
    <p className="mb-3 text-sm text-ink-2">
      <span aria-hidden="true" className="nb-scope-dot mr-2 align-middle" />
      {text}{" "}
      <button
        type="button"
        onClick={onGo}
        className={`rounded-sm text-neon-blue-text underline underline-offset-2 hover:text-ink ${FOCUS}`}
      >
        Open Checklists
      </button>
    </p>
  );
}
