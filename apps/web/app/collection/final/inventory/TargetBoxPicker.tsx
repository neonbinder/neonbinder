import { ArchiveBoxIcon } from "@heroicons/react/24/outline";
import { FOCUS } from "../../prototypes/p1/ui";
import { useQuickEntry } from "./QuickEntry";

/**
 * NEO-364 (D8) — "Adding to [Unsorted ▾]": the box the inventory's
 * Checklists count and fill. Every quantity field below reads "how many plain
 * copies are in THIS box", and "Add a range to …" files into it.
 *
 * A native select (a combobox to a screen reader, with type-ahead on the
 * box names), like the collection's Binder picker. Unsorted comes first,
 * then the collector's boxes as made. A pick replaces `box=` on the URL (an
 * in-view tweak, never a Back step) and is kept on this device for next time.
 */
export default function TargetBoxPicker() {
  const { box, boxes, setBox } = useQuickEntry();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-neon-yellow-text/60 bg-raised px-3 py-2 shadow-offset">
      <ArchiveBoxIcon aria-hidden="true" className="h-5 w-5 shrink-0 text-neon-yellow-text" />
      <label className="flex items-center gap-2 text-sm">
        <span aria-hidden="true" className="font-semibold text-ink">
          Adding to
        </span>
        <select
          aria-label="Adding to"
          value={box?.id ?? ""}
          disabled={!box}
          onChange={(e) => setBox(e.target.value)}
          className={`min-h-9 rounded-md border border-control bg-field py-1 pl-2 pr-8 text-sm font-semibold text-ink hover:border-neon-yellow-text disabled:cursor-wait ${FOCUS}`}
        >
          {!box && <option value="">Finding your boxes…</option>}
          {boxes.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-ink-3">Each number below is how many raw copies sit in this box. Type it, tab on.</p>
    </div>
  );
}
