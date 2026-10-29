import { useId } from "react";
import { FOCUS } from "../prototypes/p1/ui";
import {
  bindersOf,
  PICK_A_BINDER,
  useBinderMemory,
  useCapabilities,
  useContainers,
  useReadOnlyAll,
  useScope,
} from "./data/store";
import { useSetScope } from "./mode";

/**
 * "Binder: [All ▾]": which binder the page looks through, and where Have
 * and "Mark a range as Have" file new copies.
 *
 * - All: every copy counts, and nothing is added (NEO-374: All is a view,
 *   not a binder). A note under the picker says to choose a binder; Want is
 *   unscoped.
 * - A binder: only its copies count, Have adds to it, Want is for it.
 *
 * Only binders that hold copies are offered (Main and your own): the Want
 * List holds wants, Up for Trade is a flag, a smart binder fills itself, and
 * boxes (the sale table) are Inventory's, never the collection's (NEO-359).
 *
 * Sticky, so every tab sees the same choice. It lives on the page URL
 * (`scope=`, see `./mode`): a pick replaces the current history entry, and
 * both stores follow the URL (`useScope`). Under Profile → Settings' "remember
 * the last binder" the pick is also kept on the profile (`useBinderMemory`).
 *
 * Only a store with scope renders it.
 */
export default function BinderPicker() {
  const setScope = useSetScope();
  const scope = useScope();
  const { scope: canScope } = useCapabilities();
  const containers = useContainers();
  const memory = useBinderMemory();
  const readOnly = useReadOnlyAll();
  const noteId = useId();
  if (!canScope) return null;
  const options = bindersOf(containers);
  // While the shelf loads, the picker still shows the scope it will answer to.
  const value = scope === "all" || options.some((c) => c.id === scope) ? scope : "all";
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-sm">
        <span aria-hidden="true" className="text-ink-2">
          Binder
        </span>
        <select
          aria-label="Binder"
          value={value}
          disabled={!containers}
          aria-describedby={readOnly ? noteId : undefined}
          onChange={(e) => {
            setScope(e.target.value);
            memory?.remember(e.target.value);
          }}
          className={`min-h-8 rounded-md border bg-field py-1 pl-2 pr-8 text-sm font-medium text-ink hover:border-neon-blue ${FOCUS} ${
            value === "all" ? "border-control" : "border-selection"
          }`}
        >
          <option value="all">All</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {readOnly && (
        <p id={noteId} className="text-xs text-ink-2">
          {PICK_A_BINDER}
        </p>
      )}
    </div>
  );
}
