import { useRef } from "react";
import { useDroppable } from "@dnd-kit/core";
import CardFace from "../../prototypes/_shared/CardFace";
import { cardLabel, getPlayer, type BinderId, type Card, type Copy } from "../../prototypes/_shared/data";
import {
  havePocketLabel,
  money,
  slabLabel,
  type SlotRef,
} from "../../prototypes/p2/model";
import { cardCaption, cardNumberLine } from "../captions";
import IdTooltip, { IdLines } from "./IdTooltip";
import type { BinderPocket } from "./model";

/**
 * One sleeve of a nine-pocket page (p2's Pocket, on the consolidated page).
 *
 * - have: the card sits in the sleeve. Pressing it slides the card up out of
 *   the sleeve, then opens the page's card drawer on that copy.
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
 * Every pocket holding a card raises an identity slip on hover or focus
 * (`IdTooltip`): season, set, insert or parallel, then number and player.
 * In browse the slip hangs on the whole sleeve, so focusing its Add chip
 * shows it too.
 */

export type PocketVariant = "binder" | "browse";

export interface PocketHandlers {
  onOpen: (card: Card, copies: Copy[]) => void;
  /** `wantFor`: on the Want List, the binder the want is for (null: none). */
  onAdd: (card: Card, slot?: SlotRef, wantFor?: BinderId | null) => void;
  onAim: (slot: SlotRef) => void;
}

interface PocketProps extends PocketHandlers {
  pocket: BinderPocket;
  variant: PocketVariant;
  index: number;
  pageNumber: number;
  aimed: boolean;
  /** The pocket a hunt in the tray just found: ringed, and focused. */
  found?: boolean;
}

export function pocketDropId(slot: SlotRef): string {
  return `pocket:${slot.binderId}:${slot.page}:${slot.slot}`;
}

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
  onOpen,
  onAdd,
  onAim,
}: PocketProps) {
  const { content, slot } = pocket;
  const faceRef = useRef<HTMLSpanElement>(null);
  const { setNodeRef, isOver } = useDroppable({
    id: slot ? pocketDropId(slot) : `nodrop:${pageNumber}:${index}`,
    // Only a pocket with room takes a drop, so keyboard hops skip full ones.
    disabled: !slot || content.kind === "have",
    data: { slot, pageNumber, index },
  });
  const ring = `${isOver ? " p2-sleeve--over" : ""}${aimed ? " p2-sleeve--target" : ""}${found ? " nb-sleeve--found" : ""}`;
  const where = `pocket ${index + 1} on page ${pageNumber}`;
  const slip = (card: Card) => <IdLines title={cardCaption(card)} lines={[cardNumberLine(card)]} />;

  if (content.kind === "have") {
    const { card, copies } = content;
    const qty = copies.reduce((n, c) => n + c.quantity, 0);
    const slab = copies.length === 1 ? slabLabel(copies[0]) : null;
    const sale = copies.find((c) => c.forSale);
    const open = () => slideOut(faceRef.current, () => onOpen(card, copies));
    const art = (
      <>
        <span ref={faceRef} className="block">
          <CardFace card={card} size="fill" serial={copies.length === 1 ? copies[0].serialNumber : undefined} />
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
          <span aria-hidden="true" className="p2-tag">
            {sale.askPrice ? money(sale.askPrice) : "Sale"}
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
          data-found={found ? "true" : undefined}
          onClick={open}
          className={`p2-sleeve${ring}`}
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
            <CardFace card={card} size="fill" state="need" />
            <AddChip label={`Add ${cardLabel(card)}`} text="Add" onClick={() => onAdd(card)} />
          </div>
        </IdTooltip>
      );
    }
    const who = getPlayer(card.playerIds[0]).name.split(" ").slice(-1)[0];
    return (
      <IdTooltip content={slip(card)}>
        <button
          ref={setNodeRef}
          type="button"
          aria-label={`${cardLabel(card)}, need. Add it`}
          onClick={() => onAdd(card, slot, pocket.wantFor)}
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
