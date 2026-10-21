import type { CollectionTabProps } from "./store";

/**
 * My Binders: all of prototype 2 (Nine-Pocket) lands here (being ported
 * next). Placeholder for now: lists the binders, system ones first.
 */
export default function MyBindersTab({ store }: CollectionTabProps) {
  return (
    <section aria-label="My binders" className="space-y-3 rounded-lg border border-dashed border-slate-700 bg-gray-800 p-6 text-slate-200">
      <h2 className="text-lg font-semibold text-slate-100">My Binders</h2>
      <p className="text-sm text-slate-300">The nine-pocket binders are on their way here.</p>
      <ul className="space-y-1 text-sm">
        {store.state.binders.map((b) => {
          const count =
            b.system === "want" ? store.wantCardIds.length : store.binderCopies(b).length;
          return (
            <li key={b.id} className="flex justify-between gap-3 border-b border-slate-700/60 py-1">
              <span>
                {b.name}
                {b.system && <span className="ml-2 text-xs text-slate-400">always here</span>}
                {b.kind === "smart" && <span className="ml-2 text-xs text-slate-400">smart</span>}
              </span>
              <span className="tabular-nums text-slate-400">{count}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
