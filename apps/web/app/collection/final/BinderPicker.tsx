import { FOCUS } from "../prototypes/p1/ui";
import type { CollectionStore } from "./store";

/**
 * "Binder: [All ▾]": which binder the checklist looks through, and where
 * Have and "Mark a range as Have" file new copies.
 *
 * - All: every copy counts; a new copy goes to Main; Want is unscoped.
 * - A binder: only its copies count, Have adds to it, Want is for it.
 * - Want List: reads like All (it holds cards, not copies).
 *
 * Sticky (it lives in the store), so every tab sees the same choice.
 */
export default function BinderPicker({ store }: { store: CollectionStore }) {
  const options = store.state.binders.filter((b) => b.kind === "manual");
  return (
    <label className="flex items-center gap-2 text-sm">
      <span aria-hidden="true" className="text-slate-300">Binder</span>
      <select
        aria-label="Binder"
        value={store.selectedBinderId}
        onChange={(e) => store.setSelectedBinder(e.target.value)}
        className={`min-h-8 rounded-md border bg-slate-900 py-1 pl-2 pr-8 text-sm font-medium text-slate-100 hover:border-neon-blue ${FOCUS} ${
          store.selectedBinderId === "all" ? "border-slate-600" : "border-neon-blue"
        }`}
      >
        <option value="all">All</option>
        {options.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
    </label>
  );
}
