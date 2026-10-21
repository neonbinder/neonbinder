import { useRef, type ReactNode } from "react";
import { PlusIcon } from "@heroicons/react/24/solid";
import CardFace from "../_shared/CardFace";
import { cardLabel, type Card } from "../_shared/data";
import { useP5 } from "./context";

/**
 * One card on a shelf: the face (a button that opens the drawer), a short
 * caption, and the have/need line. A need says "Need" in words and gets a
 * "+ Add" that files one raw copy at once (Undo in the toast). Have/need is
 * never colour alone: the face is desaturated AND tagged, the line says it.
 */
export default function CardTile({
  card,
  size = "md",
  caption,
  current = false,
}: {
  card: Card;
  size?: "sm" | "md";
  /** Up to three short lines under the face. */
  caption?: ReactNode;
  /** Marks the card the drawer is showing (rainbow row). */
  current?: boolean;
}) {
  const { store, openCard, quickAdd } = useP5();
  const count = store.ownedCount(card.id);
  const need = count === 0;
  const width = size === "sm" ? "w-[5.5rem]" : "w-36";
  const faceRef = useRef<HTMLButtonElement>(null);

  return (
    <div className={`flex shrink-0 flex-col ${width}`}>
      <button
        ref={faceRef}
        type="button"
        aria-haspopup="dialog"
        aria-current={current ? "true" : undefined}
        onClick={() => openCard(card.id)}
        className={`rounded-[7%] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] focus-visible:ring-offset-2 focus-visible:ring-offset-black ${
          current
            ? "ring-2 ring-[#00C2FF] ring-offset-2 ring-offset-slate-950"
            : ""
        }`}
      >
        <CardFace card={card} size={size} state={need ? "need" : "owned"} />
      </button>
      {caption && (
        <div
          className={`mt-2 min-w-0 text-xs leading-snug text-slate-300 ${size === "md" ? "min-h-[3.75rem]" : "min-h-8"}`}
        >
          {caption}
        </div>
      )}
      <div className="mt-1.5 flex min-h-8 items-center justify-between gap-1">
        {need ? (
          <>
            {size === "md" && (
              <span className="text-xs font-semibold text-slate-400">Need</span>
            )}
            <button
              type="button"
              onClick={() => {
                // The Add button goes away once the card is a Have: keep the
                // keyboard on this card rather than dropping it on <body>.
                faceRef.current?.focus();
                quickAdd(card.id);
              }}
              aria-label={`Add ${cardLabel(card)}`}
              className="inline-flex h-11 items-center gap-1 rounded-md border border-neon-green/70 px-2 text-xs font-semibold text-neon-green hover:bg-neon-green hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] sm:h-7"
            >
              <PlusIcon aria-hidden="true" className="h-3.5 w-3.5" />
              Add
            </button>
          </>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-neon-blue">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full bg-neon-blue"
            />
            Have{count > 1 ? ` ×${count}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}
