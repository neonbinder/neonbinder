import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { normalizeEntityName } from "../../convex/lib/entityNearMatch";
// NEO-212 security review: an enrichment `wikidataId` arrives from
// query.wikidata.org, so it is external input on its way into an `href`.
// `wikidataUrl` returns null unless it is really a `Q<digits>` id — see
// lib/players/wikidata-id.ts.
import { wikidataUrl, wikipediaUrl } from "../../lib/players/wikidata-id";
// NEO-236: the team name split. Pure, no Convex — see lib/teams/team-name.ts.
import { splitTeamName, teamFullName } from "../../lib/teams/team-name";
import NeonButton from "../modules/NeonButton";
import { Input } from "../primitives/Input";
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
 * strip its green. "Add as New {Player|Team}" is an E2E contract and is the
 * accessible name of the primary in both no-match and close-only states; in the
 * exact state that primary becomes "Link to {name}" and creation survives as a
 * text link reading "Add as New {Player|Team} anyway" — visible text and
 * accessible name identical, no aria-label override (WCAG 2.2 SC 2.5.3). No
 * Maestro flow reaches the exact state (they all type unique nonsense names).
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

/**
 * Mirrors MAX_CAREER_TEAM_CREATES in convex/entityReviewQueue.ts, which
 * REFUSES an over-length `createTeams` rather than truncating it. Same number
 * as MAX_RESOLVE_NAMES by coincidence, not by dependence.
 */
const MAX_CAREER_TEAM_CREATES = 64;

/**
 * NEO-236 (a11y + E2E): STABLE ids for the team Location + Name pair, not
 * `useId()`.
 *
 * Two reasons, and they point the same way. `Input` never emits an id of its
 * own precisely because maestro-web builds `resource-id = node.id ||
 * node.ariaLabel`, so an id it cannot predict would replace the label a flow
 * targets by — a generated `:r7:` is exactly that. And these fields want a
 * visible `<label htmlFor>` rather than an `aria-label`, because two adjacent
 * text inputs are the one case where a label earns its line, which needs an id
 * to point at.
 *
 * Safe as constants: the wizard is a portal-rendered modal that exists at most
 * once, the same premise `entity-review-wizard-title` already rests on.
 */
const TEAM_LOCATION_FIELD_ID = "entity-review-team-location";
const TEAM_NAME_FIELD_ID = "entity-review-team-name";

/** The two halves a team row is created from. Empty strings, not undefined —
 *  these are controlled inputs, and a blank Location is a real answer. */
type TeamCreateDraft = { location: string; name: string };

/**
 * NEO-236 — what the Location + Name pair shows for a team row before the
 * operator touches it.
 *
 * Location is pre-filled ONLY from an ESPN location the lookup actually
 * returned, and only when `splitTeamName` finds it as a whole-word prefix of
 * the reviewed name: "San Diego" off "San Diego Padres" splits, "Anaheim" off
 * "Los Angeles Angels" does not, and neither does "Sa". Everything else starts
 * with a blank Location and the whole reviewed name in Name, which is exactly
 * how a location-less row (a college side, "Orix Buffaloes") should be created
 * and is byte-for-byte how these rows were created before the split existed.
 *
 * There is no first-token heuristic here and there must never be one: NB has
 * no code path that guesses a location without a source. The operator is the
 * fallback.
 *
 * Mirrored server-side by `prefilledTeamCreate` in convex/entityReviewQueue.ts,
 * which is what "Add All Remaining as New" writes for a team row — so
 * confirming one row and confirming the batch mean the same thing.
 */
export function teamCreatePrefill(row: {
  name: string;
  enrichment?: { location?: string } | null;
}): TeamCreateDraft {
  const location = row.enrichment?.location;
  const split = location ? splitTeamName(row.name, location) : null;
  return split
    ? { location: split.location, name: split.name }
    : { location: "", name: row.name.trim() };
}

/** `teamFullName` over a draft, for the "Shows as:" line and for matching. */
function draftFullName(draft: TeamCreateDraft): string {
  return teamFullName({ name: draft.name, location: draft.location });
}

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
  /**
   * NEO-236 — the Location + Name the operator is creating a TEAM row from,
   * keyed by review-row id.
   *
   * Keyed rather than reset per row for the same reason
   * `excludedCareerTeamsByRow` is: a correction the operator has already typed
   * ("this is Golden State / Warriors, not Golden / State Warriors") must
   * survive NEO-221's back-navigation. Absent means "untouched", and an
   * untouched row shows `teamCreatePrefill` — so the pre-fill stays live while
   * a slow enrichment lookup lands, and stops the moment the operator types.
   */
  const [teamCreateByRow, setTeamCreateByRow] = useState<
    Record<string, TeamCreateDraft>
  >({});
  /**
   * NEO-236 — the same, per accepted career team that matches no existing row,
   * keyed by review-row id and then by the label the wizard showed.
   *
   * Only the labels the operator actually edited are in here; the rest read
   * their default (`{ location: "", name: label }`) through `careerCreateFor`.
   */
  const [careerTeamCreateByRow, setCareerTeamCreateByRow] = useState<
    Record<string, Record<string, TeamCreateDraft>>
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
  /**
   * NEO-212 (a11y): the id the career-team checkbox group points at. A bare
   * <ul> of checkboxes has no name, so a screen reader entering it announces
   * "Include career team X" with no clue what the list as a whole is for.
   */
  const careerTeamsLabelId = useId();
  /** Names the "you can't confirm yet" message so the primary action can point
   *  `aria-describedby` at it. */
  const createBlockedId = useId();

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
        // NEO-236: a chip holds Location + Name; the staging list is full
        // names, because that is the key commit dedupes on.
        localChips: stagedCareerTeams.map((c) => ({ name: teamFullName(c) })),
        linkedTeamNames: (linkedTeams ?? []).map((t) => teamFullName(t)),
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
    for (const chip of stagedCareerTeams) push(teamFullName(chip));
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

  /**
   * NEO-236 — the proposed career-team names that match NO existing row, so
   * creating one is the only way they end up on the player.
   *
   * `undefined` from `resolveNames` means "not answered yet", which is NOT the
   * same as "unmatched": while it is loading, and in the over-cap case where
   * the query never runs at all, this set is empty and the create rows below
   * do not appear. The primary action is blocked for the loading case (see
   * `createBlocked`) rather than guessing.
   */
  const unmatchedProposedNames = useMemo(() => {
    const set = new Set<string>();
    for (const r of resolvedTeamNames ?? []) {
      if (!r.existingTeamId) set.add(r.name);
    }
    return set;
  }, [resolvedTeamNames]);

  /** The operator's per-career-team Location + Name edits on the current row. */
  const careerCreates = useMemo(
    () => (current ? (careerTeamCreateByRow[current._id] ?? {}) : {}),
    [careerTeamCreateByRow, current],
  );

  /** Untouched labels read their default: the label itself, no location. */
  const careerCreateFor = (label: string): TeamCreateDraft =>
    careerCreates[label] ?? { location: "", name: label };

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
        }: ${willCreate
          // NEO-236: the name as the operator has SPLIT it, not the label that
          // prompted it. This one line is the preview for every per-chip pair
          // below, which is why none of them carries its own.
          .map((r) => draftFullName(careerCreates[r.name] ?? { location: "", name: r.name }))
          .filter(Boolean)
          .join(", ")}`,
      );
    }
    if (alreadyExist > 0) parts.push(`${alreadyExist} already exist`);
    return parts.length > 0 ? parts.join(" · ") : null;
  }, [resolvedTeamNames, careerCreates]);

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

  /**
   * NEO-236 — one create decision, built from whatever the current row's kind
   * actually needs.
   *
   * A TEAM row carries `create`: the Location + Name the commit prelude will
   * build the row from, and the ONLY thing it will build one from. A PLAYER
   * row carries `createTeams`: the same pair per accepted career team that
   * matched nothing, so a stint at a team we do not have yet can still be
   * created — by the operator's split, not by the raw label.
   *
   * `manualCareerTeams` keeps carrying FULL names, because that is what commit
   * looks up and what `sourceName` is matched against.
   */
  const handleCreate = async (
    reviewRowId: Id<"entityReviewQueue">,
    payload: {
      manualCareerTeams?: CareerTeamDraft[];
      excludedCareerTeamNames?: string[];
      create?: { location?: string; name: string };
      createTeams?: Array<{
        sourceName: string;
        location?: string;
        name: string;
      }>;
    } = {},
  ) =>
    decide(() =>
      recordDecision({
        reviewRowId,
        action: "create",
        manualCareerTeams: payload.manualCareerTeams?.length
          ? payload.manualCareerTeams.map((ct) => ({
              name: teamFullName(ct),
              fromYear: ct.fromYear,
              ...(ct.toYear !== undefined ? { toYear: ct.toYear } : {}),
            }))
          : undefined,
        excludedCareerTeamNames: payload.excludedCareerTeamNames?.length
          ? payload.excludedCareerTeamNames
          : undefined,
        create: payload.create,
        createTeams: payload.createTeams?.length ? payload.createTeams : undefined,
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

  /**
   * NEO-236 — the Location + Name pair for the current TEAM row.
   *
   * Reads the operator's edit when there is one and `teamCreatePrefill`
   * otherwise, so the pre-fill keeps tracking a late-arriving enrichment
   * lookup right up until the first keystroke.
   */
  const teamCreate: TeamCreateDraft =
    current && current.kind === "team"
      ? (teamCreateByRow[current._id] ?? teamCreatePrefill(current))
      : { location: "", name: "" };

  const patchTeamCreate = (rowId: string, patch: Partial<TeamCreateDraft>) => {
    setTeamCreateByRow((prev) => ({
      ...prev,
      [rowId]: { ...(prev[rowId] ?? teamCreate), ...patch },
    }));
  };

  const patchCareerCreate = (
    rowId: string,
    label: string,
    patch: Partial<TeamCreateDraft>,
  ) => {
    setCareerTeamCreateByRow((prev) => {
      const forRow = prev[rowId] ?? {};
      return {
        ...prev,
        [rowId]: {
          ...forRow,
          [label]: {
            ...(forRow[label] ?? { location: "", name: label }),
            ...patch,
          },
        },
      };
    });
  };

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

  // ── NEO-236: what a create on this row would actually write ─────────────

  /** Every still-checked Wikidata proposal, deduped, in display order. */
  const acceptedCareerTeams = sortedCareerTeams
    .map((ct) => ct.name)
    .filter(
      (label, idx, all) =>
        all.indexOf(label) === idx && !excludedForCurrent.includes(label),
    );

  /** Accepted proposals that match nothing yet — the ones that get a visible
   *  Location + Name pair, because creating them is the only way they land. */
  const acceptedUnmatchedCareerTeams = acceptedCareerTeams.filter((label) =>
    unmatchedProposedNames.has(label),
  );

  /**
   * The same list, ordered by how much the operator has invested in it:
   * labels they edited, then the ones known to need creating, then the rest.
   * Only matters when the list has to be truncated — see `buildCreatePayload`.
   */
  const orderedAcceptedCareerTeams = [...acceptedCareerTeams].sort((a, b) => {
    const rank = (label: string) =>
      careerCreates[label] ? 0 : unmatchedProposedNames.has(label) ? 1 : 2;
    return rank(a) - rank(b);
  });

  /**
   * Why the create action cannot fire yet, or null.
   *
   * Only ever a blank name — the one thing that composes to nothing, that
   * `teamRowFields` would refuse at the server anyway, and that the operator
   * can fix on the spot. Deliberately NOT blocked on `resolveNames` still
   * being in flight: the wizard sends a create pair for every accepted career
   * team regardless (see `buildCreatePayload`), so an unanswered match query
   * costs nothing but the per-chip fields not appearing yet.
   */
  const createBlocked: string | null = (() => {
    if (!current) return null;
    if (current.kind === "team") {
      return teamCreate.name.trim()
        ? null
        : "Enter a team name before adding it.";
    }
    const missing = acceptedUnmatchedCareerTeams.filter(
      (label) => careerCreateFor(label).name.trim() === "",
    );
    if (missing.length > 0) {
      return missing.length === 1
        ? `Name the new team for ${missing[0]}, or uncheck it.`
        : `Name the ${missing.length} new teams you're keeping, or uncheck them.`;
    }
    return null;
  })();

  /** The create decision this row would record, built once for both the
   *  primary button and the demoted "…anyway" link. */
  const buildCreatePayload = () => {
    if (!current) return {};
    if (current.kind === "team") {
      const location = teamCreate.location.trim();
      return {
        create: {
          name: teamCreate.name.trim(),
          ...(location ? { location } : {}),
        },
      };
    }
    const createTeams: Array<{
      sourceName: string;
      location?: string;
      name: string;
    }> = [];
    // A hand-typed chip already IS a Location + Name — the operator split it
    // in the entry form — so it needs no second pass, and it goes first
    // because it is the most explicit thing on the row. `sourceName` is its
    // composed name, which is what `manualCareerTeams` carries and therefore
    // what commit looks the entry up by.
    for (const chip of stagedCareerTeams) {
      createTeams.push({
        sourceName: teamFullName(chip),
        name: chip.name,
        ...(chip.location ? { location: chip.location } : {}),
      });
    }
    // EVERY accepted proposal gets a pair, not only the ones known to be
    // unmatched. The prelude looks each label up before it creates anything,
    // so a pair for a team that already exists is inert — whereas omitting one
    // for a team that turns out to be new drops the stint silently. Sending
    // them all is also what keeps this honest while `resolveNames` is still in
    // flight: the fields have not appeared yet, but the untouched default is
    // exactly what they would have shown.
    for (const label of orderedAcceptedCareerTeams) {
      const draft = careerCreateFor(label);
      const location = draft.location.trim();
      createTeams.push({
        sourceName: label,
        name: draft.name.trim(),
        ...(location ? { location } : {}),
      });
    }
    return {
      manualCareerTeams: stagedCareerTeams,
      excludedCareerTeamNames: excludedForCurrent,
      // Mirrors MAX_CAREER_TEAM_CREATES in convex/entityReviewQueue.ts, which
      // REFUSES an over-length list. `orderedAcceptedCareerTeams` puts the
      // operator's own edits and the known-new teams first, so if a career
      // long enough to hit this ever turns up, what falls off the end is the
      // labels nobody touched and that most likely already exist.
      createTeams: createTeams.slice(0, MAX_CAREER_TEAM_CREATES),
    };
  };

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
        {/*
          NEO-110 — THE FOOTER MUST NOT MOVE WHEN A LOOKUP LANDS.
          The dialog's height is FIXED (see the body comment below for the whole
          story). That, not the body's content, is what pins the footer: with a
          definite height on this box and `flex-1 min-h-0` on the body, the
          footer's viewport y is invariant for the life of the dialog.

          `min(40rem, 100%)` — 100% resolves against the overlay's CONTENT box,
          which is `inset-0` minus its `p-4`, so on the 1024×629 CI viewport this
          is 629-32 = 597px and the dialog can never be clipped by the padding.
          40rem (640px) caps it on a tall desktop.
        */}
        <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-xl w-full max-w-2xl h-[min(40rem,100%)] flex flex-col">
          {/* Header: progress counter (satisfies "show N remaining"). */}
          <div className="px-6 py-4 border-b border-gray-700 shrink-0">
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
            NEO-110 — THE BODY ABSORBS EVERY HEIGHT CHANGE. It is `flex-1
            min-h-0 overflow-y-auto` inside a FIXED-HEIGHT dialog, so it grows
            and shrinks entirely within its own box and the footer below it
            never moves. Do NOT put `min-h-*` / `max-h-*` back on this div: an
            elastic body is precisely the defect, twice over.

            WHY THIS MATTERS. This body swaps between wildly different heights:
            the "Looking up N more names…" line (~20px) while every row is still
            `pending`, the full item block once one resolves, and the "All
            reviewed" line. And within the item block the height keeps moving
            for SECONDS after the dialog opens, as the Wikidata description, the
            career-team checkboxes, the near-match panel and the "Will create N
            new teams…" line each arrive on their own query. Because the overlay
            centres the dialog (`flex items-center`), any content-height jump
            used to move the footer by HALF the delta.

            INCIDENT 1 (CI run 30505189226, ~108px). The bulk "Add All Remaining
            as New (N)" link sat at y=380-396; 333ms later the item block had
            rendered and the green "Add as New {kind}" button occupied y=383-414.
            A click aimed at the bulk link landed on "Add as New Player" instead
            — deciding ONE row rather than all of them, silently, for an entity
            the user never reviewed. (Proven by pixel analysis of the failure
            screenshot: the tap point (394,388) is #00D558.) The fix then was a
            reserved minimum body height (`min-h-80`, later `min-h-[22rem]`),
            which BOUNDED the movement to about (max-h − min-h)/2 without
            eliminating it, and said so in this comment: "≈13px".

            INCIDENT 2 (CI run 33817648830, the seed job, 11px) collected that
            debt. On a real 2024 Topps Chrome fetch the first row is Shohei
            Ohtani — Wikidata description, three career-team checkboxes, the
            "Will create 3 new teams…" line. Maestro read the bulk link at
            [194,521][386,537] and clicked its centre (290,529) 332ms later; by
            then the row's async content had pushed the body from its `min-h`
            floor (352px) to its `max-h-[60vh]` ceiling (377px) and the link had
            moved to [194,532][386,548]. The click landed 3px above it, on
            footer padding: no handler, no error, no bulkError, counter frozen
            at "0 of 328 reviewed". The link is `text-xs` — only 16px tall — so
            the "bounded" 13px was never actually a safe margin.

            The fix is structural: a dialog with a definite height. There is no
            longer a residual shift to bound, so there is no longer a number
            here to get wrong.

            THE TRADE-OFF THIS ACCEPTS, honestly stated. A fixed height means a
            short body (all rows pending) renders in a taller box than it needs.
            That is the point — a stable frame is what the operator and Maestro
            both need — and it is strictly better than the alternative it
            replaces: at 1024×629 the OLD `max-h-[60vh]` body was 375px while
            the Ohtani row needed ~430px, so 55px of it (the row's own "Link to
            Existing…" and "Skip — not a person" controls) was clipped into an
            inner scroll region that Maestro's page-level scroll cannot drive.
            The fixed height gives the body 597−79(header)−65(footer) = 453px on
            that viewport, so the richest real row now fits with room to spare
            and `checklist-fetch-wizard-add-career-team`'s controls stay
            reachable. A row richer still simply scrolls — and the footer holds.
          */}
          <div className="p-6 space-y-4 flex-1 min-h-0 overflow-y-auto">
            {bulkError && (
              <p role="alert" className="text-xs text-[#FF2EB3]">
                {bulkError}
              </p>
            )}
            {current ? (
              <>
                <div>
                  {/* NEO-212 (a11y): the CopyButton and the kind/sport tag sit
                      BESIDE the heading, not inside it. Inside, they became
                      part of the heading's accessible name — "Mike Trout Copy
                      name (Player · Baseball)" — which is what a screen
                      reader reads out when navigating by heading, and what a
                      heading-level test has to match. Same shape as
                      PlayerManagement's detail header. */}
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-gray-200">
                      {current.name}
                    </h3>
                    {/* NEO-212 (audit G10): these names are copied out into
                        Wikidata, Google and the marketplaces constantly during
                        review, and a name inside a modal is fiddly to select by
                        hand without dismissing it. */}
                    <CopyButton
                      value={current.name}
                      label="name"
                      className="align-middle"
                    />
                    <span className="text-xs font-normal text-gray-400">
                      ({kindLabel(current.kind)} · {current.sportValue})
                    </span>
                  </div>

                  {/* NEO-212: the operator's escape hatch when the enrichment
                      below is not enough to tell two people apart — the source
                      record itself, one click away. */}
                  {current.enrichment &&
                    (current.enrichment.wikidataId || current.enrichment.enwikiTitle) && (
                      <p className="mt-1 flex flex-wrap items-center gap-3 text-xs">
                        {current.enrichment.wikidataId &&
                          (wikidataUrl(current.enrichment.wikidataId) ? (
                            <a
                              href={wikidataUrl(current.enrichment.wikidataId)!}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[#00B7FF] underline decoration-dotted hover:text-[#00D558] focus:text-[#00D558] focus:outline-none"
                            >
                              Wikidata {current.enrichment.wikidataId}
                              <span className="sr-only"> (opens in new tab)</span>
                            </a>
                          ) : (
                            // Not a `Q<digits>` id, so there is no record to
                            // link to. The value is still SHOWN — the operator
                            // needs to see what the lookup stored in order to
                            // judge it — just not as a clickable destination.
                            <span className="text-gray-400">
                              Wikidata {current.enrichment.wikidataId}
                            </span>
                          ))}
                        {current.enrichment.enwikiTitle && (
                          <a
                            href={wikipediaUrl(current.enrichment.enwikiTitle)}
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
                            <p id={careerTeamsLabelId} className="text-xs text-gray-400">
                              Career teams to create with this player:
                            </p>
                            {/* NEO-212 (a11y): role="group" + aria-labelledby
                                so the checkboxes are announced as one named
                                set. Without it a screen reader lands on
                                "Include career team Angels, checkbox" with no
                                indication these are proposals about to be
                                created. The <ul> keeps its list semantics
                                inside the group rather than being relabelled. */}
                            <div role="group" aria-labelledby={careerTeamsLabelId}>
                            <ul className="space-y-1">
                              {sortedCareerTeams.map((ct) => {
                                const label = `${ct.name} (${ct.fromYear}–${
                                  ct.toYear ?? "present"
                                })`;
                                const draft = careerCreateFor(ct.name);
                                const needsCreate =
                                  acceptedUnmatchedCareerTeams.includes(ct.name);
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
                                    {/*
                                      NEO-236: this team does not exist yet, so
                                      the operator says what to create it AS —
                                      Location + Name, never the raw P54 label.
                                      Indented under its own checkbox and shown
                                      only for the ones that need it, so a
                                      career of teams we already have stays a
                                      plain checkbox list. No preview line per
                                      row: the "Will create N new teams…"
                                      summary below is the preview, once.
                                    */}
                                    {needsCreate && (
                                      <div className="ml-6 mt-1 flex flex-wrap items-center gap-1.5">
                                        <Input
                                          bare
                                          type="text"
                                          value={draft.location}
                                          placeholder="Location"
                                          aria-label={`Location for new team ${ct.name}`}
                                          onChange={(e) =>
                                            patchCareerCreate(current._id, ct.name, {
                                              location: e.target.value,
                                            })
                                          }
                                          className="w-28 p-1 text-xs"
                                        />
                                        <Input
                                          bare
                                          type="text"
                                          value={draft.name}
                                          placeholder="Team name"
                                          aria-label={`Name for new team ${ct.name}`}
                                          // a11y: same reasoning as the
                                          // team-row Name field above — the
                                          // field itself carries the reason,
                                          // not just the primary button.
                                          aria-describedby={
                                            createBlocked ? createBlockedId : undefined
                                          }
                                          onChange={(e) =>
                                            patchCareerCreate(current._id, ct.name, {
                                              name: e.target.value,
                                            })
                                          }
                                          className="w-44 p-1 text-xs"
                                        />
                                        {/* gray-400, not gray-500: 500 on the
                                            dialog's gray-900 is ~3.6:1, under
                                            SC 1.4.3's 4.5:1 floor. */}
                                        <span className="text-xs text-gray-400">
                                          new team
                                        </span>
                                      </div>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                            </div>
                          </>
                        ) : (
                          <p>No career-team history found.</p>
                        )}
                      </>
                    ) : (
                      <>
                        {current.enrichment.league && <p>League: {current.enrichment.league}</p>}
                        {current.enrichment.location && (
                          <p>Location: {current.enrichment.location}</p>
                        )}
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
                    {/*
                      ── NEO-236: creating a team takes Location + Name ───────

                      Jason, 2026-09-05: "We simply shouldn't allow for full
                      string creation. Location & Team Name should be the
                      input." So the create action no longer means "store the
                      checklist string" — it means "store what these two fields
                      say", and the checklist string ("SD PADRES", "Padres  ")
                      is only ever the starting point.

                      Rendered for BOTH near-match states. When an exact match
                      exists the primary becomes "Link to …" and creation
                      survives as the "…anyway" link below — which still needs
                      somewhere to read its two halves from.

                      Visible labels rather than placeholders: two adjacent
                      text fields whose difference is not self-evident is the
                      one case where a label earns its line, and it matches the
                      Location-then-Name form in Team Management, so the pair
                      is learned once.
                    */}
                    {current.kind === "team" && (
                      <div className="space-y-1.5">
                        <div className="flex flex-wrap items-end gap-2">
                          <div className="flex flex-col gap-1">
                            <label
                              htmlFor={TEAM_LOCATION_FIELD_ID}
                              className="text-xs text-gray-400"
                            >
                              Location
                            </label>
                            <Input
                              bare
                              id={TEAM_LOCATION_FIELD_ID}
                              type="text"
                              value={teamCreate.location}
                              placeholder="San Diego"
                              onChange={(e) =>
                                patchTeamCreate(current._id, {
                                  location: e.target.value,
                                })
                              }
                              className="w-40 p-1.5 text-sm"
                            />
                          </div>
                          <div className="flex flex-col gap-1 flex-1 min-w-[10rem]">
                            <label
                              htmlFor={TEAM_NAME_FIELD_ID}
                              className="text-xs text-gray-400"
                            >
                              Team name
                            </label>
                            <Input
                              bare
                              id={TEAM_NAME_FIELD_ID}
                              type="text"
                              value={teamCreate.name}
                              placeholder="Padres"
                              onChange={(e) =>
                                patchTeamCreate(current._id, { name: e.target.value })
                              }
                              // a11y: the field whose emptiness the block is
                              // actually about — not just the button that
                              // acts on it — points at the reason too, so a
                              // screen reader hears it on focusing the field
                              // itself, without needing to tab forward.
                              aria-describedby={
                                createBlocked ? createBlockedId : undefined
                              }
                              className="w-full p-1.5 text-sm"
                            />
                          </div>
                        </div>
                        {/* The composed name, so the operator never has to
                            imagine what the two fields add up to. gray-400 for
                            contrast — see the note on the per-chip tag. */}
                        <p className="text-xs text-gray-400">
                          Shows as: {draftFullName(teamCreate) || "—"}
                        </p>
                      </div>
                    )}

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
                                  {/* NEO-236: the composed name, so the chip
                                      reads as the team that will be created
                                      rather than as its nickname. Identical to
                                      `ct.name` when no Location was typed. */}
                                  {teamFullName(ct)} ({ct.fromYear}
                                  {ct.toYear ? `–${ct.toYear}` : "–present"})
                                  <button
                                    type="button"
                                    aria-label={`Remove ${teamFullName(ct)}`}
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

                    {/*
                      ONE primary button element, one JSX slot, both states.

                      `nearMatches` resolves asynchronously while this row is on
                      screen, so `showExactHierarchy` can flip UNDER a keyboard
                      user who has already tabbed to the primary action. A
                      ternary that swaps WHICH element renders here unmounts the
                      focused node and focus falls to <body> — the operator's
                      next Tab restarts at the top of the document, mid-review
                      (WCAG 2.2 SC 3.2.2 / 2.4.3). Label, handler and variant
                      are props on a single element instead, so React patches
                      the same DOM node and focus survives the swap.
                    */}
                    <NeonButton
                      // Close-but-not-exact matches keep the label and lose the
                      // green: still the primary action, no longer the one the
                      // eye lands on before it has read the panel above.
                      secondary={!showExactHierarchy && hasCloseOnly}
                      // NEO-212 (a11y): NeonButton's `secondary` paints white
                      // on #00C2FF — 2.07:1, well under SC 1.4.3's 4.5:1. That
                      // is a defect in the shared primitive and fixing it there
                      // would repaint every `secondary` button in the app, so
                      // this call site overrides only the foreground through
                      // the `style` passthrough NeonButton already spreads
                      // last. Black on #00C2FF is 10.2:1, and the blue/green
                      // distinction that carries the demotion is untouched.
                      style={
                        !showExactHierarchy && hasCloseOnly
                          ? { color: "#000000" }
                          : undefined
                      }
                      aria-label={
                        showExactHierarchy && exactMatch
                          ? `Link to ${exactMatch.name}`
                          : `Add as New ${kindLabel(current.kind)}`
                      }
                      // NEO-236: aria-disabled rather than `disabled`, so the
                      // control stays focusable and the reason below is
                      // actually announced through `aria-describedby` — a
                      // disabled button can be neither reached nor explained.
                      // Linking is never blocked; only creating is.
                      aria-disabled={
                        createBlocked !== null && !(showExactHierarchy && exactMatch)
                          ? true
                          : undefined
                      }
                      aria-describedby={createBlocked ? createBlockedId : undefined}
                      onClick={() => {
                        if (showExactHierarchy && exactMatch) {
                          void handleLink(
                            current._id,
                            current.kind,
                            exactMatch._id as Id<"players"> | Id<"teams">,
                          );
                          return;
                        }
                        if (createBlocked) return;
                        void handleCreate(current._id, buildCreatePayload());
                      }}
                    >
                      {showExactHierarchy && exactMatch
                        ? `Link to ${exactMatch.name}`
                        : `Add as New ${kindLabel(current.kind)}`}
                    </NeonButton>
                    {/*
                      Demoted to a text link when an exact match exists — and
                      the visible text and the accessible name are now THE SAME
                      STRING. They were not: an `aria-label="Add as New Player"`
                      sat over the visible "Add as New anyway", so a
                      voice-control user saying the words they could read
                      matched nothing (WCAG 2.2 SC 2.5.3, label in name).
                      Removing the override makes the name the text.

                      Safe for E2E: this branch renders ONLY when an exact
                      near match exists, and every Maestro flow that reaches
                      this wizard types a unique nonsense name that matches
                      nothing, so they all run the branch above — where the
                      accessible name is still exactly "Add as New Player".
                    */}
                    {showExactHierarchy && (
                      <button
                        type="button"
                        aria-disabled={createBlocked ? true : undefined}
                        aria-describedby={createBlocked ? createBlockedId : undefined}
                        onClick={() => {
                          if (createBlocked) return;
                          void handleCreate(current._id, buildCreatePayload());
                        }}
                        className="self-start text-xs text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none underline decoration-dotted"
                      >
                        Add as New {kindLabel(current.kind)} anyway
                      </button>
                    )}

                    {/* Not role="alert": this is a standing precondition the
                        operator can read at any time, not an event. It appears
                        as soon as a name is blank and disappears when it is
                        filled, and the create controls point at it. */}
                    {createBlocked && (
                      <p id={createBlockedId} className="text-xs text-[#FF2EB3]">
                        {createBlocked}
                      </p>
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

          <div className="px-6 py-4 border-t border-gray-700 flex items-center justify-between gap-3 shrink-0">
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
