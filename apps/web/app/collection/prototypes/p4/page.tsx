import { Link, useSearchParams } from "react-router";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import PrototypeBanner, { prototypeName } from "../_shared/PrototypeBanner";
import { usePrototypeStore } from "../_shared/usePrototypeStore";
import BindersPanel from "./BindersPanel";
import Counter from "./Counter";
import CopyTable from "./CopyTable";
import { RING } from "./ui";

/**
 * NEO-350 — collection prototype 4, "Dealer's Counter".
 *
 * Keyboard-first speed for someone processing a stack of cards in hand: one
 * big search box, Enter to add, the next card. Four sections on a strip,
 * driven by `?tab=` so a section can be linked and Back works:
 *
 * - Counter: the omnibox, sticky scope + sticky details, the session ledger,
 *   and a read-only checklist lookup.
 * - My Cards / For Sale: two separate piles (PC and stock) as dense sortable
 *   tables with bulk actions. A copy moves between them only on purpose.
 * - Binders: manual and smart binders, with a rule builder.
 *
 * The Counter stays mounted while another section shows (`hidden`), so the
 * session ledger, scope and sticky details survive a trip to My Cards.
 *
 * Kept as a signed-in reference at its own `/collection/<n>` route
 * (lazy-loaded). The shipped collection demo is `../../final`, built from
 * prototypes 1-3; this page is not developed further.
 */

const TABS = [
  { key: "counter", label: "Counter" },
  { key: "cards", label: "My Cards" },
  { key: "sale", label: "For Sale" },
  { key: "binders", label: "Binders" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default function CollectionPrototype4() {
  const name = prototypeName(4);
  useDocumentTitle(`${name} · Collection prototype`);
  const store = usePrototypeStore("p4");
  const [params] = useSearchParams();
  const raw = params.get("tab");
  const tab: TabKey = TABS.some((t) => t.key === raw) ? (raw as TabKey) : "counter";

  const pc = store.state.copies.filter((c) => !c.forSale).reduce((n, c) => n + c.quantity, 0);
  const sale = store.state.copies.filter((c) => c.forSale).reduce((n, c) => n + c.quantity, 0);
  const counts: Record<TabKey, number | null> = {
    counter: null,
    cards: pc,
    sale,
    binders: store.state.binders.length,
  };

  return (
    <div>
      <PrototypeBanner current={4} />

      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">{name}</h1>
        <p className="text-sm text-slate-400">Card in hand, type, Enter. Next.</p>
      </div>

      <nav aria-label="Dealer's Counter sections" className="mb-4 border-b border-slate-800">
        <ul className="flex flex-wrap gap-x-4 gap-y-1 sm:gap-x-5">
          {TABS.map((t) => {
            const active = t.key === tab;
            const count = counts[t.key];
            return (
              <li key={t.key}>
                <Link
                  to={t.key === "counter" ? "?" : `?tab=${t.key}`}
                  aria-current={active ? "page" : undefined}
                  className={`-mb-px flex items-center gap-1.5 rounded-sm border-b-2 px-1 py-2.5 text-sm font-medium transition-colors ${RING} ${
                    active
                      ? "border-neon-blue text-white"
                      : "border-transparent text-slate-400 hover:border-slate-600 hover:text-white"
                  }`}
                >
                  {t.label}
                  {count !== null && (
                    <span
                      className={`hidden rounded-full px-1.5 text-xs tabular-nums sm:inline ${
                        active ? "bg-neon-blue font-semibold text-black" : "bg-slate-800 text-slate-300"
                      }`}
                    >
                      {count}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div hidden={tab !== "counter"}>
        <Counter store={store} />
      </div>
      {tab === "cards" && <CopyTable key="pc" store={store} pile="pc" />}
      {tab === "sale" && <CopyTable key="sale" store={store} pile="sale" />}
      {tab === "binders" && <BindersPanel store={store} />}

      <div className="mt-10 flex justify-end">
        <button
          type="button"
          onClick={() => store.reset()}
          className={`rounded-sm text-xs text-slate-400 underline underline-offset-2 hover:text-white ${RING}`}
        >
          Reset the demo data
        </button>
      </div>
    </div>
  );
}
