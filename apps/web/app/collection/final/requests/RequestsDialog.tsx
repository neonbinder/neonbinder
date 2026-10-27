import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import Overlay from "../../prototypes/p1/Overlay";
import { FOCUS } from "../../prototypes/p1/ui";
import type { Drill } from "../catalog/drill";
import type { Card } from "../data/types";
import MyRequests from "./MyRequests";
import RequestCardForm from "./RequestCardForm";
import RequestSetForm from "./RequestSetForm";

export type RequestsTab = "card" | "set" | "mine";

const TABS: { id: RequestsTab; label: string }[] = [
  { id: "card", label: "Request a card" },
  { id: "set", label: "Request a set" },
  { id: "mine", label: "My requests" },
];

/**
 * NEO-361 — "Can't find it?" in a real collection. Two asks and the list of
 * them, as tabs:
 *
 * - Request a card: a card NB doesn't have, in a set NB has (or in a set the
 *   collector already asked for).
 * - Request a set: a set NB doesn't have. Our crew builds it; collectors
 *   never do.
 * - My requests: where each one stands, the crew's note, and withdraw.
 *
 * Whatever is asked for is the collector's to own right away, privately,
 * while it waits and after a decline. An approve moves their copies onto the
 * catalog card for them.
 */
export default function RequestsDialog({
  searched,
  drill,
  initialTab = "card",
  onHave,
  onClose,
}: {
  /** What was in the search box, kept with the request for the crew. */
  searched: string;
  /** The Checklists drill, to start the set picker where the collector is. */
  drill: Drill;
  initialTab?: RequestsTab;
  /** "I have it": one copy of the new card, announced by the page. */
  onHave: (card: Card) => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const tabsId = useId();
  const [tab, setTab] = useState<RequestsTab>(initialTab);
  // A set request's "Add a card from it" opens the card form on that set.
  const [privateSetId, setPrivateSetId] = useState<string | null>(null);
  const tabRefs = useRef<Record<RequestsTab, HTMLButtonElement | null>>({ card: null, set: null, mine: null });
  // "Add a card from it" leaves the set tab under the keyboard: land on the card tab.
  const [landOnCard, setLandOnCard] = useState(0);
  useEffect(() => {
    if (landOnCard > 0) tabRefs.current.card?.focus();
  }, [landOnCard]);

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = TABS[next].id;
    setTab(id);
    tabRefs.current[id]?.focus();
  };

  return (
    <Overlay labelledBy={headingId} onClose={onClose} variant="modal">
      <div className="max-h-[calc(100dvh-4rem)] space-y-4 overflow-y-auto">
        <div className="space-y-1">
          <h2 id={headingId} tabIndex={-1} className="text-lg font-bold text-ink focus:outline-none">
            Can&apos;t find it?
          </h2>
          <p className="text-sm text-ink-2">
            Tell us about it and our crew will add it. It&apos;s yours to file the moment you send it.
          </p>
          {searched.trim() && (
            <p className="text-xs text-ink-3">You searched “{searched.trim()}”. We&apos;ll keep that with it.</p>
          )}
        </div>

        <div role="tablist" aria-label="Requests" className="flex flex-wrap gap-1 border-b border-rule-strong" onKeyDown={onTabKey}>
          {TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`${tabsId}-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`${tabsId}-${t.id}-panel`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              className={`-mb-px min-h-11 rounded-t-md border-b-2 px-3 text-sm font-medium sm:min-h-9 ${FOCUS} ${
                tab === t.id ? "border-selection font-semibold text-ink" : "border-transparent text-ink-2 hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Every panel stays mounted (hidden when not shown), so a half-typed
            form survives a look at My requests. */}
        <div role="tabpanel" id={`${tabsId}-card-panel`} aria-labelledby={`${tabsId}-card`} hidden={tab !== "card"}>
          <RequestCardForm
            key={privateSetId ?? "catalog"}
            searched={searched}
            drill={drill}
            privateSetId={privateSetId}
            onHave={(card) => {
              onHave(card);
              onClose();
            }}
          />
        </div>
        <div role="tabpanel" id={`${tabsId}-set-panel`} aria-labelledby={`${tabsId}-set`} hidden={tab !== "set"}>
          <RequestSetForm
            searched={searched}
            sportId={drill.sport}
            onAddCard={(id) => {
              setPrivateSetId(id);
              setTab("card");
              setLandOnCard((n) => n + 1);
            }}
          />
        </div>
        <div
          role="tabpanel"
          id={`${tabsId}-mine-panel`}
          aria-labelledby={`${tabsId}-mine`}
          hidden={tab !== "mine"}
        >
          {tab === "mine" && <MyRequests />}
        </div>
      </div>
    </Overlay>
  );
}
