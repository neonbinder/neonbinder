import { FOCUS } from "../prototypes/p1/ui";
import { useCapabilities } from "./data/store";
import { useSetScope } from "./mode";
import type { CollectionStore } from "./store";

/**
 * "Binder: [All ▾]": which binder the checklist looks through, and where
 * Have and "Mark a range as Have" file new copies.
 *
 * - All: every copy counts; a new copy goes to Main; Want is unscoped.
 * - A binder: only its copies count, Have adds to it, Want is for it.
 * - Want List: reads like All (it holds cards, not copies).
 *
 * Sticky, so every tab sees the same choice. It lives on the page URL
 * (`scope=`, see `./mode`): a pick replaces the current history entry, and
 * the store follows the URL.
 *
 * Only a store with binders scopes (NEO-358): elsewhere it renders nothing.
 */
export default function BinderPicker({ store }: { store: CollectionStore }) {
  const setScope = useSetScope();
  const { scope } = useCapabilities();
  if (!scope) return null;
  const options = store.state.binders.filter((b) => b.kind === "manual");
  return (
    <label className="flex items-center gap-2 text-sm">
      <span aria-hidden="true" className="text-ink-2">Binder</span>
      <select
        aria-label="Binder"
        value={store.selectedBinderId}
        onChange={(e) => setScope(e.target.value)}
        className={`min-h-8 rounded-md border bg-field py-1 pl-2 pr-8 text-sm font-medium text-ink hover:border-neon-blue ${FOCUS} ${
          store.selectedBinderId === "all" ? "border-control" : "border-selection"
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
