import { useEffect, useId, useLayoutEffect, useState, type CSSProperties } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import CardFace from "@/app/collection/prototypes/_shared/CardFace";
import Overlay from "@/app/collection/prototypes/p1/Overlay";
import TopLoader from "@/app/collection/final/binders/TopLoader";
import { cardLabel } from "@/app/collection/final/data/labels";
import type { Card } from "@/app/collection/final/data/types";
import NeonButton from "@/components/modules/NeonButton";
import { useOverflows } from "@/src/hooks/useOverflows";

export type PublicCopy = FunctionReturnType<typeof api.publicCollection.binderCopies>["page"][number];

export function grade(copy: PublicCopy): string | null {
  return copy.grading ? `${copy.grading.grader} ${copy.grading.grade}` : null;
}

/**
 * The wheel over a fixed layer still moves the page behind it: hold the page
 * still while one is open. The gutter stays, so a classic scrollbar going away
 * doesn't shift the binder sideways.
 */
function useLockedPage() {
  useLayoutEffect(() => {
    const { style, clientWidth } = document.documentElement;
    const { overflow, scrollbarGutter } = style;
    if (window.innerWidth > clientWidth) style.scrollbarGutter = "stable";
    style.overflow = "hidden";
    return () => {
      style.overflow = overflow;
      style.scrollbarGutter = scrollbarGutter;
    };
  }, []);
}

/**
 * NEO-444 — a card lifted out of a public binder: it pops out of its sleeve
 * into a top loader over the dimmed binder, its title directly below. What a
 * pocket has no room to say sits under the title, quieter: grade or
 * condition, how many, Trade, the catalog's Notes, the back.
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
  // Null until the visitor flips it: there is nothing to announce on opening.
  const [showBack, setShowBack] = useState<boolean | null>(null);
  const [stageRef, stageScrolls] = useOverflows<HTMLDivElement>();
  useLockedPage();
  const { photos } = copy;
  const canFlip = !!photos?.front && !!photos.back;
  const flipped = canFlip && showBack === true;
  // Fetched on opening, so See the back never shows an empty top loader.
  const back = canFlip ? photos.back : undefined;
  useEffect(() => {
    if (!back) return;
    new Image().src = back.thumbUrl;
    new Image().src = back.imageUrl;
  }, [back]);
  const photo = flipped ? photos.back : (photos?.front ?? photos?.back);
  const label = cardLabel(card);
  const side = flipped || (photos?.back && !photos.front) ? `${label}, the back` : label;
  const shape = grade(copy) ?? copy.condition;
  const several = copy.quantity > 1;

  return (
    <Overlay labelledBy={titleId} onClose={onClose} variant="stage">
      <div aria-hidden="true" className="nb-toploader-dim" />
      <NeonButton
        type="button"
        variant="secondary"
        outline
        aria-label="Close the top loader"
        onClick={onClose}
        // Solid: it can sit over the card on a phone. The fill is the button's own paint variable.
        style={{ "--nb-fill": "var(--surface)" } as CSSProperties}
        className="pointer-events-auto !absolute right-3 top-3 z-10 min-h-11 min-w-11"
      >
        <XMarkIcon aria-hidden="true" className="h-5 w-5" />
      </NeonButton>
      {/* A tab stop only when there's something to scroll. The space around the card closes it, like the scrim. */}
      <div
        ref={stageRef}
        role="group"
        aria-label={stageScrolls ? "This card and its details" : undefined}
        tabIndex={stageScrolls ? 0 : undefined}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        className="nb-toploader-stage focus-outline"
      >
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
          className="nb-toploader-title text-lg font-bold leading-snug text-ink [overflow-wrap:anywhere] focus:outline-none sm:text-xl"
        >
          {label}
        </h2>
        <div role="group" aria-label="About this card" className="nb-toploader-details text-sm text-ink-2">
          {(shape || several || copy.upForTrade) && (
            <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
              {shape && <span>{shape}</span>}
              {several && (
                <span>
                  <span aria-hidden="true">×{copy.quantity}</span>
                  <span className="sr-only">{copy.quantity} copies</span>
                </span>
              )}
              {copy.upForTrade && (
                <span className="rounded bg-raised px-1.5 py-0.5 text-xs font-semibold text-neon-blue-text">Trade</span>
              )}
            </p>
          )}
          {card.own && <p>Not in the NeonBinder catalog</p>}
          {photo && (
            <p className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
              {canFlip && (
                <NeonButton type="button" variant="secondary" outline size="1" onClick={() => setShowBack(!flipped)} className="min-h-11">
                  {flipped ? "See the front" : "See the back"}
                </NeonButton>
              )}
              <a
                href={photo.imageUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center rounded-sm text-neon-blue-text underline focus-outline"
              >
                See it full size<span className="sr-only"> (opens a new tab)</span>
              </a>
            </p>
          )}
          <p role="status" className="sr-only">
            {showBack === null ? "" : flipped ? "Showing the back" : "Showing the front"}
          </p>
          {/* NEO-367: the catalog card's Notes are NB's facts about the card, public by Jason's call. */}
          {card.notes && <p className="whitespace-pre-line [overflow-wrap:anywhere]">{card.notes}</p>}
        </div>
      </div>
    </Overlay>
  );
}
