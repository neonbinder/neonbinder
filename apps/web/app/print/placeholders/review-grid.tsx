import { useCallback, useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import NeonButton from "@/components/modules/NeonButton";
import { ScanImage } from "./scan-image";

/**
 * Correct what the matcher got wrong, before any of it reaches paper (NEO-152 §3).
 *
 * Auto-pairing is right most of the time and wrong some of the time, and a
 * placeholder sheet is a physical object — a mispair is discovered after the
 * cutting, not before. So this step is required rather than optional, and every
 * decision it makes has to be reversible.
 *
 * ## Why there is no drag-and-drop
 * The obvious design for re-pairing is dragging a back onto a front. It is also
 * the design that cannot be made keyboard-operable without building a second,
 * parallel interaction — and NEO-152 requires full keyboard operation, so the
 * drag version would need that fallback anyway.
 *
 * Instead re-pairing decomposes into two plain actions that happen to be the
 * exact two mutations the backend already has:
 *
 *   Split          unpairPlaceholderImages   -> both halves join the loose pile
 *   Pair these     manuallyPairPlaceholderImages
 *
 * Selecting one front and one back from a list is a checkbox problem, which is
 * keyboard-native for free, works on a phone, and needs no drop targets, no
 * pointer capture, and no announcement machinery.
 *
 * ## Why this only appears once the batch is finished
 * `unpairPlaceholderImages` deliberately schedules its re-pair WITHOUT force, so
 * on a terminal job the incremental guard skips it and the freed images stay
 * loose. On a still-running job that scheduled run could re-create the very pair
 * the user just split, before they can pair the halves correctly — and
 * `manuallyPairPlaceholderImages` would then refuse with "already paired". The
 * mutation's own doc comment spells this out. Reviewing a finished batch is the
 * right workflow anyway.
 *
 * ## Dropping is client-side, deliberately
 * A print run is an ephemeral act — the pairs are the durable thing, the
 * selection is not (decided 2026-08-25). Excluding a pair costs a schema field,
 * a mutation and an auth check to persist, and buys only surviving a reload of
 * the page you are actively printing from.
 */

export type ReviewPair = {
  frontIndex: number;
  backIndex: number;
  player?: string;
  cardNumber?: string;
  confidence: "exact" | "fuzzy" | "side-only";
  mechanism: "adjacency" | "pool" | "manual";
};

export type ReviewImage = {
  entryIndex: number;
  originalName: string;
  status: string;
  side?: string;
  pairStatus?: string;
};

function pairKey(pair: { frontIndex: number; backIndex: number }): string {
  return `${pair.frontIndex}-${pair.backIndex}`;
}

function cardName(pair: ReviewPair): string {
  const number = pair.cardNumber ? ` #${pair.cardNumber}` : "";
  return pair.player ? `${pair.player}${number}` : "Not identified";
}

/** What the matcher had to go on, in the user's terms rather than the schema's. */
function evidence(pair: ReviewPair): string {
  if (pair.mechanism === "manual") return "You paired these";
  if (pair.confidence === "exact") return "Name and details match";
  if (pair.confidence === "fuzzy") return "Partial match — worth a look";
  return "Scan order only — no matching details";
}

export function ReviewGrid({
  jobId,
  pairs,
  images,
  excluded,
  onToggleExcluded,
}: {
  jobId: string;
  pairs: ReviewPair[];
  images: ReviewImage[];
  excluded: ReadonlySet<string>;
  onToggleExcluded: (key: string) => void;
}) {
  const unpair = useMutation(api.placeholderPairing.unpairPlaceholderImages);
  const manuallyPair = useMutation(
    api.placeholderPairing.manuallyPairPlaceholderImages,
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosenFront, setChosenFront] = useState<number | null>(null);
  const [chosenBack, setChosenBack] = useState<number | null>(null);

  // Loose = processed, but nothing claimed it. Never hidden behind a count:
  // an unmatched front is the single thing on this page a user must act on.
  const loose = useMemo(
    () =>
      images.filter((i) => i.status === "done" && i.pairStatus !== "paired"),
    [images],
  );

  const run = useCallback(
    async (key: string, action: () => Promise<unknown>) => {
      setBusy(key);
      setError(null);
      try {
        await action();
      } catch (caught) {
        // The mutations throw plain messages meant for a person ("image is
        // already paired — unpair it first"), so showing them beats replacing
        // them with something vaguer.
        setError(caught instanceof Error ? caught.message : "That didn't work.");
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const split = (pair: ReviewPair) =>
    run(pairKey(pair), () =>
      unpair({
        jobId,
        frontIndex: pair.frontIndex,
        backIndex: pair.backIndex,
      }),
    );

  /** Swap = split, then pair the same two the other way round. */
  const swapSides = (pair: ReviewPair) =>
    run(`swap-${pairKey(pair)}`, async () => {
      await unpair({
        jobId,
        frontIndex: pair.frontIndex,
        backIndex: pair.backIndex,
      });
      await manuallyPair({
        jobId,
        frontIndex: pair.backIndex,
        backIndex: pair.frontIndex,
      });
    });

  const pairChosen = () =>
    run("pair-chosen", async () => {
      if (chosenFront === null || chosenBack === null) return;
      await manuallyPair({
        jobId,
        frontIndex: chosenFront,
        backIndex: chosenBack,
      });
      setChosenFront(null);
      setChosenBack(null);
    });

  return (
    <section aria-labelledby="review-heading" className="space-y-6">
      <div>
        <h3 id="review-heading" className="text-2xl font-bold mb-1">
          Check the pairs
        </h3>
        <p className="text-slate-400 max-w-2xl">
          Each card needs its own front and back. Fix anything that looks wrong —
          nothing prints until you say so.
        </p>
      </div>

      {/* Always mounted so a failure is announced rather than appearing silently. */}
      <p role="alert" className="text-sm text-neon-pink">
        {error ?? ""}
      </p>

      <ul className="space-y-3 list-none p-0">
        {pairs.map((pair) => {
          const key = pairKey(pair);
          const isExcluded = excluded.has(key);
          const settled =
            pair.mechanism === "manual" || pair.confidence === "exact";
          return (
            <li
              key={key}
              className={[
                "rounded-lg border p-3",
                isExcluded
                  ? "border-slate-800 bg-slate-900/20 opacity-60"
                  : settled
                    ? "border-neon-green/40 bg-slate-900/40"
                    : "border-neon-yellow/40 bg-slate-900/40",
              ].join(" ")}
            >
              <div className="flex flex-wrap items-start gap-4">
                {/* Both sides, together. The pocket grid shows only the front,
                    which is right for previewing paper and useless for deciding
                    whether a pair is the RIGHT pair. */}
                <div className="flex gap-2">
                  <figure className="m-0">
                    <ScanImage
                      jobId={jobId}
                      entryIndex={pair.frontIndex}
                      alt={`Front of ${cardName(pair)}`}
                      className="h-28 w-auto rounded border border-slate-700 object-contain"
                    />
                    <figcaption className="text-[10px] text-slate-500 text-center mt-1">
                      Front
                    </figcaption>
                  </figure>
                  <figure className="m-0">
                    <ScanImage
                      jobId={jobId}
                      entryIndex={pair.backIndex}
                      alt={`Back of ${cardName(pair)}`}
                      className="h-28 w-auto rounded border border-slate-700 object-contain"
                    />
                    <figcaption className="text-[10px] text-slate-500 text-center mt-1">
                      Back
                    </figcaption>
                  </figure>
                </div>

                <div className="min-w-[12rem] flex-1 space-y-1">
                  <p className="text-slate-200">{cardName(pair)}</p>
                  {/* Text, not a colour swatch: the border already carries the
                      colour, and colour alone fails WCAG 1.4.1. */}
                  <p
                    className={`text-xs ${settled ? "text-neon-green" : "text-neon-yellow"}`}
                  >
                    {evidence(pair)}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 text-sm text-slate-300">
                    <input
                      type="checkbox"
                      checked={!isExcluded}
                      onChange={() => onToggleExcluded(key)}
                      className="accent-[#00D558]"
                    />
                    Print
                  </label>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void swapSides(pair)}
                    className="rounded border border-slate-700 px-2 py-1 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                  >
                    {busy === `swap-${key}` ? "Swapping…" : "Swap sides"}
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void split(pair)}
                    className="rounded border border-slate-700 px-2 py-1 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                  >
                    {busy === key ? "Splitting…" : "Split"}
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {/* The loose pile. Present whenever anything is in it, and the only place
          re-pairing happens — a split lands here, and so does anything the
          matcher never claimed. */}
      {loose.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-lg font-semibold">
            Not paired ({loose.length})
          </h4>
          <p className="text-sm text-slate-400">
            Pick one front and one back, then pair them.
          </p>
          <ul className="flex flex-wrap gap-3 list-none p-0">
            {loose.map((image) => {
              const isFront = chosenFront === image.entryIndex;
              const isBack = chosenBack === image.entryIndex;
              return (
                <li key={image.entryIndex} className="w-32 space-y-1">
                  <ScanImage
                    jobId={jobId}
                    entryIndex={image.entryIndex}
                    alt={image.originalName}
                    className="h-32 w-full rounded border border-slate-700 object-contain"
                  />
                  <p className="truncate text-[10px] text-slate-500">
                    {image.originalName}
                  </p>
                  {/* Two radio groups, not a drag target: choosing "which front"
                      and "which back" is exactly what radios express, and they
                      arrow-key for free. */}
                  <div className="flex gap-2 text-xs">
                    <label className="flex items-center gap-1 text-slate-300">
                      <input
                        type="radio"
                        name="review-front"
                        checked={isFront}
                        onChange={() => setChosenFront(image.entryIndex)}
                        className="accent-[#A44AFF]"
                      />
                      Front
                    </label>
                    <label className="flex items-center gap-1 text-slate-300">
                      <input
                        type="radio"
                        name="review-back"
                        checked={isBack}
                        onChange={() => setChosenBack(image.entryIndex)}
                        className="accent-[#A44AFF]"
                      />
                      Back
                    </label>
                  </div>
                </li>
              );
            })}
          </ul>
          <NeonButton
            type="button"
            disabled={
              chosenFront === null ||
              chosenBack === null ||
              chosenFront === chosenBack ||
              busy !== null
            }
            onClick={() => void pairChosen()}
          >
            {busy === "pair-chosen" ? "Pairing…" : "Pair these two"}
          </NeonButton>
          {chosenFront !== null && chosenFront === chosenBack && (
            <p className="text-sm text-neon-pink">
              A card can&apos;t be its own back — pick a different image for one
              of them.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
