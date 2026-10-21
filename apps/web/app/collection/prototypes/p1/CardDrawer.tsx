import { useId } from "react";
import { cardLabel, type Card } from "../_shared/data";
import type { PrototypeStore } from "../_shared/usePrototypeStore";
import CardDetail from "./CardDetail";
import NoticeLine, { type Notice, type Notify } from "./notice";
import Overlay from "./Overlay";
import { FOCUS, setAndVariant, shortCardName } from "./ui";

/**
 * The admin CardDetailPanel's drawer shell (header with ↑ ↓ ×, scrolling
 * body), holding the collector's card detail instead of the operator's card
 * editor. ↑ and ↓ step through the checklist the drawer was opened from.
 */
export default function CardDrawer({
  card,
  store,
  notify,
  notice,
  onUndo,
  onDismissNotice,
  onClose,
  onPrev,
  onNext,
}: {
  card: Card;
  store: PrototypeStore;
  notify: Notify;
  notice: Notice | null;
  onUndo: () => void;
  onDismissNotice: () => void;
  onClose: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
}) {
  const headingId = useId();
  const nav =
    "flex h-8 w-8 items-center justify-center rounded text-slate-300 hover:text-[#00C2FF] disabled:opacity-30 disabled:cursor-not-allowed " +
    FOCUS;
  return (
    <Overlay labelledBy={headingId} onClose={onClose}>
      <div className="px-4 py-3 border-b border-gray-700 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2
            id={headingId}
            tabIndex={-1}
            aria-label={cardLabel(card)}
            className="text-sm font-semibold text-slate-100 truncate focus:outline-none"
          >
            {shortCardName(card)}
          </h2>
          <p className="text-xs text-slate-400 truncate">{setAndVariant(card)}</p>
        </div>
        <button
          type="button"
          onClick={onPrev ?? undefined}
          disabled={!onPrev}
          aria-label="Previous card"
          title="Previous card"
          className={nav}
        >
          ↑
        </button>
        <button
          type="button"
          onClick={onNext ?? undefined}
          disabled={!onNext}
          aria-label="Next card"
          title="Next card"
          className={nav}
        >
          ↓
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close card detail"
          title="Close (Esc)"
          className={`${nav} text-lg hover:text-[#FF2EB3]`}
        >
          ×
        </button>
      </div>
      <div className="px-4 pt-3">
        <NoticeLine notice={notice} onUndo={onUndo} onDismiss={onDismissNotice} />
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4 min-h-0">
        <CardDetail
          key={card.id}
          card={card}
          store={store}
          notify={notify}
          onCancelAdd={onClose}
        />
      </div>
    </Overlay>
  );
}
