import { FOCUS } from "../prototypes/p1/ui";
import { homesOf, useCapabilities, useContainers, useScope } from "./data/store";
import { useSetScope } from "./mode";

/**
 * "Binder: [All ▾]": which binder or box the page looks through, and where
 * Have and "Mark a range as Have" file new copies.
 *
 * - All: every copy counts; a new copy goes to Main; Want is unscoped.
 * - A binder or box: only its copies count, Have adds to it, Want is for it.
 *
 * Only homes are offered (Main, your binders, your boxes): the Want List
 * holds wants, Up for Trade is a flag, and a smart binder fills itself, so
 * none of them can hold a new copy.
 *
 * Sticky, so every tab sees the same choice. It lives on the page URL
 * (`scope=`, see `./mode`): a pick replaces the current history entry, and
 * both stores follow the URL (`useScope`).
 *
 * Only a store with scope renders it.
 */
export default function BinderPicker() {
  const setScope = useSetScope();
  const scope = useScope();
  const { scope: canScope } = useCapabilities();
  const containers = useContainers();
  if (!canScope) return null;
  const options = homesOf(containers);
  // While the shelf loads, the picker still shows the scope it will answer to.
  const value = scope === "all" || options.some((c) => c.id === scope) ? scope : "all";
  return (
    <label className="flex items-center gap-2 text-sm">
      <span aria-hidden="true" className="text-ink-2">
        Binder
      </span>
      <select
        aria-label="Binder"
        value={value}
        disabled={!containers}
        onChange={(e) => setScope(e.target.value)}
        className={`min-h-8 rounded-md border bg-field py-1 pl-2 pr-8 text-sm font-medium text-ink hover:border-neon-blue ${FOCUS} ${
          value === "all" ? "border-control" : "border-selection"
        }`}
      >
        <option value="all">All</option>
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {c.kind === "box" ? `${c.name} (box)` : c.name}
          </option>
        ))}
      </select>
    </label>
  );
}
