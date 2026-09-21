import { useEffect, useId, useMemo, useRef, useState } from "react";
import { TrashIcon } from "@heroicons/react/24/outline";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";
import { useConvex, useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  EXPECTED_FEATURES,
  type ExpectedFeature,
} from "../../convex/features/expectedFeatures";
import { slotIds, type SlotBearingRow } from "../../convex/platformSlots";
import { ConfirmDialog } from "../modules/confirm-dialog";
import { userFacingMessage } from "@/lib/errors/user-facing-message";
import { contrastRatio, normalizeHexColor } from "@/lib/print/contrast";
import { teamFullName, teamShortName } from "../../lib/teams/team-name";
import { FeatureValueControl } from "./FeatureValueControl";
import CardPrefixRow from "./CardPrefixRow";
import RenameEntityControl from "./RenameEntityControl";
import BaseRoleControl from "./BaseRoleControl";
import { isBaseRole } from "./baseRole";
import FillTeamsControl from "./FillTeamsControl";
import TeamPicker, { type TeamPickerLabels } from "./TeamPicker";
import {
  ALL_SIDES,
  joinLabels,
  LEVEL_SINGULAR,
  levelNoun,
  SIDE_LABEL,
  type SelectorLevel,
} from "./selector-sync-feedback";

/**
 * NEO-38 (PR B-2) — level-agnostic set ATTRIBUTES editor.
 *
 * Renamed/generalized from `SetFeaturesPanel`. Mounts at the deepest
 * selected node at ANY level (sport → parallel), not just setName, so
 * the panel never vanishes when a variant (e.g. "Base") is selected.
 *
 * Renders one row per applicable `EXPECTED_FEATURES` entry — persisted via
 * `setSelectorOptionFeature`, a single-row patch on THIS node only
 * (NEO-71-74: write-once feature snapshots). A row's `features` is already
 * the complete resolved value — computed once via copy-down at the node's
 * own creation — so this panel reads it directly, with no client-side
 * ancestor-chain merge.
 *
 * `releaseDate` / `block` / `totalCardCount` used to live in a separate
 * `setMetadata` object editable ONLY at the setName level (with every other
 * level showing a read-only "inherited from Set" display). That couldn't
 * represent a real case: a parallel/insert released LATER than its parent
 * set (e.g. a Panini Rewards-exclusive parallel with its own release date).
 * They're now plain features like everything else here — independently
 * editable at every set-side level, copied down at creation like the rest.
 *
 * Collapsible so it never pushes the card list off-screen. Collapsed shows
 * a single summary bar (breadcrumb + an "Edit attributes" toggle). Default
 * collapsed only when `defaultCollapsed` (cards present); expanded otherwise
 * so the setName-with-no-cards flow needs no extra tap.
 *
 * None of these fields are actually required — blank is a perfectly
 * acceptable, complete answer for most of them (not every card is
 * autographed, has a memorabilia relic, a known signer, etc). There is
 * deliberately no "missing"/required warning treatment anywhere in this
 * panel — every row renders identically whether filled in or blank.
 *
 * Save flow:
 *   1. User types a new value into a row.
 *   2. Blur / Enter triggers the mutation (patches this row only).
 *   3. Toast renders "Saved {label}".
 *
 * Clear flow (NEO-217): emptying a text row, or picking the "—" option in a
 * select, sends `value: ""`, which the server treats as "remove this key"
 * (never as a stored empty string). The toast then reads "Cleared {label}".
 * Blank is a complete answer for every field here, so being unable to get back
 * to blank was a hole, not a safeguard.
 *
 * Team (NEO-277): the ONE attribute here that flows down. A whole set can
 * belong to one team — a minor league team set, a police set, a college issue
 * — and typing that team onto every card by hand was the whole cost of
 * building such a set. `teamIds` is a typed top-level field on the row (not a
 * `features` key: it is a link to NB's own `teams` rows, not a string), edited
 * at setName/variantType/insert/parallel through the same `TeamPicker` the
 * card drawer uses. It is rendered FIRST and outside the features grid because
 * it behaves differently from everything in the grid: saving a non-empty value
 * cascades to the rows and cards beneath (server-side, chunked), so the save
 * goes through a confirm that states the card count; clearing it never touches
 * a card, and says so before it happens when cards would be left carrying the
 * team. See `SetTeamRow`.
 *
 * Card prefix (NEO-291): the first cell of the grid, at the levels whose cards
 * carry one — an insert, a parallel, or the base variant type. It is
 * `metadata.cardNumberPrefix`, not a `features` key, and saves through its own
 * mutation; otherwise it behaves exactly like the text rows around it. See
 * `CardPrefixRow`.
 */

/**
 * NEO-291 — where the Card prefix row is editable.
 *
 * The checklist sync reads the prefix off the ancestor chain of the row the
 * cards hang from, so it is edited where cards hang: inserts and parallels
 * always, and a variant type only when it is the base set (Base's cards hang
 * directly from it; any other variant type's cards hang from its inserts).
 * Sport, year, manufacturer and set are containers — a prefix there would
 * apply to every checklist beneath, which no set does.
 */
function showsCardPrefix(level: Level, metadata: unknown): boolean {
  if (level === "insert" || level === "parallel") return true;
  return level === "variantType" && isBaseRole(metadata);
}

/**
 * NEO-277 — where the Team row is editable. Sport, year and manufacturer are
 * containers for many teams' sets; a team only makes sense from the set down.
 */
const TEAM_LEVELS: ReadonlySet<string> = new Set([
  "setName",
  "variantType",
  "insert",
  "parallel",
]);

type Level =
  | "sport"
  | "year"
  | "manufacturer"
  | "setName"
  | "variantType"
  | "insert"
  | "parallel";

/** Human-readable label per selectorOptions level (fixes QA #2). */
const LEVEL_LABEL: Record<Level, string> = {
  sport: "Sport",
  year: "Year",
  manufacturer: "Manufacturer",
  setName: "Set",
  variantType: "Variant",
  insert: "Insert",
  parallel: "Parallel",
};

export default function SetAttributesPanel({
  selectorOptionId,
  defaultCollapsed,
  onDeleted,
}: {
  selectorOptionId: Id<"selectorOptions">;
  /** Start collapsed (cards present) so the panel doesn't push them off-screen. */
  defaultCollapsed?: boolean;
  /**
   * NEO-219 — the row this panel describes was just deleted, so the panel and
   * everything downstream of it is about to be pointing at nothing. The owner
   * (`SetSelector`) clears the selection from `level` down and parks focus on
   * the column, because only it knows where "stable" is; this panel cannot,
   * since it unmounts as part of the same update.
   */
  onDeleted?: (level: SelectorLevel) => void;
}) {
  const row = useQuery(api.selectorOptions.getSelectorOptionById, {
    id: selectorOptionId,
  });
  const chain = useQuery(api.selectorOptions.getAncestorChain, {
    id: selectorOptionId,
  });
  const setSelectorOptionFeature = useMutation(
    api.selectorOptions.setSelectorOptionFeature,
  );
  const setSelectorOptionCardNumberPrefix = useMutation(
    api.selectorOptions.setSelectorOptionCardNumberPrefix,
  );

  const [expanded, setExpanded] = useState(!defaultCollapsed);
  const [toast, setToast] = useState<string | null>(null);

  // Re-evaluate the default whenever the source intent flips (cards
  // appear/disappear or the selected node changes). Without this, drilling
  // from a card-less set into a node with cards would keep the panel
  // expanded (pushing the list down) because state initializes once.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-evaluates the collapse default when the source intent flips; useState only initialises once
    setExpanded(!defaultCollapsed);
  }, [defaultCollapsed, selectorOptionId]);

  // Derive the sport from the ancestor chain so we can drop features that
  // don't apply (e.g. "League" hidden for Pokemon).
  const ancestorSport = useMemo(() => {
    if (!chain) return undefined;
    return chain.find((c) => c.level === "sport")?.value;
  }, [chain]);
  // NEO-277: the sport ROW id, which is what `TeamPicker` scopes its typeahead
  // to and tags a newly-created team with (NEO-96) — never the display name.
  const ancestorSportId = useMemo(() => {
    if (!chain) return undefined;
    return chain.find((c) => c.level === "sport")?._id;
  }, [chain]);

  const applicable = useMemo(() => {
    return EXPECTED_FEATURES.filter((f) => {
      if (f.hiddenAtLevels?.includes("set")) return false;
      if (!f.applicableSports) return true;
      if (!ancestorSport) return true;
      return f.applicableSports.includes(ancestorSport);
    });
  }, [ancestorSport]);

  if (!row || !chain) return null;

  const leafLevel = row.level as Level;
  const features = row.features ?? {};
  const teamIds: Array<Id<"teams">> = row.teamIds ?? [];
  const showTeamRow = TEAM_LEVELS.has(leafLevel);
  const showCardPrefixRow = showsCardPrefix(leafLevel, row.metadata);
  const cardNumberPrefix = row.metadata?.cardNumberPrefix;

  // Toggle-pill features (checkbox + toggleOptions) render together in one
  // wrapping row instead of scattered through the 2-column grid at their
  // config-order position.
  const toggleFeatures = applicable.filter(
    (f) => f.inputType === "checkbox" || f.inputType === "toggleOptions",
  );
  const otherFeatures = applicable.filter(
    (f) => f.inputType !== "checkbox" && f.inputType !== "toggleOptions",
  );

  // Breadcrumb: "Attributes for {leaf} ({levelLabel}) — a › b › c".
  const breadcrumb = chain.map((c) => c.value).join(" › ");
  const headerTitle = `Attributes for ${row.value} (${LEVEL_LABEL[leafLevel]})`;

  /**
   * Raise a transient confirmation.
   *
   * Shared by the feature rows below and by the header's base-role control
   * (NEO-239), which is why it is a helper rather than an inline setToast:
   * two callers raising a 6s toast had to agree on the 6s.
   */
  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 6000);
  };

  /**
   * NEO-217 — an empty value CLEARS the attribute; it is not a no-op.
   *
   * This used to return early on `""`, which meant nothing set at this level
   * could ever be un-set: a League typed by mistake, or a Season that turned
   * out to belong to the parallel rather than the set, was permanent. The
   * server now removes the key entirely for `""` (never stores an empty
   * string — "attribute gone" has one spelling, absence), so the only thing
   * needed here is to stop swallowing the empty commit and to say which of
   * the two things happened.
   */
  const handleSaveFeature = async (
    key: string,
    label: string,
    value: string,
  ) => {
    const trimmed = value.trim();
    const clearing = trimmed.length === 0;
    // A clear of an already-absent key is the real no-op — `features[key]`
    // is undefined, and `"" === undefined` is false, so it needs saying.
    if (clearing ? features[key] === undefined : features[key] === trimmed) {
      return;
    }
    // Optimistic confirmation — the mutation is a single-row patch
    // (NEO-71-74), no propagation counts to report. "Saved {label}" is
    // unchanged (Maestro asserts it); "Cleared {label}" is the new string,
    // deliberately distinct so the toast never claims a value was stored.
    showToast(clearing ? `Cleared ${label}` : `Saved ${label}`);
    try {
      await setSelectorOptionFeature({ selectorOptionId, key, value: trimmed });
    } catch (e) {
      // NEVER a raw `.message`. Production redacts a plain Error to "Server
      // Error", and even a surviving message reaches the client wrapped in
      // "[CONVEX M(selectorOptions:setSelectorOptionFeature)] [Request ID: …]"
      // — so the old `Failed: ${e.message}` toast showed an operator either
      // nothing useful or a request id. Only a ConvexError's `data` is text a
      // backend deliberately chose for a person, and `userFacingMessage` is
      // the one place that rule lives.
      setToast(`Failed: ${userFacingMessage(e, `Could not save ${label}`)}`);
    }
  };

  /**
   * NEO-291 — the Card prefix row's save. Same shape as `handleSaveFeature`
   * (no-op on an unchanged value, optimistic toast, `userFacingMessage` on
   * failure) with its own mutation, because the prefix is
   * `metadata.cardNumberPrefix` rather than a `features` key. The server
   * trims and treats `""` as "remove the key", so the clear/save split here
   * is only for the toast's sake.
   */
  const handleSaveCardNumberPrefix = async (value: string) => {
    const label = "Card prefix";
    const trimmed = value.trim();
    const clearing = trimmed.length === 0;
    if (
      clearing ? cardNumberPrefix === undefined : cardNumberPrefix === trimmed
    ) {
      return;
    }
    showToast(clearing ? `Cleared ${label}` : `Saved ${label}`);
    try {
      await setSelectorOptionCardNumberPrefix({
        id: selectorOptionId,
        cardNumberPrefix: trimmed,
      });
    } catch (e) {
      setToast(`Failed: ${userFacingMessage(e, `Could not save ${label}`)}`);
    }
  };

  return (
    <div
      className="border border-gray-700 rounded-lg bg-gray-900/60 p-4 space-y-3"
      role="region"
      aria-label="Set attributes panel"
    >
      {/* Breadcrumb header (fixes QA #2 — which level/column applies). */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* NEO-96: the rename pencil sits immediately after the title
              because the title IS the name it edits — that adjacency is the
              only thing making it discoverable. The panel scopes itself to the
              deepest current selection at ANY level, so this one control
              renames sports, years, manufacturers, sets and variants alike. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-sm font-semibold text-gray-100">
              {headerTitle}
            </h3>
            {/* NEO-239: every level renames, variantType included. Base is an
                NB role flag and the BSC `variant` facet comes off the row's
                tagged slot, so no display value is load-bearing any more. */}
            <RenameEntityControl id={selectorOptionId} currentValue={row.value} />
            {/* NEO-239: which variant type is the set's base is IDENTITY, not
                an attribute, so it sits with the name rather than in the grid
                below — and stays reachable while the panel is collapsed, which
                is how an operator building a set by hand will meet it. Only
                variant types have the role; nothing else in the hierarchy can
                be a base set. */}
            {leafLevel === "variantType" && (
              <BaseRoleControl
                id={selectorOptionId}
                value={row.value}
                metadata={row.metadata}
                onResult={showToast}
              />
            )}
            {/* NEO-279: fill the teams this set's cards are missing from the
                set's own evidence. Set level only — "the same player elsewhere
                in this set" is a whole-set fact — and up here with the name
                rather than in the grid below because it is an ACTION on the
                cards, not an attribute of the row, and because it has to be
                reachable while the panel is collapsed, which is the state an
                operator reviewing a freshly synced checklist meets it in.
                Keyed on the row for the same reason the delete is: the panel
                does not remount when the selection moves, and a preview
                dialog opened for one set must never ask about the next. The
                key carries its own prefix because the delete control beside
                it is keyed on the same id, and two siblings sharing a key is
                the one thing React refuses to reconcile — CI run 34930152576
                rendered this button THREE times after a drill and routed the
                dialog's state updates to the wrong copy, so "Filling…" never
                ended. */}
            {leafLevel === "setName" && (
              <FillTeamsControl
                key={`fill-teams-${selectorOptionId}`}
                id={selectorOptionId}
                level={leafLevel}
                showToast={showToast}
              />
            )}
            {/* NEO-219: the one sanctioned delete, next to the pencil for the
                same reason the pencil is next to the title — the title IS the
                row it acts on.
                NEO-239: this used to be wrapped in `canRenameSelectorRow(row)`,
                which meant "hide it on a variantType that is not custom". That
                predicate is gone with the custom concept — a row either carries
                marketplace ids or it does not, and both behave the same — so
                the gate is now the control's OWN, and it is a better one: it
                reads `getSelectorOptionHoldings` and renders nothing for a
                protected row, an explained refusal for a row with something
                below it, and the confirm only when the row is genuinely empty.
                Server-side emptiness + protection checks still run
                independently. Nothing became deletable that the server would
                not already have let go. */}
            <DeleteSelectorRowControl
              // Keyed on the row: this panel does NOT remount when the
              // selection moves, so without this a dialog opened for one row
              // — or a revealed reason belonging to it — would survive onto
              // the next one and ask its question about the wrong thing.
              key={selectorOptionId}
              id={selectorOptionId}
              row={row}
              level={leafLevel}
              onDeleted={onDeleted}
            />
          </div>
          <p className="text-xs text-gray-500 mt-0.5 truncate" title={breadcrumb}>
            {breadcrumb}
            {/* NEO-277: the set's team, said the way a collector says it —
                "Bulls", in Durham Bulls blue — on the collapsed summary bar,
                which is the state this panel spends almost all of its life in.
                Only while collapsed: expanded, the picker two lines down shows
                the same fact with the full name and a remove button, and a
                chip that repeats it is an accessory to take off. */}
            {!expanded && showTeamRow && teamIds.length > 0 && (
              <SetTeamLivery teamIds={teamIds} />
            )}
          </p>
        </div>
        {expanded ? (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-label="Hide attributes"
            className="shrink-0 text-xs text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none"
          >
            Hide attributes ▴
          </button>
        ) : (
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setExpanded(true)}
              aria-label="Edit attributes"
              className="text-xs text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none"
            >
              Edit attributes ▾
            </button>
          </div>
        )}
      </div>

      {toast && (
        // NEO-47: position the save confirmation FIXED in the viewport, not
        // in-flow above the grid. A save made while scrolled down to the
        // feature rows would otherwise render the toast off-screen above
        // the fold — invisible to the user (and the e2e assertion).
        //
        // NEO-239: outside the `expanded` branch, because the header now holds
        // a control ("Mark as base set") that is reachable while the panel is
        // collapsed. A confirmation that only renders in the expanded state
        // would leave that action looking like it did nothing.
        <div
          className="fixed top-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-gray-900 border border-[#00D558]/60 rounded text-xs text-[#00D558] shadow-lg"
          role="status"
          aria-live="polite"
        >
          {toast}
        </div>
      )}

      {expanded && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
              Set attributes
            </span>
          </div>

          {/* NEO-277: FIRST, full width, and outside the grid — the position
              is the information. Every row below is a fact about THIS node
              only (write-once snapshots, no cascade); this one flows down to
              every card. Keyed on the row so a confirm opened for one set can
              never ask its question about the next one — the same reason
              `DeleteSelectorRowControl` is keyed. */}
          {showTeamRow && (
            <SetTeamRow
              key={selectorOptionId}
              selectorOptionId={selectorOptionId}
              level={leafLevel}
              teamIds={teamIds}
              teamCascadeStartedAt={row.teamCascadeStartedAt}
              sportId={ancestorSportId}
              onSaved={showToast}
              onFailed={(message) => setToast(`Failed: ${message}`)}
            />
          )}

          {toggleFeatures.length > 0 && (
            <div
              className="flex flex-wrap items-center gap-2"
              role="group"
              aria-label="Set attribute toggles"
            >
              {toggleFeatures.map((feat) => (
                <SetFeatureRow
                  key={feat.key}
                  feat={feat}
                  value={features[feat.key]}
                  onSave={(v) => handleSaveFeature(feat.key, feat.label, v)}
                />
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {/* NEO-291: first cell, because it is the one fact here that
                changes how the cards beneath are NUMBERED — every card in an
                insert wears it — and an operator building a Diamond Kings
                insert meets it before League or Era. Only at the levels
                cards hang from; see `showsCardPrefix`. */}
            {showCardPrefixRow && (
              <CardPrefixRow
                value={cardNumberPrefix}
                onSave={handleSaveCardNumberPrefix}
              />
            )}
            {otherFeatures.map((feat) => (
              <SetFeatureRow
                key={feat.key}
                feat={feat}
                value={features[feat.key]}
                onSave={(v) => handleSaveFeature(feat.key, feat.label, v)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Editable feature row. Maestro targets `Value for {label}` — DO NOT rename.
 */
function SetFeatureRow({
  feat,
  value,
  onSave,
}: {
  feat: ExpectedFeature;
  value: string | undefined;
  onSave: (value: string) => Promise<unknown>;
}) {
  const label = feat.label;
  // Unique per-field marker class so Maestro's inputText targets THIS field
  // rather than the first input sharing the className (see useFieldTestClass).
  const fieldClass = useFieldTestClass();

  // "checkbox" features store "true"/"false" strings in the `features` map
  // (unlike "boolean", which is bound to a real schema column and isn't
  // meaningful at the set level). Unchecked/unset is itself a complete
  // answer, so this never shows the amber "missing" treatment. "toggleOptions"
  // renders the same bare-pill way (no label/box chrome) so it sits
  // indistinguishably in the shared toggle row.
  if (feat.inputType === "checkbox" || feat.inputType === "toggleOptions") {
    return (
      <div
        className="flex flex-row items-center"
        aria-label={`Set feature ${label}`}
      >
        <FeatureValueControl
          feat={feat}
          value={value ?? ""}
          onSave={onSave}
          ariaLabel={`Value for ${label}`}
          dataFeatKey={feat.key}
          className=""
        />
      </div>
    );
  }

  // "boolean" has no typed target at the set level (no set-level isRookie
  // column) and is filtered out via `hiddenAtLevels` before reaching here —
  // this is a defensive fallback, not an expected path.
  if (feat.inputType === "boolean") {
    console.warn(
      `SetFeatureRow: unexpected boolean-type feature "${feat.key}" at set level; rendering read-only.`,
    );
    return (
      <div
        className="flex flex-col gap-0.5 p-2 rounded border text-xs border-gray-700 bg-gray-900/30"
        aria-label={`Set feature ${label}`}
      >
        <span className="text-[10px] uppercase tracking-wide text-gray-400">
          {label}
        </span>
        <span className="text-gray-300">{value ?? "—"}</span>
      </div>
    );
  }

  return (
    <label
      className="flex flex-col gap-0.5 p-2 rounded border text-xs border-gray-700 bg-gray-900/30"
      aria-label={`Set feature ${label}`}
    >
      <span className="flex items-center justify-between text-[10px] uppercase tracking-wide text-gray-400">
        <span
          title={feat.hint}
          className={
            feat.hint
              ? "cursor-help underline decoration-dotted decoration-gray-500"
              : undefined
          }
        >
          {label}
        </span>
      </span>
      <FeatureValueControl
        feat={feat}
        value={value ?? ""}
        onSave={onSave}
        // NEO-217: without this, `useReactiveField` treats an empty commit as
        // "revert" and writes the old value straight back into the input — the
        // operator deletes the text, tabs out, and watches it reappear. Routing
        // it to `onSave("")` is what makes a set attribute clearable.
        onEmptyCommit={() => onSave("")}
        ariaLabel={`Value for ${label}`}
        placeholder="—"
        dataFeatKey={feat.key}
        className={`${fieldClass()} w-full p-1 border rounded text-xs dark:bg-gray-900 dark:border-gray-700 focus:border-[#00D558] focus:outline-none`}
      />
    </label>
  );
}

// ---------------------------------------------------------------------------
// NEO-277 — Team: the one attribute that flows down
// ---------------------------------------------------------------------------

/**
 * What a save of `teamIds` on this node would change beneath it — the
 * server's `getSelectorOptionTeamCascadePreview` answer.
 *
 * The confirm speaks in CARDS only. `nodesFollowing` is still counted (the
 * descendant rows that will carry the team down to cards created later) but
 * a collector does not think in variant rows, so it is never in a sentence.
 */
type TeamCascadePreview = {
  nodesFollowing: number;
  /** Cards that will get the new team: empty, or equal to this node's current team. */
  cardsFollowing: number;
  /** Every card that stays — the sum of the three reasons below. */
  cardsStaying: number;
  /** …because it carries a team of its own that is neither empty nor this node's. */
  cardsOverridden: number;
  /** …because an operator marked it as having no team. */
  cardsTeamless: number;
  /** …because it holds a team NAME still waiting for review, not a team row. */
  cardsPendingName: number;
  /**
   * Cards set-equal to this node's CURRENT team. Only meaningful for a
   * preview asked with `teamIds: []`: it is what a clear would leave behind.
   */
  cardsCarryingCurrent: number;
  /** Counting stopped early; every count above is a floor, not a total. */
  truncated: boolean;
};

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** How long a scheduled cascade is believed to still be running. */
const CASCADE_IN_FLIGHT_MS = 10 * 60 * 1000;

/**
 * "28 cards" — or, when the preview stopped counting, "more than 500 cards":
 * the floor is said up front rather than pretending to a total.
 */
function followingCards(preview: TeamCascadePreview): string {
  const cards = plural(preview.cardsFollowing, "card", "cards");
  return preview.truncated ? `more than ${cards}` : cards;
}

/**
 * The staying sentence, split by reason so the operator can tell WHY a card
 * is not following — a card on another team, a card confirmed as having no
 * team, and a card whose typed team name is still in review are three
 * different situations with three different remedies. Only non-zero parts
 * are said; the noun "card(s)" rides on the first part only, the way a
 * person lists them.
 *
 *   "2 cards carry a different team, 1 is marked as having no team,
 *    3 have a team name waiting for review — these will not change."
 */
function stayingSentence(preview: TeamCascadePreview): string {
  type Part = { count: number; lead: [string, string]; follow: [string, string] };
  const all: Part[] = [
    {
      count: preview.cardsOverridden,
      lead: ["card carries a different team", "cards carry a different team"],
      follow: ["carries a different team", "carry a different team"],
    },
    {
      count: preview.cardsTeamless,
      lead: [
        "card is marked as having no team",
        "cards are marked as having no team",
      ],
      follow: ["is marked as having no team", "are marked as having no team"],
    },
    {
      count: preview.cardsPendingName,
      lead: [
        "card has a team name waiting for review",
        "cards have a team name waiting for review",
      ],
      follow: [
        "has a team name waiting for review",
        "have a team name waiting for review",
      ],
    },
  ];
  const parts = all.filter((p) => p.count > 0);
  if (parts.length === 0) return "";
  const phrases = parts.map((p, i) => {
    const [one, many] = i === 0 ? p.lead : p.follow;
    return plural(p.count, one, many);
  });
  return `${phrases.join(", ")} — these will not change.`;
}

/**
 * The apply confirm's title and body, pure so the pluralisation, the split
 * staying sentence and the truncated floor can be pinned in a test without a
 * picker in the way.
 *
 *   title: "Apply Durham Bulls to this set?"
 *   body:  "28 cards under this set will get Durham Bulls. 2 cards carry a
 *           different team — these will not change."
 *
 * The second sentence only appears when something is staying, because "0
 * cards carry a different team" is reassurance nobody asked for. "This set" /
 * "this insert" / … follows the node's level, so the question is about the
 * thing the operator has selected, not a generic set.
 */
export function teamCascadeConfirmCopy({
  teamNames,
  levelLabel,
  preview,
}: {
  teamNames: string;
  levelLabel: string;
  preview: TeamCascadePreview;
}): { title: string; description: string } {
  const noun = levelLabel.toLowerCase();
  const following = followingCards(preview);
  const first = `${following.charAt(0).toUpperCase()}${following.slice(1)} under this ${noun} will get ${teamNames}.`;
  const staying = stayingSentence(preview);
  return {
    title: `Apply ${teamNames} to this ${noun}?`,
    description: staying ? `${first} ${staying}` : first,
  };
}

/**
 * The clear confirm — asked only when cards beneath are set-equal to the
 * team being taken off, because those are the cards an operator who picked
 * the wrong team is about to strand. The body says the way out: a clear
 * touches the node only, but a REPLACEMENT carries those cards along.
 *
 *   title: "Take Durham Bulls off this set?"
 *   body:  "28 cards keep Durham Bulls. Picked the wrong team? Pick the
 *           right one instead and they'll follow."
 */
export function teamClearConfirmCopy({
  teamNames,
  levelLabel,
  cardsCarryingCurrent,
}: {
  teamNames: string;
  levelLabel: string;
  cardsCarryingCurrent: number;
}): { title: string; description: string } {
  const noun = levelLabel.toLowerCase();
  return {
    title: `Take ${teamNames} off this ${noun}?`,
    description: `${plural(cardsCarryingCurrent, "card keeps", "cards keep")} ${teamNames}. Picked the wrong team? Pick the right one instead and they'll follow.`,
  };
}

/**
 * The toast after a confirmed save: "Saved Team · applying to 28 cards".
 * "Applying", present tense, because the cascade is scheduled and chunked
 * server-side and may still be running when this reads — the toast says what
 * was started; "Team applied to cards" says when it finished (see the
 * in-flight handling in `SetTeamRow`).
 */
export function teamSavedToast(preview: TeamCascadePreview | null): string {
  if (!preview || preview.cardsFollowing === 0) {
    return "Saved Team";
  }
  return `Saved Team · applying to ${followingCards(preview)}`;
}

/**
 * The visible hint under the picker, keyed on the level because the set is
 * where a collector meets this (a team issue, a police set, a college set, a
 * stadium giveaway) and a variant beneath it only needs the mechanism.
 */
export function teamHintCopy(level: Level): string {
  if (level === "setName") {
    return "Team issues, police sets, college sets, stadium giveaways: pick the team once and every card in this set gets it.";
  }
  return `Every card in this ${LEVEL_LABEL[level].toLowerCase()} gets this team. Pick it once.`;
}

/** Order-insensitive equality: the picker appends, the row stores a set. */
function sameTeamIds(
  a: ReadonlyArray<Id<"teams">>,
  b: ReadonlyArray<Id<"teams">>,
): boolean {
  if (a.length !== b.length) return false;
  const sorted = (xs: ReadonlyArray<Id<"teams">>) =>
    [...(xs as ReadonlyArray<string>)].sort();
  const sa = sorted(a);
  const sb = sorted(b);
  return sa.every((id, i) => id === sb[i]);
}

/**
 * NEO-277 — the set row's picker exposes DIFFERENT accessible names from the
 * card drawer's, the quick-add form's and the attention walker's, because this
 * panel can be expanded while any of those has a picker open beneath it, and
 * neither hides the other. Whole-string rewords, never a suffix: Maestro's
 * `id:` selector is a regex find over the aria-label, so "Add team to set"
 * would make a flow's `id: "Add team"` match both. Each string shares no
 * substring with its default in either direction — pinned in
 * `SetAttributesPanel.test.tsx`, because the failure is silent both ways.
 *
 * `trigger` is also the trigger's VISIBLE text ("+ Add set team"), so it has
 * to read as a button label and not only as a name — SC 2.5.3.
 *
 * Module scope so the object identity is stable across renders and the E2E
 * author has one place to read the real strings from.
 */
export const SET_TEAM_PICKER_LABELS: TeamPickerLabels = {
  root: "Whole-set team",
  trigger: "Add set team",
  search: "Find a team for the set",
  results: "Set team matches",
};

/** The picker trigger inside the row, for parking focus after a decision. */
const PICKER_TRIGGER_SELECTOR = `button[aria-label="${SET_TEAM_PICKER_LABELS.trigger}"]`;

/**
 * The Team row.
 *
 * Save flow, the only one in this panel with a question in it:
 *   1. A pick in `TeamPicker` calls `onChange(next)` with the full array.
 *   2. The picker shows `next` at once (`pending`), and two one-shot reads go
 *      out together: the cascade preview for `next`, and the team rows for
 *      their names. Imperative `convex.query` rather than `useQuery`, because
 *      this is a question asked once per pick, not a subscription.
 *   3. Cards follow → `ConfirmDialog` with the count. No card follows (an
 *      empty set, or every card already carries a different team) → save
 *      straight away; a question with only one honest answer is not asked.
 *   4. Confirm → `setSelectorOptionTeams` → "Saved Team · applying to …".
 *      Cancel → `pending` is dropped and the picker reads the row again.
 *
 * Change-team flow — the gesture this row exists for. The picker is
 * append-only, so "Bulls → Mudcats" is × on Bulls then add Mudcats. If the ×
 * saved a clear, the add would then arrive with an EMPTY previous value and
 * every card would silently stay on Bulls. So removing the LAST chip never
 * saves: the row goes into a pending-empty state — the picker shows no chips,
 * the stored value is untouched, and two actions appear beneath: "Clear team"
 * and "Keep {team}". Adding a team from there is the ordinary non-empty path,
 * and because the server's `previous` is still the stored team, the Bulls
 * cards are the ones reported as following. Moving the selection to another
 * row discards the pending state (this component is keyed on the row).
 *
 * Clear flow: "Clear team" asks the preview with `[]`; when cards beneath
 * carry this node's current team it opens a confirm that says they will keep
 * it and how to bring them along instead. Confirm (or nothing to strand) →
 * `[]` is saved, which patches the node only. Removing one chip of a
 * multi-team row is the ordinary non-empty path.
 *
 * In flight: while the row carries a fresh `teamCascadeStartedAt` the cascade
 * is still writing cards beneath it. The picker is disabled and a status line
 * says so; the moment the field clears, "Team applied to cards". The server
 * refuses a save in that window with a `ConvexError`, whose text the failure
 * toast shows as it is.
 *
 * A pick made while an earlier preview is still in flight supersedes it
 * (`seq`): the later answer is the only one the operator can still be asking
 * about.
 *
 * Focus: `ConfirmDialog` returns focus to whatever had it when it opened —
 * which, after a pick, is the picker's popover search box. Opening the dialog
 * blurs the picker, the picker closes its popover, and the box is gone by the
 * time the dialog closes, so the dialog's own restore finds nothing connected.
 * This row parks focus on the picker's "+ Add set team" trigger itself
 * instead: after a confirm or cancel, after a clear, after "Keep", and on
 * entering the pending-empty state (the × that got us there has just
 * unmounted under the operator's finger). Focus never falls to `<body>`.
 */
function SetTeamRow({
  selectorOptionId,
  level,
  teamIds,
  teamCascadeStartedAt,
  sportId,
  onSaved,
  onFailed,
}: {
  selectorOptionId: Id<"selectorOptions">;
  level: Level;
  /** The row's stored value; `[]` when the field is absent. */
  teamIds: Array<Id<"teams">>;
  /** Set when a cascade is scheduled, cleared by its last chunk. */
  teamCascadeStartedAt: number | undefined;
  sportId: Id<"selectorOptions"> | undefined;
  onSaved: (message: string) => void;
  onFailed: (message: string) => void;
}) {
  const convex = useConvex();
  const setSelectorOptionTeams = useMutation(
    api.selectorOptions.setSelectorOptionTeams,
  );
  // The stored team's rows, for "Keep Durham Bulls" and the clear confirm.
  // A subscription (not a one-shot) because the label is on screen for as
  // long as the pending-empty state is; Convex dedupes it with the picker's
  // own read of the same ids.
  const storedRows = useQuery(api.teams.getManyByIds, { ids: teamIds });
  const storedNames =
    storedRows && storedRows.length > 0
      ? joinLabels(storedRows.map((t) => teamFullName(t)))
      : null;
  const labelId = useId();
  const hintId = useId();
  const rowRef = useRef<HTMLDivElement | null>(null);
  const seqRef = useRef(0);

  /** The picker's value while a pick is being previewed or saved. */
  const [pending, setPending] = useState<Array<Id<"teams">> | null>(null);
  /** The last chip was removed and the operator has not yet said which way. */
  const [pendingEmpty, setPendingEmpty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{
    kind: "apply" | "clear";
    next: Array<Id<"teams">>;
    preview: TeamCascadePreview | null;
    title: string;
    description: string;
  } | null>(null);

  // --- cascade in flight -------------------------------------------------
  // `now` exists so a fresh timestamp can go stale while this row is mounted
  // (a cascade that died mid-way must not lock the row forever): the effect
  // schedules one re-read at the moment it would cross the line.
  const [now, setNow] = useState(() => Date.now());
  const inFlight =
    teamCascadeStartedAt !== undefined &&
    now - teamCascadeStartedAt < CASCADE_IN_FLIGHT_MS;
  useEffect(() => {
    if (!inFlight || teamCascadeStartedAt === undefined) return;
    const remaining = teamCascadeStartedAt + CASCADE_IN_FLIGHT_MS - Date.now();
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [inFlight, teamCascadeStartedAt]);

  // "Team applied to cards" — said once, when the field the server set at
  // schedule time is cleared by the cascade's last chunk. A stale timestamp
  // expiring is NOT that: nothing finished, the row is merely usable again.
  const prevStartedAtRef = useRef(teamCascadeStartedAt);
  useEffect(() => {
    const prev = prevStartedAtRef.current;
    prevStartedAtRef.current = teamCascadeStartedAt;
    if (prev !== undefined && teamCascadeStartedAt === undefined) {
      onSaved("Team applied to cards");
    }
    // `onSaved` is a fresh closure per parent render; the transition is what
    // this effect is about.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamCascadeStartedAt]);

  const focusTrigger = () => {
    setTimeout(() => {
      rowRef.current
        ?.querySelector<HTMLElement>(PICKER_TRIGGER_SELECTOR)
        ?.focus();
    }, 0);
  };

  const save = async (
    next: Array<Id<"teams">>,
    preview: TeamCascadePreview | null,
  ) => {
    setBusy(true);
    try {
      await setSelectorOptionTeams({ selectorOptionId, teamIds: next });
      onSaved(
        next.length === 0
          ? "Cleared Team · cards unchanged"
          : teamSavedToast(preview),
      );
    } catch (e) {
      // Same rule as the feature rows: only a ConvexError's `data` is text a
      // backend chose for a person; anything else is the fallback. The
      // server's "Still applying the last team change…" refusal is one such
      // and reads as it was written.
      onFailed(userFacingMessage(e, "Could not save Team"));
    } finally {
      setBusy(false);
      setPending(null);
      setPendingEmpty(false);
    }
  };

  const handleChange = async (next: Array<Id<"teams">>) => {
    if (busy || inFlight) return;
    if (sameTeamIds(next, teamIds)) {
      // Includes re-adding the stored team from the pending-empty state:
      // that is "Keep", spelled with the picker.
      setPending(null);
      setPendingEmpty(false);
      return;
    }
    const seq = ++seqRef.current;
    setPending(next);

    if (next.length === 0) {
      // Never a save. The stored value stands until the operator says
      // "Clear team", "Keep …", or picks a replacement.
      setPendingEmpty(true);
      focusTrigger();
      return;
    }
    setPendingEmpty(false);

    let preview: TeamCascadePreview;
    let names: string;
    try {
      const [p, rows] = await Promise.all([
        convex.query(api.selectorOptions.getSelectorOptionTeamCascadePreview, {
          selectorOptionId,
          teamIds: next,
        }),
        convex.query(api.teams.getManyByIds, { ids: next }),
      ]);
      preview = p;
      names = joinLabels(rows.map((t) => teamFullName(t)));
    } catch (e) {
      if (seq !== seqRef.current) return;
      setPending(null);
      onFailed(userFacingMessage(e, "Could not save Team"));
      return;
    }
    // A later pick has taken over; this answer is about a value the picker
    // no longer shows.
    if (seq !== seqRef.current) return;

    if (preview.cardsFollowing === 0) {
      await save(next, preview);
      return;
    }
    setConfirm({
      kind: "apply",
      next,
      preview,
      ...teamCascadeConfirmCopy({
        teamNames: names,
        levelLabel: LEVEL_LABEL[level],
        preview,
      }),
    });
  };

  const handleClear = async () => {
    if (busy || inFlight) return;
    const seq = ++seqRef.current;
    setBusy(true);
    let preview: TeamCascadePreview;
    try {
      preview = await convex.query(
        api.selectorOptions.getSelectorOptionTeamCascadePreview,
        { selectorOptionId, teamIds: [] },
      );
    } catch (e) {
      setBusy(false);
      if (seq !== seqRef.current) return;
      onFailed(userFacingMessage(e, "Could not save Team"));
      return;
    }
    if (seq !== seqRef.current) {
      setBusy(false);
      return;
    }
    if (preview.cardsCarryingCurrent === 0) {
      await save([], null);
      focusTrigger();
      return;
    }
    setBusy(false);
    setConfirm({
      kind: "clear",
      next: [],
      preview,
      ...teamClearConfirmCopy({
        teamNames: storedNames ?? "the team",
        levelLabel: LEVEL_LABEL[level],
        cardsCarryingCurrent: preview.cardsCarryingCurrent,
      }),
    });
  };

  const handleKeep = () => {
    if (busy) return;
    seqRef.current++;
    setPending(null);
    setPendingEmpty(false);
    focusTrigger();
  };

  const showPendingActions = pendingEmpty && !inFlight;

  return (
    <div
      ref={rowRef}
      role="group"
      aria-labelledby={labelId}
      aria-describedby={hintId}
      className="flex flex-col gap-1 p-2 rounded border text-xs border-gray-700 bg-gray-900/30"
    >
      <span
        id={labelId}
        className="text-[10px] uppercase tracking-wide text-gray-400"
      >
        Team
      </span>
      <TeamPicker
        value={inFlight ? teamIds : (pending ?? teamIds)}
        onChange={(next) => void handleChange(next)}
        sportId={sportId}
        disabled={busy || inFlight}
        labels={SET_TEAM_PICKER_LABELS}
        ariaDescribedBy={hintId}
      />
      {inFlight && (
        // Next to the control it describes, not only in the toast: this is
        // the state the operator will find the row in after a save, and a
        // disabled picker with no sentence beside it is a question.
        <p role="status" className="text-[10px] text-[#00D558]">
          Applying to cards…
        </p>
      )}
      {showPendingActions && (
        // The two honest answers to "the chip is gone — now what?". Text
        // buttons in the panel's own weight, the clear in the pink every
        // remove in this app wears on hover, the keep in the green every
        // affirm wears — the colour says which way each one leans before the
        // word is read. Neither is a default: reflexive Enter here does
        // nothing, because focus went to the trigger.
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void handleClear()}
            disabled={busy}
            className="text-[11px] text-gray-300 underline decoration-dotted underline-offset-2 hover:text-[#FF2EB3] focus:text-[#FF2EB3] focus:outline-none disabled:opacity-50"
          >
            Clear team
          </button>
          <button
            type="button"
            onClick={handleKeep}
            disabled={busy}
            className="text-[11px] text-gray-300 underline decoration-dotted underline-offset-2 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none disabled:opacity-50"
          >
            Keep {storedNames ?? "current team"}
          </button>
        </div>
      )}
      {/* Visible, not a tooltip like the feature hints: this is the one row
          whose save reaches beyond the row, and that has to be readable
          before the pick, not discoverable after it. gray-400 on this
          ground clears 4.5:1 (the pair every sub-line in this panel uses). */}
      <p id={hintId} className="text-[10px] text-gray-400">
        {teamHintCopy(level)}
      </p>
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          description={confirm.description}
          confirmLabel={confirm.kind === "clear" ? "Yes, clear" : "Yes, apply"}
          busyLabel={confirm.kind === "clear" ? "Clearing…" : "Applying…"}
          busy={busy}
          onConfirm={() => {
            if (busy) return;
            const { next, preview } = confirm;
            void save(next, preview).finally(() => {
              setConfirm(null);
              focusTrigger();
            });
          }}
          onCancel={() => {
            if (busy) return;
            setConfirm(null);
            if (confirm.kind === "clear") {
              // Still pending-empty; the dialog hands focus back to the
              // "Clear team" button it opened from, which is still here.
              return;
            }
            setPending(null);
            focusTrigger();
          }}
        />
      )}
    </div>
  );
}

/**
 * Composited panel ground for the contrast gate below: `bg-gray-900/60`
 * (#111827 at 60%) over the near-black page (#0a0a0a). Worked out once here
 * rather than guessed, because a franchise colour can clear 4.5:1 on pure
 * black and miss it on this slightly lifted surface.
 */
const PANEL_GROUND = "#0e121b";

/** WCAG 2.2 SC 1.4.3 for text this size. A gate, not a readout — this is UI. */
const LIVERY_MIN_CONTRAST = 4.5;

/**
 * The team's own colour for its name, or null to leave it muted.
 *
 * Primary first, secondary as the fallback, muted when neither clears the
 * floor — the same order the Players page uses, for the same reason: many
 * franchises are built on a near-black navy or maroon whose secondary is the
 * pale one they print the dark on, so the fallback is usually the right
 * colour as well as the readable one. Colour is never the only carrier: the
 * word reads the same whichever branch is taken (SC 1.4.1).
 */
function teamTextColor(
  colors: { primary?: string; secondary?: string } | undefined,
): string | null {
  for (const candidate of [colors?.primary, colors?.secondary]) {
    if (!candidate) continue;
    const hex = normalizeHexColor(candidate);
    if (!hex) continue;
    const ratio = contrastRatio(hex, PANEL_GROUND);
    if (ratio !== null && ratio >= LIVERY_MIN_CONTRAST) return hex;
  }
  return null;
}

/**
 * NEO-277 — the set's team on the collapsed summary bar, in livery.
 *
 * The short name ("Bulls"), because that is what a collector says and the
 * bar is one truncating line; the full name rides on `title` and in the
 * accessible text. Renders nothing until the rows arrive rather than a
 * "Loading…" — a summary bar that flickers a placeholder on every selection
 * change is worse than one that fills in a beat later.
 */
function SetTeamLivery({ teamIds }: { teamIds: Array<Id<"teams">> }) {
  const rows = useQuery(api.teams.getManyByIds, { ids: teamIds });
  if (!rows || rows.length === 0) return null;
  return (
    <span className="ml-1.5 whitespace-nowrap">
      <span aria-hidden="true">· </span>
      <span className="sr-only">Team: </span>
      {rows.map((team, i) => {
        const color = teamTextColor(team.colors);
        return (
          <span key={team._id}>
            {i > 0 && ", "}
            <span
              title={teamFullName(team)}
              className={color ? "font-semibold" : "font-semibold text-gray-300"}
              style={color ? { color } : undefined}
            >
              {teamShortName(team)}
            </span>
          </span>
        );
      })}
    </span>
  );
}

// ---------------------------------------------------------------------------
// NEO-219 — the one sanctioned delete
// ---------------------------------------------------------------------------

/**
 * "Sets are fixed, never deleted" holds, with ONE exception agreed 2026-09-03:
 * a row with nothing below it — no child rows, no cards anywhere in its
 * subtree, no cross-listings, and at sport level no players/teams/leagues —
 * may be removed. That is the whole rule, and it is checked SERVER-side; this
 * control only mirrors it so the operator is not offered an action that will
 * be refused.
 *
 * Two states, both stated in words rather than colour:
 *   • holdings exist → the button is `aria-disabled` and names what is below
 *     it ("Holds 3 sets and 220 cards — delete what is below it first").
 *     Clicking reveals that sentence visually, because "why is this greyed
 *     out?" is the question a disabled control always raises and a permanent
 *     line of it under every row in the Set Builder is noise. The sentence is
 *     in the DOM at all times as the button's `aria-describedby` target, so a
 *     screen reader hears the reason without the reveal.
 *   • nothing below it → a ConfirmDialog, Cancel-focused (decision 3), which
 *     additionally says the row may come back if it carries a marketplace id:
 *     an empty SYNCED row deleted today is re-inserted by the next Sync Sets,
 *     which is harmless but surprising if unannounced.
 *
 * A `SELECTOR_ROW_NOT_EMPTY` refusal is a real race, not a bug: the holdings
 * query and the click are separated by however long the operator read the
 * dialog. It renders the server's own `holds` inside the dialog rather than
 * closing, so the answer arrives where the question was asked.
 */

/** One thing standing in the way of a delete, as the server reports it. */
type SelectorHolding = {
  kind: string;
  count: number;
  /**
   * On `kind: "rows"`, the level of the children being counted — OMITTED when
   * they are mixed (a variantType holding both inserts and parallels). Absent
   * therefore means "no single right noun exists", not "look it up": deriving
   * one from the parent's level would confidently name the wrong thing in
   * exactly the case the server declined to name.
   */
  level?: SelectorLevel;
  examples?: string[];
};

type SelectorHoldings = {
  holds: SelectorHolding[];
  /** `refusesValueRename` on the server — a structural row, never deletable. */
  protected: boolean;
};

/**
 * Singular/plural nouns for every non-row holding kind that is a COUNT NOUN —
 * i.e. every kind whose remedy is the sentence's own "delete what is below it
 * first". `review` deliberately has no entry here; see `reviewClause`.
 */
const HOLD_NOUN: Record<string, readonly [string, string]> = {
  cards: ["card", "cards"],
  crossListings: ["cross-listing", "cross-listings"],
  "cross-listings": ["cross-listing", "cross-listings"],
  players: ["player", "players"],
  teams: ["team", "teams"],
  leagues: ["league", "leagues"],
};

function holdPhrase(hold: SelectorHolding): string {
  if (hold.kind === "rows") {
    // No level means the children are MIXED (inserts and parallels under one
    // variantType), so there is no single right noun. "3 rows" is the honest
    // answer; deriving one from the parent would name the wrong thing in
    // precisely the case the server declined to name.
    return hold.level
      ? `${hold.count} ${levelNoun(hold.level, hold.count)}`
      : `${hold.count} ${hold.count === 1 ? "row" : "rows"}`;
  }
  const noun = HOLD_NOUN[hold.kind];
  if (!noun) return `${hold.count} ${hold.kind}`;
  return `${hold.count} ${hold.count === 1 ? noun[0] : noun[1]}`;
}

/**
 * An in-flight checklist review on this row.
 *
 * NOT a `HOLD_NOUN` entry, because it is not the same kind of statement as the
 * others. "Holds 1 checklist review — delete what is below it first" would give
 * the operator the wrong instruction: a review is not a thing below the row
 * waiting to be deleted, it is work in progress on the row itself, and the way
 * out is to finish or cancel it. So it gets its own clause with its own remedy.
 */
function reviewClause(count: number): string {
  return count === 1
    ? "a checklist review is in progress here — finish or cancel it first"
    : `${count} checklist reviews are in progress here — finish or cancel them first`;
}

/**
 * "Holds 3 sets and 220 cards — delete what is below it first."
 *
 * Exported shape shared by the disabled reason and the server's refusal, so
 * the operator reads the same sentence whichever side produced it.
 *
 * Two clauses at most, because there are two different remedies: everything
 * countable below the row is deleted, and an in-flight review is finished or
 * cancelled. Both can be true at once, so both are said.
 */
export function selectorHoldsMessage(
  holds: readonly SelectorHolding[],
): string {
  const present = holds.filter((h) => h.count > 0);
  const countable = present.filter((h) => h.kind !== "review");
  const reviewCount = present
    .filter((h) => h.kind === "review")
    .reduce((total, h) => total + h.count, 0);

  const clauses: string[] = [];
  if (countable.length > 0) {
    clauses.push(
      `Holds ${joinLabels(countable.map(holdPhrase))} — delete what is below it first`,
    );
  }
  if (reviewCount > 0) {
    const clause = reviewClause(reviewCount);
    // Leading clause starts a sentence; a trailing one continues one.
    clauses.push(
      clauses.length === 0
        ? clause.charAt(0).toUpperCase() + clause.slice(1)
        : clause,
    );
  }
  return clauses.join("; ");
}

/**
 * The server's delete refusals, matched STRUCTURALLY rather than with
 * `instanceof ConvexError` — same reasoning as RenameEntityControl's
 * `refusalMessage`: a mocked or rethrown error in a test, or a version skew in
 * the convex client, must still surface the server's own answer.
 */
function deleteRefusalMessage(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return null;
  const data = (e as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const { code, holds, message } = data as {
    code?: unknown;
    holds?: unknown;
    message?: unknown;
  };
  if (code === "SELECTOR_ROW_NOT_EMPTY") {
    const list = Array.isArray(holds) ? (holds as SelectorHolding[]) : [];
    return (
      selectorHoldsMessage(list) ||
      "Something is below it now — it can't be deleted."
    );
  }
  if (code === "SELECTOR_ROW_PROTECTED") {
    return typeof message === "string" && message.length > 0
      ? message
      : "This row can't be deleted.";
  }
  return null;
}

function DeleteSelectorRowControl({
  id,
  row,
  level,
  onDeleted,
}: {
  id: Id<"selectorOptions">;
  row: Pick<SlotBearingRow, "platformData"> & { value: string };
  level: SelectorLevel;
  onDeleted?: (level: SelectorLevel) => void;
}) {
  const holdings: SelectorHoldings | undefined = useQuery(
    api.selectorOptions.getSelectorOptionHoldings,
    { id },
  );
  const deleteSelectorOption = useMutation(
    api.selectorOptions.deleteSelectorOption,
  );

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasonRevealed, setReasonRevealed] = useState(false);
  const reasonId = useId();

  // A protected row is not "disabled", it is not a thing you may do at all —
  // same call the pencil makes. Rendering nothing beats rendering a control
  // that can only ever refuse.
  if (holdings?.protected) return null;

  const reason =
    holdings === undefined
      ? "Checking what is below it…"
      : selectorHoldsMessage(holdings.holds);
  const blocked = reason.length > 0;

  const linkedSides = ALL_SIDES.filter(
    (side) => slotIds(row, side).length > 0,
  ).map((side) => SIDE_LABEL[side]);

  const description =
    "Nothing is below it. This cannot be undone." +
    (linkedSides.length > 0
      ? ` It is linked to ${joinLabels(
          linkedSides,
        )}; the next sync may add it back.`
      : "");

  const handleConfirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteSelectorOption({ id });
      setOpen(false);
      onDeleted?.(level);
    } catch (e) {
      setError(
        deleteRefusalMessage(e) ??
          (e instanceof Error ? e.message : String(e)),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (blocked) {
            setReasonRevealed(true);
            return;
          }
          setError(null);
          setOpen(true);
        }}
        // aria-disabled, not `disabled`: the reason is the whole point of the
        // control in this state, and a natively disabled button cannot be
        // focused to hear it or clicked to reveal it.
        aria-disabled={blocked || undefined}
        aria-describedby={blocked ? reasonId : undefined}
        aria-label={`Delete ${row.value}`}
        title={`Delete ${row.value}`}
        // p-1: a bare 16x16 icon is under WCAG 2.5.8's 24x24 minimum target.
        className="shrink-0 p-1 text-gray-500 hover:text-[#FF2EB3] focus:text-[#FF2EB3] focus:outline-none aria-disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:hover:text-gray-500"
      >
        <TrashIcon className="w-4 h-4" />
      </button>
      {blocked && (
        <span
          id={reasonId}
          className={
            reasonRevealed
              ? "w-full text-[10px] text-gray-400"
              : "sr-only"
          }
        >
          {reason}
        </span>
      )}
      {open && (
        <ConfirmDialog
          title={`Delete ${LEVEL_SINGULAR[level]} "${row.value}"?`}
          description={description}
          confirmLabel="Yes, delete"
          busyLabel="Deleting…"
          busy={busy}
          error={error}
          onConfirm={() => void handleConfirm()}
          onCancel={() => {
            if (busy) return;
            setError(null);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
