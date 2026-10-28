import { spineLabelPrintHref } from "@/lib/print/spine-label-params";
import type { ContainerLabel } from "../data/types";
import type { PileFilters, SortKey } from "./model";
import type { OpenView, Tally } from "./openView";
import PrintShopLink from "./PrintShopLink";
import NeonButton from "@/components/modules/NeonButton";

/**
 * The open binder's furniture, from prototype 2's page: the master pile's sort and filters, the inside front cover (name, tally,
 * a few lines of how-to) and its phone-width summary. All of it reads the
 * open view's data (`OpenView`); `BinderView.tsx` puts it together.
 */

const FOCUS = "focus-outline";

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
      {cards === null ? "Counting cards" : `${cards.toLocaleString("en-US")} ${cards === 1 ? "card" : "cards"}`}
    </p>
  );
}

/** The cover's small "Edit label" control: restyles the binder's spine. */
export function EditLabelButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <NeonButton
      type="button"
      variant="secondary"
      outline
      size="1"
      onClick={onClick}
      aria-label={`Edit label for ${name}`}
      className="min-h-8 self-start max-sm:min-h-11"
    >
      Edit label
    </NeonButton>
  );
}

/**
 * The cover's "Print label": the Print Shop's spine-label designer with this
 * binder's name, colours and face filled in. The label it wears, exactly
 * (the collector's pick, else its default), never the shelf's readable swap.
 * In the app it opens a new tab (`PrintShopLink`).
 */
export function PrintLabelLink({ name, label }: { name: string; label: ContainerLabel }) {
  return (
    <PrintShopLink
      appHref={spineLabelPrintHref({ name, ...label })}
      aria-label={`Print label for ${name}`}
      className={`inline-flex min-h-8 items-center rounded-md px-1 text-xs font-medium text-neon-blue-text underline underline-offset-2 hover:text-ink max-sm:min-h-11 ${FOCUS}`}
    >
      Print label
    </PrintShopLink>
  );
}

/** The cover's "Rename or delete": the collector's own binders and boxes only. */
export function EditContainerButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <NeonButton
      type="button"
      variant="secondary"
      outline
      size="1"
      onClick={onClick}
      aria-label={`Rename or delete ${name}`}
      className="min-h-8 self-start max-sm:min-h-11"
    >
      Rename or delete
    </NeonButton>
  );
}

export interface CoverActions {
  onEditLabel: () => void;
  onEditContainer: () => void;
}

/**
 * The label and rename controls, on the cover only where there are no binder
 * settings to hold them (a box, the Want List, Up for Trade, a store without
 * settings). NEO-362: a binder with settings keeps them in its settings.
 */
function LabelControls({ open, actions }: { open: OpenView; actions: CoverActions }) {
  if (!open.label || open.settings) return null;
  const { container, label } = open.label;
  return (
    <div className="flex flex-wrap items-center gap-2 self-start">
      <EditLabelButton name={container.name} onClick={actions.onEditLabel} />
      <PrintLabelLink name={container.name} label={label} />
      {open.editable && <EditContainerButton name={container.name} onClick={actions.onEditContainer} />}
    </div>
  );
}

/** The inside front cover: name, label controls when it has a label, tally, how-to. */
export function Cover({ open, actions, rearrange = false }: { open: OpenView; actions: CoverActions; rearrange?: boolean }) {
  return (
    <div className="flex h-full flex-col gap-3 text-sm text-ink-2">
      <p
        aria-hidden="true"
        className={`neon-header !text-[26px] leading-tight text-ink ${open.want ? "nb-glow-pink" : "nb-glow-blue"}`}
      >
        {open.title}
      </p>
      <LabelControls open={open} actions={actions} />
      <TallyLine tally={open.tally} want={open.want} />
      {open.blurb.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {!open.box && (
        <p className="mt-auto text-xs text-ink-3">
          PageUp and PageDown turn the pages.
          {rearrange && " To move a card, drag it to an empty pocket, press Alt+← or Alt+→ on it, or tap an empty pocket and then the card."}
        </p>
      )}
    </div>
  );
}

/** The cover's phone-width summary. */
export function MobileSummary({ open, actions }: { open: OpenView; actions: CoverActions }) {
  return (
    <div className="mb-3 space-y-1 text-sm text-ink-2">
      {open.label && !open.settings && (
        <div className="float-right ml-3">
          <LabelControls open={open} actions={actions} />
        </div>
      )}
      <TallyLine tally={open.tally} want={open.want} />
      {/* NEO-362: every line, so a phone also says when the binder keeps itself sorted (dragging is off). */}
      {open.blurb.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}
