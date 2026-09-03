import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { normalizeEntityName } from "../../convex/lib/entityNearMatch";
import NeonButton from "../modules/NeonButton";
import { CopyButton } from "../primitives/CopyButton";
import {
  NearMatchPanel,
  hasExact,
  type NearMatch,
} from "../entities/NearMatchPanel";
import EntityLinkSearch from "./EntityLinkSearch";
import CareerTeamEntry, { type CareerTeamDraft } from "./CareerTeamEntry";
import { deriveStagedTeamNames } from "./entity-review-staging";

/**
 * NEO-92: step-through review wizard, replaces the old single-screen
 * UnknownEntitiesDialog (a flat checkbox list of every unknown name at
 * once, no per-name info). Presents ONE player/team at a time, showing
 * whatever the background Wikidata lookup (entityReviewQueue.ts +
 * adapters/wikidata.ts's runEntityReviewLookup, drained by the NEO-99
 * Wikidata pool) has already found — fully reactive via `getBatch`, so a
 * row's status flips live as the pool drains without polling.
 *
 * "Current item" = the earliest-inserted row that is no longer "pending"
 * and has no decision yet. NEO-99: the background lookups now drain through
 * the deployment-wide Wikidata pool (convex/wikidataPool.ts) 5 at a time
 * rather than a single serial chain, so completion order is no longer
 * strictly insertion order — a later row can resolve first. Presenting the
 * earliest-inserted non-"pending", undecided row keeps the wizard stable
 * regardless of that order: each item still appears "as soon as its lookup
 * completes", rows still "pending" are skipped over rather than blocking on a
 * straggler, and the header's "N still being looked up" streams down as the
 * pool works through the batch.
 *
 * Every name resolves to exactly one of THREE decisions:
 *   - "Add as New" — recordDecision({action:"create"}); commitCardChecklist
 *     seeds the new row directly from this row's cached enrichment, minus any
 *     Wikidata career team the operator unchecked (excludedCareerTeamNames).
 *   - "Link to Existing…" — EntityLinkSearch picks a real existing row;
 *     recordDecision({action:"link", linked*Id}); no new row is created.
 *   - NEO-212 "Skip — not a person/team" — recordDecision({action:"skip"}).
 *     The checklist string is not a person or a franchise at all ("Checklist",
 *     "Team Card", a subset header that landed in the player column). Nothing
 *     is created and nothing is linked; the card keeps the raw name as free
 *     text and commit records it in `entityReviewSkips` so the same string
 *     does not come back on the next fetch of this set. Before this existed
 *     the only ways past such a row were to mint a junk player row or to
 *     cancel the entire batch.
 * All three are patched immediately (recordDecision), not just kept in local
 * React state — wizard progress survives a page refresh.
 *
 * "Add All Remaining as New" (recordAllRemainingAsCreate) is the bulk
 * fast path for the common case — a first-time real-set sync can surface
 * hundreds of genuinely-new names (every rookie in a brand-new set), where
 * one-at-a-time review only has value for the names that look wrong. Its
 * NEO-212 twin, "Skip Remaining" (recordAllRemainingAsSkip), is the same fast
 * path for the opposite batch: a column that turned out to be headers rather
 * than people. Nothing is written to players/teams/cardChecklist until the
 * final Confirm & Save either way — these only mark decisions early.
 *
 * NEO-212 also puts a `NearMatchPanel` in front of the create action. The
 * wizard used to ask "does this exact normalized key already exist?" and,
 * getting no, offered a green "Add as New" with nothing else on screen — so
 * "NY Yankees" became a second Yankees row next to "New York Yankees". The
 * panel shows the soft matches, and the PRIMARY action changes shape with
 * them: an exact match demotes create to a text link and promotes "Link to
 * {name}" to the green button; close matches leave create as the primary but
 * strip its green. The accessible name "Add as New {Player|Team}" survives all
 * three states — it is an E2E contract — even where the visible text does not.
 * A promoted exact match is filtered OUT of the panel, so no two controls ever
 * share the accessible name `Link to {name}`.
 *
 * Cancel only ever deletes this batch's entityReviewQueue rows
 * (cancelBatch) — players/teams/cardChecklist are never touched during
 * review, matching the old dialog's exact all-or-nothing Cancel semantics.
 */

/**
 * Mirrors RESOLVE_NAMES_MAX in convex/teams.ts.
 *
 * `teams.resolveNames` REFUSES an over-length list rather than truncating it,
 * because a truncated answer is a wrong count and the whole point of the
 * summary line is that the count is right. A thrown Convex error inside
 * `useQuery` unmounts the wizard mid-review, so the over-length case skips the
 * query and shows no summary — no line at all is honest; a wrong one is not.
 */
const MAX_RESOLVE_NAMES = 64;

export default function EntityReviewWizard({
  isOpen,
  selectorOptionId,
  batchId,
  cardCount,
  onConfirm,
  onCancel,
  saving,
}: {
  isOpen: boolean;
  selectorOptionId: Id<"selectorOptions">;
  batchId: string;
  /** Number of cards this fetch will save once committed — shown on the final step. */
  cardCount: number;
  /** All rows decided, user clicked "Confirm & Save". Parent calls commitCardChecklist. */
  onConfirm: () => void;
  /** Parent should clear its pending-preview state and show a "cancelled" message. */
  onCancel: () => void;
  /** True while commitCardChecklist is in flight. Disables the final Save button. */
  saving?: boolean;
}) {
  const rows = useQuery(
    api.entityReviewQueue.getBatch,
    isOpen ? { selectorOptionId, batchId } : "skip",
  );
  const recordDecision = useMutation(api.entityReviewQueue.recordDecision);
  const cancelBatch = useMutation(api.entityReviewQueue.cancelBatch);
  const recordAllRemainingAsCreate = useMutation(
    api.entityReviewQueue.recordAllRemainingAsCreate,
  );
  const recordAllRemainingAsSkip = useMutation(
    api.entityReviewQueue.recordAllRemainingAsSkip,
  );

  const [linkingOpen, setLinkingOpen] = useState(false);
  // Manual career-team entries the admin has staged for the CURRENT player
  // row (only ever populated for a player). Held here (not in CareerTeamEntry)
  // so it resets per-row alongside linkingOpen and is passed through to
  // recordDecision on "Add as New Player".
  const [stagedCareerTeams, setStagedCareerTeams] = useState<CareerTeamDraft[]>([]);
  /**
   * NEO-212 — Wikidata career-team proposals the operator has UNCHECKED, keyed
   * by review-row id.
   *
   * Keyed rather than reset per row on purpose. The per-row reset effect below
   * belongs to NEO-220/221 and a decision the operator has already expressed
   * ("this player never played for that team") should survive them stepping
   * back to the row to change something else, which is exactly what NEO-221's
   * back-navigation will let them do. A map costs one entry per reviewed row.
   */
  const [excludedCareerTeamsByRow, setExcludedCareerTeamsByRow] = useState<
    Record<string, string[]>
  >({});
  const [cancelling, setCancelling] = useState(false);
  /**
   * Which bulk action is in flight, if any. One piece of state rather than two
   * booleans so "Add All Remaining" and "Skip Remaining" cannot both be running
   * — they decide the same rows, and racing them would make the outcome depend
   * on which mutation landed second.
   */
  const [bulkPending, setBulkPending] = useState<null | "create" | "skip">(null);
  /**
   * NEO-212 — a per-row decision is in flight.
   *
   * Every single-row decision (create / link / skip) routes through `decide`
   * so there is exactly ONE place to hang the in-flight guard NEO-221 adds.
   * This deliberately does NOT disable anything yet: adding the guard is that
   * ticket's call, and a half-guard (disable here, no re-entrancy handling
   * there) is worse than none. It is surfaced as `aria-busy` so the state is
   * at least observable to assistive tech in the meantime.
   */
  const [deciding, setDeciding] = useState(false);
  // NEO-110: a rejected bulk decide used to be swallowed entirely (the call
  // site is `void handleBulkCreate()` and there was no catch), so a failed
  // bulk looked identical to a partial one — the button simply re-enabled and
  // the counter didn't move. Surface it instead.
  const [bulkError, setBulkError] = useState<string | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  const total = rows?.length ?? 0;
  const decided = useMemo(() => rows?.filter((r) => r.decision).length ?? 0, [rows]);
  const stillLookingUp = useMemo(
    () => rows?.filter((r) => r.status === "pending").length ?? 0,
    [rows],
  );
  const current = useMemo(
    () => rows?.find((r) => r.status !== "pending" && !r.decision) ?? null,
    [rows],
  );
  const allDecided = total > 0 && decided === total;

  // ------------------------------------------------------------------------
  // NEO-212 reads. All unconditional hooks, above the `isOpen` early return.
  // ------------------------------------------------------------------------

  /**
   * Soft "is this already one of these?" candidates for the current row.
   *
   * Two hooks with the inactive one "skip"ped rather than a ternary over the
   * two function references: `players.nearMatches` and `teams.nearMatches`
   * return differently-branded ids, so a union of the two references does not
   * survive `useQuery`'s argument inference.
   */
  const playerNearMatches = useQuery(
    api.players.nearMatches,
    current && current.kind === "player"
      ? { name: current.name, sportId: current.sportId }
      : "skip",
  );
  const teamNearMatches = useQuery(
    api.teams.nearMatches,
    current && current.kind === "team"
      ? { name: current.name, sportId: current.sportId }
      : "skip",
  );
  // Widened to a single array type on the way out. The two queries return
  // differently-branded ids, and a `Id<"players">[] | Id<"teams">[]`-shaped
  // union is not callable through `.find` — nor is it what NearMatchPanel
  // wants, which is deliberately structural.
  const nearMatches: NearMatch[] | undefined =
    current?.kind === "player" ? playerNearMatches : teamNearMatches;

  /** Team rows already decided "link" — their TARGET's canonical name is what
   *  the batch will actually use, so the staging list needs it, not the raw
   *  checklist string on the review row. One query for the whole batch. */
  const linkedTeamIds = useMemo(() => {
    const ids: Id<"teams">[] = [];
    for (const row of rows ?? []) {
      if (row.kind !== "team") continue;
      if (row.decision?.action !== "link") continue;
      if (row.decision.linkedTeamId) ids.push(row.decision.linkedTeamId);
    }
    return ids;
  }, [rows]);
  const linkedTeams = useQuery(
    api.teams.getManyByIds,
    linkedTeamIds.length > 0 ? { ids: linkedTeamIds } : "skip",
  );

  const excludedForCurrent = current
    ? (excludedCareerTeamsByRow[current._id] ?? [])
    : [];

  /** Every team name this batch already accounts for — fed to the career-team
   *  typeahead so it can suggest teams that exist only as pending decisions. */
  const stagedTeamNames = useMemo(
    () =>
      deriveStagedTeamNames({
        rows: rows ?? [],
        currentRowId: current?._id ?? null,
        localChips: stagedCareerTeams,
        linkedTeamNames: (linkedTeams ?? []).map((t) => t.name),
      }).map((s) => s.name),
    [rows, current?._id, stagedCareerTeams, linkedTeams],
  );

  /**
   * The team names an "Add as New Player" on THIS row would put through
   * commit's get-or-create: the Wikidata proposals still checked, plus the
   * hand-typed chips. Deduped by the same key the server writes, so the count
   * in the summary line is the count of rows commit will actually insert.
   */
  const proposedTeamNames = useMemo(() => {
    if (!current || current.kind !== "player") return [];
    const excluded = new Set(
      (excludedCareerTeamsByRow[current._id] ?? []).map(normalizeEntityName),
    );
    const seen = new Set<string>();
    const names: string[] = [];
    const push = (raw: string) => {
      const key = normalizeEntityName(raw);
      if (!key || seen.has(key)) return;
      seen.add(key);
      names.push(raw);
    };
    for (const ct of current.enrichment?.careerTeams ?? []) {
      if (excluded.has(normalizeEntityName(ct.name))) continue;
      push(ct.name);
    }
    for (const chip of stagedCareerTeams) push(chip.name);
    return names;
  }, [current, excludedCareerTeamsByRow, stagedCareerTeams]);

  const resolvedTeamNames = useQuery(
    api.teams.resolveNames,
    current &&
      current.kind === "player" &&
      proposedTeamNames.length > 0 &&
      proposedTeamNames.length <= MAX_RESOLVE_NAMES
      ? { names: proposedTeamNames, sportId: current.sportId }
      : "skip",
  );

  /** "Will create 2 new teams: X, Y · 1 already exist" — either half is
   *  omitted when its count is zero, so the line never says "0 new teams". */
  const teamSummary = useMemo(() => {
    if (!resolvedTeamNames || resolvedTeamNames.length === 0) return null;
    const willCreate = resolvedTeamNames.filter((r) => !r.existingTeamId);
    const alreadyExist = resolvedTeamNames.length - willCreate.length;
    const parts: string[] = [];
    if (willCreate.length > 0) {
      parts.push(
        `Will create ${willCreate.length} new ${
          willCreate.length === 1 ? "team" : "teams"
        }: ${willCreate.map((r) => r.name).join(", ")}`,
      );
    }
    if (alreadyExist > 0) parts.push(`${alreadyExist} already exist`);
    return parts.length > 0 ? parts.join(" · ") : null;
  }, [resolvedTeamNames]);

  // Closing the "Link to Existing" search whenever the current item changes
  // (e.g. after a decision advances the wizard) so it doesn't stay open for
  // the wrong row.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- closes the link-search when the wizard advances so it cannot stay open on the wrong row
    setLinkingOpen(false);
    setStagedCareerTeams([]);
  }, [current?._id]);

  // Focus the final Save button as soon as it appears so Enter immediately
  // works, mirroring the old dialog's keyboard contract.
  useEffect(() => {
    if (allDecided) confirmButtonRef.current?.focus();
  }, [allDecided]);

  const handleCancel = async () => {
    if (cancelling || saving) return;
    setCancelling(true);
    try {
      await cancelBatch({ selectorOptionId, batchId });
    } finally {
      // onCancel() lives in finally so the wizard always closes and the parent
      // always clears its pending-preview state — even if cancelBatch rejects
      // (transient network/auth error). Leaving it after the try/finally would
      // let a rejection (swallowed by the caller's `void handleCancel()`) strand
      // the dialog permanently open.
      setCancelling(false);
      onCancel();
    }
  };

  /**
   * The bulk fast paths. Both decide the same set of rows (everything still
   * undecided in this batch), so they share one in-flight flag and one error
   * slot — a failure in either has to be visible for the same NEO-110 reason:
   * `void handleBulk(...)` at the call site means an uncaught rejection is
   * indistinguishable from a partial decide.
   */
  const handleBulk = async (kind: "create" | "skip") => {
    if (bulkPending || saving) return;
    setBulkPending(kind);
    setBulkError(null);
    try {
      if (kind === "create") {
        await recordAllRemainingAsCreate({ selectorOptionId, batchId });
      } else {
        await recordAllRemainingAsSkip({ selectorOptionId, batchId });
      }
    } catch (e) {
      setBulkError(
        e instanceof Error
          ? e.message
          : kind === "create"
            ? "Couldn't add the remaining names. Try again."
            : "Couldn't skip the remaining names. Try again.",
      );
    } finally {
      setBulkPending(null);
    }
  };

  if (!isOpen || rows === undefined) return null;

  /**
   * The single seam every per-row decision passes through.
   *
   * create/link/skip are three different mutations' worth of arguments but one
   * user-visible act — "this row is now settled" — and anything that has to
   * happen around all three (NEO-221's in-flight guard, an optimistic advance,
   * error surfacing) belongs here rather than three times over.
   */
  const decide = async (fn: () => Promise<unknown>) => {
    setDeciding(true);
    try {
      await fn();
    } finally {
      setDeciding(false);
    }
  };

  const handleCreate = async (
    reviewRowId: Id<"entityReviewQueue">,
    manualCareerTeams?: CareerTeamDraft[],
    excludedCareerTeamNames?: string[],
  ) =>
    decide(() =>
      recordDecision({
        reviewRowId,
        action: "create",
        manualCareerTeams:
          manualCareerTeams && manualCareerTeams.length ? manualCareerTeams : undefined,
        excludedCareerTeamNames:
          excludedCareerTeamNames && excludedCareerTeamNames.length
            ? excludedCareerTeamNames
            : undefined,
      }),
    );
  const handleLink = async (
    reviewRowId: Id<"entityReviewQueue">,
    kind: "player" | "team",
    linkedId: Id<"players"> | Id<"teams">,
  ) =>
    decide(() =>
      recordDecision({
        reviewRowId,
        action: "link",
        linkedPlayerId: kind === "player" ? (linkedId as Id<"players">) : undefined,
        linkedTeamId: kind === "team" ? (linkedId as Id<"teams">) : undefined,
      }),
    );
  const handleSkip = async (reviewRowId: Id<"entityReviewQueue">) =>
    decide(() => recordDecision({ reviewRowId, action: "skip" }));

  const kindLabel = (kind: "player" | "team") => (kind === "player" ? "Player" : "Team");
  /** "not a person" / "not a team" — the skip control says what it is denying. */
  const notAWhat = (kind: "player" | "team") => (kind === "player" ? "person" : "team");

  const toggleCareerTeam = (rowId: string, teamName: string) => {
    setExcludedCareerTeamsByRow((prev) => {
      const currentExclusions = prev[rowId] ?? [];
      const isExcluded = currentExclusions.includes(teamName);
      return {
        ...prev,
        [rowId]: isExcluded
          ? currentExclusions.filter((n) => n !== teamName)
          : [...currentExclusions, teamName],
      };
    });
  };

  // Chronological, with an open-ended tenure last within a shared start year —
  // "2011–present" is the one that is still running, so it reads as the end of
  // the list rather than something buried in the middle of it.
  const sortedCareerTeams = current?.enrichment?.careerTeams
    ? [...current.enrichment.careerTeams].sort((a, b) => {
        if (a.fromYear !== b.fromYear) return a.fromYear - b.fromYear;
        const aOpen = a.toYear === undefined ? 1 : 0;
        const bOpen = b.toYear === undefined ? 1 : 0;
        if (aOpen !== bOpen) return aOpen - bOpen;
        return (a.toYear ?? 0) - (b.toYear ?? 0);
      })
    : [];

  const exactMatch = (nearMatches ?? []).find((m) => m.confidence === "exact") ?? null;
  const showExactHierarchy = hasExact(nearMatches) && exactMatch !== null;
  const hasCloseOnly = !showExactHierarchy && (nearMatches?.length ?? 0) > 0;
  /**
   * What the panel is left to show once the primary action has been promoted.
   *
   * When an exact match exists, the green button IS that row — same name, same
   * id, same `Link to {name}` accessible name. Listing it again below would put
   * two controls with one accessible name on screen: ambiguous to a screen
   * reader reading the list, and ambiguous to a Maestro `tapOn` matching by it.
   * So the promoted row is filtered out of the panel and appears exactly once,
   * as the primary. Filtering by `_id` rather than by confidence is deliberate
   * — any OTHER row is a genuinely different entity and still belongs in the
   * list, whatever its confidence.
   *
   * If nothing else remains, this is `[]` and NearMatchPanel renders no panel
   * at all (it already treats an empty list as nothing to show).
   */
  const panelMatches =
    showExactHierarchy && nearMatches
      ? nearMatches.filter((m) => m._id !== exactMatch._id)
      : nearMatches;
  const remaining = total - decided;

  return createPortal(
    // See BaseSetPicker.tsx / SetAttributesPanel.tsx for why createPortal
    // needs a nested <Theme> — it escapes the root Theme's CSS scope.
    <Theme>
      <div
        className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="entity-review-wizard-title"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !linkingOpen) {
            e.preventDefault();
            void handleCancel();
          } else if (
            e.key === "Enter" &&
            allDecided &&
            !saving &&
            (e.target as HTMLElement)?.tagName !== "INPUT"
          ) {
            e.preventDefault();
            onConfirm();
          }
        }}
      >
        <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-xl w-full max-w-2xl flex flex-col">
          {/* Header: progress counter (satisfies "show N remaining"). */}
          <div className="px-6 py-4 border-b border-gray-700">
            <h2
              id="entity-review-wizard-title"
              className="text-lg font-semibold text-gray-100"
            >
              Confirm New Players &amp; Teams
            </h2>
            <p className="text-xs text-gray-400 mt-0.5" role="status" aria-live="polite">
              {decided} of {total} reviewed
              {stillLookingUp > 0 ? ` · ${stillLookingUp} still being looked up` : ""}
            </p>
          </div>

          {/*
            NEO-110 — THE FOOTER MUST NOT MOVE WHEN A LOOKUP LANDS.
            This body swaps between three wildly different heights: the
            "Looking up N more names…" line (~20px) while every row is still
            `pending`, the full item block once one resolves, and the
            "All reviewed" line. Because the overlay centres the dialog
            (`flex items-center`), a content-height jump moves the footer by
            HALF the delta — measured at ~108px in CI run 30505189226.

            That is not cosmetic. The bulk "Add All Remaining as New (N)" link
            sat at y=380-396; 333ms later the item block had rendered and the
            green "Add as New {kind}" button occupied y=383-414. A click aimed
            at the bulk link landed on "Add as New Player" instead — deciding
            ONE row rather than all of them, silently, for an entity the user
            never reviewed. (Proven by pixel analysis of the failure
            screenshot: the tap point (394,388) is #00D558.)

            MEASURED from that failure screenshot: header 98→176, body 176→463
            (287px) for a player row with "No Wikidata match found" plus the
            manual career-team form. `min-h-80` (320px) covered that.

            NEO-212 GREW THAT SAME STATE and the reservation moved with it. The
            row now also carries the skip control, the near-match live region,
            the "will create N teams" summary line once anything is staged, and
            body text at `text-sm` rather than `text-xs`. That state measures
            ~340px, so the reservation is now `min-h-[22rem]` (352px) — still
            ~15px of headroom, and still BELOW `max-h-[60vh]` (377px on the
            1024×629 CI viewport), which is the constraint that matters:
            min-height beats max-height in CSS, so a reservation at or above
            60vh would silently disable the scroll cap and let the dialog grow
            past the viewport.

            HONEST LIMIT, unchanged in kind and now larger in degree: this
            bounds the movement, it does not eliminate it. An enrichment-rich
            row (HoF badge, a long checkbox list of career teams, a near-match
            panel) can exceed 352px, at which point the body grows to
            `max-h-[60vh]` and turns into a scroll region. Worst-case residual
            footer shift is therefore about (377-352)/2 ≈ 13px, versus the 108px
            that caused the incident and the ~28px this file carried before.
            Eliminating it entirely needs a fixed-height body (`h-[60vh]`),
            which would put the item block behind an inner scrollbar that
            Maestro's page-level scroll cannot drive — that trade-off is a
            product call, tracked on NEO-110 rather than made silently here.

            min- (not fixed h-) is also why `checklist-fetch-wizard-add-career-team`
            keeps working: the career-team controls stay in normal page flow.
          */}
          <div className="p-6 space-y-4 min-h-[22rem] max-h-[60vh] overflow-y-auto">
            {bulkError && (
              <p role="alert" className="text-xs text-[#FF2EB3]">
                {bulkError}
              </p>
            )}
            {current ? (
              <>
                <div>
                  <h3 className="text-sm font-semibold text-gray-200">
                    {current.name}{" "}
                    {/* NEO-212 (audit G10): these names are copied out into
                        Wikidata, Google and the marketplaces constantly during
                        review, and a name inside a modal is fiddly to select by
                        hand without dismissing it. */}
                    <CopyButton
                      value={current.name}
                      label="name"
                      className="align-middle"
                    />{" "}
                    <span className="text-xs font-normal text-gray-400">
                      ({kindLabel(current.kind)} · {current.sportValue})
                    </span>
                  </h3>

                  {/* NEO-212: the operator's escape hatch when the enrichment
                      below is not enough to tell two people apart — the source
                      record itself, one click away. */}
                  {current.enrichment &&
                    (current.enrichment.wikidataId || current.enrichment.enwikiTitle) && (
                      <p className="mt-1 flex flex-wrap items-center gap-3 text-xs">
                        {current.enrichment.wikidataId && (
                          <a
                            href={`https://www.wikidata.org/wiki/${current.enrichment.wikidataId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[#00B7FF] underline decoration-dotted hover:text-[#00D558] focus:text-[#00D558] focus:outline-none"
                          >
                            Wikidata {current.enrichment.wikidataId}
                            <span className="sr-only"> (opens in new tab)</span>
                          </a>
                        )}
                        {current.enrichment.enwikiTitle && (
                          <a
                            href={`https://en.wikipedia.org/wiki/${encodeURIComponent(
                              current.enrichment.enwikiTitle.replace(/ /g, "_"),
                            )}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[#00B7FF] underline decoration-dotted hover:text-[#00D558] focus:text-[#00D558] focus:outline-none"
                          >
                            Wikipedia
                            <span className="sr-only"> (opens in new tab)</span>
                          </a>
                        )}
                      </p>
                    )}

                  {/* The one line that most often settles "is this the same
                      Mike Smith?": Wikidata's own short description and a birth
                      year. */}
                  {current.enrichment &&
                    (current.enrichment.description || current.enrichment.birthYear) && (
                      <p className="mt-1 text-sm text-gray-300">
                        {[
                          current.enrichment.description,
                          current.enrichment.birthYear
                            ? `b. ${current.enrichment.birthYear}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    )}

                  <div className="mt-2 text-sm text-gray-400 space-y-1">
                    {current.status === "error" || !current.enrichment ? (
                      <p className="italic">No Wikidata match found.</p>
                    ) : current.kind === "player" ? (
                      <>
                        {current.enrichment.isHallOfFame && (
                          <p className="text-[#00D558] font-semibold">Hall of Fame</p>
                        )}
                        {sortedCareerTeams.length > 0 ? (
                          <>
                            {/*
                              NEO-212: PROPOSALS, not facts. Wikidata's P54
                              memberships are frequently wrong for the hobby —
                              a minor-league affiliate, a national team, a
                              one-day roster move — and every one of them used
                              to become a real `teams` row at commit with no way
                              to say no short of cancelling the batch. Checked
                              by default because the common case is that they
                              are right.
                            */}
                            <p className="text-xs text-gray-400">
                              Career teams to create with this player:
                            </p>
                            <ul className="space-y-1">
                              {sortedCareerTeams.map((ct) => {
                                const label = `${ct.name} (${ct.fromYear}–${
                                  ct.toYear ?? "present"
                                })`;
                                return (
                                  <li key={`${ct.name}-${ct.fromYear}`}>
                                    <label className="flex items-center gap-2">
                                      <input
                                        type="checkbox"
                                        checked={!excludedForCurrent.includes(ct.name)}
                                        aria-label={`Include career team ${ct.name}`}
                                        onChange={() =>
                                          toggleCareerTeam(current._id, ct.name)
                                        }
                                        className="accent-[#00D558]"
                                      />
                                      <span>{label}</span>
                                    </label>
                                  </li>
                                );
                              })}
                            </ul>
                          </>
                        ) : (
                          <p>No career-team history found.</p>
                        )}
                      </>
                    ) : (
                      <>
                        {current.enrichment.league && <p>League: {current.enrichment.league}</p>}
                        {current.enrichment.city && <p>City: {current.enrichment.city}</p>}
                        {current.enrichment.yearsActive && (
                          <p>
                            Active: {current.enrichment.yearsActive.from}
                            {current.enrichment.yearsActive.to
                              ? `–${current.enrichment.yearsActive.to}`
                              : "–present"}
                          </p>
                        )}
                        {current.enrichment.colors?.primary && (
                          <p className="flex items-center gap-1">
                            Colors:
                            <span
                              aria-hidden="true"
                              className="inline-block w-3 h-3 rounded-full border border-gray-600"
                              style={{ backgroundColor: current.enrichment.colors.primary }}
                            />
                            {current.enrichment.colors.secondary && (
                              <span
                                aria-hidden="true"
                                className="inline-block w-3 h-3 rounded-full border border-gray-600"
                                style={{ backgroundColor: current.enrichment.colors.secondary }}
                              />
                            )}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/*
                  Above the action row, and hidden while the link search is
                  open: both render a `Link to {name}` button per candidate, and
                  two lists of them on screen at once is an ambiguity for a
                  screen reader and for Maestro alike. `panelMatches`, not
                  `nearMatches`, for the same reason one level down — see there.
                */}
                {!linkingOpen && (
                  <NearMatchPanel
                    kind={current.kind}
                    matches={panelMatches}
                    onPick={(id) => {
                      void handleLink(
                        current._id,
                        current.kind,
                        id as Id<"players"> | Id<"teams">,
                      );
                    }}
                  />
                )}

                {linkingOpen ? (
                  <EntityLinkSearch
                    kind={current.kind}
                    sportId={current.sportId}
                    onSelect={(id) => {
                      void handleLink(current._id, current.kind, id);
                    }}
                    onCancel={() => setLinkingOpen(false)}
                  />
                ) : (
                  <div className="flex flex-col gap-2" aria-busy={deciding}>
                    {current.kind === "player" && (
                      <div className="space-y-1.5">
                        <p className="text-sm text-gray-400">
                          Add career team history manually
                          <span className="text-gray-500"> (optional)</span>:
                        </p>
                        {stagedCareerTeams.length > 0 && (
                          <ul className="flex flex-wrap gap-1.5" aria-label="Staged career teams">
                            {stagedCareerTeams.map((ct, idx) => (
                              <li key={`${ct.name}-${ct.fromYear}-${idx}`}>
                                <span className="inline-flex items-center gap-1 rounded-full border border-gray-700 bg-gray-800 px-2 py-0.5 text-xs text-gray-200">
                                  {ct.name} ({ct.fromYear}
                                  {ct.toYear ? `–${ct.toYear}` : "–present"})
                                  <button
                                    type="button"
                                    aria-label={`Remove ${ct.name}`}
                                    onClick={() =>
                                      setStagedCareerTeams((prev) =>
                                        prev.filter((_, i) => i !== idx),
                                      )
                                    }
                                    className="text-gray-500 hover:text-[#FF2EB3] focus:text-[#FF2EB3] focus:outline-none"
                                  >
                                    ×
                                  </button>
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                        <CareerTeamEntry
                          sportId={current.sportId}
                          stagedNames={stagedTeamNames}
                          onAdd={(entry) =>
                            setStagedCareerTeams((prev) => [...prev, entry])
                          }
                        />
                        {/* What the create is actually about to write. Not a
                            role="status" — the header progress line already
                            owns that role, and a second one turns every
                            checkbox toggle into a competing announcement. */}
                        {teamSummary && (
                          <p className="text-xs text-gray-400" aria-live="polite">
                            {teamSummary}
                          </p>
                        )}
                      </div>
                    )}

                    {showExactHierarchy ? (
                      <>
                        <NeonButton
                          aria-label={`Link to ${exactMatch.name}`}
                          onClick={() => {
                            void handleLink(
                              current._id,
                              current.kind,
                              exactMatch._id as Id<"players"> | Id<"teams">,
                            );
                          }}
                        >
                          Link to {exactMatch.name}
                        </NeonButton>
                        {/*
                          Demoted to a text link, but the ACCESSIBLE NAME is
                          unchanged — "Add as New Player" is an E2E contract and
                          a rename here would be a silent break. The visible
                          text says "anyway" because that is what it now means:
                          a row with this exact name already exists and the
                          operator is overriding.
                        */}
                        <button
                          type="button"
                          aria-label={`Add as New ${kindLabel(current.kind)}`}
                          onClick={() =>
                            void handleCreate(
                              current._id,
                              current.kind === "player" ? stagedCareerTeams : undefined,
                              current.kind === "player" ? excludedForCurrent : undefined,
                            )
                          }
                          className="self-start text-xs text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none underline decoration-dotted"
                        >
                          Add as New anyway
                        </button>
                      </>
                    ) : (
                      // Close-but-not-exact matches keep the label and lose the
                      // green: still the primary action, no longer the one the
                      // eye lands on before it has read the panel above.
                      <NeonButton
                        secondary={hasCloseOnly}
                        aria-label={`Add as New ${kindLabel(current.kind)}`}
                        onClick={() =>
                          void handleCreate(
                            current._id,
                            current.kind === "player" ? stagedCareerTeams : undefined,
                            current.kind === "player" ? excludedForCurrent : undefined,
                          )
                        }
                      >
                        Add as New {kindLabel(current.kind)}
                      </NeonButton>
                    )}

                    <div className="flex items-center gap-4">
                      <button
                        type="button"
                        onClick={() => setLinkingOpen(true)}
                        aria-label="Link to existing instead"
                        className="text-xs text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none underline decoration-dotted"
                      >
                        Link to Existing…
                      </button>
                      {/*
                        NEO-212: the third way out. "Checklist", "Team Card" and
                        subset headers land in the player column constantly, and
                        before this the operator's only options were to mint a
                        junk player row or cancel the whole batch.
                      */}
                      <button
                        type="button"
                        onClick={() => void handleSkip(current._id)}
                        aria-label={`Skip ${current.name} — not a ${notAWhat(current.kind)}`}
                        className="text-xs text-gray-400 hover:text-[#FF2EB3] focus:text-[#FF2EB3] focus:outline-none underline decoration-dotted"
                      >
                        Skip — not a {notAWhat(current.kind)}
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : allDecided ? (
              <p className="text-sm text-gray-200">
                All reviewed — save {cardCount} {cardCount === 1 ? "card" : "cards"}?
              </p>
            ) : (
              <p className="text-sm text-gray-400 italic">
                Looking up {stillLookingUp} more {stillLookingUp === 1 ? "name" : "names"}…
              </p>
            )}
          </div>

          <div className="px-6 py-4 border-t border-gray-700 flex items-center justify-between gap-3">
            <div className="flex items-center gap-4">
              {!allDecided && remaining > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => void handleBulk("create")}
                    disabled={bulkPending !== null || saving}
                    aria-label={`Add all remaining as new (${remaining})`}
                    className="text-xs text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none underline decoration-dotted disabled:opacity-50"
                  >
                    {bulkPending === "create"
                      ? "Adding all remaining…"
                      : `Add All Remaining as New (${remaining})`}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleBulk("skip")}
                    disabled={bulkPending !== null || saving}
                    aria-label={`Skip remaining (${remaining})`}
                    className="text-xs text-gray-400 hover:text-[#FF2EB3] focus:text-[#FF2EB3] focus:outline-none underline decoration-dotted disabled:opacity-50"
                  >
                    {bulkPending === "skip"
                      ? "Skipping remaining…"
                      : `Skip Remaining (${remaining})`}
                  </button>
                </>
              )}
            </div>
            <div className="flex items-center gap-3">
              <NeonButton cancel onClick={() => void handleCancel()} disabled={cancelling || saving}>
                Cancel (Esc)
              </NeonButton>
              {allDecided && (
                <NeonButton ref={confirmButtonRef} onClick={onConfirm} disabled={saving}>
                  {saving ? "Saving..." : "Confirm & Save (Enter)"}
                </NeonButton>
              )}
            </div>
          </div>
        </div>
      </div>
    </Theme>,
    document.body,
  );
}
