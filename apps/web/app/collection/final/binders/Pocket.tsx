import { useRef, type KeyboardEvent, type MouseEventHandler, type TouchEventHandler } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import CardFace from "../../prototypes/_shared/CardFace";
import { cardCaption, cardNumberLine } from "../captions";
import { cardLabel } from "../data/labels";
import { isForSale } from "../data/store";
import type { Card, ContainerId, Copy } from "../data/types";
import { copyDragId, pocketDropId } from "./dnd";
import IdTooltip, { IdLines } from "./IdTooltip";
import { havePocketLabel, slabLabel, type PocketModel, type SlotRef } from "./model";
import NeonButton from "@/components/modules/NeonButton";

/**
 * One sleeve of a nine-pocket page (p2's Pocket, on the consolidated page).
 *
 * - have: the card sits in the sleeve. Pressing it slides the card up out of
 *   the sleeve, then opens the page's card drawer on that copy. In a binder
 *   the collector can rearrange (`rearrange`), drag it onto an empty pocket,
 *   or press Alt+Left / Alt+Right to move it to the open pocket before or
 *   after (`onShift`).
 * - need: an empty sleeve with a ghost number and the word "Need"; pressing
 *   it adds that card (the open binder says how).
 * - empty: a blank sleeve. In a binder with real pockets, pressing it aims
 *   the pack at this pocket.
 *
 * In "browse" (a catalog set), every card shows its face and has an Add
 * button instead: the faces are the point of flipping through a set.
 *
 * `found` rings a pocket the hunt tray led the collector to.
 *
 * `saleTag` (the Up for Trade pile only, the one collection view that lists
 * box copies): a copy whose home is a box wears the yellow "For sale" price
 * sticker, so a trade pile mixing binder and box copies shows which is
 * inventory. It rides the right edge halfway down (`nb-sale-tag` in
 * binders.css), clear of the slab label, the serial stamp and the count. The pocket's name already ends ", for sale", so the sticker is
 * hidden from assistive tech.
 *
 * Every pocket holding a card raises an identity slip on hover or focus
 * (`IdTooltip`): season, set, insert or parallel, then number and player.
 * In browse the slip hangs on the whole sleeve, so focusing its Add chip
 * shows it too.
 */

export type PocketVariant = "binder" | "browse";

export interface PocketHandlers {
  onOpen: (card: Card, copies: Copy[]) => void;
  /** `wantFor`: on the Want List, the binder or box the want is for (null: none). */
  onAdd: (card: Card, slot?: SlotRef, wantFor?: ContainerId | null) => void;
  onAim: (slot: SlotRef) => void;
  /** Alt+Left (-1) / Alt+Right (1) on a card the collector may rearrange. */
  onShift?: (copy: Copy, from: SlotRef, dir: -1 | 1) => void;
}

interface PocketProps extends PocketHandlers {
  pocket: PocketModel;
  variant: PocketVariant;
  index: number;
  pageNumber: number;
  aimed: boolean;
  /** The pocket a hunt in the tray just found: ringed, and focused. */
  found?: boolean;
  /** Wear the "For sale" sticker on a copy in a box (the Up for Trade pile only). */
  saleTag?: boolean;
  /** Its card may be dragged or Alt+arrowed to another pocket of this binder. */
  rearrange?: boolean;
}

export { pocketDropId };

/** The one hidden line every movable card points at (rendered by BinderDesk). */
export const POCKET_MOVE_HINT_ID = "nb-pocket-move-hint";

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

/** The p2 lead-in: the card rides up out of its sleeve, then the drawer opens. */
function slideOut(face: HTMLElement | null, then: () => void) {
  if (!face || prefersReducedMotion() || typeof face.animate !== "function") {
    then();
    return;
  }
  const anim = face.animate(
    [
      { transform: "none", opacity: 1 },
      { transform: "translateY(-38%) scale(1.06)", opacity: 0 },
    ],
    { duration: 200, easing: "cubic-bezier(0.3, 0.7, 0.4, 1)" },
  );
  anim.onfinish = then;
  anim.oncancel = then;
}

export default function Pocket({
  pocket,
  variant,
  index,
  pageNumber,
  aimed,
  found = false,
  saleTag = false,
  onOpen,
  onAdd,
  onAim,
  onShift,
  rearrange = false,
}: PocketProps) {
  const { content, slot } = pocket;
  const faceRef = useRef<HTMLSpanElement>(null);
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: slot ? pocketDropId(slot) : `nodrop:${pageNumber}:${index}`,
    // Only a pocket with room takes a drop, so keyboard hops skip full ones.
    disabled: !slot || content.kind === "have",
    data: { slot, pageNumber, index },
  });
  // A lone copy in a binder pocket can be picked up and dropped on an empty one.
  const lone =
    rearrange && variant === "binder" && slot && content.kind === "have" && content.copies.length === 1
      ? content.copies[0]
      : null;
  const drag = useDraggable({
    id: lone ? copyDragId(lone.id) : `nodrag:${pageNumber}:${index}`,
    disabled: !lone,
    data: { copyId: lone?.id },
  });
  const setNodeRef = (el: HTMLElement | null) => {
    setDropRef(el);
    drag.setNodeRef(el);
  };
  // Pointer drags only: the keyboard has Alt+arrows, so Enter still opens the card.
  const pointer = lone
    ? {
        onMouseDown: drag.listeners?.onMouseDown as MouseEventHandler<HTMLButtonElement> | undefined,
        onTouchStart: drag.listeners?.onTouchStart as TouchEventHandler<HTMLButtonElement> | undefined,
      }
    : {};
  // In a binder that rearranges, Alt+Left/Right always means a pocket move,
  // never the browser's Back or Forward (the open binder lives in the URL).
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!rearrange || variant !== "binder" || !e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    if (lone && slot && onShift) onShift(lone, slot, e.key === "ArrowLeft" ? -1 : 1);
  };
  const ring = `${isOver ? " p2-sleeve--over" : ""}${aimed ? " p2-sleeve--target" : ""}${found ? " nb-sleeve--found" : ""}`;
  const where = `pocket ${index + 1} on page ${pageNumber}`;
  const slip = (card: Card) => <IdLines title={cardCaption(card)} lines={[cardNumberLine(card)]} />;

  if (content.kind === "have") {
    const { card, copies } = content;
    const qty = copies.reduce((n, c) => n + c.quantity, 0);
    const slab = copies.length === 1 ? slabLabel(copies[0]) : null;
    const sale = saleTag && copies.some(isForSale);
    const open = () => slideOut(faceRef.current, () => onOpen(card, copies));
    const art = (
      <>
        <span ref={faceRef} className="block">
          <CardFace model={card} size="fill" serial={copies.length === 1 ? copies[0].serialNumber : undefined} />
        </span>
        {slab && (
          <span aria-hidden="true" className="p2-slab">
            {slab}
          </span>
        )}
        {qty > 1 && (
          <span aria-hidden="true" className="p2-qty">
            ×{qty}
          </span>
        )}
        {sale && (
          <span aria-hidden="true" className="p2-tag nb-sale-tag">
            For sale
          </span>
        )}
      </>
    );
    if (variant === "browse") {
      return (
        <IdTooltip content={slip(card)}>
          <div ref={setNodeRef} className={`p2-sleeve flex flex-col${ring}`}>
            <button
              type="button"
              aria-haspopup="dialog"
              aria-label={`${havePocketLabel(card, copies)}, have`}
              onClick={open}
              className="relative block w-full rounded focus-visible:outline-none"
            >
              {art}
            </button>
            <AddChip label={`Add another ${cardLabel(card)}`} text="Add" onClick={() => onAdd(card)} />
          </div>
        </IdTooltip>
      );
    }
    return (
      <IdTooltip content={slip(card)}>
        <button
          ref={setNodeRef}
          type="button"
          aria-haspopup="dialog"
          aria-label={havePocketLabel(card, copies)}
          aria-keyshortcuts={lone ? "Alt+ArrowLeft Alt+ArrowRight" : undefined}
          aria-describedby={lone ? POCKET_MOVE_HINT_ID : undefined}
          data-found={found ? "true" : undefined}
          data-lifted={lone && drag.isDragging ? "true" : undefined}
          onClick={open}
          onKeyDown={onKeyDown}
          {...pointer}
          className={`p2-sleeve${ring}${lone ? " nb-sleeve--movable" : ""}`}
        >
          {art}
        </button>
      </IdTooltip>
    );
  }

  if (content.kind === "need") {
    const { card } = content;
    if (variant === "browse") {
      return (
        <IdTooltip content={slip(card)}>
          <div ref={setNodeRef} className={`p2-sleeve${ring}`}>
            <CardFace model={card} size="fill" state="need" />
            <AddChip label={`Add ${cardLabel(card)}`} text="Add" onClick={() => onAdd(card)} />
          </div>
        </IdTooltip>
      );
    }
    const who = (card.players[0]?.name ?? "").split(" ").slice(-1)[0];
    return (
      <IdTooltip content={slip(card)}>
        <button
          ref={setNodeRef}
          type="button"
          aria-label={`${cardLabel(card)}, need. Add it`}
          onClick={() => onAdd(card, slot, pocket.wantFor)}
          onKeyDown={onKeyDown}
          className={`p2-sleeve${ring}`}
        >
          <span aria-hidden="true" className="p2-ghost">
            <span className="p2-ghost-number">#{card.cardNumber}</span>
            <span className="p2-ghost-need">Need</span>
            <span className="p2-ghost-who">{who}</span>
          </span>
        </button>
      </IdTooltip>
    );
  }

  if (slot) {
    return (
      <button
        ref={setNodeRef}
        type="button"
        aria-label={`Empty ${where}. Fill it from the pack`}
        onClick={() => onAim(slot)}
        onKeyDown={onKeyDown}
        className={`p2-sleeve group${ring}`}
      >
        <span
          aria-hidden="true"
          className="absolute inset-0 z-[3] flex items-center justify-center text-xs font-bold text-ink-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          Fill
        </span>
      </button>
    );
  }
  return <div ref={setNodeRef} aria-hidden="true" className="p2-sleeve" />;
}

function AddChip({ label, text, onClick }: { label: string; text: string; onClick: () => void }) {
  return (
    <NeonButton
      type="button"
      size="1"
      radius="full"
      aria-label={label}
      onClick={onClick}
      className="absolute bottom-1 left-1/2 z-[3] -translate-x-1/2 shadow-md max-sm:min-h-11"
    >
      {text}
    </NeonButton>
  );
}
