import { useEffect, useRef, useState } from "react";
import StaticColumn, { DRILL_ROW_ATTR } from "../../prototypes/p1/StaticColumn";
import { COLUMN_CARD, COLUMN_WIDTH, SELECTED } from "../../prototypes/p1/ui";
import type { ColumnItem } from "../../prototypes/p1/drill";
import { useCollectionStore } from "../data/store";
import type { DrillItem } from "../data/types";
import { pick, type Drill, type DrillStep } from "./drill";
import { LoadingNote, SkeletonBars } from "./Skeleton";
import type { DrillState } from "./useDrillState";

/**
 * NEO-358 — the Checklists cascade, copied out of `prototypes/p1/Cascade`
 * (which stays for the prototypes) and fed by the store's drill
 * (`useDrillState`) instead of the fixture catalog.
 *
 * One StaticColumn per level, side by side, scrolling sideways on a narrow
 * screen exactly as the Set Builder does. A pick collapses its column to a
 * summary card and moves the caret into the next column (or onto the
 * checklist heading once the drill reaches one). A column still loading shows
 * its title over a skeleton; the caret waits for it.
 */

const SELECTED_FOR: Record<DrillStep, string> = {
  sport: SELECTED.sport,
  year: SELECTED.year,
  brand: SELECTED.brand,
  set: SELECTED.set,
  type: SELECTED.variantType,
  variant: SELECTED.variant,
  sub: SELECTED.variant,
};

/** "/50 · have 2 of 30", or "335 cards": the line under a checklist row. */
function describe(item: DrillItem): string | undefined {
  if (item.description) return item.description;
  const n = item.baseCardCount ?? item.cardCount;
  if (n === null || n === undefined || !item.variantId) return undefined;
  return `${n} ${n === 1 ? "card" : "cards"}`;
}

function toColumnItems(items: DrillItem[]): ColumnItem[] {
  return items.map((i) => ({ id: i.id, name: i.name, description: describe(i) }));
}

export default function Cascade({
  state,
  onDrill,
  label,
  onReachedChecklist,
}: {
  state: DrillState;
  onDrill: (next: Drill) => void;
  /** The row's accessible name, e.g. "Sport, year, brand and set". */
  label: string;
  /** Called after a pick lands on a checklist, to move focus to it. */
  onReachedChecklist: () => void;
}) {
  const { kind } = useCollectionStore();
  // Only what the collector toggled is held; otherwise a column with a pick
  // shows its summary card, so a drill restored from elsewhere (a deep link,
  // Back, a search jump) reads as a trail of picks.
  const [expanded, setExpanded] = useState<Partial<Record<DrillStep, boolean>>>({});
  const rowRef = useRef<HTMLDivElement>(null);
  const [focusStep, setFocusStep] = useState<DrillStep | "checklist" | null>(null);

  // The next column may still be loading: wait for its box, then move in.
  useEffect(() => {
    if (!focusStep) return;
    const frame = requestAnimationFrame(() => {
      if (focusStep === "checklist") {
        onReachedChecklist();
        setFocusStep(null);
        return;
      }
      const box = rowRef.current?.querySelector<HTMLElement>(`[data-level="${focusStep}"] [role="combobox"]`);
      if (box) {
        box.focus();
        setFocusStep(null);
      }
    });
    return () => cancelAnimationFrame(frame);
  });

  const choose = (step: DrillStep, item: DrillItem) => {
    onDrill(pick(state.drill, step, item.id));
    setExpanded((prev) => {
      const out = { ...prev };
      const steps: DrillStep[] = ["sport", "year", "brand", "set", "type", "variant", "sub"];
      for (const s of steps.slice(steps.indexOf(step) + 1)) delete out[s];
      return out;
    });
    const next: Record<DrillStep, DrillStep | null> = {
      sport: "year",
      year: "brand",
      brand: "set",
      set: "type",
      type: "variant",
      variant: "sub",
      sub: null,
    };
    setFocusStep(item.variantId || !item.hasChildren || !next[step] ? "checklist" : next[step]);
  };

  return (
    <div
      ref={rowRef}
      role="group"
      aria-label={label}
      {...{ [DRILL_ROW_ATTR]: "" }}
      className="relative flex flex-row items-start gap-4 overflow-x-auto pr-2 pb-4"
    >
      {state.pending && state.columns.length === 0 && <ColumnSkeleton title="Sports" />}
      {state.columns.map((column) => {
        if (column.items === undefined) return <ColumnSkeleton key={column.step} title={column.title} />;
        const items = column.items;
        // The real catalog sends years newest first and variants in the
        // set's own order; the demo's lists sort as they always have.
        const keepOrder = column.step === "type" || column.step === "variant" || column.step === "sub" || (kind === "convex" && column.step === "year");
        return (
          <div key={column.step} data-level={column.step} className={COLUMN_WIDTH}>
            <StaticColumn
              title={column.title}
              items={toColumnItems(items)}
              selectedId={column.selectedId}
              onSelect={(id) => {
                const item = items.find((i) => i.id === id);
                if (item) choose(column.step, item);
              }}
              expanded={expanded[column.step] ?? column.selectedId === null}
              setExpanded={(value) => setExpanded((prev) => ({ ...prev, [column.step]: value }))}
              selectedColor={SELECTED_FOR[column.step]}
              keepOrder={keepOrder}
            />
          </div>
        );
      })}
    </div>
  );
}

function ColumnSkeleton({ title }: { title: string }) {
  return (
    <div className={COLUMN_WIDTH}>
      <div className={COLUMN_CARD} aria-busy="true">
        <p className="mb-4 text-lg font-semibold text-ink">{title}</p>
        <SkeletonBars rows={4} />
        <LoadingNote>{`Loading ${title.toLowerCase()}…`}</LoadingNote>
      </div>
    </div>
  );
}
