import type { MouseEvent } from "react";
import { useDroppable } from "@dnd-kit/core";
import CardFace from "../_shared/CardFace";
import { cardLabel, getPlayer, type Card } from "../_shared/data";
import {
  havePocketLabel,
  money,
  slabLabel,
  type PocketModel,
  type SlotRef,
} from "./model";

/**
 * One sleeve of a nine-pocket page.
 *
 * - have: the card sits in the sleeve; pressing it slides it out (detail).
 * - need: an empty sleeve with a ghost number and the word "Need"; pressing
 *   it adds exactly that card (and files it in this pocket when the binder
 *   has real pockets).
 * - empty: a blank sleeve. In a binder with real pockets, pressing it aims
 *   the pack at this pocket.
 *
 * In "browse" (a catalog set), every card shows its face and has an Add
 * button instead: the faces are the point of flipping through a set.
 */

export type PocketVariant = "binder" | "browse";

export interface PocketHandlers {
  onOpen: (card: Card, opener: HTMLElement) => void;
  onAdd: (card: Card, slot?: SlotRef) => void;
  onAim: (slot: SlotRef) => void;
}

interface PocketProps extends PocketHandlers {
  pocket: PocketModel;
  variant: PocketVariant;
  index: number;
  pageNumber: number;
  aimed: boolean;
}

export function pocketDropId(slot: SlotRef): string {
  return `pocket:${slot.binderId}:${slot.page}:${slot.slot}`;
}

export default function Pocket({
  pocket,
  variant,
  index,
  pageNumber,
  aimed,
  onOpen,
  onAdd,
  onAim,
}: PocketProps) {
  const { content, slot } = pocket;
  const { setNodeRef, isOver } = useDroppable({
    id: slot ? pocketDropId(slot) : `nodrop:${pageNumber}:${index}`,
    // Only a pocket with room takes a drop, so keyboard hops skip full ones.
    disabled: !slot || content.kind === "have",
    data: { slot, pageNumber, index },
  });
  const ring = `${isOver ? " p2-sleeve--over" : ""}${aimed ? " p2-sleeve--target" : ""}`;
  const where = `pocket ${index + 1} on page ${pageNumber}`;

  if (content.kind === "have") {
    const { card, copies } = content;
    const qty = copies.reduce((n, c) => n + c.quantity, 0);
    const slab = copies.length === 1 ? slabLabel(copies[0]) : null;
    const sale = copies.find((c) => c.forSale);
    const art = (
      <>
        <CardFace card={card} size="fill" serial={copies.length === 1 ? copies[0].serialNumber : undefined} />
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
          <span aria-hidden="true" className="p2-tag">
            {sale.askPrice ? money(sale.askPrice) : "Sale"}
          </span>
        )}
      </>
    );
    if (variant === "browse") {
      return (
        <div ref={setNodeRef} className={`p2-sleeve flex flex-col${ring}`}>
          <button
            type="button"
            aria-haspopup="dialog"
            aria-label={`${havePocketLabel(card, copies)}, have`}
            onClick={(e: MouseEvent<HTMLButtonElement>) => onOpen(card, e.currentTarget)}
            className="relative block w-full rounded focus-visible:outline-none"
          >
            {art}
          </button>
          <AddChip label={`Add another ${cardLabel(card)}`} text="Add" onClick={() => onAdd(card)} />
        </div>
      );
    }
    return (
      <button
        ref={setNodeRef}
        type="button"
        aria-haspopup="dialog"
        aria-label={havePocketLabel(card, copies)}
        onClick={(e) => onOpen(card, e.currentTarget)}
        className={`p2-sleeve${ring}`}
      >
        {art}
      </button>
    );
  }

  if (content.kind === "need") {
    const { card } = content;
    if (variant === "browse") {
      return (
        <div ref={setNodeRef} className={`p2-sleeve${ring}`}>
          <CardFace card={card} size="fill" state="need" />
          <AddChip label={`Add ${cardLabel(card)}`} text="Add" onClick={() => onAdd(card)} />
        </div>
      );
    }
    const who = getPlayer(card.playerIds[0]).name.split(" ").slice(-1)[0];
    return (
      <button
        ref={setNodeRef}
        type="button"
        aria-label={`${cardLabel(card)}, need. Add it`}
        onClick={() => onAdd(card, slot)}
        className={`p2-sleeve${ring}`}
      >
        <span aria-hidden="true" className="p2-ghost">
          <span className="p2-ghost-number">#{card.cardNumber}</span>
          <span className="p2-ghost-need">Need</span>
          <span className="p2-ghost-who">{who}</span>
        </span>
      </button>
    );
  }

  if (slot) {
    return (
      <button
        ref={setNodeRef}
        type="button"
        aria-label={`Empty ${where}. Fill it from the pack`}
        onClick={() => onAim(slot)}
        className={`p2-sleeve group${ring}`}
      >
        <span
          aria-hidden="true"
          className="absolute inset-0 z-[3] flex items-center justify-center text-xs font-bold text-slate-300 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
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
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="absolute bottom-1 left-1/2 z-[3] flex min-h-6 -translate-x-1/2 items-center rounded-full bg-neon-green px-3 text-xs font-bold text-black max-sm:min-h-11 max-sm:px-4 shadow-md hover:bg-[#33e07c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
    >
      {text}
    </button>
  );
}
