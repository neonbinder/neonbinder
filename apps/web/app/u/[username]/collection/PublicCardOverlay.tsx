import { useId, useState } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import CardFace from "@/app/collection/prototypes/_shared/CardFace";
import Overlay from "@/app/collection/prototypes/p1/Overlay";
import TopLoader from "@/app/collection/final/binders/TopLoader";
import { cardLabel } from "@/app/collection/final/data/labels";
import type { Card } from "@/app/collection/final/data/types";
import NeonButton from "@/components/modules/NeonButton";

export type PublicCopy = FunctionReturnType<typeof api.publicCollection.binderCopies>["page"][number];

export function grade(copy: PublicCopy): string | null {
  return copy.grading ? `${copy.grading.grader} ${copy.grading.grade}` : null;
}

/**
 * NEO-444 — a card lifted out of a public binder: it pops out of its sleeve
 * into a top loader over the dimmed binder, its title directly below. What a
 * pocket has no room to say sits under the title, quieter: grade or
 * condition, how many, Trade and for-sale, the catalog's Notes, the back.
 * Never the copy's own notes: this page never receives them.
 *
 * Opens from the URL (`PublicBinderPage`). Escape, the close button and the
 * backdrop all close it; `Overlay` holds focus inside and hands it back.
 */
export default function PublicCardOverlay({
  copy,
  card,
  onClose,
}: {
  copy: PublicCopy;
  card: Card;
  onClose: () => void;
}) {
  const titleId = useId();
  const [showBack, setShowBack] = useState(false);
  const { photos } = copy;
  const canFlip = !!photos?.front && !!photos.back;
  const flipped = canFlip && showBack;
  const photo = flipped ? photos.back : (photos?.front ?? photos?.back);
  const label = cardLabel(card);
  const side = flipped ? `${label}, the back` : label;
  const facts = [grade(copy) ?? copy.condition, copy.quantity > 1 ? `×${copy.quantity}` : null].filter(Boolean);

  return (
    <Overlay labelledBy={titleId} onClose={onClose} variant="stage">
      <div className="nb-toploader-stage">
        <NeonButton
          type="button"
          variant="secondary"
          outline
          aria-label="Close the top loader"
          onClick={onClose}
          className="pointer-events-auto !absolute right-3 top-3 min-h-11 min-w-11"
        >
          <XMarkIcon aria-hidden="true" className="h-5 w-5" />
        </NeonButton>
        <TopLoader>
          {/* Remounts on a flip, so the turn plays each way. */}
          <div key={flipped ? "back" : "front"} className="nb-toploader-flip">
            {photo ? (
              <>
                <img src={photo.thumbUrl} alt="" className="nb-toploader-photo" />
                <img src={photo.imageUrl} alt={side} decoding="async" className="nb-toploader-photo" />
              </>
            ) : (
              <CardFace model={card} size="fill" />
            )}
          </div>
        </TopLoader>
        <h2
          id={titleId}
          tabIndex={-1}
          className="nb-toploader-title pointer-events-auto text-lg font-bold leading-snug text-ink [overflow-wrap:anywhere] focus:outline-none sm:text-xl"
        >
          {label}
        </h2>
        {/* Long Notes are the only thing that can make this scroll, so only then is it a tab stop. */}
        <div
          role="group"
          aria-label="About this card"
          tabIndex={card.notes ? 0 : undefined}
          className="nb-toploader-details pointer-events-auto text-sm text-ink-2 focus-outline"
        >
          {(facts.length > 0 || copy.upForTrade || copy.forSale) && (
            <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
              {facts.map((fact) => (
                <span key={fact}>{fact}</span>
              ))}
              {copy.upForTrade && (
                <span className="rounded bg-raised px-1.5 py-0.5 text-xs font-semibold text-neon-blue-text">Trade</span>
              )}
              {copy.forSale && (
                <span className="rounded bg-raised px-1.5 py-0.5 text-xs font-semibold text-neon-green-text">
                  Also for sale
                </span>
              )}
            </p>
          )}
          {card.own && <p className="text-ink-3">Not in the NeonBinder catalog</p>}
          {photo && (
            <p className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
              {canFlip && (
                <NeonButton type="button" variant="secondary" outline size="1" onClick={() => setShowBack(!flipped)} className="min-h-10">
                  {flipped ? "See the front" : "See the back"}
                </NeonButton>
              )}
              <a
                href={photo.imageUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-10 items-center rounded-sm text-neon-blue-text underline focus-outline"
              >
                See it full size<span className="sr-only"> (opens a new tab)</span>
              </a>
            </p>
          )}
          <p role="status" className="sr-only">
            {flipped ? "Showing the back" : ""}
          </p>
          {/* NEO-367: the catalog card's Notes are NB's facts about the card, public by Jason's call. */}
          {card.notes && (
            <p className="whitespace-pre-line text-ink-3 [overflow-wrap:anywhere]">{card.notes}</p>
          )}
        </div>
      </div>
    </Overlay>
  );
}
