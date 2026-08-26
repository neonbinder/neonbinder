import { ScanImage } from "./scan-image";

/**
 * The 9-pocket page — this feature's own unit, used as its progress display.
 *
 * ## Why a binder page and not a progress bar
 * A progress bar would say "60%" and nothing else. The thing being built here
 * IS a 9-pocket page, so showing one fills three jobs at once: it reports
 * progress, it previews the output at the size and arrangement it will print
 * in, and it teaches the 9-per-sheet rule without a sentence of explanation.
 * The collector already thinks in pages; borrowing their unit is cheaper than
 * inventing ours.
 *
 * ## Colour carries the pairing decision, and never alone
 * NEO-152 made an `exact` match final and left softer ones revisable, so the
 * grid draws that distinction rather than hiding it:
 *
 *   settled   neon-green   locked in — the identity matched outright
 *   potential neon-yellow  worth a look — matched, but the app is guessing
 *   empty     dashed slate nothing here yet
 *
 * Every pocket also carries a text label, because colour alone fails both a
 * colour-blind user and a screen reader (WCAG 1.4.1).
 */

export type PocketPair = {
  frontIndex: number;
  backIndex: number;
  player?: string;
  cardNumber?: string;
  confidence: "exact" | "fuzzy" | "side-only";
  mechanism: "adjacency" | "pool" | "manual";
};

const POCKETS_PER_PAGE = 9;

/** Settled = final. Mirrors `isLockedPair` on the server; see placeholderPairing.ts. */
export function isSettled(pair: PocketPair): boolean {
  return pair.mechanism === "manual" || pair.confidence === "exact";
}

function pocketLabel(pair: PocketPair): string {
  if (pair.mechanism === "manual") return "You set this";
  return pair.confidence === "exact" ? "Matched" : "Check this";
}

function cardName(pair: PocketPair): string {
  const number = pair.cardNumber ? ` #${pair.cardNumber}` : "";
  return pair.player ? `${pair.player}${number}` : "Card not identified";
}

export function PocketPage({
  jobId,
  pairs,
}: {
  jobId: string;
  pairs: PocketPair[];
}) {
  // Pages, not one long scroll: nine is the physical unit, so the break between
  // the ninth and tenth pair is real information — that is where a new sheet
  // of paper starts.
  const pageCount = Math.max(1, Math.ceil(pairs.length / POCKETS_PER_PAGE));

  return (
    <div className="space-y-6">
      {Array.from({ length: pageCount }, (_, page) => {
        const slice = pairs.slice(
          page * POCKETS_PER_PAGE,
          (page + 1) * POCKETS_PER_PAGE,
        );
        return (
          <div key={page} className="space-y-2">
            {pageCount > 1 && (
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Sheet {page + 1} of {pageCount}
              </p>
            )}
            {/* Capped: a 9-pocket page is a physical object about 8.5in wide,
                and stretched across a desktop column it stops reading as one.
                Roughly card-sized pockets also make the front art legible at a
                glance, which is the only reason to show it here. */}
            <ul className="grid max-w-md grid-cols-3 gap-2 list-none p-0 sm:gap-3">
              {Array.from({ length: POCKETS_PER_PAGE }, (_, slot) => {
                const pair = slice[slot];
                if (!pair) {
                  return (
                    <li
                      key={slot}
                      aria-hidden="true"
                      className="aspect-[2.5/3.5] rounded-md border border-dashed border-slate-700/80"
                    />
                  );
                }
                const settled = isSettled(pair);
                return (
                  <li
                    key={`${pair.frontIndex}-${pair.backIndex}`}
                    className={[
                      "relative aspect-[2.5/3.5] overflow-hidden rounded-md border-2",
                      "motion-safe:animate-[fadeIn_200ms_ease-out]",
                      settled ? "border-neon-green/70" : "border-neon-yellow/70",
                    ].join(" ")}
                  >
                    {/* Fills the pocket edge to edge, which is also how it
                        PRINTS — NEO-152 decided card art is full bleed, right
                        to the cut line, so a preview with the image floating in
                        a corner would be lying about the output. */}
                    <ScanImage
                      jobId={jobId}
                      entryIndex={pair.frontIndex}
                      alt={`Front of ${cardName(pair)}`}
                      className="h-full w-full object-cover"
                    />
                    <span
                      className={[
                        "absolute inset-x-0 bottom-0 truncate px-1 py-0.5 text-[10px]",
                        settled
                          ? "bg-neon-green/20 text-neon-green"
                          : "bg-neon-yellow/20 text-neon-yellow",
                      ].join(" ")}
                    >
                      {pocketLabel(pair)}
                    </span>
                    {/* The pocket shows the front; the name and the pairing
                        decision are what a screen reader needs, and neither is
                        available from the image alone. */}
                    <span className="sr-only">
                      {cardName(pair)} — {pocketLabel(pair)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
