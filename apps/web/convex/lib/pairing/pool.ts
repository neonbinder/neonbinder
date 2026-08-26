/**
 * The scoring card pool — port of script-frontend's `CardPool` class, via the
 * preprocess service's audited Python port (`app/pairing/pool.py`).
 *
 * `CardPool` is **internal to this package on purpose.** Its semantics are
 * incremental: cards are offered one at a time, a card that finds no partner
 * is held, and both the same-side collision resolution and the tie-breaking
 * depend on the order cards were offered in. That statefulness is
 * load-bearing, so it survives the port intact — but it is not the surface
 * the NEO-170 pipeline consumes. `pairBatch` (in `pairBatch.ts`) owns the
 * lifecycle: it constructs a pool, feeds it in upload order, and returns.
 * Callers outside this package should use that.
 *
 * Two behaviours in here are the result of production bugs and must not be
 * "simplified" back:
 *
 * 1. **Player disagreement is a hard reject, not a penalty.** It was a -1000
 *    score penalty until card numbers misread off fronts (jersey numbers,
 *    copyright years) coincidentally matched and outweighed it, pairing
 *    unrelated cards. Player name is the largest, cleanest text on a card;
 *    when both sides carry one and they disagree, no other signal may
 *    overrule it.
 *
 * 2. **A same-side collision never blindly overwrites the pooled image.**
 *    See `CardPool.resolveSameSideCollision`.
 */

import { imagesLookIdentical, isDhashHex } from "./dhash";
import { playerNamesMatch, teamNamesMatch } from "./names";
import {
  CardSide,
  Confidence,
  ImageHasher,
  MatchResult,
  PoolCard,
  cardLabel,
  hasIdentity,
  makeMatchResult,
} from "./types";

// ── Scoring weights ──────────────────────────────────────────────────────────
// Ported verbatim. The absolute magnitudes matter less than the gaps: card
// number dominates everything combined, an exact player beats any team signal,
// and the weakest single accepted signal lands exactly on the threshold.

/**
 * Card number is the only field that uniquely identifies a card within a set,
 * so an exact hit outweighs every other signal put together.
 */
export const CARD_NUMBER_EXACT_SCORE = 2000;

/** Player name after normalisation matched character for character. */
export const PLAYER_EXACT_SCORE = 1000;

/**
 * Player matched through the fuzzy ladder (surname-only, initials, prefixes).
 * Kept well below the exact weight because a shared surname within one set is
 * common enough to be a real false-positive source.
 */
export const PLAYER_FUZZY_SCORE = 400;

/**
 * Team matched exactly. Far weaker than player: a set has ~30 teams and
 * dozens of cards per team, so a team hit narrows the field without
 * identifying a card.
 */
export const TEAM_EXACT_SCORE = 500;

/**
 * Team matched by containment ("Chiefs" inside "Kansas City Chiefs"). This is
 * the weakest accepted signal and sits exactly on the accept threshold, so a
 * fuzzy team match alone is the minimum evidence that will pair two cards.
 */
export const TEAM_FUZZY_SCORE = 200;

/**
 * Photographed one after the other.
 *
 * Most scans run front, back, front, back, so two images one apart are
 * probably two sides of one card — but only probably, which is exactly why
 * this is a small bonus and not a mechanism. It is deliberately the same
 * weight as the weakest identity signal (a fuzzy team hit): enough to break a
 * tie and to lift a corroborated identity match over the exact threshold.
 *
 * It is applied ONLY when identity has already scored — see the call site.
 * Ungated it would equal MATCH_ACCEPT_THRESHOLD on its own and pair two
 * adjacent images with no identity whatsoever, displacing the guarded
 * adjacency fallback that exists to handle exactly that case honestly.
 */
export const ADJACENCY_SCORE = 200;

/**
 * Minimum score to accept a candidate. Set to the weakest single signal so
 * that any one identity agreement pairs, but zero agreement never does.
 */
export const MATCH_ACCEPT_THRESHOLD = 200;

/**
 * Above this, a pairing is treated as settled — see `Confidence`.
 *
 * STRICTLY above, and that is the point: an exact player-name match alone
 * scores exactly 1000 and stays `fuzzy`. A name on its own is not proof, since
 * one player can appear on several cards in a set. It needs corroboration —
 * the team agreeing (+500), or the two images being adjacent in the scan
 * (+200) — to settle. A card-number agreement (2000) clears it outright, on
 * the rare occasion both halves carry one.
 */
export const EXACT_CONFIDENCE_THRESHOLD = 1000;

/**
 * Do these two cards describe the same physical card?
 *
 * Used only for same-side collision detection, which is why it is looser than
 * the scorer: it wants "plausibly the same card", not "confidently pairable".
 *
 * Player name is authoritative when both sides have one — an explicit
 * disagreement there is decisive and card number is not consulted, for the
 * same reason it is a hard reject in `CardPool.findMatch`. Card number and
 * team are fallbacks that only apply when at least one side lacks a player.
 */
export function sameCardIdentity(a: PoolCard, b: PoolCard): boolean {
  if (a.player && b.player) {
    return playerNamesMatch(a.player, b.player).match;
  }

  if (a.cardNumber && b.cardNumber) {
    if (a.cardNumber.toLowerCase().trim() === b.cardNumber.toLowerCase().trim()) {
      return true;
    }
  }

  if (a.team && b.team && teamNamesMatch(a.team, b.team).match) {
    return true;
  }

  return false;
}

/** The other side of a card. */
export function oppositeSide(side: CardSide): CardSide {
  return side === "front" ? "back" : "front";
}

/** Return [front, back] for a matched pair, driven by `card.side`. */
function orient(card: PoolCard, partner: PoolCard): [PoolCard, PoolCard] {
  if (card.side === "front") {
    return [card, partner];
  }
  return [partner, card];
}

/**
 * Holds unpaired cards and matches each new arrival against them.
 *
 * Insertion order is significant. The pool is backed by a `Map`, whose
 * iteration order is insertion order, and `findMatch` improves its best
 * candidate on a strict `>` starting from 0 — so when two candidates score
 * identically the **first one offered to the pool wins**. The original
 * TypeScript relied on `Map` iteration order for exactly this; the Python
 * port relied on dict insertion order for the same guarantee, and a test pins
 * it.
 */
export class CardPool {
  private readonly cards: Map<string, PoolCard> = new Map();
  private readonly hashImage: ImageHasher | null;

  /**
   * @param opts.hashImage optional perceptual-hash callback used only to
   *   disambiguate same-side collisions. Without it the pool falls back to
   *   the legacy newer-wins behaviour.
   */
  constructor(opts: { hashImage?: ImageHasher | null } = {}) {
    this.hashImage = opts.hashImage ?? null;
  }

  get size(): number {
    return this.cards.size;
  }

  /** Cards currently held, in the order they were offered. */
  entries(): PoolCard[] {
    return [...this.cards.values()];
  }

  /** Drop a card by key. Returns whether it was present. */
  remove(key: string): boolean {
    return this.cards.delete(key);
  }

  /**
   * Offer a card to the pool.
   *
   * Returns a `MatchResult` when the card pairs with one already held (the
   * partner is removed from the pool and neither card is retained), or null
   * when the card is held awaiting a partner.
   */
  addCard(card: PoolCard): MatchResult | null {
    // Collision resolution runs first: a re-scan should evict the stale
    // entry, and a mis-classified image should be flipped, before either
    // one is offered to the matcher.
    this.resolveSameSideCollision(card);

    const match = this.findMatch(card);
    if (match !== null) {
      const partner = match.front.key === card.key ? match.back : match.front;
      this.cards.delete(partner.key);
      return match;
    }

    this.cards.set(card.key, card);
    return null;
  }

  /**
   * Find the best-scoring opposite-side partner for `card`.
   *
   * Scores every opposite-side card held, rejecting outright any candidate
   * whose player name explicitly disagrees, and accepts the best if it clears
   * `MATCH_ACCEPT_THRESHOLD`. Falls back to a side-only pairing when exactly
   * one opposite-side card is held and neither card carries any identity at
   * all.
   */
  findMatch(card: PoolCard): MatchResult | null {
    const wanted = oppositeSide(card.side);
    let bestCandidate: PoolCard | null = null;
    let bestScore = 0;

    // Tracked for the side-only fallback below.
    let oppositeCount = 0;
    let lastOpposite: PoolCard | null = null;

    for (const existing of this.cards.values()) {
      if (existing.side !== wanted) {
        continue;
      }
      oppositeCount += 1;
      lastOpposite = existing;

      // Hard reject — see the module docstring. This is deliberately NOT a
      // score penalty; a coincidentally-equal card number must never be able
      // to outweigh an explicit player disagreement.
      if (
        card.player &&
        existing.player &&
        !playerNamesMatch(card.player, existing.player).match
      ) {
        continue;
      }

      let score = 0;
      let cardNumberMatched = false;
      let playerMatched = false;
      let teamMatched = false;

      if (card.cardNumber && existing.cardNumber) {
        if (
          card.cardNumber.toLowerCase().trim() ===
          existing.cardNumber.toLowerCase().trim()
        ) {
          score += CARD_NUMBER_EXACT_SCORE;
          cardNumberMatched = true;
        }
      }

      if (card.player && existing.player) {
        const pm = playerNamesMatch(card.player, existing.player);
        // `pm.match` is structurally always true here — the hard reject above
        // already skipped every candidate where both players exist and
        // disagree. Kept as written in the source so the two blocks stay
        // independently readable.
        if (pm.match) {
          score += pm.exact ? PLAYER_EXACT_SCORE : PLAYER_FUZZY_SCORE;
          playerMatched = true;
        }
      }

      if (card.team && existing.team) {
        const tm = teamNamesMatch(card.team, existing.team);
        if (tm.match) {
          score += tm.exact ? TEAM_EXACT_SCORE : TEAM_FUZZY_SCORE;
          teamMatched = true;
        }
      }

      // Scan order — CORROBORATION ONLY, never grounds for a pairing.
      //
      // Gated on the identity signals having already scored something. On its
      // own the bonus equals MATCH_ACCEPT_THRESHOLD exactly, so an ungated
      // version would pair any two adjacent opposite-side images with no
      // identity at all — quietly taking over from the guarded adjacency
      // fallback below, which handles that case deliberately and labels it
      // `mechanism: "adjacency"`, `confidence: "side-only"` so the UI can say
      // "this is only scan order". Boosting a real match is the job; inventing
      // one is not.
      //
      // Both positions must be known: an absent order means "we do not know",
      // not "not adjacent", and must not be scored either way.
      if (
        score > 0 &&
        card.order !== null &&
        existing.order !== null &&
        Math.abs(card.order - existing.order) === 1
      ) {
        score += ADJACENCY_SCORE;
      }

      // Strict `>` — ties keep the first-offered candidate.
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = existing;
      }
    }

    // Confidence is a band of the winning SCORE. The old checklist —
    // `cardNumberMatched && (playerMatched || teamMatched)` — could never be
    // true, because it wanted a card number on both halves and no set prints
    // one on the front. See the `Confidence` doc comment.
    const bestConfidence: Confidence =
      bestScore > EXACT_CONFIDENCE_THRESHOLD
        ? "exact"
        : bestScore > 0
          ? "fuzzy"
          : "side-only";

    if (bestCandidate !== null && bestScore >= MATCH_ACCEPT_THRESHOLD) {
      const [front, back] = orient(card, bestCandidate);
      return makeMatchResult(front, back, bestConfidence, "pool", bestScore);
    }

    // Side-only fallback. Only safe when there is exactly one opposite-side
    // card to choose from AND neither card has any identity to contradict the
    // pairing — with two candidates and no identity we would be guessing, and
    // a card that *does* have identity failed to match for a reason worth
    // respecting.
    if (oppositeCount === 1 && lastOpposite !== null) {
      if (!hasIdentity(card) && !hasIdentity(lastOpposite)) {
        const [front, back] = orient(card, lastOpposite);
        return makeMatchResult(front, back, "side-only", "pool", 0);
      }
    }

    return null;
  }

  /**
   * Handle a new card colliding with a held card of the same side.
   *
   * Front/back classification is sometimes wrong, so two *different* images
   * of the same card can both arrive labelled the same side. Overwriting the
   * pooled image would silently lose one of them, so instead:
   *
   * - **Same physical scan** (dHash within threshold) — a deliberate re-scan.
   *   Evict the stale entry and let the newer one through.
   * - **Different image** — the incoming card was mis-classified. Flip its
   *   side so it *pairs* with the held card instead of clobbering it. This is
   *   the mutation that forces `PoolCard` to be mutable.
   *
   * Without a working hasher the two cases are indistinguishable, so we fall
   * back to the pre-safety-net newer-wins behaviour.
   *
   * Only the first colliding card is considered, matching the source.
   */
  private resolveSameSideCollision(card: PoolCard): void {
    if (!hasIdentity(card)) {
      return;
    }

    for (const existing of this.cards.values()) {
      if (existing.side !== card.side) {
        continue;
      }
      if (existing.key === card.key) {
        continue;
      }
      if (!sameCardIdentity(card, existing)) {
        continue;
      }

      if (this.imagesAreSame(card, existing)) {
        this.cards.delete(existing.key);
      } else {
        card.side = oppositeSide(card.side);
      }
      return;
    }
  }

  /**
   * Compare two cards' images perceptually.
   *
   * Returns true when they look like the same physical scan. With no hasher,
   * or when hashing either side fails, conservatively returns true so
   * behaviour matches the legacy newer-wins logic rather than flipping a side
   * on no evidence.
   */
  private imagesAreSame(a: PoolCard, b: PoolCard): boolean {
    if (this.hashImage === null) {
      return true;
    }
    const ha = this.ensureHash(a);
    const hb = this.ensureHash(b);
    if (ha === null || hb === null) {
      return true;
    }
    return imagesLookIdentical(ha, hb);
  }

  /**
   * Lazily fetch and memoise a card's perceptual hash.
   *
   * Hashing is only ever reached on a same-side collision, so most cards in a
   * batch are never hashed at all. A throwing hasher, or one that hands back
   * a malformed hex string, degrades to null (newer-wins) — a hash failure
   * must never fail a batch.
   */
  private ensureHash(card: PoolCard): string | null {
    if (card.imageHash !== null) {
      return card.imageHash;
    }
    if (this.hashImage === null) {
      // Unreachable in practice — `imagesAreSame` short-circuits on a missing
      // hasher before ever getting here. Retained from the source as a guard
      // for any future caller of this helper.
      return null;
    }
    let value: string | null;
    try {
      value = this.hashImage(card.key);
    } catch {
      console.warn(`pairing: hashing failed for ${card.key}`);
      return null;
    }
    if (value !== null && !isDhashHex(value)) {
      // A hex-contract violation is a hasher bug, but it must degrade the
      // same way a hashing failure does rather than blowing up the batch.
      console.warn(
        `pairing: hasher returned a malformed hash for ${cardLabel(card)}; ignoring it`,
      );
      return null;
    }
    if (value !== null) {
      card.imageHash = value;
    }
    return value;
  }
}
