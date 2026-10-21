import { useId } from "react";
import { cardLabel, type BinderId, type Card, type CopyId } from "../prototypes/_shared/data";
import NoticeLine, { type Notice } from "../prototypes/p1/notice";
import Overlay from "../prototypes/p1/Overlay";
import { FOCUS, setAndVariant, shortCardName } from "../prototypes/p1/ui";
import CardDetail from "./CardDetail";
import type { CollectionStore, Notify } from "./store";

/**
 * The one right-side card drawer every tab opens through `openCard`: the
 * admin CardDetailPanel's shell (header with ↑ ↓ ×, scrolling body) around
 * the collector's card detail. ↑ and ↓ step through the list it was opened
 * from. While it is open the page behind is inert, so it carries its own
 * copy of the status line.
 */
export default function CardDrawer({
  card,
  store,
  mode,
  focusCopyId,
  addBinderId,
  openKey,
  notify,
  notice,
  onUndo,
  onDismissNotice,
  onClose,
  onPrev,
  onNext,
}: {
  card: Card;
  store: CollectionStore;
  mode: "view" | "add";
  focusCopyId?: CopyId;
  /** The binder the add form ticks instead of the page's target. */
  addBinderId?: BinderId;
  /** Bumps on every openCard, so the detail remounts and re-runs its focus. */
  openKey: number;
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
      <div className="flex items-center gap-2 border-b border-gray-700 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2
            id={headingId}
            tabIndex={-1}
            aria-label={cardLabel(card)}
            className="truncate text-sm font-semibold text-slate-100 focus:outline-none"
          >
            {shortCardName(card)}
          </h2>
          <p className="truncate text-xs text-slate-400">{setAndVariant(card)}</p>
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
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <CardDetail
          key={`${card.id}|${openKey}`}
          card={card}
          store={store}
          notify={notify}
          mode={mode}
          focusCopyId={focusCopyId}
          addBinderId={addBinderId}
          onCancelAdd={onClose}
        />
      </div>
    </Overlay>
  );
}
