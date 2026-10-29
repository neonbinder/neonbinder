import { useId } from "react";
import NoticeLine, { type Notice } from "../prototypes/p1/notice";
import Overlay from "../prototypes/p1/Overlay";
import { FOCUS } from "../prototypes/p1/ui";
import CardDetail, { CopyList } from "./CardDetail";
import { LoadingNote, SkeletonBars } from "./catalog/Skeleton";
import { cardLabel, setAndVariant, shortCardName } from "./data/labels";
import { useCapabilities, useCard, useCollectionActions, useContainers, useCopiesOf } from "./data/store";
import type { Card, CardId, CopyId } from "./data/types";
import { lineNames, lineSummary } from "./lineItems";
import { usePageApi } from "./pageApi";

/**
 * The one right-side card drawer every tab opens through `openCard`: the
 * admin CardDetailPanel's shell (header with ↑ ↓ ×, scrolling body) around
 * the collector's card detail. ↑ and ↓ step through the list it was opened
 * from, and a polite line says where you are ("Card 3 of 12, …") while
 * focus stays on the arrow; at either end the arrow stays focusable and says
 * it is unavailable rather than dropping out from under the keyboard. While
 * it is open the page behind is inert, so it carries its own copy of the
 * status line.
 *
 * It reads the card live (`useCard`), drawing the opener's copy (`seed`) in
 * the meantime. A card the catalog no longer holds still opens: it says so,
 * and lists the collector's copies of it so they can be taken out.
 */
export default function CardDrawer({
  cardId,
  seed,
  mode,
  focusCopyId,
  editCopyId,
  addBinderId,
  openKey,
  notice,
  onUndo,
  onDismissNotice,
  onClose,
  onPrev,
  onNext,
  position = null,
}: {
  cardId: CardId;
  /** The card as the opener had it. */
  seed?: Card;
  mode: "view" | "add";
  focusCopyId?: CopyId;
  /** NEO-377: open this line's Edit form when it is the card's one line (a row click). */
  editCopyId?: CopyId;
  /** The home the add form picks instead of the page's scope (the hunt tray's open binder). */
  addBinderId?: string;
  /** Bumps on every openCard, so the detail remounts and re-runs its focus. */
  openKey: number;
  notice: Notice | null;
  onUndo: () => void;
  onDismissNotice: () => void;
  onClose: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  /** Where the card sits in the list ↑ ↓ step through; null for a list of one. */
  position?: { index: number; total: number } | null;
}) {
  const headingId = useId();
  const live = useCard(cardId);
  const card = live === null ? null : (live ?? (seed?.id === cardId ? seed : undefined));
  const nav =
    "flex h-8 w-8 items-center justify-center rounded text-ink-2 hover:text-neon-blue-text aria-disabled:opacity-30 aria-disabled:cursor-not-allowed aria-disabled:hover:text-ink-2 " +
    FOCUS;
  const where = position
    ? `Card ${position.index + 1} of ${position.total}${card ? `, ${cardLabel(card)}` : ""}`
    : "";
  return (
    <Overlay labelledBy={headingId} onClose={onClose}>
      <div className="flex items-center gap-2 border-b border-rule-strong px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2
            id={headingId}
            tabIndex={-1}
            aria-label={card ? cardLabel(card) : undefined}
            className="truncate text-sm font-semibold text-ink focus:outline-none"
          >
            {card ? shortCardName(card) : card === null ? "No longer in the catalog" : "Loading the card…"}
          </h2>
          <p className="truncate text-xs text-ink-3">{card ? setAndVariant(card) : " "}</p>
        </div>
        <button
          type="button"
          onClick={() => onPrev?.()}
          aria-disabled={!onPrev || undefined}
          aria-label="Previous card"
          title="Previous card"
          className={nav}
        >
          ↑
        </button>
        <button
          type="button"
          onClick={() => onNext?.()}
          aria-disabled={!onNext || undefined}
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
          className={`${nav} text-lg hover:text-neon-pink-text`}
        >
          ×
        </button>
      </div>
      <p role="status" className="sr-only">
        {where}
      </p>
      <div className="px-4 pt-3">
        <NoticeLine notice={notice} onUndo={onUndo} onDismiss={onDismissNotice} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {card ? (
          <CardDetail
            key={`${card.id}|${openKey}`}
            card={card}
            mode={mode}
            focusCopyId={focusCopyId}
            editCopyId={editCopyId}
            addBinderId={addBinderId}
            onCancelAdd={onClose}
          />
        ) : card === null ? (
          <GoneCard cardId={cardId} focusCopyId={focusCopyId} />
        ) : (
          <div aria-busy="true">
            <SkeletonBars rows={6} />
            {/* The heading already says it; the position line says the card once it lands. */}
            <LoadingNote silent>Loading the card…</LoadingNote>
          </div>
        )}
      </div>
    </Overlay>
  );
}

/** A card the catalog dropped: the collector's copies stay theirs to see and take out. */
function GoneCard({ cardId, focusCopyId }: { cardId: CardId; focusCopyId?: CopyId }) {
  const api = usePageApi();
  const writes = useCollectionActions();
  const capabilities = useCapabilities();
  const binders = useContainers();
  const copies = useCopiesOf(cardId);
  const names = lineNames(copies ?? [], binders);
  return (
    <div className="space-y-4">
      <p className="rounded-md border border-dashed border-rule-strong px-3 py-2 text-sm text-ink-2">
        This card is no longer in the catalog. Your copies are still yours: keep them, or take them out.
      </p>
      <CopyList
        name="this card"
        copies={copies}
        names={names}
        binders={binders}
        focusCopyId={focusCopyId}
        showTrade={capabilities.trade}
        showSale={capabilities.binders && capabilities.inventory}
        onRemove={(copy) =>
          void api.run(
            () => writes.removeCopy(copy),
            (r) => `Removed ${lineSummary(r.removed, binders)}`,
          )
        }
      />
    </div>
  );
}
