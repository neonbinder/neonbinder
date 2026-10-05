/**
 * The scoring card pool — port of script-frontend's `CardPool` class, via the
 * preprocess service's audited Python port (`app/pairing/pool.py`).
 *
 * `CardPool` is **internal to this package on purpose.** Its semantics are
 * incremental: cards are offered one at a time and a card that finds no
 * partner is held. `pairBatch` (in `pairBatch.ts`) owns the lifecycle: it
 * constructs a pool, feeds it, and returns. Callers outside this package
 * should use that.
 *
 * ## Pair first, then decide the sides (NEO-327)
 *
 * Two images pair because they are the same card — the identity scorer below
 * — and only then is the pair oriented by `orientPair`. The classifier's
 * front/back label is NOT a gate: it calls photo-heavy backs "front" (sets
 * whose backs carry a big player photo and the name), so a pool that only
 * paired opposite labels, and flipped a same-label arrival, made the side a
 * coin flip on upload order. Now:
 *
 * - any held card is a candidate, whatever its label;
 * - a candidate that `orientPair` cannot orient is a hard reject, which is
 *   the duplicate-copy guard (two fronts, or two backs, of the same card);
 * - arrival or entry order never decides which image is the front.
 *
 * Three behaviours in here are the result of production bugs and must not be
 * "simplified" back:
 *
 * 1. **Player disagreement is a hard reject, not a penalty.** It was a -1000
 *    score penalty until card numbers misread off fronts (jersey numbers,
 *    copyright years) coincidentally matched and outweighed it, pairing
 *    unrelated cards. Player name is the largest, cleanest text on a card;
 *    when both sides carry one and they disagree, no other signal may
 *    overrule it.
 *
 * 2. **Orientation is a hard reject, not a penalty.** Two images that cannot
 *    be told apart as a front and a back are not a pair, however well their
 *    identities agree — a duplicate copy agrees perfectly. Skipping it per
 *    candidate is what lets the true partner still win.
 *
 * 3. **A new image never silently overwrites a held one.** Only a deliberate
 *    re-scan (same identity AND the same picture) evicts. See
 *    `CardPool.evictRescan`.
 */

import { imagesLookIdentical, isDhashHex } from "./dhash";
import { playerNamesMatch, teamNamesMatch } from "./names";
import {
  CardSide,
  Confidence,
  ImageHasher,
  MatchResult,
  OrientRule,
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

// ── Orientation ──────────────────────────────────────────────────────────────

/**
 * Text-count orientation thresholds. Within a pair, the image with CLEARLY
 * more Vision text is the back: the back carries the card number, bio or
 * stats, copyright and fine print, while a front is mostly photo. "Clearly"
 * is both a ratio and an absolute gap, and BOTH must hold, so neither two
 * text-light images (13 vs 4: ratio 3.25, gap 9) nor two text-heavy ones
 * (142 vs 110: ratio 1.29, gap 32) are oriented by text — that is what a
 * duplicate copy looks like.
 *
 * Calibrated from Vision text counts on real scans, by true side
 * (min / p5 / median / p95 / max):
 *
 *   2014 Panini Rookies & Stars (photo backs)
 *     fronts   5 /   5 /   7 /  12 /  13
 *     backs  110 / 112 / 129 / 138 / 142
 *   1991 Throwback (stat backs)
 *     fronts   6–15
 *     backs  138–155
 *
 * Real front/back pairs: the smallest back÷front ratio was 9.7 and the
 * smallest gap 103. Two images of the SAME side: two fronts reached ratio 2.6
 * / gap 9, two backs ratio 1.29 / gap 32.
 *
 * So ratio 4 and gap 40 leave at least 2.4× headroom under every real pair
 * (9.7 / 4, 103 / 40) while blocking every observed same-side combination
 * (fronts fail the gap, backs fail both). A pair that lands below the band —
 * a text-light back, a text-heavy front — is not guessed at: it falls to the
 * label tie-break, and without disagreeing labels it is not a pair.
 */
export const TEXT_ORIENT_MIN_RATIO = 4;
export const TEXT_ORIENT_MIN_GAP = 40;

/** A card's label when a person set it, else null. */
function userLabel(card: PoolCard): CardSide | null {
  return card.labelByUser ? validLabel(card.label) : null;
}

/**
 * Narrow a label to a valid `CardSide`, or null. The type says it already is
 * one, but labels come from model responses and stored rows, so the runtime
 * check stays.
 */
function validLabel(label: unknown): CardSide | null {
  return label === "front" || label === "back" ? label : null;
}

/**
 * Decide which of two images is the front and which the back — or that they
 * are not a front/back pair at all. Symmetric: swapping `a` and `b` never
 * changes the answer, and nothing here reads arrival or entry order.
 *
 * In order:
 *
 * 0. **A person decided — the side they set wins.** Exactly one image carries
 *    a user-set label → that image is that side and the other is the
 *    opposite. Both user-set and disagreeing → the user labels. Both user-set
 *    and the SAME → null: the person said both show the same side, so no
 *    automatic evidence may turn them into a front/back pair.
 * 1. **Text.** The image with clearly more Vision text is the back — see
 *    `TEXT_ORIENT_MIN_RATIO` / `TEXT_ORIENT_MIN_GAP`.
 * 2. **Labels.** Text counts are close, but both images carry a label and
 *    the labels disagree → the labels.
 * 3. **Otherwise null.** Close text counts and no disagreeing labels is what
 *    two copies of the same side look like; pairing them would be a guess.
 */
export function orientPair(
  a: PoolCard,
  b: PoolCard,
): { front: PoolCard; back: PoolCard; rule: OrientRule } | null {
  // (0) user labels
  const userA = userLabel(a);
  const userB = userLabel(b);
  if (userA !== null && userB === null) {
    return userA === "front"
      ? { front: a, back: b, rule: "user" }
      : { front: b, back: a, rule: "user" };
  }
  if (userB !== null && userA === null) {
    return userB === "front"
      ? { front: b, back: a, rule: "user" }
      : { front: a, back: b, rule: "user" };
  }
  if (userA !== null && userB !== null) {
    if (userA === userB) {
      return null;
    }
    return userA === "front"
      ? { front: a, back: b, rule: "user" }
      : { front: b, back: a, rule: "user" };
  }

  // (1) text count
  const hi = Math.max(a.textCount, b.textCount);
  const lo = Math.min(a.textCount, b.textCount);
  if (hi >= lo * TEXT_ORIENT_MIN_RATIO && hi - lo >= TEXT_ORIENT_MIN_GAP) {
    return a.textCount > b.textCount
      ? { front: b, back: a, rule: "text" }
      : { front: a, back: b, rule: "text" };
  }

  // (2) classifier labels, only when they disagree
  const labelA = validLabel(a.label);
  const labelB = validLabel(b.label);
  if (labelA !== null && labelB !== null && labelA !== labelB) {
    return labelA === "front"
      ? { front: a, back: b, rule: "label" }
      : { front: b, back: a, rule: "label" };
  }

  // (3) not a front/back pair
  return null;
}

/**
 * Do these two cards describe the same physical card?
 *
 * Used only for re-scan detection, which is why it is looser than the
 * scorer: it wants "plausibly the same card", not "confidently pairable".
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

/**
 * Holds unpaired cards and matches each new arrival against them.
 *
 * Insertion order breaks exact score ties between candidates. The pool is
 * backed by a `Map`, whose iteration order is insertion order, and
 * `findMatch` improves its best candidate on a strict `>` starting from 0 —
 * so when two candidates score identically the **first one offered to the
 * pool wins**. A test pins it. Order never decides which image of a pair is
 * the front; `orientPair` does.
 */
export class CardPool {
  private readonly cards: Map<string, PoolCard> = new Map();
  private readonly hashImage: ImageHasher | null;

  /**
   * @param opts.hashImage optional perceptual-hash callback used only to
   *   recognise a deliberate re-scan (`evictRescan`). Without it no held card
   *   is ever evicted.
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
    // Runs first: a re-scan should evict the stale copy before the matcher
    // can pair the new image with it or with the stale copy's partner-to-be.
    this.evictRescan(card);

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
   * Find the best-scoring partner for `card` among every held card.
   *
   * Each held card is a candidate whatever its label. Hard rejects, in order:
   * a user split (`unpairedFrom`), an explicit player disagreement, and a
   * pair `orientPair` cannot orient. The survivors are scored and the best is
   * accepted if it clears `MATCH_ACCEPT_THRESHOLD`; its sides come from
   * `orientPair`, never from which card arrived first.
   *
   * Falls back to a side-only pairing when exactly one held card survives
   * the user-split and orientation rejects and neither card carries any
   * identity at all.
   */
  findMatch(card: PoolCard): MatchResult | null {
    let bestCandidate: PoolCard | null = null;
    let bestOrientation: ReturnType<typeof orientPair> = null;
    let bestScore = 0;

    // Tracked for the side-only fallback below: held cards this one could
    // form an oriented pair with, the user not having split them.
    let orientableCount = 0;
    let lastOrientable: PoolCard | null = null;
    let lastOrientation: ReturnType<typeof orientPair> = null;

    for (const existing of this.cards.values()) {
      // A re-offered key (a retried image) is not its own partner.
      if (existing.key === card.key) {
        continue;
      }

      // The user already separated these two. A hard reject, and for a
      // stronger reason than the player check below: no amount of identity
      // agreement should let the matcher overrule a person who looked at
      // both images and said no. Checked in both directions so the outcome
      // cannot depend on which card the pool happens to be holding.
      if (
        card.unpairedFrom.includes(existing.key) ||
        existing.unpairedFrom.includes(card.key)
      ) {
        continue;
      }

      // Not a front/back pair (two copies of the same side, as far as the
      // evidence can tell) — a hard reject per candidate, so a duplicate copy
      // is skipped and the true partner can still win. See `orientPair`.
      const orientation = orientPair(card, existing);
      if (orientation === null) {
        continue;
      }
      orientableCount += 1;
      lastOrientable = existing;
      lastOrientation = orientation;

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

      // Each image keeps the number it read, front or back, so a front that
      // really prints the number agrees here. A disagreement is NOT a penalty:
      // a front's read is often a jersey number.
      if (card.cardNumber && existing.cardNumber) {
        if (
          card.cardNumber.toLowerCase().trim() ===
          existing.cardNumber.toLowerCase().trim()
        ) {
          score += CARD_NUMBER_EXACT_SCORE;
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
        }
      }

      if (card.team && existing.team) {
        const tm = teamNamesMatch(card.team, existing.team);
        if (tm.match) {
          score += tm.exact ? TEAM_EXACT_SCORE : TEAM_FUZZY_SCORE;
        }
      }

      // Scan order — CORROBORATION ONLY, never grounds for a pairing, and
      // never a say in which image is the front.
      //
      // Gated on the identity signals having already scored something. On its
      // own the bonus equals MATCH_ACCEPT_THRESHOLD exactly, so an ungated
      // version would pair any two adjacent images with no identity at all.
      // Boosting a real match is the job; inventing one is not.
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
        bestOrientation = orientation;
      }
    }

    // Confidence is a band of the winning SCORE — see the `Confidence` doc
    // comment.
    const bestConfidence: Confidence =
      bestScore > EXACT_CONFIDENCE_THRESHOLD
        ? "exact"
        : bestScore > 0
          ? "fuzzy"
          : "side-only";

    if (
      bestCandidate !== null &&
      bestOrientation !== null &&
      bestScore >= MATCH_ACCEPT_THRESHOLD
    ) {
      return makeMatchResult(
        bestOrientation.front,
        bestOrientation.back,
        bestConfidence,
        "pool",
        bestScore,
        bestOrientation.rule,
      );
    }

    // Side-only fallback. Only safe when there is exactly one held card this
    // one could be oriented against AND neither card has any identity to
    // contradict the pairing — with two candidates and no identity we would
    // be guessing, and a card that *does* have identity failed to match for
    // a reason worth respecting.
    if (
      orientableCount === 1 &&
      lastOrientable !== null &&
      lastOrientation !== null &&
      !hasIdentity(card) &&
      !hasIdentity(lastOrientable)
    ) {
      return makeMatchResult(
        lastOrientation.front,
        lastOrientation.back,
        "side-only",
        "pool",
        0,
        lastOrientation.rule,
      );
    }

    return null;
  }

  /**
   * Evict any held card the incoming one is a deliberate re-scan of.
   *
   * A re-scan is the same card (`sameCardIdentity`) AND the same picture (the
   * perceptual hashes are within `SAME_IMAGE_THRESHOLD`). The held copy is
   * stale, so it goes and the new one carries on to the matcher.
   *
   * Anything short of that is left alone: the same card with a different
   * picture is its other side, or a second copy, and `findMatch` /
   * `orientPair` decide which. Labels are not consulted — they are not
   * trusted to say which side an image shows. Without a hasher, or when
   * either image cannot be hashed, nothing is evicted: a re-scan cannot be
   * told from a different image, and dropping an image on no evidence would
   * lose it.
   */
  private evictRescan(card: PoolCard): void {
    if (this.hashImage === null || !hasIdentity(card)) {
      return;
    }

    for (const existing of [...this.cards.values()]) {
      if (existing.key === card.key) {
        continue;
      }
      if (!sameCardIdentity(card, existing)) {
        continue;
      }
      const incomingHash = this.ensureHash(card);
      if (incomingHash === null) {
        return;
      }
      const heldHash = this.ensureHash(existing);
      if (heldHash !== null && imagesLookIdentical(incomingHash, heldHash)) {
        this.cards.delete(existing.key);
      }
    }
  }

  /**
   * Lazily fetch and memoise a card's perceptual hash.
   *
   * Hashing is only ever reached when a new image shares an identity with a
   * held one, so most cards in a batch are never hashed at all. A throwing
   * hasher, or one that hands back a malformed hex string, degrades to null
   * (no eviction) — a hash failure must never fail a batch.
   */
  private ensureHash(card: PoolCard): string | null {
    if (card.imageHash !== null) {
      return card.imageHash;
    }
    if (this.hashImage === null) {
      // Unreachable in practice — `evictRescan` returns early on a missing
      // hasher before ever getting here. Retained as a guard for any future
      // caller of this helper.
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
