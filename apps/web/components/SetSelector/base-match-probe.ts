import { useCallback, useEffect, useRef, useState } from "react";
import type { ConvexReactClient } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type {
  BscProbeResult,
  SlCountResult,
  SlFirstPageResult,
} from "../../convex/lib/baseMatchProbe";
import {
  BASE_MATCH_COPY,
  judgeAgainstBase,
  judgeFirstCard,
  needsCount,
  type BaseJudgement,
  type BaseMatchSide,
  type BaseSignature,
  type ObservedCard,
} from "@/lib/cards/base-match";

/**
 * NEO-325 — the Reconcile dialog's check of every pending parallel against
 * the saved Base (Jason, 2026-10-09). The dialog opens at once; this hook
 * fetches the Base's signature, then works through a client-side queue of
 * pending marketplace sets, a few at a time, and hands back a verdict per
 * set as each one settles. `lib/cards/base-match.ts` decides; this only
 * asks the marketplaces and keeps the books.
 *
 * ## The queue
 *
 *   - Entries are `{side, id}`. An id joins the queue the first time it is in
 *     the dialog's SCOPE — the rows a column shows before its search box (the
 *     SportLots prefix filter, the other-level exclusion). "Show all
 *     SportLots items" widens the scope and so enqueues the rest on demand;
 *     narrowing it again leaves the extra ones queued but undispatched.
 *   - Priority follows the VIEW: rows in the column's current filtered view
 *     first, in view order, then everything else in the order it joined. It
 *     re-sorts whenever the view changes, so typing "Black Refractor" checks
 *     those within seconds.
 *   - SportLots is two steps. Every id gets its first page (32 ids a call);
 *     only an id whose first card matched — or could not be read — is then
 *     counted (8 ids a call), because counting walks every page. BSC is one
 *     step (4 ids a call). Two calls in flight per side.
 *   - Verdicts are cached by side + id for the dialog's life, so a set that
 *     goes to Ready and comes back (DETACH, DISBAND) is not asked twice.
 *
 * ## Sign-in stop (security F1, client half)
 *
 * When a batch comes back `failed` with kind `signed_out` or `no_sign_in`
 * for EVERY id it asked about, that side is not asked again for the rest of
 * the sitting: every set of that side still queued (and any that joins the
 * scope later) is settled as "couldn't be checked", and the live line says
 * so once. One signed-out answer is not a stop; a whole batch of them is.
 *
 * ## The live line
 *
 * `announcement` is the dialog's one polite line for the whole check. Its
 * total is FIXED when the check starts (the scope at that moment), so a
 * column shrinking as rows go up to Ready never moves it: a start line, at
 * most one line per quarter, one closing sentence, never repeated. A set
 * that left the columns before it was checked counts as accounted for.
 *
 * ## Cancel
 *
 * A generation counter. Closing the dialog (or unmounting it) bumps it: a
 * call already in flight finishes on the server, its answer is ignored, and
 * nothing more is sent. Nothing is ever stored — the verdicts die with the
 * dialog.
 *
 * ## No subscription
 *
 * The signature is read once with `client.query`, not `useQuery`: the check
 * is a snapshot for this sitting, and a live Base edit mid-dialog re-sorting
 * the operator's columns under them would be worse than a stale verdict.
 * Every Convex reference is read at CALL time, so a component test whose
 * hand-built `api` mock lacks this module keeps rendering (the dialog only
 * gets a client when the caller asked for the check).
 */

/** The two calls the probe makes — a `ConvexReactClient`, as `useConvex()` returns it. */
export type BaseMatchClient = Pick<ConvexReactClient, "query" | "action">;

/** What `getBaseSignatureForVariantType` answers. Anything but `ok` means skip. */
export type BaseSignatureResult =
  | BaseSignature
  | {
      status:
        | "notParallelType"
        | "noBase"
        | "manyBases"
        | "noCards"
        | "tooManyCards";
    };

/** One pending set's check, as the dialog renders it. */
export type RowCheck =
  | { state: "queued" }
  | { state: "checking" }
  | ({ state: "done" } & BaseJudgement);

/**
 * `off`: no check (no client, not a parallel, or a Base the server said to
 * skip) — the dialog shows no chrome at all. `loading`: the signature is
 * being read — still no chrome, so a skip never flashes it. `on`: checking.
 */
export type BaseMatchPhase = "off" | "loading" | "on";

export type BaseMatchProbe = {
  phase: BaseMatchPhase;
  signature: BaseSignature | null;
  /** Every check so far, keyed by `checkKey(side, id)`. A fresh map per change. */
  checks: ReadonlyMap<string, RowCheck>;
  /** The dialog's live line for the check; "" until there is something to say. */
  announcement: string;
};

export const checkKey = (side: BaseMatchSide, id: string) => `${side}:${id}`;

/** Ids per side, in the order the column lists them. */
export type SideIds = { bsc: readonly string[]; sportlots: readonly string[] };

const SIDES: readonly BaseMatchSide[] = ["sportlots", "bsc"];

/** Calls in flight per side. */
export const MAX_IN_FLIGHT_PER_SIDE = 2;
/** Ids per call, by step. Matches the server's bounds (`convex/lib/baseMatchProbe.ts`). */
export const SL_FIRST_PAGE_BATCH = 32;
export const SL_COUNT_BATCH = 8;
export const BSC_BATCH = 4;

type Stage = "first" | "count";

type Entry = {
  side: BaseMatchSide;
  id: string;
  stage: Stage;
  status: "queued" | "inflight" | "done";
  /** Order it joined the queue, the tiebreak after view order. */
  seq: number;
  /** SportLots: the first card the first-page step read, carried to the count. */
  first?: ObservedCard | null;
  judgement?: BaseJudgement;
};

function snapshotOf(entries: Map<string, Entry>): Map<string, RowCheck> {
  const out = new Map<string, RowCheck>();
  for (const [key, e] of entries) {
    out.set(
      key,
      e.status === "done" && e.judgement
        ? { state: "done", ...e.judgement }
        : e.status === "inflight"
          ? { state: "checking" }
          : { state: "queued" },
    );
  }
  return out;
}

/** The failure kinds that mean "sign in again" — asking more cannot help. */
const SIGN_IN_KINDS: ReadonlySet<string> = new Set(["signed_out", "no_sign_in"]);

/** Did every id in the batch come back failed for want of a sign-in? */
export function wholeBatchSignedOut(
  ids: readonly string[],
  results: readonly { id: string; status: string; kind?: string }[] | undefined,
): boolean {
  if (ids.length === 0) return false;
  const got = byId(results);
  return ids.every((id) => {
    const r = got.get(id);
    return r !== undefined && r.status === "failed" && SIGN_IN_KINDS.has(r.kind ?? "");
  });
}

export type AnnounceState = {
  started: boolean;
  quarter: number;
  done: boolean;
  stoppedSaid: Set<BaseMatchSide>;
};

export const freshAnnounce = (): AnnounceState => ({
  started: false,
  quarter: 0,
  done: false,
  stoppedSaid: new Set(),
});

/**
 * The live line's next text, or null when nothing new is to be said. Moves
 * `state` forward; every milestone is said at most once per sitting.
 */
export function nextAnnouncement({
  state,
  startKeys,
  entries,
  inScope,
  stopped,
}: {
  state: AnnounceState;
  startKeys: ReadonlySet<string>;
  entries: ReadonlyMap<string, Pick<Entry, "status" | "judgement">>;
  inScope: ReadonlySet<string>;
  stopped: Record<BaseMatchSide, boolean>;
}): string | null {
  const parts: string[] = [];
  for (const side of SIDES) {
    if (stopped[side] && !state.stoppedSaid.has(side)) {
      state.stoppedSaid.add(side);
      parts.push(BASE_MATCH_COPY.liveStopped(side));
    }
  }
  const total = startKeys.size;
  if (total > 0 && !state.done) {
    let accounted = 0;
    let checked = 0;
    let match = 0;
    let mismatch = 0;
    let unverifiable = 0;
    for (const key of startKeys) {
      const e = entries.get(key);
      if (e?.status === "done" && e.judgement) {
        accounted++;
        checked++;
        if (e.judgement.verdict === "match") match++;
        else if (e.judgement.verdict === "mismatch") mismatch++;
        else unverifiable++;
      } else if (!inScope.has(key)) {
        // Left the columns (made a set, attached) before it was checked.
        accounted++;
      }
    }
    const quarter = Math.floor((accounted * 4) / total);
    if (!state.started) {
      state.started = true;
      state.quarter = quarter;
      if (accounted < total) parts.push(BASE_MATCH_COPY.liveStart(total));
    }
    if (accounted >= total) {
      state.done = true;
      // Nothing was actually checked: no closing sentence to say.
      if (checked > 0) {
        parts.push(BASE_MATCH_COPY.liveDone(checked, match, mismatch, unverifiable));
      }
    } else if (quarter > state.quarter) {
      state.quarter = quarter;
      parts.push(BASE_MATCH_COPY.liveQuarter(quarter * 25));
    }
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function byId<T extends { id: string }>(results: readonly T[] | undefined): Map<string, T> {
  const map = new Map<string, T>();
  for (const r of results ?? []) map.set(r.id, r);
  return map;
}

/** A side-ids pair as one string, for content-keyed effects. */
function sideIdsKey(ids: SideIds): string {
  return `${ids.bsc.join("\u0000")}\u0001${ids.sportlots.join("\u0000")}`;
}

export function useBaseMatchProbe({
  client,
  variantTypeId,
  scope,
  view,
}: {
  /** Null → off. The dialog has one only when its caller asked for the check. */
  client: BaseMatchClient | null;
  /** Undefined → off (and, going from set to unset, cancel). */
  variantTypeId: Id<"selectorOptions"> | undefined;
  /** What each column would show with its search box empty: the check's reach. */
  scope: SideIds;
  /** What each column shows right now: the check's priority, in order. */
  view: SideIds;
}): BaseMatchProbe {
  const [phase, setPhase] = useState<BaseMatchPhase>("off");
  const [signature, setSignature] = useState<BaseSignature | null>(null);
  const [checks, setChecks] = useState<ReadonlyMap<string, RowCheck>>(
    () => new Map(),
  );
  const [announcement, setAnnouncement] = useState("");

  const entriesRef = useRef(new Map<string, Entry>());
  const seqRef = useRef(0);
  const inScopeRef = useRef(new Set<string>());
  const rankRef = useRef(new Map<string, number>());
  const inFlightRef = useRef<Record<BaseMatchSide, number>>({
    bsc: 0,
    sportlots: 0,
  });
  /** Bumped on close: every answer from before it is ignored. */
  const genRef = useRef(0);
  /** The signature the queue runs against, null while off or loading. */
  const sigRef = useRef<BaseSignature | null>(null);
  const clientRef = useRef<BaseMatchClient | null>(null);
  const variantTypeIdRef = useRef<Id<"selectorOptions"> | undefined>(undefined);
  const scopeRef = useRef(scope);
  const viewRef = useRef(view);
  /** The scope when the check started: the live line's fixed total. */
  const startKeysRef = useRef<ReadonlySet<string>>(new Set());
  const announceRef = useRef<AnnounceState>(freshAnnounce());
  /** Sides stopped for want of a sign-in: never asked again this sitting. */
  const stoppedRef = useRef<Record<BaseMatchSide, boolean>>({
    bsc: false,
    sportlots: false,
  });

  const publish = useCallback(() => {
    setChecks(snapshotOf(entriesRef.current));
    if (!sigRef.current) return;
    const next = nextAnnouncement({
      state: announceRef.current,
      startKeys: startKeysRef.current,
      entries: entriesRef.current,
      inScope: inScopeRef.current,
      stopped: stoppedRef.current,
    });
    if (next !== null) setAnnouncement(next);
  }, []);

  /** Bring the queue in line with the latest scope and view. */
  const syncScope = useCallback(() => {
    const inScope = new Set<string>();
    for (const side of SIDES) {
      for (const id of scopeRef.current[side]) {
        const key = checkKey(side, id);
        inScope.add(key);
        if (!entriesRef.current.has(key)) {
          const sig = sigRef.current;
          const entry: Entry = {
            side,
            id,
            stage: "first",
            status: "queued",
            seq: seqRef.current++,
          };
          // A side stopped for want of a sign-in is not asked again: a set
          // joining its scope now settles as "couldn't be checked" at once.
          if (stoppedRef.current[side] && sig) {
            entry.status = "done";
            entry.judgement = judgeAgainstBase(sig, side, { status: "failed" });
          }
          entriesRef.current.set(key, entry);
        }
      }
    }
    inScopeRef.current = inScope;
    const rank = new Map<string, number>();
    for (const side of SIDES) {
      viewRef.current[side].forEach((id, i) => {
        const key = checkKey(side, id);
        if (!rank.has(key)) rank.set(key, i);
      });
    }
    rankRef.current = rank;
  }, []);

  /** The best queued, in-scope entries of one side and step, up to `size`. */
  const pick = useCallback(
    (side: BaseMatchSide, stage: Stage, size: number): Entry[] => {
      const rank = rankRef.current;
      const queued: Entry[] = [];
      for (const [key, e] of entriesRef.current) {
        if (e.side !== side || e.stage !== stage || e.status !== "queued") continue;
        if (!inScopeRef.current.has(key)) continue;
        queued.push(e);
      }
      const r = (e: Entry) => rank.get(checkKey(e.side, e.id)) ?? Infinity;
      queued.sort((a, b) => r(a) - r(b) || a.seq - b.seq);
      return queued.slice(0, size);
    },
    [],
  );

  const finish = useCallback((e: Entry, judgement: BaseJudgement) => {
    e.status = "done";
    e.judgement = judgement;
  }, []);

  /** Stop asking `side`: settle everything it still has queued as unverifiable. */
  const stopSide = useCallback(
    (side: BaseMatchSide, sig: BaseSignature) => {
      stoppedRef.current[side] = true;
      for (const e of entriesRef.current.values()) {
        if (e.side === side && e.status === "queued") {
          finish(e, judgeAgainstBase(sig, side, { status: "failed" }));
        }
      }
    },
    [finish],
  );

  // `pump` and `dispatch` call each other; the ref breaks the cycle.
  const pumpRef = useRef<() => void>(() => undefined);

  const dispatch = useCallback(
    (side: BaseMatchSide, stage: Stage, batch: Entry[]) => {
      const convex = clientRef.current;
      const sig = sigRef.current;
      const variantTypeIdNow = variantTypeIdRef.current;
      if (!convex || !sig || !variantTypeIdNow) return;
      const myGen = genRef.current;
      for (const e of batch) e.status = "inflight";
      inFlightRef.current[side]++;
      const ids = batch.map((e) => e.id);

      const unverifiable = (e: Entry) =>
        finish(e, judgeAgainstBase(sig, side, { status: "failed" }));

      const call = async () => {
        if (side === "bsc") {
          const results: BscProbeResult[] = await convex.action(
            api.baseMatchProbe.probeBscSets,
            { variantTypeId: variantTypeIdNow, variantNameIds: ids },
          );
          const got = byId(results);
          const signedOut = wholeBatchSignedOut(ids, results);
          for (const e of batch) {
            const r = got.get(e.id);
            // `failed` (a paused marketplace answers `refused` as its kind)
            // and `refused` (a chain that cannot scope the id) are both
            // unverifiable, never a mismatch.
            if (!r || r.status !== "ok") unverifiable(e);
            else {
              finish(
                e,
                judgeAgainstBase(sig, side, {
                  status: "ok",
                  first: r.first ?? null,
                  // BSC's count is non-variation cards, so a set with none
                  // is judged on that count (0); BSC's rows say nothing more.
                  count: r.count,
                }),
              );
            }
          }
          if (signedOut) stopSide(side, sig);
          return;
        }
        if (stage === "first") {
          const results: SlFirstPageResult[] = await convex.action(
            api.baseMatchProbe.probeSlFirstPage,
            { setIds: ids },
          );
          const got = byId(results);
          const signedOut = wholeBatchSignedOut(ids, results);
          for (const e of batch) {
            const r = got.get(e.id);
            if (!r || r.status !== "ok") {
              unverifiable(e);
              continue;
            }
            const first = r.first ?? null;
            if (!r.pageHadRows) {
              // An empty set: its count is known to be 0 without a walk.
              finish(e, judgeAgainstBase(sig, side, { status: "ok", first, count: 0 }));
              continue;
            }
            if (!first) {
              // Rows, but every one a variation: no first card to compare,
              // which `base-match.ts` sets aside as a first-card mismatch.
              finish(
                e,
                judgeAgainstBase(sig, side, { status: "ok", first, onlyVariations: true }),
              );
              continue;
            }
            const outcome = judgeFirstCard(sig, first);
            if (needsCount(sig, side, outcome)) {
              e.stage = "count";
              e.status = "queued";
              e.first = first;
            } else {
              finish(e, judgeAgainstBase(sig, side, { status: "ok", first }));
            }
          }
          if (signedOut) stopSide(side, sig);
          return;
        }
        const results: SlCountResult[] = await convex.action(
          api.baseMatchProbe.probeSlCount,
          { setIds: ids },
        );
        const got = byId(results);
        const signedOut = wholeBatchSignedOut(ids, results);
        for (const e of batch) {
          const r = got.get(e.id);
          if (!r || r.status !== "ok") unverifiable(e);
          else {
            finish(
              e,
              judgeAgainstBase(sig, side, {
                status: "ok",
                first: e.first ?? null,
                count: r.count,
              }),
            );
          }
        }
        if (signedOut) stopSide(side, sig);
      };

      void call()
        .catch(() => {
          if (genRef.current !== myGen) return;
          // A call that threw answered for none of its ids: each one is
          // unverifiable, never a mismatch.
          for (const e of batch) if (e.status === "inflight") unverifiable(e);
        })
        .then(() => {
          if (genRef.current !== myGen) return;
          inFlightRef.current[side] = Math.max(0, inFlightRef.current[side] - 1);
          publish();
          pumpRef.current();
        });
    },
    [finish, publish, stopSide],
  );

  const pump = useCallback(() => {
    if (!sigRef.current || !clientRef.current) return;
    let sent = false;
    for (const side of SIDES) {
      if (stoppedRef.current[side]) continue;
      while (inFlightRef.current[side] < MAX_IN_FLIGHT_PER_SIDE) {
        let stage: Stage = "first";
        let batch: Entry[];
        if (side === "bsc") {
          batch = pick(side, "first", BSC_BATCH);
        } else {
          // Whichever step holds the better-placed row goes next; a tie goes
          // to the count, which is the step that finishes a row.
          const counts = pick(side, "count", SL_COUNT_BATCH);
          const firsts = pick(side, "first", SL_FIRST_PAGE_BATCH);
          const best = (list: Entry[]) =>
            list.length === 0
              ? Infinity
              : (rankRef.current.get(checkKey(side, list[0].id)) ?? Infinity);
          const preferCount =
            counts.length > 0 &&
            (firsts.length === 0 || best(counts) <= best(firsts));
          stage = preferCount ? "count" : "first";
          batch = preferCount ? counts : firsts;
        }
        if (batch.length === 0) break;
        dispatch(side, stage, batch);
        sent = true;
      }
    }
    if (sent) publish();
  }, [dispatch, pick, publish]);

  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

  // The scope and view, kept current; new ids join, priority re-sorts.
  // Keyed on CONTENT, not identity: the dialog rebuilds these lists on any
  // render that touches its filters (and some callers' default props are a
  // fresh `[]` per render), and an identity-keyed effect that publishes would
  // re-render the dialog into itself forever.
  const scopeKey = sideIdsKey(scope);
  const viewKey = sideIdsKey(view);
  useEffect(() => {
    scopeRef.current = scope;
    viewRef.current = view;
    syncScope();
    if (sigRef.current) {
      publish();
      pumpRef.current();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content; `scope`/`view` are read from the render whose key changed
  }, [scopeKey, viewKey, syncScope, publish]);

  // Open: read the signature, then start. Close: cancel.
  useEffect(() => {
    if (!client || !variantTypeId) {
      setPhase("off");
      return;
    }
    const myGen = ++genRef.current;
    clientRef.current = client;
    variantTypeIdRef.current = variantTypeId;
    setPhase("loading");
    syncScope();
    void client
      .query(api.baseMatchProbe.getBaseSignatureForVariantType, {
        variantTypeId,
      })
      .then((result: BaseSignatureResult) => {
        if (genRef.current !== myGen) return;
        if (result.status !== "ok") {
          setPhase("off");
          return;
        }
        sigRef.current = result;
        // The live line's total, fixed now: the scope as the check starts.
        startKeysRef.current = new Set(inScopeRef.current);
        setSignature(result);
        setPhase("on");
        publish();
        pumpRef.current();
      })
      .catch(() => {
        // No signature, no check: the dialog works exactly as it did.
        if (genRef.current === myGen) setPhase("off");
      });
    return () => {
      genRef.current++;
      sigRef.current = null;
      clientRef.current = null;
      variantTypeIdRef.current = undefined;
      inFlightRef.current = { bsc: 0, sportlots: 0 };
      // Nothing outlives the sitting: the next open starts from nothing.
      entriesRef.current = new Map();
      seqRef.current = 0;
      startKeysRef.current = new Set();
      announceRef.current = freshAnnounce();
      stoppedRef.current = { bsc: false, sportlots: false };
      setAnnouncement("");
    };
  }, [client, variantTypeId, syncScope, publish]);

  return {
    phase,
    signature,
    checks: phase === "on" ? checks : EMPTY,
    announcement: phase === "on" ? announcement : "",
  };
}

const EMPTY: ReadonlyMap<string, RowCheck> = new Map();
