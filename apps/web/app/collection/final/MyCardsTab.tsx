import type { CollectionTabProps } from "./store";

/**
 * My Cards: prototype 3's Checklist Wall lands here (being ported next).
 * Placeholder for now: proves the props contract with a couple of live reads.
 */
export default function MyCardsTab({ store, goToTab }: CollectionTabProps) {
  const lines = store.scopedCopies.length;
  const cards = store.scopedCopies.reduce((n, c) => n + c.quantity, 0);
  return (
    <section aria-label="My cards" className="space-y-3 rounded-lg border border-dashed border-slate-700 bg-gray-800 p-6 text-slate-200">
      <h2 className="text-lg font-semibold text-slate-100">My Cards</h2>
      <p className="text-sm text-slate-300">
        The Checklist Wall is on its way here. For now: {cards} cards in {lines} line items.
      </p>
      <button
        type="button"
        onClick={() => goToTab("checklists")}
        className="rounded-sm text-sm text-neon-blue underline underline-offset-2 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]"
      >
        Go to Checklists
      </button>
    </section>
  );
}
