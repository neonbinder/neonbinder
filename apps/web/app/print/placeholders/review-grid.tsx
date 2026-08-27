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
  const updateIdentity = useMutation(
    api.placeholderPairing.updatePlaceholderImageIdentity,
  );
  const swapSidesMutation = useMutation(api.placeholderPairing.swapPairSides);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Entry indexes ticked for pairing. Two, of opposite sides, makes a pair. */
  const [selected, setSelected] = useState<readonly number[]>([]);

  // Loose = processed, but nothing claimed it. Never hidden behind a count:
  // an unmatched front is the single thing on this page a user must act on.
  const loose = useMemo(
    () =>
      images.filter((i) => i.status === "done" && i.pairStatus !== "paired"),
    [images],
  );

  // What the pile can offer. All-backs is a normal mid-batch state — fronts
  // escalate to the slow path far more often than backs, which are text-dense
  // and settle fast — so telling someone to pick a front when none exists reads
  // as the tool being broken.
  const looseFronts = loose.filter((i) => i.side === "front").length;
  const looseBacks = loose.filter((i) => i.side === "back").length;

  // Only images still in the pile can stay selected.
  const present = new Set(loose.map((i) => i.entryIndex));
  const picked = selected.filter((i) => present.has(i));
  const pickedRows = picked
    .map((i) => loose.find((l) => l.entryIndex === i))
    .filter((r): r is ReviewImage => r !== undefined);

  const front = pickedRows.find((r) => r.side === "front");
  const back = pickedRows.find((r) => r.side === "back");
  // Two selected, one of each side. Which is which comes from the SIDE, not
  // from the order they were ticked — that is the whole point of the side being
  // a property of the image.
  const canPair = pickedRows.length === 2 && front !== undefined && back !== undefined;

  const toggleSelected = (entryIndex: number) =>
    setSelected((current) =>
      current.includes(entryIndex)
        ? current.filter((i) => i !== entryIndex)
        : // Cap at two: a pair is two cards, and silently dropping the oldest
          // is friendlier than refusing a click with no explanation.
          [...current.filter((i) => present.has(i)), entryIndex].slice(-2),
    );

  const setSide = (entryIndex: number, side: "front" | "back") =>
    run(`side-${entryIndex}`, () =>
      updateIdentity({ jobId, entryIndex, side }),
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

  /**
   * Swap in ONE call, not unpair-then-pair.
   *
   * Two round trips left a window the matcher could act in: on a live batch the
   * re-pair that unpair schedules can claim a freed half for a different
   * partner, and the follow-up pair then fails with "already paired" — the
   * user's swap having silently become a split. See `swapPairSides`.
   */
  const swapSides = (pair: ReviewPair) =>
    run(`swap-${pairKey(pair)}`, () =>
      swapSidesMutation({
        jobId,
        frontIndex: pair.frontIndex,
        backIndex: pair.backIndex,
      }),
    );

  const pairChosen = () =>
    run("pair-chosen", async () => {
      if (!front || !back) return;
      await manuallyPair({
        jobId,
        frontIndex: front.entryIndex,
        backIndex: back.entryIndex,
      });
      setSelected([]);
    });

  return (
    <section
      aria-label={pairs.length > 0 ? undefined : "Cards not yet paired"}
      aria-labelledby={pairs.length > 0 ? "review-heading" : undefined}
      className="space-y-6"
    >
      {/* Only once there is something to check. Mid-batch the pile can be all
          backs with no pairs yet, and heading that "Check the pairs" — directly
          under the panel already saying "No pairs yet" — reads as a section
          that failed to load rather than one that has not filled yet. */}
      {pairs.length > 0 && (
        <div>
          <h3 id="review-heading" className="text-2xl font-bold mb-1">
            Check the pairs
          </h3>
          <p className="text-slate-400 max-w-2xl">
            Each card needs its own front and back. Fix anything that looks
            wrong — nothing prints until you say so.
          </p>
        </div>
      )}

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
            {looseFronts === 0
              ? "Only backs here so far — their fronts are still being read. They will pair up as those finish."
              : looseBacks === 0
                ? "Only fronts here so far — their backs are still being read. They will pair up as those finish."
                : "Tick two cards — a front and a back — then pair them."}
          </p>
          <ul className="flex flex-wrap gap-3 list-none p-0">
            {loose.map((image) => {
              const isPicked = picked.includes(image.entryIndex);
              const side =
                image.side === "front" || image.side === "back"
                  ? image.side
                  : null;
              return (
                <li
                  key={image.entryIndex}
                  className={[
                    "w-32 space-y-1 rounded border p-1",
                    isPicked
                      ? "border-neon-purple bg-neon-purple/10"
                      : "border-transparent",
                  ].join(" ")}
                >
                  <ScanImage
                    jobId={jobId}
                    entryIndex={image.entryIndex}
                    alt={image.originalName}
                    className="h-32 w-full rounded border border-slate-700 object-contain"
                  />
                  <p className="truncate text-[10px] text-slate-500">
                    {image.originalName}
                  </p>

                  {/* WHICH SIDE THIS CARD IS — a property of the image, not of
                      the pair being built, which is why every card shows its
                      own answer rather than one card in the pile being "the
                      front". Pre-filled from the classifier and SAVED when
                      changed: a corrected side is written back with
                      updatePlaceholderImageIdentity, which forces a re-pair, so
                      fixing a misread here can resolve the pairing on its own
                      without anyone pairing by hand. */}
                  <fieldset className="flex gap-2 text-xs">
                    <legend className="sr-only">
                      Which side is {image.originalName}?
                    </legend>
                    {(["front", "back"] as const).map((value) => (
                      <label
                        key={value}
                        className="flex items-center gap-1 text-slate-300 capitalize"
                      >
                        <input
                          type="radio"
                          name={`side-${image.entryIndex}`}
                          checked={side === value}
                          disabled={busy !== null}
                          onChange={() => void setSide(image.entryIndex, value)}
                          className="accent-[#A44AFF]"
                        />
                        {value}
                      </label>
                    ))}
                  </fieldset>
                  {side === null && (
                    <p className="text-[10px] text-neon-yellow">
                      Side unclear — pick one
                    </p>
                  )}

                  {/* Separate from the side, because they answer different
                      questions: what IS this, and do I want to pair it now. */}
                  <label className="flex items-center gap-1 text-xs text-slate-300">
                    <input
                      type="checkbox"
                      checked={isPicked}
                      disabled={busy !== null}
                      onChange={() => toggleSelected(image.entryIndex)}
                      className="accent-[#00D558]"
                    />
                    Pair this
                  </label>
                </li>
              );
            })}
          </ul>
          <NeonButton
            type="button"
            disabled={!canPair || busy !== null}
            onClick={() => void pairChosen()}
          >
            {busy === "pair-chosen" ? "Pairing…" : "Pair these two"}
          </NeonButton>
          {/* Say WHY it is unavailable. A disabled button with no explanation
              is the same dead end as an error with no next step. */}
          {picked.length === 2 && !canPair && (
            <p className="text-sm text-neon-pink">
              Those are both {front ? "fronts" : "backs"} — a pair needs one of
              each. Change a side above, or pick a different card.
            </p>
          )}
          {picked.length === 1 && (
            <p className="text-sm text-slate-400">
              Pick one more — a pair needs a front and a back.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
