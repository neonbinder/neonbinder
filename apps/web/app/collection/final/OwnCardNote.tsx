import type { OwnCard } from "./data/types";

/**
 * NEO-361 — what the card drawer says about a card the collector owns that NB
 * doesn't have: that it is unlisted, where its request stands, and what they
 * wrote and photographed. It is theirs either way; nothing here needs doing.
 */
export default function OwnCardNote({ own }: { own: OwnCard }) {
  return (
    <div className="space-y-2 rounded-md border border-dashed border-neon-blue/60 bg-sheet p-3 text-xs">
      <p className="font-semibold text-neon-blue-text">Unlisted: not in the NeonBinder catalog</p>
      {own.status && (
        <p className="text-ink-2">
          {own.status === "waiting"
            ? `You asked us to add it${own.nbSet ? "" : " with its set"}. It's yours to file in the meantime.`
            : "We didn't add it to the catalog. It stays yours, just for you."}
        </p>
      )}
      {own.notes && (
        <p className="text-ink-3">
          <span className="text-ink-2">Your notes:</span> {own.notes}
        </p>
      )}
      {(own.frontImageUrl || own.backImageUrl) && (
        <ul className="flex gap-2" aria-label="Your photos">
          {own.frontImageUrl && (
            <li>
              <img src={own.frontImageUrl} alt="Front of the card" className="h-24 w-auto rounded border border-rule-strong" />
            </li>
          )}
          {own.backImageUrl && (
            <li>
              <img src={own.backImageUrl} alt="Back of the card" className="h-24 w-auto rounded border border-rule-strong" />
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
