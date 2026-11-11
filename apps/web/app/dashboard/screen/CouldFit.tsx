import type { CSSProperties } from "react";
import { BlockHeading, CardLine } from "./bits";
import type { ShelfBinder } from "./shelf-model";

/**
 * NEO-464 combined dashboard, block 5 — cards of yours that COULD FIT a smart
 * binder: they match its rule but are not filed in it. One strip per smart
 * binder with candidates, led by a length of that binder's spine so it reads
 * as "these go there", then the count and up to three cards by their full
 * listing titles, "+N" beyond. Replaces prototype 4's "Filed themselves".
 *
 * The heading is a placeholder for Jason to pick.
 */

/** Cards a strip names; the signed-in page hydrates only these. */
export const COULD_FIT_PREVIEW = 3;

export default function CouldFit({ binders, wanted }: { binders: ShelfBinder[]; wanted: Set<string> }) {
  const withCandidates = binders.filter((b) => b.kind === "smart" && b.couldFit.length > 0);
  if (withCandidates.length === 0) return null;

  return (
    <section aria-labelledby="cb-fit-heading" className="space-y-4">
      <div>
        <BlockHeading id="cb-fit-heading">Could fit your smart binders</BlockHeading>
        <p className="mt-1 text-sm text-ink-3">Cards of yours that match a binder&apos;s rule but aren&apos;t in it yet.</p>
      </div>
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {withCandidates.map((b) => (
          <li key={b.id}>
            <Strip binder={b} wanted={wanted} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Strip({ binder, wanted }: { binder: ShelfBinder; wanted: Set<string> }) {
  const shown = binder.couldFit.slice(0, COULD_FIT_PREVIEW);
  // ↑ ↓ in a card's panel walk every candidate the strip holds.
  const list = binder.couldFit.map((c) => c.id);
  const total = binder.couldFitTotal?.count ?? binder.couldFit.length;
  const more = binder.couldFitTotal?.more ?? false;
  const rest = total - shown.length;
  const style = { "--vinyl": binder.vinyl } as CSSProperties;
  const headingId = `cb-fit-${binder.id}`;

  return (
    <article aria-labelledby={headingId} className="flex h-full gap-3 rounded-xl border border-rule bg-raised p-3">
      <span className="cb-swatch" style={style} aria-hidden="true">
        <span className="cb-hatch" />
      </span>
      <div className="min-w-0 flex-1 space-y-2.5">
        <div>
          <h3 id={headingId} className="font-bold leading-tight text-ink">
            {binder.name}
          </h3>
          {binder.ruleText && <p className="text-xs text-ink-3">{binder.ruleText}</p>}
          <p className="mt-1 text-sm font-semibold text-neon-blue-text">{total}
            {more ? "+" : ""} could fit
          </p>
        </div>
        <ul aria-label={`Cards that could fit ${binder.name}`} className="flex flex-col gap-2">
          {shown.map((c) => (
            <li key={c.id}>
              <CardLine card={c} thumb="w-9" wanted={wanted.has(c.id)} link={{ side: "collection", list }} />
            </li>
          ))}
        </ul>
        {rest > 0 && (
          <p className="text-xs font-bold text-ink-2">
            +{rest}
            <span className="sr-only">{rest === 1 ? " more card" : " more cards"}</span>
          </p>
        )}
      </div>
    </article>
  );
}
