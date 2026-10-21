import { useEffect, useRef, useState } from "react";
import { getSet, type Completion, type SetId, type VariantFilter } from "../_shared/data";
import StaticColumn, { DRILL_ROW_ATTR } from "./StaticColumn";
import {
  brandItems,
  pick,
  setItems,
  sportItems,
  variantItems,
  variantTypeItems,
  yearItems,
  type Drill,
  type Level,
} from "./drill";
import { COLUMN_WIDTH, SELECTED } from "./ui";

/**
 * The admin cascade's row, collector edition: one StaticColumn per level,
 * side by side, scrolling sideways on a narrow screen exactly as the Set
 * Builder does. A pick collapses its column to a summary card and moves the
 * caret into the next column (or onto the checklist heading once the drill
 * reaches one).
 */
export default function Cascade({
  drill,
  onDrill,
  completion,
  label,
  onReachedChecklist,
}: {
  drill: Drill;
  onDrill: (next: Drill) => void;
  completion: (setId: SetId, v?: VariantFilter) => Completion;
  /** The row's accessible name, e.g. "Find a set". */
  label: string;
  /** Called after a pick lands on a checklist, to move focus to it. */
  onReachedChecklist: () => void;
}) {
  // A column with a pick starts collapsed to its summary card, so a drill
  // restored from elsewhere (search's "Open checklist", a tab switch) reads
  // as a trail of picks rather than six open lists.
  const [expanded, setExpandedState] = useState<Record<Level, boolean>>(() => ({
    sport: drill.sport === null,
    year: drill.year === null,
    brand: drill.brand === null,
    set: drill.set === null,
    variantType: drill.variantType === null,
    variant: drill.variant === null,
  }));
  const setExpanded = (level: Level) => (value: boolean) =>
    setExpandedState((prev) => ({ ...prev, [level]: value }));

  const rowRef = useRef<HTMLDivElement>(null);
  const [focusLevel, setFocusLevel] = useState<Level | "checklist" | null>(null);

  useEffect(() => {
    if (!focusLevel) return;
    const frame = requestAnimationFrame(() => {
      if (focusLevel === "checklist") onReachedChecklist();
      else
        rowRef.current
          ?.querySelector<HTMLElement>(`[data-level="${focusLevel}"] [role="combobox"]`)
          ?.focus();
      setFocusLevel(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusLevel, onReachedChecklist]);

  const choose = (level: Level, id: string) => {
    const next = pick(drill, level, id);
    onDrill(next);
    // Every deeper column opens fresh.
    setExpandedState((prev) => {
      const out = { ...prev };
      let deeper = false;
      for (const l of Object.keys(prev) as Level[]) {
        if (deeper) out[l] = true;
        if (l === level) deeper = true;
      }
      return out;
    });
    const isTerminal =
      (level === "variantType" && id === "Base") || level === "variant";
    const order: Level[] = ["sport", "year", "brand", "set", "variantType", "variant"];
    setFocusLevel(isTerminal ? "checklist" : order[order.indexOf(level) + 1]);
  };

  const set = drill.set ? getSet(drill.set) : null;

  const column = (level: Level, title: string, items: ReturnType<typeof sportItems>, selectedId: string | null, keepOrder = false) => (
    <div key={level} data-level={level} className={COLUMN_WIDTH}>
      <StaticColumn
        title={title}
        items={items}
        selectedId={selectedId}
        onSelect={(id) => choose(level, id)}
        expanded={expanded[level] || selectedId === null}
        setExpanded={setExpanded(level)}
        selectedColor={SELECTED[level]}
        keepOrder={keepOrder}
      />
    </div>
  );

  return (
    <div
      ref={rowRef}
      role="group"
      aria-label={label}
      {...{ [DRILL_ROW_ATTR]: "" }}
      className="relative flex flex-row items-start gap-4 overflow-x-auto pb-4"
    >
      {column("sport", "Sports", sportItems(), drill.sport)}
      {drill.sport && column("year", "Years", yearItems(drill.sport), drill.year === null ? null : String(drill.year))}
      {drill.sport && drill.year !== null &&
        column("brand", "Brands", brandItems(drill.sport, drill.year), drill.brand)}
      {drill.sport && drill.year !== null && drill.brand &&
        column("set", "Sets", setItems(drill.sport, drill.year, drill.brand, completion), drill.set)}
      {set && column("variantType", "Variant Types", variantTypeItems(set), drill.variantType, true)}
      {set && drill.variantType && drill.variantType !== "Base" &&
        column("variant", drill.variantType, variantItems(set, drill.variantType, completion), drill.variant, true)}
    </div>
  );
}
