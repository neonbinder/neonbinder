/**
 * Front/back pairing pass — the last stage of a placeholder batch (NEO-170).
 *
 * Runs in the DEFAULT runtime, not Node. `pairBatch` is a pure TypeScript port
 * of the algorithm that used to live in services/preprocess/app/pairing/; it
 * touches no Node APIs, and keeping it out of the Node runtime means this
 * action starts without the Node cold-start penalty on every batch.
 *
 * The interesting property of this stage is that it costs nothing. In the
 * Python original, `resolveIdentity` was a Haiku call and was the expensive
 * part of the whole pipeline — the adjacency pre-pass existed specifically to
 * avoid paying it. Here the identity was already produced by `/process-entry`
 * and is sitting on the placeholderImages row, so `resolveIdentity` is a
 * dictionary lookup. `resolverCalls` therefore stops being a spend metric and
 * becomes pure diagnostics: it tells us how often adjacency failed to settle a
 * pair, which is the signal for whether scan order is being preserved.
 *
 * ## Why this runs many times per batch
 *
 * Because pairing is free, it does not have to wait for the batch to finish.
 * `runPairing` is scheduled after image completions (debounced through
 * `placeholderJobs.pairingScheduled`) as well as at the end, so a pair reaches
 * the client's `listPlaceholderPairs` subscription the moment both of its halves
 * have been processed rather than minutes later when the last unrelated image
 * lands. That is what makes a 200-card scanner session feel live.
 *
 * Two properties make repeated runs safe, and both are worth stating plainly:
 *
 *  - **Every run is a full recomputation, and the writes are a DIFF.** The
 *    action recomputes `pairBatch` over all done rows in entry-index order —
 *    never an "add just this pair" shortcut — then compares the result against
 *    what is stored, keyed on (frontIndex, backIndex), and writes only the
 *    difference. Pairs that did not change are not touched, so a subscribed
 *    client re-renders on real changes only. This matters beyond flicker: the
 *    pool's matcher can legitimately revise an earlier decision when a better
 *    candidate arrives, and a diff expresses that as one pair leaving and
 *    another arriving, where an append-only writer would accumulate both.
 *  - **Only the FINAL run decides the batch's fate.** `final: false` runs write
 *    pairs and nothing else — no status transition, no `markJobFailed`, and a
 *    throw is logged rather than failing the job. Everything about the terminal
 *    decision below is exactly as it was when this ran once per batch.
 *
 * Together those give the convergence property the design rests on: the state
 * after the final run is the state a single end-of-batch run would have
 * produced, no matter how many provisional runs preceded it.
 */

import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { pairBatch } from "./lib/pairing/pairBatch";
import { playerNamesMatch, teamNamesMatch } from "./lib/pairing/names";
import type { CardSide, Confidence, Mechanism, PoolCard } from "./lib/pairing/types";
import {
  INCREMENTAL_PAIRING_STATUSES,
  MAX_FIELD_CHARS,
  MAX_PLAYERS,
  findJob,
  findOwnedJob,
  markJobFailedImpl,
  markJobSucceededImpl,
  requireUserId,
} from "./placeholderPipeline";

/**
 * Statuses on which a `force` re-pair (a manual correction) is allowed to run.
 *
 * A superset of the incremental statuses: it adds "pairing" (a run already in
 * flight — the debounce/convergence handles the overlap) and the terminal
 * "succeeded"/"failed" (the correction phase, where the user is fixing a
 * finished batch). It deliberately EXCLUDES pending/uploaded/extracting — a job
 * with no meaningful done rows, or one mid-restart, where a re-pair would fight
 * the restart's sweep.
 */
const REPAIR_ALLOWED_STATUSES = new Set([
  "collecting",
  "processing",
  "pairing",
  "succeeded",
  "failed",
]);

/** Rows written per applyPairDiff / syncImagePairStatus invocation. */
const PAIR_CHUNK_SIZE = 50;

const CONFIDENCES: readonly string[] = ["exact", "fuzzy", "side-only"];
const MECHANISMS: readonly string[] = ["adjacency", "pool"];

/**
 * Coerce pairBatch's `confidence` / `mechanism` into the schema's unions.
 *
 * These are already typed as literal unions in the pairing module, so the
 * checks are belt-and-braces — but they guard a real failure mode: an
 * unrecognized literal would be rejected by the table's validator at INSERT
 * time, i.e. after the batch has done all its work, and would fail the whole
 * chunk rather than one pair. Degrading to the weakest honest value keeps a
 * vocabulary change from destroying an otherwise-good batch.
 */
function asConfidence(value: unknown): Confidence {
  return typeof value === "string" && CONFIDENCES.includes(value)
    ? (value as Confidence)
    : "side-only";
}

function asMechanism(value: unknown): Mechanism {
  return typeof value === "string" && MECHANISMS.includes(value)
    ? (value as Mechanism)
    : "pool";
}

/** null → undefined, and anything non-string → undefined. */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Narrow the stored `side` column to the pairing module's `CardSide`.
 *
 * The column is a plain string because the vocabulary belongs to the
 * preprocess service's classifier, not to us. Anything outside {front, back}
 * becomes null, which pairing reads as "no side evidence" and answers with the
 * text-count heuristic — the same degradation it applies when the classifier
 * was never run. Coercing an unknown value to "front" instead would be an
 * invented fact.
 */
function asCardSide(value: unknown): CardSide | null {
  return value === "front" || value === "back" ? value : null;
}

/**
 * One pair the current run wants to exist, in the shape the diff compares and
 * the shape `applyPairDiff` inserts.
 *
 * `frontImageId` / `backImageId` are carried alongside the indexes but are NOT
 * stored: they are how the `pairStatus` half of the diff addresses the image
 * rows (see the note on `applyPairDiff` about why writes go by id).
 */
type DesiredPair = {
  frontImageId: Id<"placeholderImages">;
  backImageId: Id<"placeholderImages">;
  frontIndex: number;
  backIndex: number;
  player?: string;
  team?: string;
  cardNumber?: string;
  confidence: Confidence;
  mechanism: Mechanism;
  score: number;
};

/** A revision to an existing pair row — everything except its identity. */
type PairPatch = {
  pairId: Id<"placeholderPairs">;
  player?: string;
  team?: string;
  cardNumber?: string;
  confidence: Confidence;
  mechanism: Mechanism;
  score: number;
};

/**
 * The identity of a pair row, as a map key.
 *
 * (frontIndex, backIndex) and not the document id, because the document id is
 * what the diff is trying to LOOK UP: a run has just recomputed pairs from
 * scratch and needs to know which stored row, if any, is the same pair. Entry
 * indexes are unique within a job and stable across runs, so the same physical
 * card produces the same key every time; the id only exists once the row does.
 *
 * The two halves are joined with a character that cannot appear in a decimal
 * integer, so `(1, 23)` and `(12, 3)` cannot collide.
 */
function pairKey(frontIndex: number, backIndex: number): string {
  return `${frontIndex}:${backIndex}`;
}

/** Just the identity fields of a done image row, as the backfill reads them. */
type PairingRowIdentity = {
  players?: string[];
  team?: string;
  cardNumber?: string;
};

/**
 * The pair's descriptive identity: the algorithm's answer, falling back to the
 * two rows' own identity where the algorithm left a gap.
 *
 * **This is a deliberate, wrapper-level deviation from the ported algorithm, and
 * it lives here rather than in convex/lib/pairing on purpose.** The port stays
 * verbatim — it is an audited translation of code that has been right in
 * production for years, and the value of that is precisely that it has not been
 * "improved" in translation.
 *
 * What it deviates from: an adjacency-matched pair comes back with
 * `player/team/cardNumber` all null. That is not a bug in the port, it is the
 * whole point of the pre-pass — `adjacencyCard` builds its cards with
 * `identityResolved: false` and never calls the resolver, because in the
 * original the resolver was a Haiku call and avoiding it was the entire saving.
 * Null there honestly means "never asked", not "asked and found nothing".
 *
 * Why we can do better HERE: in this pipeline the identity is not behind a model
 * call at all. `/process-entry` already extracted it and it is sitting on the
 * placeholderImages row we just read. So the pre-pass's reason for not knowing
 * does not apply to us — we are not paying to look, we are declining to read a
 * field we already have. A live run showed the cost of that: pairs whose two
 * rows carried a full, matching identity were stored with `player: null`,
 * leaving the review UI unable to label a card it could perfectly well name.
 *
 * The merge follows the same asymmetry as `makeMatchResult` (and the cardlister
 * priors before it), for the same reasons:
 *   - **player and team prefer the FRONT.** Fronts print them large, in a
 *     display face, against a clean background — the most reliable read.
 *   - **cardNumber comes from the BACK only, with no fall back to the front.**
 *     Card numbers are printed on backs; what a model reads as one on a front is
 *     a jersey number, a copyright year or a subset code. Two other places
 *     deliberately discard a front's card number (`poolCardFromIdentity` drops
 *     it, `makeMatchResult` reads only the back's), so falling back to it here
 *     would re-import exactly the value the rest of the design throws away.
 *
 * Only the DESCRIPTIVE fields are touched. `confidence`, `mechanism` and `score`
 * are left exactly as the algorithm reported them — see the call site.
 */
export function mergedRowIdentity(
  match: { player?: unknown; team?: unknown; cardNumber?: unknown },
  front: PairingRowIdentity,
  back: PairingRowIdentity,
): { player?: string; team?: string; cardNumber?: string } {
  return {
    player:
      optionalString(match.player) ??
      optionalString(front.players?.[0]) ??
      optionalString(back.players?.[0]),
    team: optionalString(match.team) ?? optionalString(front.team) ?? optionalString(back.team),
    cardNumber: optionalString(match.cardNumber) ?? optionalString(back.cardNumber),
  };
}

/**
 * Do these two cards carry POSITIVE evidence that they are different cards?
 *
 * The guard on the scan-order fallback, and the reason the fallback can be
 * trusted at all. Two cards contradict when both name the SAME field and the two
 * values disagree — a known player against a different known player, or a known
 * team against a different known team. A field that is missing on either side is
 * not evidence of anything and never contradicts.
 *
 * Player and team, because the user's directive names exactly those: "name and
 * team should have precedency over adjacency". Card number is deliberately not
 * consulted here — a front's number is discarded upstream
 * (`poolCardFromIdentity` keeps it only for backs), so on a front↔back pair only
 * one side ever has one, and "one side missing" is not a contradiction anyway.
 *
 * This is the "NEVER override or contradict an identity signal" half of the
 * fallback: adjacency may pair two cards whose identities are silent, but it may
 * not pair two the identity evidence has already told us apart.
 */
export function identitiesContradict(a: PoolCard, b: PoolCard): boolean {
  if (a.player && b.player && !playerNamesMatch(a.player, b.player).match) return true;
  if (a.team && b.team && !teamNamesMatch(a.team, b.team).match) return true;
  return false;
}

/**
 * The scan-order fallback: pair the identity pass's LEFTOVERS by adjacency, but
 * only where nothing contradicts.
 *
 * This is the demoted role adjacency now plays. The identity pool has already
 * run over every card (see the call site — `useAdjacency: false`), so everything
 * here is a card the identity evidence could not place: an unreadable scan, a
 * card whose partner failed to process, a stray. For those — and ONLY for
 * those — file order is a weak tiebreaker, exactly as the user framed it: "We
 * could use file numbers to strengthen our decision about matching if we haven't
 * found matches but we cannot assume it to be true."
 *
 * The walk is the ported `planAdjacency`'s shape — advance by two on a pair, by
 * one on a miss so a single stray at the head does not desynchronise the rest —
 * over the leftovers in scan (entry-index) order, with two conditions per
 * neighbour pair:
 *
 *   - **opposite sides.** Both PoolCards always carry a side (the pool resolves
 *     one from the classifier or the text-count heuristic), so this is the same
 *     front/back-disagreement signal the original pre-pass used.
 *   - **no contradiction** (`identitiesContradict`). This is the whole
 *     correction: the old pre-pass paired on side disagreement ALONE, which is
 *     how a Gray front next to a Hosmer back got matched before identity could
 *     place them. Here two neighbours whose identities disagree are left for the
 *     "unmatched" bucket rather than forced together.
 *
 * "Neighbours" means consecutive among the leftovers in scan order, not
 * consecutive by raw entry index — a card the identity pass already claimed is
 * gone, and the cards on either side of it are as adjacent as anything gets once
 * it is removed. Every pair this produces is labelled the weakest honest thing
 * (`side-only`, mechanism `adjacency`, score 0) at the call site, because file
 * proximity is exactly that weak.
 *
 * Note that the pool's OWN side-only fallback already pairs an unambiguous lone
 * identity-less opposite pair (see `CardPool.findMatch`), so those never reach
 * here; this handles the case the pool defers on — two or more same-side
 * leftovers where a single opposite card cannot be assigned without a tiebreak.
 */
export function guardedAdjacencyFallback(leftovers: PoolCard[]): Array<[PoolCard, PoolCard]> {
  const sorted = [...leftovers].sort((a, b) => Number(a.key) - Number(b.key));
  const pairs: Array<[PoolCard, PoolCard]> = [];

  let index = 0;
  while (index < sorted.length - 1) {
    const first = sorted[index];
    const second = sorted[index + 1];
    if (first.side !== second.side && !identitiesContradict(first, second)) {
      pairs.push([first, second]);
      index += 2;
      continue;
    }
    index += 1;
  }

  return pairs;
}

/**
 * The `listDoneImagesForPairing` row shape — one done image, as the pairing pass
 * reads it. Declared here so `computePairingDiff` and both of its callers (the
 * scheduled action and the inline close-path finalize) share ONE definition and
 * cannot drift.
 */
export type PairingImageRow = {
  _id: Id<"placeholderImages">;
  entryIndex: number;
  originalName: string;
  players?: string[];
  team?: string;
  cardNumber?: string;
  side?: string;
  textCount?: number;
  dhash?: string;
  pairStatus?: "paired" | "unmatched";
};

/** The `listPairsForDiff` row shape — one stored pair, as the diff compares it. */
export type StoredPairRow = {
  _id: Id<"placeholderPairs">;
  frontIndex: number;
  backIndex: number;
  player?: string;
  team?: string;
  cardNumber?: string;
  confidence: Confidence;
  // Includes "manual": the diff reads the mechanism to tell manual (sticky) pairs
  // from automatic ones.
  mechanism: "adjacency" | "pool" | "manual";
  score: number;
};

/** One new pair in the shape `applyPairDiff` inserts — carries NO image ids. */
export type PairInsertRow = {
  frontIndex: number;
  backIndex: number;
  player?: string;
  team?: string;
  cardNumber?: string;
  confidence: Confidence;
  mechanism: Mechanism;
  score: number;
};

/**
 * The complete result of one pairing recomputation, as data: the pair-row diff
 * (delete / patch / insert), the image `pairStatus` diff (becomingPaired /
 * becomingUnmatched), and the resolver-call count. The scheduled action and the
 * inline finalize apply this identically.
 */
export type PairingDiff = {
  resolverCalls: number;
  deleteIds: Id<"placeholderPairs">[];
  patches: PairPatch[];
  insertRows: PairInsertRow[];
  becomingPaired: Id<"placeholderImages">[];
  becomingUnmatched: Id<"placeholderImages">[];
};

/**
 * Recompute a batch's pairing from the done rows and the stored pairs, returning
 * the writes as data. This is the PURE heart of a pairing pass — everything
 * between reading the rows and writing them: manual-pair stickiness, the
 * identity-first `pairBatch`, the guarded adjacency fallback, the front-preferred
 * identity merge, and both the pair-row and image-status diffs.
 *
 * Extracted verbatim from `runPairing` (NEO-175) so the inline finalize on the
 * close path (`finalizePairingInline`) produces byte-identical pairs,
 * `resolverCalls` and `pairStatus` without a scheduler hop. It touches no `ctx`
 * and no job status — those stay with the two callers that APPLY the diff.
 */
/**
 * Is this pair final — locked out of this automatic run?
 *
 * The single definition of the lock, used by the diff that enforces it AND by
 * the log counters that describe it. They were two expressions of the same rule
 * once, and the log drifted the moment the rule grew a second clause.
 *
 *  - `manual`  the user forced it. Their decision outranks the matcher's,
 *              unconditionally.
 *  - `exact`   the identities agreed outright — a certainty, not a guess —
 *              AND both halves are still done rows (see below).
 *
 * Everything else (`fuzzy`, `side-only`) stays fluid and is surfaced to the
 * user as a POTENTIAL match, because those are exactly the ones a later image
 * can legitimately improve.
 */
export function isLockedPair(
  pair: {
    mechanism: string;
    confidence: string;
    frontIndex: number;
    backIndex: number;
  },
  doneIndexes: ReadonlySet<number>,
): boolean {
  // A user's decision outranks the matcher unconditionally.
  if (pair.mechanism === "manual") return true;
  if (pair.confidence !== "exact") return false;

  // LIVENESS, and it is load-bearing. An exact pair is only locked while BOTH
  // halves are still done rows. Without this a STALE exact pair — one whose
  // partner was reset to "queued" by a restart, so it is no longer in `rows` —
  // would be locked out of the diff and could never be deleted, leaving a pair
  // pointing at an image that is not processed. The existing
  // "a stored AUTO pair no longer desired is deleted" test caught exactly that.
  return doneIndexes.has(pair.frontIndex) && doneIndexes.has(pair.backIndex);
}

export function computePairingDiff(
  rows: PairingImageRow[],
  stored: StoredPairRow[],
): PairingDiff {
  // ---- Settled pairs are STICKY (NEO-152) ---------------------------
  //
  // A pair is SETTLED when it is either manually forced by the user, or matched
  // at "exact" confidence — the identity on both halves agreed outright. Both
  // are locked; everything softer stays fluid.
  //
  // Three properties, all enforced here, together:
  //   (b) never re-pair a settled image → its index is removed from the
  //       pairBatch input (`autoRows`), so the automatic matcher never even
  //       sees it;
  //   (a) never delete or overwrite a settled pair row → the diff below
  //       compares only against `unsettledStored`, so a settled row is never a
  //       "removed" candidate and never patched;
  //   (c) still re-pair everything else freely → every unsettled image and
  //       pair flows through exactly as before.
  // The image's partner is likewise excluded, which is what frees the OTHER
  // images (a taken front's identity twin is now available to pair with its
  // real partner).
  //
  // ## Why "exact" joined "manual" here
  // Pairing recomputes the WHOLE batch after every image completion, and the
  // pool was free to revise an earlier decision when a later candidate scored
  // better. That is defensible for a guess and indefensible for a certainty:
  // it meant a pair the user had already seen settle could silently come apart
  // and re-form differently several images later, which reads as the tool
  // changing its mind about work it had finished. Locking "exact" makes a
  // confident match final, and leaves "fuzzy" / "side-only" — the ones the UI
  // surfaces as POTENTIAL matches — free to improve as more of the batch
  // arrives, which is exactly where revision earns its keep.
  //
  // Known consequence, accepted: two copies of the SAME card in one batch have
  // identical identities, so their four images can settle as front-A/back-B and
  // front-B/back-A. Both pairs are still that card, so the printed placeholder
  // is right either way — but the lock does mean that arrangement is now final.
  const doneIndexes = new Set(rows.map((r) => r.entryIndex));
  const settledIndexes = new Set<number>();
  for (const pair of stored) {
    if (!isLockedPair(pair, doneIndexes)) continue;
    settledIndexes.add(pair.frontIndex);
    settledIndexes.add(pair.backIndex);
  }
  const autoRows = rows.filter((r) => !settledIndexes.has(r.entryIndex));
  const autoStored = stored.filter((p) => !isLockedPair(p, doneIndexes));

  // Key by zip index. It is stable, unique within the batch, and — unlike
  // the original filename — cannot collide, which matters because the pool
  // uses the key as a dictionary key. The VALUE carries `_id`, which is
  // what the write-back is keyed on; see the note on
  // `listDoneImagesForPairing`. Manually-paired rows are excluded.
  const byKey = new Map(autoRows.map((r) => [String(r.entryIndex), r] as const));

  // The desired state, recomputed from scratch every run. `pairBatch` is a
  // pure function of the done rows in entry-index order, so two runs over
  // the same rows produce the same answer — which is what lets the writes
  // below be a diff rather than a rebuild.
  const desired: DesiredPair[] = [];
  const pairedIds = new Set<string>();
  let resolverCalls = 0;

  if (autoRows.length > 0) {
    const result = pairBatch(
      autoRows.map((r) => ({
        key: String(r.entryIndex),
        textCount: r.textCount ?? 0,
        originalFilename: r.originalName,
        side: asCardSide(r.side),
      })),
      {
        // Already-resolved identity, straight off the row — see the module
        // comment. Returning null for a key we do not have lets pairing
        // degrade to the text-count side heuristic instead of throwing.
        resolveIdentity: (key: string) => {
          const row = byKey.get(key);
          if (!row) return null;
          return {
            // `players` is the canonical list. `player` is derived from it
            // here rather than read from a column, because the row has no
            // such column — the service computes its `player` field as
            // `players[0]` and a stored copy could only go stale.
            // CardIdentity is an interface and cannot derive one from the
            // other, so both are supplied.
            players: row.players ?? [],
            player: row.players?.[0] ?? null,
            team: row.team ?? null,
            cardNumber: row.cardNumber ?? null,
            side: asCardSide(row.side),
          };
        },
        // The perceptual hash `/process-entry` already computed. Null when
        // the service could not produce one (or produced a malformed one —
        // see `asDhash` in placeholderPipeline.ts); pairing treats that as
        // "cannot compare these two images" rather than "they differ".
        hashImage: (key: string) => byKey.get(key)?.dhash ?? null,
        // IDENTITY FIRST. `false` turns off the ported adjacency PRE-pass, so
        // every card goes through the identity pool and front↔back are
        // matched by who is on the card, not by who was scanned next to whom.
        //
        // This inverts the cardlister precedence on purpose, and the reason
        // is that the cardlister precedence was an answer to a cost that no
        // longer exists. There, `resolveIdentity` was a Haiku call, so the
        // pre-pass paired confident neighbours FIRST precisely to avoid
        // paying for it. Here identity is already on the row (it is a
        // dictionary lookup — see the module comment), so there is no cost to
        // avoid and a real correctness price to pay: the pre-pass matched on
        // side-disagreement ALONE, which paired a Sonny Gray front next to an
        // Eric Hosmer back — opposite sides, so it grabbed them — before the
        // pool could pair each with its own partner. Any dropped or reordered
        // side cascaded into mispairs.
        //
        // Scan order is not discarded, only demoted: `guardedAdjacencyFallback`
        // below applies it to whatever identity could not place, and only
        // between neighbours nothing contradicts.
        useAdjacency: false,
      },
    );

    resolverCalls = result.resolverCalls;
    for (const match of result.matches) {
      const front =
        typeof match.front?.key === "string" ? byKey.get(match.front.key) : undefined;
      const back =
        typeof match.back?.key === "string" ? byKey.get(match.back.key) : undefined;
      // A match whose keys don't resolve back to rows we read is unusable —
      // dropping it leaves both images "unmatched", which is accurate,
      // rather than writing a pair row pointing at images that don't exist.
      if (!front || !back) continue;
      pairedIds.add(front._id);
      pairedIds.add(back._id);
      desired.push({
        frontImageId: front._id,
        backImageId: back._id,
        frontIndex: front.entryIndex,
        backIndex: back.entryIndex,
        // Identity, with a WRAPPER-LEVEL backfill — see `mergedRowIdentity`.
        // The algorithm's answer always wins; the rows only fill a gap it
        // left, which in practice means adjacency pairs.
        ...mergedRowIdentity(match, front, back),
        // Deliberately NOT backfilled. These three describe HOW the match
        // was made, and an adjacency pair genuinely was made from side
        // evidence alone with a score of 0 — "side-only" is the honest
        // account of the evidence even when the two rows happen to agree on
        // a player. Enriching them would turn a description of the method
        // into a claim about confidence that nothing actually checked.
        confidence: asConfidence(match.confidence),
        mechanism: asMechanism(match.mechanism),
        score: typeof match.score === "number" ? match.score : 0,
      });
    }

    // ---- Scan-order fallback over the identity pass's leftovers --------
    //
    // Everything the identity pool could not place, paired by adjacency
    // where nothing contradicts — see `guardedAdjacencyFallback`. These are
    // the WEAKEST pairs the batch produces, and they are labelled as such:
    // mechanism "adjacency", confidence "side-only", score 0, exactly the
    // shape the /placeholders review page renders as "front/back only · by
    // scan order". Identity pairs above keep their real pool confidence.
    for (const [a, b] of guardedAdjacencyFallback(result.unmatched)) {
      const front = byKey.get(a.side === "front" ? a.key : b.key);
      const back = byKey.get(a.side === "front" ? b.key : a.key);
      // A leftover key that no longer resolves to a row is dropped, same as
      // an identity match above — leaving both images unmatched is accurate.
      if (!front || !back) continue;
      pairedIds.add(front._id);
      pairedIds.add(back._id);
      desired.push({
        frontImageId: front._id,
        backImageId: back._id,
        frontIndex: front.entryIndex,
        backIndex: back.entryIndex,
        // No algorithm identity to keep — an adjacency fallback pair was
        // made without consulting one — so the label comes entirely from the
        // rows, front-preferred for player/team and back-only for the card
        // number (the same asymmetry `mergedRowIdentity` documents).
        ...mergedRowIdentity({ player: null, team: null, cardNumber: null }, front, back),
        confidence: "side-only",
        mechanism: "adjacency",
        score: 0,
      });
    }
  }

  // ---- Diff the desired state against the AUTOMATIC stored pairs -----
  //
  // Against `autoStored`, NOT `stored`: manual pairs are excluded so the diff
  // can neither delete nor overwrite them. This is the load-bearing half of
  // "manual pairs survive an automatic re-run" — a manual row is never in
  // `desired` (its images were excluded from pairBatch) and never in the
  // set the delete/patch computation walks, so nothing here can touch it.
  //
  // Otherwise unchanged: runs on every pass, including the first (empty
  // `autoStored` → insert everything) and a pass over zero auto rows (every
  // auto pair is stale and goes). One code path, no special cases.
  const storedByKey = new Map(
    autoStored.map((p) => [pairKey(p.frontIndex, p.backIndex), p]),
  );

  const inserts: DesiredPair[] = [];
  const patches: PairPatch[] = [];
  const desiredKeys = new Set<string>();
  for (const pair of desired) {
    const key = pairKey(pair.frontIndex, pair.backIndex);
    desiredKeys.add(key);
    const current = storedByKey.get(key);
    if (!current) {
      inserts.push(pair);
    } else if (
      // Identity of a pair row is (frontIndex, backIndex); everything else
      // is revisable. An untouched row is the common case by far — most
      // pairs are settled by the first run that sees both halves — and NOT
      // writing it is the point: a patch is a change the client's
      // subscription re-renders on.
      current.player !== pair.player ||
      current.team !== pair.team ||
      current.cardNumber !== pair.cardNumber ||
      current.confidence !== pair.confidence ||
      current.mechanism !== pair.mechanism ||
      current.score !== pair.score
    ) {
      patches.push({
        pairId: current._id,
        player: pair.player,
        team: pair.team,
        cardNumber: pair.cardNumber,
        confidence: pair.confidence,
        mechanism: pair.mechanism,
        score: pair.score,
      });
    }
  }
  // From `autoStored`, so a manual pair is NEVER a delete candidate — the
  // single point that makes manual pairs survive the diff. (Mutation-tested:
  // switching this to `stored` deletes manual pairs on the next auto-run.)
  const deleteIds = autoStored
    .filter((p) => !desiredKeys.has(pairKey(p.frontIndex, p.backIndex)))
    .map((p) => p._id);

  // `frontImageId` / `backImageId` are dropped on the way in: they address
  // the IMAGE rows for the pairStatus half of the diff and are not columns
  // on a pair row, which stores entry indexes (see `applyPairDiff`).
  const insertRows: PairInsertRow[] = inserts.map((pair) => ({
    frontIndex: pair.frontIndex,
    backIndex: pair.backIndex,
    player: pair.player,
    team: pair.team,
    cardNumber: pair.cardNumber,
    confidence: pair.confidence,
    mechanism: pair.mechanism,
    score: pair.score,
  }));

  // The same diff, applied to `placeholderImages.pairStatus`. Derived from
  // what was actually PAIRED above rather than from `result.unmatched`: a
  // match dropped for an unresolvable key must end up marked unmatched, and
  // reading the paired set back is the only way that stays true. Rows whose
  // verdict is unchanged are excluded here rather than inside the mutation
  // so an unchanged batch costs zero mutations, not one per chunk.
  const becomingPaired: Array<Id<"placeholderImages">> = [];
  const becomingUnmatched: Array<Id<"placeholderImages">> = [];
  // Over `autoRows`, not `rows`: a manually-paired image is excluded, so its
  // "paired" status set by `manuallyPairPlaceholderImages` is left untouched
  // rather than being reset to "unmatched" (it is not in `pairedIds`).
  for (const row of autoRows) {
    const want = pairedIds.has(row._id) ? "paired" : "unmatched";
    if (row.pairStatus === want) continue;
    (want === "paired" ? becomingPaired : becomingUnmatched).push(row._id);
  }

  return {
    resolverCalls,
    deleteIds,
    patches,
    insertRows,
    becomingPaired,
    becomingUnmatched,
  };
}

/**
 * Pair up a batch and — on the final run only — set its terminal status.
 *
 * The terminal decision is made here rather than at the end of processing
 * because "did this batch work?" is a question about the batch as a whole, and
 * the answer is not simply "did every image succeed". A print sheet with one
 * unreadable scan is a good batch; one where most images failed is not,
 * regardless of whether the failures were individually retryable.
 *
 * `final` defaults to TRUE, so every caller that predates incremental pairing
 * keeps its meaning without being touched: the last-one-done transition in
 * `recordImageOutcomeImpl`, the no-usable-images hand-off in
 * `pruneUnregisteredImages`, and `closePlaceholderStream` all schedule the run
 * that ends the batch. Only the debounced completion hook passes `false`, and
 * that run is purely additive — it writes pairs and returns.
 *
 * The whole body is wrapped in a try/catch that ends in `markJobFailed`,
 * because a FINAL run is the LAST link in the chain: "pairing" is not a
 * terminal status, nothing is scheduled behind this action, and Convex does
 * not retry a scheduled action that throws. Any escape — a pairing bug on a
 * pathological batch, an OCC conflict on a chunk mutation, a validator
 * rejection — would leave the job stuck in "pairing" with no writer left
 * alive to move it, which reads to the user as a spinner that never stops.
 * Failing the job is worse than succeeding and better than hanging: "failed"
 * is startable, so the user has a way forward, and a restart keeps every image
 * that already processed.
 *
 * A PROVISIONAL run must not do that. It is not the last link — more
 * completions are coming, and the final run will recompute everything from
 * scratch — so killing a healthy batch because one intermediate pass hit an OCC
 * conflict would be the cure causing the disease. It logs and returns.
 */
export const runPairing = internalAction({
  args: {
    jobId: v.string(),
    userId: v.string(),
    /**
     * Absent means final. See the note above on why the default is this way
     * round rather than the safer-looking `final: v.boolean()`.
     */
    final: v.optional(v.boolean()),
    /**
     * A DELIBERATE re-pair request (NEO-152) — the manual-correction mutations
     * schedule `{final: false, force: true}` so a user's identity edit re-pairs
     * even a job that has already SUCCEEDED. Without it the incremental guard
     * below would skip the run (a succeeded job is not an incremental status),
     * and the whole point of "fix the front's name → it auto-pairs" would only
     * work mid-batch. `force` bypasses that guard on already-processed statuses
     * WITHOUT making the terminal decision, so a re-pair can never un-succeed a
     * good batch (only a `final` run touches the terminal status).
     */
    force: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const final = args.final ?? true;
    try {
      // FIRST, before anything is read. Clearing the debounce latch up front is
      // what makes the sequence converge: a completion landing while this run is
      // still working finds the latch clear, sets it, and schedules a successor
      // that will see the row this run missed. Clearing it at the END would let
      // that completion find the latch still set, schedule nothing, and leave
      // its image unpaired until the final run — which is the whole bug the
      // ordering exists to prevent.
      await ctx.runMutation(internal.placeholderPairing.clearPairingScheduled, {
        jobId: args.jobId,
      });

      const job = await ctx.runQuery(internal.placeholderPipeline.getJobInternal, {
        jobId: args.jobId,
      });
      if (!job) return null;

      // A provisional run is scheduled and then arrives some time later, by
      // which point the job may have been canceled, restarted, or closed and
      // handed to its final run. Writing pairs into any of those would be a
      // stale writer fighting the live one. The final run has no equivalent
      // guard, and must not grow one: it is the only thing that can move a job
      // out of "pairing", so refusing to act on an unexpected status is exactly
      // how a batch gets stuck.
      //
      // A `force` re-pair (a manual correction) additionally runs on a job that
      // has finished pairing or reached a terminal status — but NOT on one that
      // is still pre-processing or mid-restart (pending/uploaded/extracting),
      // where there are no meaningful done rows and a diff would fight the
      // restart. It never runs the terminal decision (it is not `final`), so it
      // cannot un-succeed a batch.
      const canRun =
        final ||
        INCREMENTAL_PAIRING_STATUSES.has(job.status) ||
        (args.force && REPAIR_ALLOWED_STATUSES.has(job.status));
      if (!canRun) return null;

      const rows = await ctx.runQuery(
        internal.placeholderPipeline.listDoneImagesForPairing,
        { jobId: args.jobId },
      );

      // Read the stored pairs UP FRONT (before pairing), because they carry the
      // manual pairs, and manual pairing changes what the automatic pass even
      // operates on. `stored` here is the authoritative source of "what is
      // manual" — there is no separate flag on the image row to drift from it.
      const stored = await ctx.runQuery(internal.placeholderPairing.listPairsForDiff, {
        jobId: args.jobId,
      });

      // The whole recompute — manual-pair stickiness, the identity-first
      // pairBatch, the guarded adjacency fallback, the front-preferred identity
      // merge, and the pair-row + image-status diff — is a PURE function of the
      // done rows and the stored pairs. Extracted (NEO-175) so the inline
      // finalize on the close path runs byte-identical logic against the same
      // inputs.
      const diff = computePairingDiff(rows, stored);

      // Deletes first, then patches, then inserts. The three sets are disjoint
      // by construction so the order cannot change the outcome — but it does
      // change what a client subscribed to `listPlaceholderPairs` sees in
      // between, and "the superseded pair disappears before its replacement
      // appears" is the honest intermediate state. The reverse order briefly
      // shows the same image paired twice. Chunked so a large sheet's pairs
      // never build one oversized, conflict-prone transaction.
      for (let i = 0; i < diff.deleteIds.length; i += PAIR_CHUNK_SIZE) {
        await ctx.runMutation(internal.placeholderPairing.applyPairDiff, {
          jobId: args.jobId,
          userId: args.userId,
          deleteIds: diff.deleteIds.slice(i, i + PAIR_CHUNK_SIZE),
          patches: [],
          inserts: [],
        });
      }
      for (let i = 0; i < diff.patches.length; i += PAIR_CHUNK_SIZE) {
        await ctx.runMutation(internal.placeholderPairing.applyPairDiff, {
          jobId: args.jobId,
          userId: args.userId,
          deleteIds: [],
          patches: diff.patches.slice(i, i + PAIR_CHUNK_SIZE),
          inserts: [],
        });
      }
      for (let i = 0; i < diff.insertRows.length; i += PAIR_CHUNK_SIZE) {
        await ctx.runMutation(internal.placeholderPairing.applyPairDiff, {
          jobId: args.jobId,
          userId: args.userId,
          deleteIds: [],
          patches: [],
          inserts: diff.insertRows.slice(i, i + PAIR_CHUNK_SIZE),
        });
      }

      // The same diff, applied to `placeholderImages.pairStatus`. Rows whose
      // verdict is unchanged were excluded inside `computePairingDiff` so an
      // unchanged batch costs zero mutations, not one per chunk.
      for (let i = 0; i < diff.becomingPaired.length; i += PAIR_CHUNK_SIZE) {
        await ctx.runMutation(internal.placeholderPairing.syncImagePairStatus, {
          jobId: args.jobId,
          pairStatus: "paired",
          imageIds: diff.becomingPaired.slice(i, i + PAIR_CHUNK_SIZE),
        });
      }
      for (let i = 0; i < diff.becomingUnmatched.length; i += PAIR_CHUNK_SIZE) {
        await ctx.runMutation(internal.placeholderPairing.syncImagePairStatus, {
          jobId: args.jobId,
          pairStatus: "unmatched",
          imageIds: diff.becomingUnmatched.slice(i, i + PAIR_CHUNK_SIZE),
        });
      }

      if (rows.length > 0) {
        // The log's shape counters are reconstructed from the same two inputs the
        // diff came from — they are NOT in `computePairingDiff`'s return, which is
        // kept to the minimal set both callers apply. `pairs` = the auto pairs
        // that survive this run (stored auto pairs, less deletes, plus inserts),
        // and every paired image is one of two halves, so paired images = 2×pairs.
        // Same predicate the diff used, not a second copy of the rule.
        const doneIdx = new Set(rows.map((r) => r.entryIndex));
        const settledPairs = stored.filter((p) => isLockedPair(p, doneIdx));
        const settledEntryIndexes = new Set<number>();
        for (const p of settledPairs) {
          settledEntryIndexes.add(p.frontIndex);
          settledEntryIndexes.add(p.backIndex);
        }
        const autoImages = rows.filter(
          (r) => !settledEntryIndexes.has(r.entryIndex),
        ).length;
        const autoStoredCount = stored.length - settledPairs.length;
        const pairs = autoStoredCount - diff.deleteIds.length + diff.insertRows.length;
        console.log(
          JSON.stringify({
            msg: "placeholder_pairing_done",
            jobId: args.jobId,
            final,
            force: args.force ?? false,
            images: autoImages,
            // `manual` keeps its original meaning — user-forced pairs — because
            // something may already be reading it. `settled` is the number the
            // counters beside it are actually computed against now: manual PLUS
            // exact-confidence, i.e. everything locked out of this run.
            manual: settledPairs.filter((p) => p.mechanism === "manual").length,
            settled: settledPairs.length,
            pairs,
            unmatched: autoImages - pairs * 2,
            inserted: diff.insertRows.length,
            revised: diff.patches.length,
            removed: diff.deleteIds.length,
            resolverCalls: diff.resolverCalls,
          }),
        );
      }

      // Everything above is what a provisional run does, and it stops here. The
      // batch is not over: more images may still complete, and the run that
      // observes the last of them will redo all of it before deciding anything.
      if (!final) return null;

      // Below this line the batch IS complete, so this run's numbers describe
      // the whole of it. That is what makes the resolver count meaningful — a
      // provisional run over a partial batch always leaves a trailing image
      // unpaired and would report a call the finished batch never needed.
      await ctx.runMutation(internal.placeholderPairing.recordResolverCalls, {
        jobId: args.jobId,
        calls: diff.resolverCalls,
      });

      // Terminal decision. `failedImages * 2 > totalImages` rather than a
      // division so the comparison is exact on odd totals (5 images, 3 failures
      // is a failed batch; 5 and 2 is not).
      const noUsableImages = job.totalImages === 0;
      if (noUsableImages || job.failedImages * 2 > job.totalImages) {
        await ctx.runMutation(internal.placeholderPipeline.markJobFailed, {
          jobId: args.jobId,
          errorCode: "TOO_MANY_IMAGE_FAILURES",
          errorDetail: noUsableImages
            ? // The two modes reach zero usable images by different routes, and
              // telling a scanner user their "upload" was rejected sends them
              // looking for a file they never chose.
              job.mode === "stream"
              ? "no images were uploaded before the batch was closed"
              : "no images were accepted from the upload"
            : `${job.failedImages} of ${job.totalImages} images failed to process`,
        });
        return null;
      }

      await ctx.runMutation(internal.placeholderPipeline.markJobSucceeded, {
        jobId: args.jobId,
      });
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[runPairing] job=${args.jobId} final=${final} failed: ${message}`,
      );
      // A provisional run failing is not the batch failing. Nothing downstream
      // depends on it having succeeded — the final run recomputes the whole
      // diff — so it stays out of the terminal path entirely. Only the run that
      // owns the terminal decision may make one.
      if (!final) return null;
      await ctx.runMutation(internal.placeholderPipeline.markJobFailed, {
        jobId: args.jobId,
        errorCode: "PAIRING_FAILED",
        errorDetail: message.slice(0, 1000),
      });
      return null;
    }
  },
});

/**
 * Clear the incremental-pairing debounce latch.
 *
 * Its own mutation rather than part of a larger one because of WHEN it has to
 * happen: `runPairing` is an action and must clear the latch before its first
 * read, in a transaction of its own, so a completion arriving one millisecond
 * later already sees a clear latch. Folding this into a later write would
 * shrink the window but not close it.
 *
 * A no-op when the latch is already clear — the final run calls this too, and on
 * a batch that never triggered an incremental pass there is nothing to clear.
 * Skipping the patch in that case keeps the job row from being written (and
 * every `getPlaceholderJob` subscriber from being woken) for no reason.
 */
export const clearPairingScheduled = internalMutation({
  args: { jobId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await findJob(ctx, args.jobId);
    if (!job) return null;
    await clearPairingScheduledImpl(ctx, job);
    return null;
  },
});

/**
 * The debounce-latch clear itself, as a plain function taking the job DOC, so a
 * caller that already holds the row — the inline close-path finalize
 * (`finalizePairingInline`) — makes the SAME write rather than a hand-rolled
 * copy. A no-op when the latch is already clear, which keeps the job row (and
 * every `getPlaceholderJob` subscriber) from being written for no reason.
 */
export async function clearPairingScheduledImpl(
  ctx: MutationCtx,
  job: Doc<"placeholderJobs">,
): Promise<void> {
  if (job.pairingScheduled === undefined) return;
  await ctx.db.patch(job._id, { pairingScheduled: undefined });
}

/**
 * Every pair currently stored for a job, in the shape the diff compares on.
 *
 * Unbounded `.collect()` on purpose, and bounded in practice by the same thing
 * that bounds `getPlaceholderJob`'s pair count: a job holds at most
 * MAX_ZIP_ENTRIES entries and therefore at most half that many pairs. The diff
 * needs the WHOLE stored set in one place — a pair missing from a partial read
 * looks exactly like a pair that needs inserting, and inserting it would produce
 * the duplicate the (frontIndex, backIndex) key exists to prevent.
 */
export const listPairsForDiff = internalQuery({
  args: { jobId: v.string() },
  returns: v.array(
    v.object({
      _id: v.id("placeholderPairs"),
      frontIndex: v.number(),
      backIndex: v.number(),
      player: v.optional(v.string()),
      team: v.optional(v.string()),
      cardNumber: v.optional(v.string()),
      confidence: v.union(
        v.literal("exact"),
        v.literal("fuzzy"),
        v.literal("side-only"),
      ),
      // Includes "manual": this feeds `runPairing`, which reads the mechanism to
      // tell manual (sticky) pairs from automatic ones.
      mechanism: v.union(
        v.literal("adjacency"),
        v.literal("pool"),
        v.literal("manual"),
      ),
      score: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const pairs = await ctx.db
      .query("placeholderPairs")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .collect();
    return pairs.map((p) => ({
      _id: p._id,
      frontIndex: p.frontIndex,
      backIndex: p.backIndex,
      player: p.player,
      team: p.team,
      cardNumber: p.cardNumber,
      confidence: p.confidence,
      mechanism: p.mechanism,
      score: p.score,
    }));
  },
});

/**
 * Record the FINAL run's resolver-call count on the job.
 *
 * Sets rather than accumulates, and only the final run calls it — see the
 * `resolverCalls` comment in schema.ts for why summing across incremental runs
 * would measure completion interleaving instead of the batch.
 *
 * Zero is stored as ABSENT, so "no value" is the single representation of "did
 * not pay" and a stale count from an earlier final pass cannot survive a later
 * one that came back clean. The write is skipped when the row already agrees:
 * the job row is subscribed to through `getPlaceholderJob`, and on the healthy
 * path (0, absent, unchanged) that means no write and no woken clients at all.
 *
 * Its own mutation rather than folded into `applyPairDiff`, because that one
 * runs zero times on a pass where no pair moved — and a pass that resolved
 * identities without changing any pair is exactly a case worth recording.
 */
export const recordResolverCalls = internalMutation({
  args: { jobId: v.string(), calls: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await findJob(ctx, args.jobId);
    if (!job) return null;
    await recordResolverCallsImpl(ctx, job, args.calls);
    return null;
  },
});

/**
 * The resolver-count write itself, as a plain function taking the job DOC, so
 * the inline finalize (`finalizePairingInline`) records the count identically —
 * zero stored as ABSENT, and the write skipped when the row already agrees.
 */
export async function recordResolverCallsImpl(
  ctx: MutationCtx,
  job: Doc<"placeholderJobs">,
  calls: number,
): Promise<void> {
  const next = calls > 0 ? calls : undefined;
  if (job.resolverCalls === next) return;
  await ctx.db.patch(job._id, { resolverCalls: next });
}

/**
 * Apply one chunk of the pair diff: delete stale rows, revise changed ones,
 * insert new ones.
 *
 * Chunked because a large sheet produces hundreds of pairs and one transaction
 * per batch would be needlessly large and correspondingly conflict-prone. The
 * caller passes exactly one of the three lists per call, so a chunk is bounded
 * by PAIR_CHUNK_SIZE writes whichever kind of work it is doing.
 *
 * Deletes and patches are keyed on the document ID rather than re-resolved from
 * (jobId, frontIndex, backIndex). Two reasons, both about the gap between
 * pairing's read and its writes — an action can sit for minutes between them:
 *
 *  - Correctness. If the job was canceled and restarted in that gap, the row
 *    that key now names is a DIFFERENT attempt's row, and stamping this run's
 *    verdict on it would be a lie. A `ctx.db.get` on the id either returns the
 *    row pairing actually read or returns nothing, and nothing is the honest
 *    answer — so a missing row is skipped, not an error.
 *  - Cost. It is a direct read instead of an index lookup per row.
 *
 * The `jobId` re-check on each row is not redundant with that. An id resolves to
 * a document regardless of which job it belongs to, and this mutation is what
 * stands between a caller's diff and the pairs table; confirming the row is
 * actually this job's keeps a bug in the diff arithmetic from deleting a
 * different (possibly another user's) job's pairs. Cheap guard, expensive
 * failure — the same trade `pruneUnregisteredImages` makes.
 *
 * Pair rows still STORE `frontIndex`/`backIndex`, not image ids: the entry index
 * is what identifies an image to the user and to the preprocess service, and a
 * stored document id would be a second, redundant identity that a restart would
 * silently invalidate.
 */
export const applyPairDiff = internalMutation({
  args: {
    jobId: v.string(),
    userId: v.string(),
    deleteIds: v.array(v.id("placeholderPairs")),
    patches: v.array(
      v.object({
        pairId: v.id("placeholderPairs"),
        player: v.optional(v.string()),
        team: v.optional(v.string()),
        cardNumber: v.optional(v.string()),
        confidence: v.union(
          v.literal("exact"),
          v.literal("fuzzy"),
          v.literal("side-only"),
        ),
        mechanism: v.union(v.literal("adjacency"), v.literal("pool")),
        score: v.number(),
      }),
    ),
    inserts: v.array(
      v.object({
        frontIndex: v.number(),
        backIndex: v.number(),
        player: v.optional(v.string()),
        team: v.optional(v.string()),
        cardNumber: v.optional(v.string()),
        confidence: v.union(
          v.literal("exact"),
          v.literal("fuzzy"),
          v.literal("side-only"),
        ),
        mechanism: v.union(v.literal("adjacency"), v.literal("pool")),
        score: v.number(),
      }),
    ),
  },
  returns: v.object({
    deleted: v.number(),
    revised: v.number(),
    inserted: v.number(),
  }),
  handler: async (ctx, args) => {
    return applyPairDiffImpl(ctx, args.jobId, args.userId, {
      deleteIds: args.deleteIds,
      patches: args.patches,
      inserts: args.inserts,
    });
  },
});

/**
 * The pair-diff apply itself, as a plain function, so the inline close-path
 * finalize (`finalizePairingInline`) can apply the WHOLE diff in one transaction
 * (unchunked) with the exact delete/patch/insert semantics the chunked action
 * uses — the same id-keyed reads, the same `jobId` re-check, the same insert
 * shape. Keeping one implementation is what stops the two paths diverging.
 */
export async function applyPairDiffImpl(
  ctx: MutationCtx,
  jobId: string,
  userId: string,
  args: {
    deleteIds: Id<"placeholderPairs">[];
    patches: PairPatch[];
    inserts: PairInsertRow[];
  },
): Promise<{ deleted: number; revised: number; inserted: number }> {
  let deleted = 0;
  for (const pairId of args.deleteIds) {
    const pair = await ctx.db.get(pairId);
    if (!pair || pair.jobId !== jobId) continue;
    await ctx.db.delete(pair._id);
    deleted += 1;
  }

  let revised = 0;
  for (const patch of args.patches) {
    const pair = await ctx.db.get(patch.pairId);
    if (!pair || pair.jobId !== jobId) continue;
    await ctx.db.patch(pair._id, {
      player: patch.player,
      team: patch.team,
      cardNumber: patch.cardNumber,
      confidence: patch.confidence,
      mechanism: patch.mechanism,
      score: patch.score,
    });
    revised += 1;
  }

  for (const insert of args.inserts) {
    await ctx.db.insert("placeholderPairs", {
      jobId,
      userId,
      frontIndex: insert.frontIndex,
      backIndex: insert.backIndex,
      player: insert.player,
      team: insert.team,
      cardNumber: insert.cardNumber,
      confidence: insert.confidence,
      mechanism: insert.mechanism,
      score: insert.score,
    });
  }

  return { deleted, revised, inserted: args.inserts.length };
}

/**
 * Stamp one verdict onto a chunk of image rows.
 *
 * "unmatched" means pairing ran for this row and found no partner — distinct
 * from leaving `pairStatus` unset, which means pairing has not looked at it at
 * all. While a batch is still collecting or processing, "unmatched" additionally
 * carries "…as of the images done so far", which is why `listPlaceholderPairs`
 * documents both fields as provisional until the job is terminal.
 *
 * The caller has already filtered out rows whose stored verdict matches, so
 * every id here is a genuine change; the VERDICT is not re-checked, because
 * that would be a second read of a row the action already read. The `jobId`
 * IS re-checked — the same defence-in-depth `applyPairDiff` keeps: a bug in
 * the diff arithmetic must not be able to stamp a different (possibly another
 * user's) job's images. By document ID, and a row that is gone is skipped
 * rather than reported.
 */
export const syncImagePairStatus = internalMutation({
  args: {
    jobId: v.string(),
    pairStatus: v.union(v.literal("paired"), v.literal("unmatched")),
    imageIds: v.array(v.id("placeholderImages")),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    return syncImagePairStatusImpl(ctx, args.jobId, args.pairStatus, args.imageIds);
  },
});

/**
 * The pairStatus stamp itself, as a plain function, so the inline finalize
 * (`finalizePairingInline`) stamps rows with the exact same by-id read, `jobId`
 * re-check, and skip-if-gone semantics the chunked action uses. The caller has
 * already filtered rows whose stored verdict matches, so every id is a genuine
 * change.
 */
export async function syncImagePairStatusImpl(
  ctx: MutationCtx,
  jobId: string,
  pairStatus: "paired" | "unmatched",
  imageIds: Id<"placeholderImages">[],
): Promise<number> {
  let marked = 0;
  for (const imageId of imageIds) {
    const image = await ctx.db.get(imageId);
    if (!image) continue;
    if (image.jobId !== jobId) continue;
    await ctx.db.patch(image._id, { pairStatus });
    marked += 1;
  }
  return marked;
}

/**
 * Finalize a SMALL closed batch INLINE, in the caller's own mutation
 * transaction — the NEO-175 fast path that takes the terminal pairing
 * transition off the Convex scheduler.
 *
 * Byte-identical to what the scheduled `runPairing` action does on its FINAL
 * pass, but without the async hop that backs up under deployment load. It reads
 * the same done rows and stored pairs, runs the same `computePairingDiff`,
 * applies the same pair-row and pairStatus writes via the same plain helpers,
 * records the same resolver count, and makes the same terminal decision. Because
 * it runs inside the close mutation, the whole thing commits atomically at
 * succeeded/failed and the client sees Collecting → terminal with no
 * intermediate "pairing" flicker.
 *
 * Only safe for a SMALL batch — see `INLINE_FINALIZE_MAX_IMAGES` in
 * placeholderStream.ts. It applies the ENTIRE diff in one transaction (no
 * chunking), so a large sheet's read/write/time budget is exactly why big
 * batches keep the chunked action path.
 *
 * The plain-function imports from placeholderPipeline (`markJobFailedImpl` /
 * `markJobSucceededImpl`) do NOT create an import cycle: placeholderPipeline
 * reaches placeholderPairing only through the generated `internal` api (a
 * runtime value), never a static import, so this one-way static edge is safe.
 *
 * Returns the terminal status it set, so the close mutation can hand it straight
 * back to the client.
 */
export async function finalizePairingInline(
  ctx: MutationCtx,
  job: Doc<"placeholderJobs">,
): Promise<"succeeded" | "failed"> {
  // Clear the debounce latch first, exactly as the action does before its first
  // read: a provisional run scheduled while the batch was still collecting must
  // not be able to fight this terminal write.
  await clearPairingScheduledImpl(ctx, job);

  // Done rows, read directly in entry-index order (load-bearing for pairing's
  // adjacency reasoning), mapped to the SAME shape `listDoneImagesForPairing`
  // returns so `computePairingDiff` sees an identical input.
  const imageRows = await ctx.db
    .query("placeholderImages")
    .withIndex("by_job_and_index", (q) => q.eq("jobId", job.jobId))
    .collect();
  const rows: PairingImageRow[] = imageRows
    .filter((r) => r.status === "done")
    .map((r) => ({
      _id: r._id,
      entryIndex: r.entryIndex,
      originalName: r.originalName,
      players: r.players,
      team: r.team,
      cardNumber: r.cardNumber,
      side: r.side,
      textCount: r.textCount,
      dhash: r.dhash,
      pairStatus: r.pairStatus,
    }));

  // Stored pairs, read directly, mapped to the `listPairsForDiff` shape.
  const storedPairs = await ctx.db
    .query("placeholderPairs")
    .withIndex("by_job", (q) => q.eq("jobId", job.jobId))
    .collect();
  const stored: StoredPairRow[] = storedPairs.map((p) => ({
    _id: p._id,
    frontIndex: p.frontIndex,
    backIndex: p.backIndex,
    player: p.player,
    team: p.team,
    cardNumber: p.cardNumber,
    confidence: p.confidence,
    mechanism: p.mechanism,
    score: p.score,
  }));

  const diff = computePairingDiff(rows, stored);

  // The whole diff at once — a small batch fits one transaction, which is the
  // precondition the caller checks before taking this path.
  await applyPairDiffImpl(ctx, job.jobId, job.userId, {
    deleteIds: diff.deleteIds,
    patches: diff.patches,
    inserts: diff.insertRows,
  });
  await syncImagePairStatusImpl(ctx, job.jobId, "paired", diff.becomingPaired);
  await syncImagePairStatusImpl(ctx, job.jobId, "unmatched", diff.becomingUnmatched);

  await recordResolverCallsImpl(ctx, job, diff.resolverCalls);

  // Terminal decision — identical to the action's final block (see the
  // `runPairing` handler). `failed * 2 > total` rather than a division so the
  // comparison is exact on odd totals (5 images, 3 failures is a failed batch;
  // 5 and 2 is not).
  const total = job.totalImages ?? 0;
  const failed = job.failedImages ?? 0;
  const noUsableImages = total === 0;
  if (noUsableImages || failed * 2 > total) {
    await markJobFailedImpl(
      ctx,
      job,
      "TOO_MANY_IMAGE_FAILURES",
      noUsableImages
        ? // The two modes reach zero usable images by different routes, and
          // telling a scanner user their "upload" was rejected sends them
          // looking for a file they never chose.
          job.mode === "stream"
          ? "no images were uploaded before the batch was closed"
          : "no images were accepted from the upload"
        : `${failed} of ${total} images failed to process`,
    );
    return "failed";
  }

  await markJobSucceededImpl(ctx, job);
  return "succeeded";
}

// ---------------------------------------------------------------------------
// Public: manual correction surface (NEO-152)
// ---------------------------------------------------------------------------
//
// The model sometimes misreads (or cannot read) a card's identity, and before
// this the result was unfixable — unlike the old client-side CardPool a user
// could nudge by hand. These three mutations are that nudge, and they compose:
//
//   - `updatePlaceholderImageIdentity` fixes a misread. Because pairing is
//     identity-first, correcting the front's name is usually the WHOLE fix: the
//     re-pair it schedules auto-matches the corrected front to its real back.
//   - `manuallyPairPlaceholderImages` forces a pair when there is no readable
//     identity to fix. Manual pairs are STICKY — the automatic pass excludes
//     their images and never rewrites their rows (see `runPairing`).
//   - `unpairPlaceholderImages` breaks a pair (manual or automatic) so a wrong
//     one can be corrected.
//
// All three: public, `requireUserId` + `findOwnedJob` ownership, `jobId` +
// `entryIndex` the only client handles (no object path — the standing rule).

/** Load one image of a job by its entry index, or null. */
async function imageByIndex(
  ctx: MutationCtx,
  jobId: string,
  entryIndex: number,
): Promise<Doc<"placeholderImages"> | null> {
  return ctx.db
    .query("placeholderImages")
    .withIndex("by_job_and_index", (q) =>
      q.eq("jobId", jobId).eq("entryIndex", entryIndex),
    )
    .unique();
}

/**
 * Whether a `force` re-pair should be scheduled for this job status, and the
 * flags to use.
 *
 * Both start paths and every automatic transition converge on `runPairing`; the
 * manual mutations reuse it too. A correction on an already-SUCCEEDED job has to
 * re-pair, which needs `force` (the incremental guard would otherwise skip it) —
 * see the `force` arg on `runPairing`.
 */
async function scheduleRepair(
  ctx: MutationCtx,
  jobId: string,
  userId: string,
  opts: { force: boolean },
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.placeholderPairing.runPairing, {
    jobId,
    userId,
    final: false,
    force: opts.force,
  });
}

/**
 * Correct a misread identity on one processed image, then re-pair.
 *
 * Only the fields the caller PROVIDES are touched (an absent arg leaves the
 * column alone); a provided empty string / empty array CLEARS the column, which
 * is how a spuriously-read team or player is removed. Same caps as ingestion:
 * players capped to MAX_PLAYERS entries, every string sliced to MAX_FIELD_CHARS.
 * `side` is constrained to front/back by the arg validator.
 *
 * Requires the image be `done` — identity only exists on a processed row, and
 * editing a still-processing row would be clobbered when `/process-entry`
 * completes. Then schedules a `force` re-pair so a corrected identity can
 * immediately produce or revise a match (the common Acuña case: fix the front's
 * name → identity-first auto-pairs it to its back on the next run). The force is
 * what makes this work on a batch that has already succeeded.
 *
 * NOTE on a manually-paired image: this still edits its row, but the re-pair
 * excludes it (it is manual), so its manual pair row's snapshot label is not
 * refreshed. To relabel a manual pair, unpair and re-pair. Editing the identity
 * of a manually-paired image is a contradiction in the first place (you paired
 * it BECAUSE the identity was unreadable), so this edge is left simple.
 */
export const updatePlaceholderImageIdentity = mutation({
  args: {
    jobId: v.string(),
    entryIndex: v.number(),
    players: v.optional(v.array(v.string())),
    team: v.optional(v.string()),
    cardNumber: v.optional(v.string()),
    side: v.optional(v.union(v.literal("front"), v.literal("back"))),
  },
  returns: v.object({
    entryIndex: v.number(),
    players: v.optional(v.array(v.string())),
    team: v.optional(v.string()),
    cardNumber: v.optional(v.string()),
    side: v.optional(v.string()),
    status: v.string(),
    pairStatus: v.optional(v.union(v.literal("paired"), v.literal("unmatched"))),
  }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const job = await findOwnedJob(ctx, args.jobId, userId);
    if (!job) throw new Error("Job not found");

    const image = await imageByIndex(ctx, args.jobId, args.entryIndex);
    if (!image) throw new Error("Image not found");
    if (image.status !== "done") {
      throw new Error("image is not processed yet");
    }

    const patch: Partial<Doc<"placeholderImages">> = {};
    if (args.players !== undefined) {
      const capped = args.players
        .slice(0, MAX_PLAYERS)
        .map((p) => p.slice(0, MAX_FIELD_CHARS));
      patch.players = capped.length > 0 ? capped : undefined;
    }
    if (args.team !== undefined) {
      patch.team = args.team.length > 0 ? args.team.slice(0, MAX_FIELD_CHARS) : undefined;
    }
    if (args.cardNumber !== undefined) {
      patch.cardNumber =
        args.cardNumber.length > 0 ? args.cardNumber.slice(0, MAX_FIELD_CHARS) : undefined;
    }
    if (args.side !== undefined) {
      patch.side = args.side;
    }
    await ctx.db.patch(image._id, patch);

    // A corrected identity should re-pair even a finished batch — hence force.
    await scheduleRepair(ctx, args.jobId, job.userId, { force: true });

    const updated = await ctx.db.get(image._id);
    return {
      entryIndex: args.entryIndex,
      players: updated?.players,
      team: updated?.team,
      cardNumber: updated?.cardNumber,
      side: updated?.side,
      status: updated?.status ?? image.status,
      pairStatus: updated?.pairStatus,
    };
  },
});

/**
 * Force a pair between two processed images, regardless of identity.
 *
 * For the case an identity edit cannot fix: a front whose name is genuinely
 * unreadable, which the automatic pass will never confidently match. The caller
 * designates which image is the front and which the back; the merged label
 * follows the same asymmetry as everywhere else (front-preferred player/team,
 * back-only card number), confidence "side-only", score 0.
 *
 * The pair is written with mechanism "manual", which is what makes it STICKY:
 * `runPairing` excludes both images from its input and never touches the manual
 * row in its diff, so the next automatic re-run cannot pull the pair apart. Both
 * images are set `pairStatus: "paired"`.
 *
 * Guards: both images must exist and be `done`; refuses if EITHER is already
 * paired (the caller unpairs first — a pairing decision is never silently
 * overwritten). No re-pair is scheduled: nothing changed for any OTHER image
 * (both of these were unpaired and are now excluded), so there is nothing for
 * the automatic pass to reconsider.
 */
export const manuallyPairPlaceholderImages = mutation({
  args: { jobId: v.string(), frontIndex: v.number(), backIndex: v.number() },
  returns: v.object({
    paired: v.boolean(),
    frontIndex: v.number(),
    backIndex: v.number(),
  }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const job = await findOwnedJob(ctx, args.jobId, userId);
    if (!job) throw new Error("Job not found");
    if (args.frontIndex === args.backIndex) {
      throw new Error("cannot pair an image with itself");
    }

    const front = await imageByIndex(ctx, args.jobId, args.frontIndex);
    const back = await imageByIndex(ctx, args.jobId, args.backIndex);
    if (!front || !back) throw new Error("Image not found");
    if (front.status !== "done" || back.status !== "done") {
      throw new Error("both images must be processed before pairing");
    }
    if (front.pairStatus === "paired" || back.pairStatus === "paired") {
      throw new Error("image is already paired — unpair it first");
    }

    const identity = mergedRowIdentity(
      { player: null, team: null, cardNumber: null },
      { players: front.players, team: front.team, cardNumber: front.cardNumber },
      { players: back.players, team: back.team, cardNumber: back.cardNumber },
    );
    await ctx.db.insert("placeholderPairs", {
      jobId: args.jobId,
      userId: job.userId,
      frontIndex: args.frontIndex,
      backIndex: args.backIndex,
      player: identity.player,
      team: identity.team,
      cardNumber: identity.cardNumber,
      confidence: "side-only",
      mechanism: "manual",
      score: 0,
    });
    await ctx.db.patch(front._id, { pairStatus: "paired" });
    await ctx.db.patch(back._id, { pairStatus: "paired" });

    return { paired: true, frontIndex: args.frontIndex, backIndex: args.backIndex };
  },
});

/**
 * Break a pair — manual or automatic — so a wrong pairing can be corrected.
 *
 * Deletes the pair row and resets both images to `pairStatus: "unmatched"`. For
 * a MANUAL pair, deleting the row removes the manual mark itself (the row's
 * mechanism WAS the mark), so both images become eligible for automatic pairing
 * again. For an AUTO pair, they are simply free again.
 *
 * Then schedules a re-pair — but WITHOUT `force`. That asymmetry with the
 * identity edit is deliberate and load-bearing:
 *
 *   - On an ACTIVE job (collecting/processing) the re-pair runs and the freed
 *     images re-enter automatic pairing, exactly as the spec asks.
 *   - On a TERMINAL job (the correction phase) the no-force re-pair is skipped
 *     by the incremental guard, so the images STAY unmatched. This is what keeps
 *     the manual-pair-after-unpair workflow race-free: without it, the scheduled
 *     re-run could re-create the very pair the user just broke (an identity match
 *     or an adjacency neighbour) before they can force the correct pairing, and
 *     `manuallyPairPlaceholderImages` would then refuse ("already paired"). The
 *     user's next deliberate action — a manual pair, or an identity edit (which
 *     DOES force) — drives the outcome instead.
 */
export const unpairPlaceholderImages = mutation({
  args: { jobId: v.string(), frontIndex: v.number(), backIndex: v.number() },
  returns: v.object({ unpaired: v.boolean(), wasManual: v.boolean() }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const job = await findOwnedJob(ctx, args.jobId, userId);
    if (!job) throw new Error("Job not found");

    const pairs = await ctx.db
      .query("placeholderPairs")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .collect();
    const pair = pairs.find(
      (p) => p.frontIndex === args.frontIndex && p.backIndex === args.backIndex,
    );
    if (!pair) throw new Error("Pair not found");

    const wasManual = pair.mechanism === "manual";
    await ctx.db.delete(pair._id);

    const front = await imageByIndex(ctx, args.jobId, args.frontIndex);
    const back = await imageByIndex(ctx, args.jobId, args.backIndex);
    if (front) await ctx.db.patch(front._id, { pairStatus: "unmatched" });
    if (back) await ctx.db.patch(back._id, { pairStatus: "unmatched" });

    // No force: re-enters auto on an active job, stays put on a terminal one —
    // see the doc comment for why that keeps the correction workflow race-free.
    await scheduleRepair(ctx, args.jobId, job.userId, { force: false });

    return { unpaired: true, wasManual };
  },
});
