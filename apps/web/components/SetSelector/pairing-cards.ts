/**
 * NEO-255 — one streamed candidate → one `PairingCard`, in exactly one place.
 *
 * This mapping used to live inside `CardChecklist`'s `streamedPairing` memo as
 * a closure called `toCard`, which was fine while the pairing dialog was the
 * only thing that ever built a `PairingCard`. It is not any more: a set with
 * exactly ONE marketplace attached has nothing to line up, so the dialog never
 * mounts and the client commits every fetched card itself, as a kept single.
 *
 * Two paths building the same card from the same row is precisely the shape
 * that drifts — NEO-199's `nameConflict` and NEO-251's `playersConflict` were
 * each added to one mapping and had to be chased into the other, and a field
 * missed here is a field the operator never sees and the sync-review diff is
 * never told about. So the mapping is one exported function, used by both, and
 * the auto-keep path cannot silently build a thinner card than the dialog does.
 */

import type { PairingCard } from "./CardPairingModal";

/**
 * The half of `checklistCandidates.getReadyCandidates`' card shape this
 * mapping reads.
 *
 * Structural rather than imported from the generated API: the query returns
 * more than this (`_id`, `stem`, `teamResolved`, `confidence`), and naming only
 * what is consumed keeps the helper — and its unit test — free of Convex.
 */
export type ReadyCandidate = {
  cardNumber: string;
  cardName: string;
  teams?: string[];
  players?: string[];
  attributes?: string[];
  isRookie?: boolean;
  isRelic?: boolean;
  printRun?: number;
  autographType?: string;
  cardVariation?: string;
  isVariation?: boolean;
  platformData: {
    bsc?: { ref: string; setId?: string };
    sportlots?: { ref: string; setId?: string };
  };
  nameConflict?: { bsc: string; sportlots: string };
  playersConflict?: {
    bsc: string[];
    sportlots: string[];
    preferred?: "bsc" | "sportlots";
  };
  bucket: "matched" | "bscOnly" | "slOnly";
};

/**
 * One candidate as the pairing dialog sees it.
 *
 * `unmatched` is the bucket read from the other end: a card only BSC listed is
 * missing its SportLots half (`"sl"`), and vice versa. A matched pair is
 * missing nothing and carries no marker at all. That is the same value
 * `commitCardChecklist` writes its `unmatched-<side>` attribute from, so the
 * badge on a kept single is decided here.
 */
export function candidateToPairingCard(c: ReadyCandidate): PairingCard {
  return {
    cardNumber: c.cardNumber,
    cardName: c.cardName,
    teams: c.teams,
    players: c.players,
    attributes: c.attributes,
    isRookie: c.isRookie,
    isRelic: c.isRelic,
    printRun: c.printRun,
    autographType: c.autographType,
    cardVariation: c.cardVariation,
    // NEO-189: without this the modal commits every variation as a standalone
    // card — the flag has to survive the whole path.
    isVariation: c.isVariation,
    platformData: c.platformData,
    // NEO-199: the losing name from a server-side merge. Absent on every row
    // the two marketplaces agree about, which is nearly all of them; where it
    // is present the modal raises the same choice a hand-linked conflict gets.
    nameConflict: c.nameConflict,
    // NEO-251: and the losing ROSTER, on exactly the same terms.
    playersConflict: c.playersConflict,
    unmatched:
      c.bucket === "bscOnly" ? "sl" : c.bucket === "slOnly" ? "bsc" : undefined,
  };
}

/**
 * NEO-255 — the candidates as COMMITTABLE cards: what the dialog's Confirm
 * would hand back on a set where every row is a kept single.
 *
 * The two disagreement fields are dropped, and that is not a shortcut — it is
 * the same lift `CardPairingModal` performs. `seedMatched` moves a conflict off
 * the card and onto the PAIR the moment it arrives, so a card reaching
 * `onConfirm` never carries one, and `commitCardChecklist` THROWS on a card
 * that still does. A single has no second marketplace to disagree with, so on
 * this path there is nothing to lift and nothing to ask; going through the same
 * mapping and then dropping the fields keeps that a stated property rather than
 * an assumption about which buckets can appear.
 */
export function candidatesToPairingCards(
  candidates: readonly ReadyCandidate[],
): PairingCard[] {
  return candidates.map((c) => {
    const card = candidateToPairingCard(c);
    delete card.nameConflict;
    delete card.playersConflict;
    return card;
  });
}
