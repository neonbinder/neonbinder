import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Input } from "../primitives/Input";
import { Textarea } from "../primitives/Textarea";
import { Theme } from "@radix-ui/themes";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { userFacingMessage } from "@/lib/errors/user-facing-message";
import type { Id } from "../../convex/_generated/dataModel";
import TeamPicker from "./TeamPicker";
import PlayerPicker from "./PlayerPicker";
import CardFeaturesEditor, { CardFeatureRow } from "./CardFeaturesEditor";
import { EXPECTED_FEATURES } from "../../convex/features/expectedFeatures";
import { useReactiveField } from "../forms/useReactiveField";
import {
  ASPECT_VALUE_MAX,
  LISTING_TITLE_MAX,
  TitleFieldNote,
  TitleLengthAlert,
  TitleLengthMeter,
  titleLengthState,
} from "./TitleLengthMeter";
import { useTitlePreview } from "./useTitlePreview";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";

const AUTOGRAPHED_FEATURE = EXPECTED_FEATURES.find(
  (f) => f.key === "autographed",
)!;

/**
 * NEO-25: right-anchored card detail panel. Replaces the old per-row edit
 * modal in CardChecklistItem. ONE instance serves the whole list — selection
 * state is hoisted into CardChecklist and the parent re-keys this component on
 * `card._id`, so switching cards (arrow nav / prev-next) remounts it fresh.
 *
 * ## NEO-216 (Jason, 2026-09-04) — this drawer autosaves per field. There is
 * ## no Save button, no draft state, and no discard bar.
 *
 * It used to seed a full draft from the `card` prop at mount and write the
 * WHOLE draft back in one `updateCard` on Save. Two things were wrong with
 * that, and both were data loss rather than annoyance:
 *
 *   1. `card` is a row out of the LIVE `getCardChecklist` query, so the server
 *      keeps patching it underneath a stale draft. The BSC per-card team queue
 *      fills in `teamOnCardIds` seconds after a commit; a Save a moment later
 *      sent `teamOnCardIds: []` from a draft seeded before that write, and the
 *      queue never re-enqueues a card it has stamped — so the team was gone
 *      for good. `playerIds` raced the same way via NEO-212's finalize.
 *   2. Because `dirty` compared the draft against that moving prop, an
 *      external patch with no operator edit made the panel look dirty, and an
 *      external patch plus an unrelated edit was invisible.
 *
 * The fix is not a conflict UI — it is to stop sending fields nobody edited.
 * Every editable control now writes ONLY its own field, immediately:
 *
 *   - text fields (`cardName`, `listingTitle`, `listingDescription`,
 *     `printRun`, `cardVariation`) are each one `useReactiveField`
 *     (components/forms/useReactiveField.ts, NEO-39) rendered through the
 *     `Input`/`Textarea` primitives — uncontrolled, external pushes mirrored
 *     only while the field is idle, value read from the DOM at commit. Commit
 *     is on blur or Enter (Cmd/Ctrl+Enter in the description, where a bare
 *     Enter is a newline). Never per keystroke: the title generator and the
 *     NEO-101 length rules must not fire mid-word.
 *   - the attribute chips write `attributes` plus the two booleans derived
 *     from it on every toggle (see the RC note at the write site);
 *   - TeamPicker / PlayerPicker write their own array on change, and now READ
 *     the live row, so a team the BSC queue fills in appears while the drawer
 *     is open instead of being overwritten by it.
 *
 * Two writers on the same field at the same instant resolve last-write-wins
 * (single-admin product), and the hook keeps the operator's text while they
 * are in the field, so a sync can never wipe in-flight typing. There is
 * nothing left for a conflict bar to arbitrate.
 *
 * Closing (Escape, the overlay, the × or Done) just closes. Nothing is
 * unsaved by then except a commit already in flight, which is left to land —
 * cancelling it would be the data loss the whole change is about. NEO-233
 * ("one persistence rule per edit dialog") is resolved in the autosave
 * direction for this dialog.
 *
 * Per-field feedback matches SetAttributesPanel, the drawer's sibling editor:
 * one `role="status"` toast that says "Saved {field}", a per-field "Saving…"
 * note, and a per-field `role="alert"` that keeps the typed value so a refusal
 * can be corrected rather than retyped.
 *
 * Display-only: card images (imageUrls or placeholder), and the
 * inherited-from-set hierarchy (sport→…→variant). The hierarchy levels stay
 * read-only: NEO-21 resolved "this card belongs somewhere else too" with the
 * additive "Also appears in" section below (cardCrossListings) rather than by
 * letting a card override its own home set, so `selectorOptionId` remains the
 * single source of truth for release year, SKU and provenance.
 *
 * Per-card feature overrides live in the embedded CardFeaturesEditor, which
 * has always persisted immediately via `setCardFeature` — the pattern this
 * whole drawer has now been brought in line with. That editor includes a
 * Rookie checkbox (NEO-71) writing `cardChecklist.isRookie` directly and
 * independently of the RC chip above. The Autographed dropdown is the same
 * `features.autographed` control, promoted out of that collapsed editor to
 * always-visible here (previously a redundant free-text `autographType`
 * input lived here instead — removed so there's one source of truth for
 * "is this card autographed", not two disagreeing controls).
 */

// Attribute tokens the panel exposes as toggle chips. Any other token already
// on the card (e.g. the reconciliation tags "unmatched-bsc"/"unmatched-sl") is
// preserved untouched on save and shown read-only — `attributes` is a
// full-replacement patch, so we must not silently drop tokens we don't render.
const EDITABLE_ATTRIBUTES = ["RC", "AU", "RELIC", "SP", "SSP", "NUM"] as const;

const ATTRIBUTE_LABEL: Record<string, string> = {
  RC: "RC",
  AU: "AU",
  RELIC: "RELIC",
  SP: "SP",
  SSP: "SSP",
  NUM: "#'d",
};

/**
 * NEO-217 — what a print run may be, said once, in the server's own words.
 *
 * `/0` is not a print run, `/2.5` is not a quantity, and a run past 1,000,000
 * is a typo rather than a card, so all three are refused here before the round
 * trip as well as server-side (`updateCard` throws
 * "Print run must be a whole number between 1 and 1,000,000; received N."). The
 * bound and the wording are kept in step with `selectorOptions.updateCard`
 * deliberately: an operator who hits it locally and an operator who hits it on
 * the server must not be told two different rules. The "received N" tail is
 * dropped only because the value is still in the field beside the message.
 *
 * Clearing the field is a different thing entirely and is allowed: it sends
 * `printRun: null`, which removes the field — there was no way to spell "no
 * print run" on the wire before this ticket, because every arg was
 * `v.optional` and absent means untouched.
 */
const PRINT_RUN_MAX = 1_000_000;
const PRINT_RUN_MESSAGE =
  "Print run must be a whole number between 1 and 1,000,000.";

type CardDetailCard = {
  _id: Id<"cardChecklist">;
  selectorOptionId: Id<"selectorOptions">;
  cardNumber: string;
  cardName: string;
  playerIds?: Array<Id<"players">>;
  teamOnCardIds?: Array<Id<"teams">>;
  /**
   * NEO-208 — team names an operator typed that no `teams` row exists for yet.
   *
   * Read-only here, and shown above the picker rather than folded into it: a
   * chip in `TeamPicker` is a real `teams._id` the rest of the product can act
   * on, and putting a bare string among them would be claiming a link that
   * does not exist. The drawer's job is to make the name VISIBLE (it rendered
   * nowhere before this ticket) and to say what will happen to it.
   *
   * Never edited here. It is retired by the server, derived from a real team
   * write — see `updateCard`, which clears it in the same patch as a non-empty
   * `teamOnCardIds`. So an operator "replaces" a pending name by picking a
   * team; there is nothing here for them to edit or delete directly.
   */
  pendingTeamNames?: string[];
  attributes?: string[];
  isRookie?: boolean;
  isRelic?: boolean;
  printRun?: number;
  cardVariation?: string;
  // NEO-189: the card this one varies, when it is a variation.
  variationOfCardId?: Id<"cardChecklist">;
  listingTitle?: string;
  /**
   * NEO-101: the auto-generated title did not fit and was cut at a word
   * boundary, so what is stored is not the whole card. Set at creation and
   * cleared server-side by any write of `listingTitle` — so an operator
   * rewriting the title clears it by construction, with no flag to remember.
   */
  listingTitleTruncated?: boolean;
  listingDescription?: string;
  imageUrls?: { front?: string; back?: string };
  // NEO-137: ref = marketplace card identity, src = slot on the parent row.
  platformData: {
    bsc?: { ref: string; src?: string };
    sportlots?: { ref: string; src?: string };
  };
  isCustom?: boolean;
  features?: Record<string, string>;
};

type AncestorLevel = { level: string; value: string };

type CardDetailPanelProps = {
  card: CardDetailCard;
  // Ancestor chain (sport→…→variant) already queried once in CardChecklist.
  ancestorChain?: Array<AncestorLevel>;
  ancestorSport?: string;
  /** NEO-96: sport-level selectorOptions row id, for the entity pickers. */
  ancestorSportId?: Id<"selectorOptions">;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
};

// Human label for each hierarchy level shown in the inherited section.
const LEVEL_LABEL: Record<string, string> = {
  sport: "Sport",
  year: "Year",
  manufacturer: "Manufacturer",
  setName: "Set",
  variantType: "Variant",
  insert: "Insert",
  parallel: "Parallel",
};

/**
 * The per-field busy/error line, rendered under every autosaving control.
 *
 * At module scope, not inside the panel: a component declared in another
 * component's body is a new type on every render, so React remounts it rather
 * than updating it — which would blow away focus and re-announce the alert on
 * each keystroke (react-hooks/static-components).
 *
 * "Saving…" is words, not a spinner or a colour, so the busy state survives
 * both a screen reader and a monochrome display. The error is `role="alert"`
 * (announced once, when it appears) and the hook deliberately leaves the typed
 * value in the field behind it, so a refusal is corrected, never retyped.
 */
function FieldFeedback({
  busy,
  error,
  errorId,
}: {
  busy: boolean;
  error: string | null;
  errorId: string;
}) {
  return (
    <>
      {busy && (
        <p className="mt-1 text-[10px] text-gray-500 dark:text-gray-400">
          Saving…
        </p>
      )}
      {error && (
        // a11y: NOT the brand `#FF2EB3` — measured 3.34:1 on this drawer's
        // light-mode `bg-white` and 4.4:1 on its `dark:bg-gray-800`, both under
        // WCAG 1.4.3's 4.5:1 floor. This darkened/lightened pair in the same
        // hue measures 5.55:1 / 5.87:1 and is the file's existing precedent.
        <p
          id={errorId}
          role="alert"
          className="mt-1 text-[10px] text-[#C2178A] dark:text-[#FF6FCB]"
        >
          {error}
        </p>
      )}
    </>
  );
}

export default function CardDetailPanel({
  card,
  ancestorChain,
  ancestorSport,
  ancestorSportId,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
}: CardDetailPanelProps) {
  const updateCard = useMutation(api.selectorOptions.updateCard);
  const setCardFeature = useMutation(api.selectorOptions.setCardFeature);
  const setVariationParent = useMutation(
    api.selectorOptions.setCardVariationParent,
  );
  // NEO-189: the other cards in this checklist, so a variation can be pointed
  // at the one it varies. Convex dedupes same-arg queries, so this rides along
  // with the checklist the panel is already open inside.
  const siblingCards = useQuery(api.selectorOptions.getCardChecklist, {
    selectorOptionId: card.selectorOptionId,
  });
  const [parentError, setParentError] = useState<string | null>(null);
  const [parentNumber, setParentNumber] = useState("");
  // a11y: announced once a link/clear actually commits — see the effect below.
  // This is the ONLY feedback a screen reader gets for either action: there is
  // no Save step for this field (it writes immediately), and the visual swap
  // from input → static text (or back) is silent otherwise.
  const [parentStatus, setParentStatus] = useState<string | null>(null);
  const parentCard = useMemo(
    () =>
      card.variationOfCardId
        ? (siblingCards ?? []).find((c) => c._id === card.variationOfCardId)
        : undefined,
    [card.variationOfCardId, siblingCards],
  );

  // a11y: focus targets either side of the input ↔ static-text swap below.
  // Whichever element had focus when a link/clear commits gets removed from
  // the DOM (input unmounts on link, the Clear button unmounts on clear), and
  // an unmounted focused element drops focus to <body> with no further
  // warning — costly in a tool built around long keyboard-driven review
  // sessions. The effect below moves focus to the element that replaces it.
  const parentInputRef = useRef<HTMLInputElement | null>(null);
  const clearButtonRef = useRef<HTMLButtonElement | null>(null);
  // Tracks the previous linked state so the focus/announce effect only fires
  // on a real transition, not on this component's initial mount (every
  // remount — e.g. arrow-key nav to the next card — would otherwise steal
  // focus and announce a link that isn't new).
  const prevVariationOfIdRef = useRef(card.variationOfCardId);
  useEffect(() => {
    const prev = prevVariationOfIdRef.current;
    const curr = card.variationOfCardId;
    if (prev === curr) return;
    prevVariationOfIdRef.current = curr;
    if (curr) {
      requestAnimationFrame(() => clearButtonRef.current?.focus());
      // Reacting to an external system (the setVariationParent mutation
      // committing and this card's reactive query updating), not deriving
      // render state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setParentStatus(
        parentCard
          ? `Linked as a variation of #${parentCard.cardNumber}.`
          : "Linked.",
      );
    } else if (prev) {
      requestAnimationFrame(() => parentInputRef.current?.focus());
      setParentStatus("Variation link cleared.");
    }
    // parentCard intentionally omitted: it derives from curr + siblingCards,
    // and re-running this on every siblingCards tick would re-focus/re-announce
    // on unrelated reactive updates, not just on curr actually changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.variationOfCardId]);

  /**
   * Resolve a typed card number to a sibling and set (or clear) the link.
   *
   * An empty value clears. A number that matches nothing is reported rather
   * than silently ignored — a typo that quietly does nothing is worse than one
   * that says so.
   */
  const applyVariationParent = async (raw: string) => {
    setParentError(null);
    const wanted = raw.trim();
    try {
      if (!wanted) {
        await setVariationParent({ cardId: card._id });
        setParentNumber("");
        return;
      }
      const match = (siblingCards ?? []).find(
        (c) => c.cardNumber.toLowerCase() === wanted.toLowerCase(),
      );
      if (!match) {
        setParentError(`No card #${wanted} in this checklist.`);
        return;
      }
      await setVariationParent({ cardId: card._id, parentCardId: match._id });
      setParentNumber("");
    } catch (err) {
      // The mutation refuses self-parenting, cross-checklist parents and
      // nesting, and each refusal is a ConvexError carrying the reason. Read
      // `data`, never `.message`: production redacts a plain Error to "Server
      // Error", and even a surviving message arrives wrapped in
      // "[CONVEX M(...)] [Request ID: ...]" noise.
      setParentError(
        userFacingMessage(err, "Could not set the parent card"),
      );
    }
  };
  // NEO-21: every guest set this card is cross-listed into. A property of the
  // card itself, so it renders whether the panel was opened from the card's
  // home checklist or from one of its guest checklists.
  const crossListings = useQuery(api.selectorOptions.getCrossListingsForCard, {
    cardChecklistId: card._id,
  });
  const removeCrossListing = useMutation(
    api.selectorOptions.removeCrossListing,
  );
  const cardNameInputRef = useRef<HTMLInputElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  // Unique per-field marker class so Maestro's inputText targets the tapped
  // field rather than the first input in the drawer (see useFieldTestClass).
  const fieldClass = useFieldTestClass();
  const uid = useId();

  // ----- per-field autosave plumbing -----------------------------------
  //
  // ONE live region for the whole drawer, matching SetAttributesPanel. A
  // `role="status"` per field would announce the same edit N times and, worse,
  // would be N regions competing for one announcement queue.
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announce = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 6000);
  }, []);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  /**
   * Write ONE field and say so. Every editable control in this drawer goes
   * through here, and the patch it passes carries only the field it owns —
   * that single rule is what makes the sync race impossible rather than
   * merely unlikely (`updateCard` treats an absent key as untouched).
   *
   * A refusal is re-thrown as a plain `Error` carrying the user-facing text:
   * `useReactiveField` surfaces `error.message` verbatim, and a raw Convex
   * rejection reads "[CONVEX M(selectorOptions:updateCard)] [Request ID: …]"
   * in front of the sentence that matters.
   */
  const commitField = useCallback(
    async (patch: Record<string, unknown>, done: string) => {
      try {
        await updateCard({ id: card._id, ...patch });
      } catch (err) {
        throw new Error(userFacingMessage(err, "Could not save that change"));
      }
      announce(done);
    },
    [updateCard, card._id, announce],
  );

  const nameField = useReactiveField({
    value: card.cardName,
    onSave: (trimmed) => commitField({ cardName: trimmed }, "Saved Card name"),
  });

  /**
   * NEO-101's cap, enforced at commit rather than on the Save button that no
   * longer exists. Refusing here (instead of letting the server refuse) keeps
   * the over-length text in the field with the explanation beside it; the
   * server enforces the same constant either way.
   */
  const titleField = useReactiveField({
    value: card.listingTitle ?? "",
    onSave: async (trimmed) => {
      const state = titleLengthState(trimmed.length, LISTING_TITLE_MAX, true);
      if (state.over) {
        throw new Error(`Title is ${state.alert} Shorten it before saving.`);
      }
      await commitField({ listingTitle: trimmed }, "Saved Card title");
    },
  });

  const descriptionField = useReactiveField<HTMLTextAreaElement>({
    value: card.listingDescription ?? "",
    // A bare Enter here is a paragraph break the operator typed, not a save.
    enterCommit: "modEnter",
    onSave: (trimmed) =>
      commitField({ listingDescription: trimmed }, "Saved Card description"),
  });

  const printRunField = useReactiveField({
    value: card.printRun != null ? String(card.printRun) : "",
    onSave: async (trimmed) => {
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > PRINT_RUN_MAX) {
        throw new Error(PRINT_RUN_MESSAGE);
      }
      await commitField({ printRun: parsed }, "Saved Print run");
    },
    // NEO-217: blank is a real answer ("this card is not numbered"), and
    // `null` is the only spelling of it on the wire — every other arg is
    // optional, so an omitted number means "leave it alone".
    onEmptyCommit: () => commitField({ printRun: null }, "Cleared Print run"),
  });

  const variationField = useReactiveField({
    value: card.cardVariation ?? "",
    onSave: (trimmed) =>
      commitField({ cardVariation: trimmed }, "Saved Variation"),
  });

  // ----- live length readouts (NEO-101) --------------------------------
  //
  // The two capped fields are uncontrolled, so their length cannot come from
  // React state the way it did from the old draft. It is tracked here instead:
  // updated on input while the operator types, and re-derived from the live row
  // whenever that changes and the field is idle — the same focus-guard the hook
  // itself applies, for the same reason (a reactive push must not renumber a
  // counter for text the operator can still see in front of them).
  const [titleLength, setTitleLength] = useState(
    (card.listingTitle ?? "").length,
  );
  const [variationLength, setVariationLength] = useState(
    (card.cardVariation ?? "").length,
  );
  const variationInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (
      typeof document !== "undefined" &&
      document.activeElement === titleInputRef.current
    ) {
      return;
    }
    // Mirroring an external (reactive) value, not deriving render state.
    setTitleLength((card.listingTitle ?? "").length);
  }, [card.listingTitle]);

  useEffect(() => {
    if (
      typeof document !== "undefined" &&
      document.activeElement === variationInputRef.current
    ) {
      return;
    }
    setVariationLength((card.cardVariation ?? "").length);
  }, [card.cardVariation]);

  const titleState = titleLengthState(titleLength, LISTING_TITLE_MAX, true);
  const titleAlertId = `${uid}-title-limit`;
  const variationAlertId = `${uid}-variation-limit`;
  const nameErrorId = `${uid}-name-error`;
  const titleErrorId = `${uid}-title-error`;
  const descriptionErrorId = `${uid}-description-error`;
  const descriptionHintId = `${uid}-description-hint`;
  const printRunErrorId = `${uid}-print-run-error`;
  const variationErrorId = `${uid}-variation-error`;

  // Regenerate. Lazy: no preview is fetched until the operator asks for one,
  // because the drawer opens for every card they arrow through.
  //
  // The fetched title lands in the DOM and is then committed through the SAME
  // single-field path as typing it by hand — `titleField.commit()` reads the
  // live input, so Regenerate inherits the cap check, the busy state, the
  // error line and the "Saved Card title" toast for free. Held in a ref
  // because `commit`'s identity changes with the row, and `applyTitle` is a
  // dependency of an effect inside useTitlePreview.
  const commitTitleRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    commitTitleRef.current = titleField.commit;
  }, [titleField.commit]);
  const applyTitle = useCallback((title: string) => {
    const el = titleInputRef.current;
    if (el) el.value = title;
    setTitleLength(title.length);
    void commitTitleRef.current?.();
  }, []);
  const preview = useTitlePreview(card._id, applyTitle);
  /** Does the field hold something other than what is stored? Read live. */
  const titleIsEdited = () =>
    (titleInputRef.current?.value ?? "") !== (card.listingTitle ?? "");

  // ----- attributes: one mutation per toggle ---------------------------
  const attributes = useMemo(() => card.attributes ?? [], [card.attributes]);
  const [attributesBusy, setAttributesBusy] = useState(false);
  const [attributesError, setAttributesError] = useState<string | null>(null);
  const attributesErrorId = `${uid}-attributes-error`;

  const toggleAttribute = async (token: string) => {
    // Busy-guard: two toggles in flight would both derive `attributes` from
    // the same pre-toggle array, and the second would undo the first.
    if (attributesBusy) return;
    const next = attributes.includes(token)
      ? attributes.filter((t) => t !== token)
      : [...attributes, token];
    setAttributesBusy(true);
    try {
      await commitField(
        {
          // Full-replacement: send the entire desired token array, and derive
          // the denormalized booleans from it so they cannot drift (matches
          // fetchCardChecklist / commitCardChecklist semantics).
          //
          // NEO-217 (C): `isRookie` is `attributes.includes("RC")`, with no OR
          // against the current value. The old OR existed because a full-panel
          // Save could otherwise revert a `true` that CardFeaturesEditor's
          // Rookie checkbox had just written — but it also made the RC chip a
          // one-way switch, so unticking RC left `isRookie: true` and the
          // generated title kept its "RC" token. Per-field writes remove the
          // reason for the OR: this mutation fires only when the operator
          // toggles a chip, so it can no longer trample an unrelated edit, and
          // RC now drives isRookie in both directions. The checkbox remains a
          // second, independent writer on purpose (NEO-71).
          attributes: next,
          isRookie: next.includes("RC"),
          isRelic: next.includes("RELIC"),
        },
        "Saved Attributes",
      );
      setAttributesError(null);
    } catch (e) {
      setAttributesError(e instanceof Error ? e.message : String(e));
    } finally {
      setAttributesBusy(false);
    }
  };

  // ----- teams / players: write their own array, read the live row -----
  //
  // `pending` holds the operator's choice only until the mutation resolves.
  // Convex updates the subscribed query BEFORE the mutation promise settles,
  // so by the time this clears, `card` already carries the new array and the
  // chips never flicker. On a refusal it clears too — the picker snapping back
  // to server truth beside the error is the honest reading of what happened.
  const [teamsPending, setTeamsPending] = useState<Array<Id<"teams">> | null>(
    null,
  );
  const [teamsError, setTeamsError] = useState<string | null>(null);
  const [playersPending, setPlayersPending] = useState<Array<
    Id<"players">
  > | null>(null);
  const [playersError, setPlayersError] = useState<string | null>(null);
  const teamsErrorId = `${uid}-teams-error`;
  const playersErrorId = `${uid}-players-error`;

  const teamIds = teamsPending ?? card.teamOnCardIds ?? [];
  const playerIds = playersPending ?? card.playerIds ?? [];

  const saveTeams = async (next: Array<Id<"teams">>) => {
    setTeamsPending(next);
    try {
      await commitField({ teamOnCardIds: next }, "Saved Teams");
      setTeamsError(null);
    } catch (e) {
      setTeamsError(e instanceof Error ? e.message : String(e));
    } finally {
      setTeamsPending(null);
    }
  };

  const savePlayers = async (next: Array<Id<"players">>) => {
    setPlayersPending(next);
    try {
      await commitField({ playerIds: next }, "Saved Players");
      setPlayersError(null);
    } catch (e) {
      setPlayersError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlayersPending(null);
    }
  };

  const focusedInEditable = () => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    return (
      el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.isContentEditable
    );
  };

  // Focus the card-name input on mount (each remount = new card).
  useEffect(() => {
    cardNameInputRef.current?.focus();
  }, []);

  // Keyboard: Escape closes; Arrow Up/Down move card selection. Listening on
  // document covers focus inside the TeamPicker popover too. Arrows are
  // ignored while typing in a field (so the caret can move).
  //
  // None of these are guarded any more: there is no unsaved draft to discard.
  // A commit triggered by the blur these actions cause is left to land.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        // a11y (audit fix, NEO-216/217): every OTHER way of closing this
        // drawer (clicking the backdrop, ×, or Done) moves the mouse to a
        // non-focused element first, which the browser turns into a native
        // blur on whatever field the operator was typing in — and that blur
        // is what commits the field under this drawer's autosave-on-blur
        // contract. Escape is the one close path that does NOT touch focus,
        // so without this, a keyboard user who types a new Card name and
        // hits Escape before tabbing away loses the edit silently — a
        // keyboard-only failure mode a mouse user can't hit. Blurring the
        // active field here (a no-op if it isn't one) makes Escape commit
        // exactly like every other close path before it unmounts the drawer;
        // the commit itself is fire-and-forget, same as a blur immediately
        // followed by a click on Done.
        if (focusedInEditable()) {
          (document.activeElement as HTMLElement | null)?.blur();
        }
        onClose();
        return;
      }
      if (focusedInEditable()) return;
      if (e.key === "ArrowDown" && hasNext) {
        e.preventDefault();
        onNext();
      } else if (e.key === "ArrowUp" && hasPrev) {
        e.preventDefault();
        onPrev();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hasPrev, hasNext, onClose, onPrev, onNext]);

  // Read-only tokens we render but don't expose as toggles (preserved on save).
  const readOnlyTokens = useMemo(
    () =>
      attributes.filter(
        (t) => !(EDITABLE_ATTRIBUTES as readonly string[]).includes(t),
      ),
    [attributes],
  );

  const inheritedLevels = (ancestorChain ?? []).filter(
    (a) => LEVEL_LABEL[a.level],
  );

  const front = card.imageUrls?.front;
  const back = card.imageUrls?.back;
  const hasImages = Boolean(front || back);

  const { ref: nameHookRef, ...nameInputProps } = nameField.inputProps;
  const { ref: titleHookRef, ...titleInputProps } = titleField.inputProps;
  const { ref: variationHookRef, ...variationInputProps } =
    variationField.inputProps;

  return createPortal(
    // NEO-71-74 QA fix: see BaseSetPicker.tsx for why this nested <Theme> is
    // needed — createPortal(document.body) escapes the root Theme's CSS scope.
    <Theme>
    <div className="fixed inset-0 z-50">
      {/* Backdrop. Clicking it closes. The panel is a sibling layered above,
          so taps inside the panel never reach here — e.g. tapping the Card
          name input to dismiss the TeamPicker popover does not close the
          panel. */}
      <div
        className="absolute inset-0 bg-black/60"
        aria-hidden="true"
        onClick={onClose}
      />
      {/* The one save confirmation for the whole drawer.

          NEO-47's reasoning, inherited from SetAttributesPanel: FIXED in the
          viewport rather than in-flow, because an edit made while scrolled
          down to the print run would otherwise render its confirmation above
          the fold, invisible to the operator who just made it. */}
      {toast && (
        <div
          className="fixed top-20 left-1/2 -translate-x-1/2 z-[60] px-4 py-2 bg-gray-900 border border-[#00D558]/60 rounded text-xs text-[#00D558] shadow-lg"
          role="status"
          aria-live="polite"
        >
          {toast}
        </div>
      )}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`card-detail-title-${card._id}`}
        className="absolute top-0 right-0 h-full w-full sm:w-[30rem] max-w-[95vw] bg-white dark:bg-gray-800 border-l border-gray-200 dark:border-gray-700 shadow-xl flex flex-col animate-slide-in-right"
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
          <h2
            id={`card-detail-title-${card._id}`}
            className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex-1 truncate"
          >
            Card #{card.cardNumber}
            {card.isCustom && (
              <span className="ml-2 text-[10px] uppercase tracking-wide text-blue-500">
                Custom
              </span>
            )}
          </h2>
          <button
            onClick={onPrev}
            disabled={!hasPrev}
            aria-label="Previous card"
            title="Previous card (↑)"
            className="px-2 py-1 text-sm rounded text-gray-500 hover:text-[#00B7FF] disabled:opacity-30 disabled:cursor-not-allowed"
          >
            ↑
          </button>
          <button
            onClick={onNext}
            disabled={!hasNext}
            aria-label="Next card"
            title="Next card (↓)"
            className="px-2 py-1 text-sm rounded text-gray-500 hover:text-[#00B7FF] disabled:opacity-30 disabled:cursor-not-allowed"
          >
            ↓
          </button>
          <button
            onClick={onClose}
            aria-label="Close card detail"
            title="Close (Esc)"
            className="px-2 py-1 text-lg leading-none rounded text-gray-400 hover:text-[#FF2EB3] focus:text-[#FF2EB3] focus:outline-none"
          >
            ×
          </button>
        </div>

        {/* Scrollable body. No overflow clipping on the TeamPicker section is
            handled by giving the whole body a single scroll container; the
            popover renders within it. */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 min-h-0">
          {/* Card name */}
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              Card name
            </label>
            <Input
              bare
              {...nameInputProps}
              ref={(el) => {
                nameHookRef(el);
                cardNameInputRef.current = el;
              }}
              type="text"
              // readOnly, never `disabled`, while a commit is in flight: a
              // disabled control leaves the tab order, so committing with
              // Enter would drop focus to <body> mid-edit. readOnly keeps the
              // caret exactly where the operator left it.
              readOnly={nameField.busy}
              aria-busy={nameField.busy || undefined}
              aria-invalid={nameField.error ? true : undefined}
              aria-describedby={nameField.error ? nameErrorId : undefined}
              className={`${fieldClass("cardName")} w-full p-1.5 text-sm`}
              placeholder="Card name"
              aria-label="Card name"
            />
            <FieldFeedback
              busy={nameField.busy}
              error={nameField.error}
              errorId={nameErrorId}
            />
          </div>

          {/* Teams */}
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              Teams
            </label>
            {/* NEO-208 — unresolved typed names, above the picker and
                read-only. TEXT ONLY, never an anchor or a button: there is no
                action to offer. The name is retired server-side when a real
                team is saved (updateCard clears `pendingTeamNames` in the same
                patch as a non-empty `teamOnCardIds`), so the two things that
                can happen to it are stated in the hint rather than wired to a
                control the operator would have to find. */}
            {(card.pendingTeamNames?.length ?? 0) > 0 && (
              <div className="mb-2 text-xs text-gray-500 dark:text-gray-400">
                <div className="flex flex-wrap gap-x-2">
                  {/* Index-qualified key, not the name itself: `pendingTeamNames`
                      is not deduplicated, and legacy rows written before
                      NEO-208 can carry the same typed name twice. A bare
                      `key={name}` then hands React duplicate sibling keys —
                      a dev-mode warning, and the second entry silently
                      dropped/mis-reconciled in the render. This list is
                      read-only and never reordered, so the index is a stable
                      identity here. */}
                  {card.pendingTeamNames!.map((name, index) => (
                    <span key={`${index}-${name}`}>
                      {name}{" "}
                      {/* a11y: this MUST stay `text-gray-500 dark:text-gray-400`
                          (the container's own pair, two lines up) and never the
                          reverse — `text-gray-400 dark:text-gray-500` measures
                          2.54:1 on this panel's light-mode `bg-white` and 3.04:1
                          on its `dark:bg-gray-800`, both under WCAG 1.4.3's
                          4.5:1 floor for normal text (script-verified). The
                          reversed pair was in here before; if you're tempted to
                          dim this relative to the name, use weight/size, not a
                          lighter gray in light mode. */}
                      <span className="text-gray-500 dark:text-gray-400">
                        (unconfirmed)
                      </span>
                    </span>
                  ))}
                </div>
                {/* Same a11y note as above — text-gray-500 (light) /
                    text-gray-400 (dark) is the pair that clears 4.5:1 against
                    this panel's bg-white / dark:bg-gray-800; the reverse fails
                    both. */}
                <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                  Typed on the card before it was linked — resolves at the next
                  sync, or pick a team to replace it.
                </p>
              </div>
            )}
            <TeamPicker
              value={teamIds}
              onChange={(next) => void saveTeams(next)}
              sportId={ancestorSportId}
            />
            <FieldFeedback
              busy={teamsPending !== null}
              error={teamsError}
              errorId={teamsErrorId}
            />
          </div>

          {/* Per-card feature overrides (persists immediately via setCardFeature).
              Kept directly under Teams — matching the old inline edit modal — so
              the collapsed "Show features editor" toggle is above the fold and
              reachable without scrolling the drawer body. */}
          <div>
            <CardFeaturesEditor
              cardChecklistId={card._id}
              cardFeatures={card.features}
              ancestorSport={ancestorSport}
              cardIsRookie={card.isRookie}
              // a11y (audit fix, NEO-216/217): route into this drawer's own
              // single toast region rather than adding a second one — see
              // CardFeaturesEditor's `onFieldSaved` doc comment.
              onFieldSaved={announce}
            />
          </div>

          {/* Listing title + description (marketplace-agnostic).

              NEO-101: the header row is a <div>, not the <label> it used to be,
              because Regenerate lives in it and a <button> inside a <label> is
              a click-target fight. Nothing is lost: the label carried no
              `htmlFor` and never wrapped the input, so the field's accessible
              name has always come from its `aria-label` — which is also the
              handle every Maestro flow taps (`id: "Card title"`), so it and the
              field's position in the drawer are both unchanged. */}
          <div>
            <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              <span>Card title</span>
              <span className="flex items-center gap-2">
                <TitleLengthMeter length={titleLength} soft />
                <button
                  type="button"
                  onClick={() => preview.request(titleIsEdited())}
                  // a11y (2.5.3, audit fix): the visible text also becomes
                  // "Rebuilding…"/"Replace?", neither a substring of a fully
                  // static name. "Replace?" is kept as the fixed string on
                  // purpose — this exact query
                  // (`getByLabelText("Regenerate card title")`) is asserted
                  // while `confirming` is true in
                  // CardDetailPanel.titleLimits.test.tsx, so changing it here
                  // would desync from that locked test. The confirm text
                  // below (already wired via aria-describedby) covers the
                  // gap for screen-reader users.
                  aria-label={
                    preview.loading ? "Regenerate card title — rebuilding" : "Regenerate card title"
                  }
                  aria-describedby={
                    preview.confirming ? `${uid}-regen-confirm` : undefined
                  }
                  // a11y (1.4.3, audit fix): #00B7FF alone measures 2.28:1
                  // against this drawer's light-mode `bg-white` (fails
                  // 4.5:1) — this panel is genuinely bi-themed
                  // (`bg-white dark:bg-gray-800`), unlike TitleFixer's
                  // always-dark walker dialog. #0369A1 measures 5.93:1
                  // against white; #00B7FF unchanged for dark mode (6.44:1
                  // against gray-800).
                  className="rounded px-1 uppercase tracking-wide text-[#0369A1] dark:text-[#00B7FF] underline decoration-dotted hover:text-black dark:hover:text-white focus:outline-none focus:ring-1 focus:ring-[#00B7FF]"
                >
                  {preview.loading
                    ? "Rebuilding…"
                    : preview.confirming
                      ? "Replace?"
                      : "Regenerate"}
                </button>
              </span>
            </div>
            <Input
              bare
              {...titleInputProps}
              ref={(el) => {
                titleHookRef(el);
                titleInputRef.current = el;
              }}
              type="text"
              onChange={(e) => {
                setTitleLength(e.target.value.length);
                // Typing is the operator changing their mind about replacing
                // the draft — drop the pending confirm rather than leaving a
                // second click armed against text they just wrote.
                preview.cancelConfirm();
              }}
              readOnly={titleField.busy}
              aria-busy={titleField.busy || undefined}
              // No maxLength, deliberately: it would silently swallow the tail
              // of a pasted title, and an over-length title the operator cannot
              // SEE is one they cannot fix. Let it overflow and say so.
              className={`${fieldClass("cardTitle")} w-full p-1.5 text-sm`}
              placeholder="Listing title reused across marketplaces"
              aria-label="Card title"
              aria-invalid={titleState.over || Boolean(titleField.error) || undefined}
              aria-describedby={
                [
                  titleState.over ? titleAlertId : null,
                  titleField.error ? titleErrorId : null,
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
            />
            <TitleLengthAlert id={titleAlertId} length={titleLength} />
            <FieldFeedback
              busy={titleField.busy}
              error={titleField.error}
              errorId={titleErrorId}
            />
            {preview.confirming && (
              <p
                id={`${uid}-regen-confirm`}
                role="status"
                aria-atomic="true"
                // a11y (1.4.3, audit fix): same light/dark split as the
                // Regenerate button above, same reason — this panel is
                // bi-themed and #00B7FF alone fails 4.5:1 against its
                // light-mode `bg-white`.
                className="mt-1 text-[10px] text-[#0369A1] dark:text-[#00B7FF]"
              >
                Regenerate again to replace the title you have typed.
              </p>
            )}
            {card.listingTitleTruncated && (
              <TitleFieldNote>Auto title was cut short — rewrite it</TitleFieldNote>
            )}
            {preview.dropped.length > 0 && (
              <TitleFieldNote>
                Left out to fit: {preview.dropped.join(", ")}
              </TitleFieldNote>
            )}
            {preview.chips.length > 0 && (
              // What the title was built from. Plain text, never links: a card's
              // variation text is operator- and marketplace-sourced content, so
              // it is something to read, not something to follow.
              <ul
                aria-label="Title built from"
                className="mt-1.5 flex flex-wrap gap-1"
              >
                {preview.chips.map((chip, idx) => (
                  <li
                    key={`${chip.label}-${chip.value}-${idx}`}
                    // a11y (1.4.3, audit fix): this exact chip className,
                    // unchanged, is also what TitleFixer.tsx renders — safe
                    // there (always-dark surface) but not here. Composited
                    // over this panel's light-mode `bg-white`, the original
                    // `bg-gray-800/60 text-gray-200` measured 3.27:1 (fails
                    // 4.5:1) and the label's `text-gray-400` measured 1.56:1
                    // (fails badly). Light-mode values below measure 9.36:1
                    // / 6.87:1 against their own `bg-gray-100`; dark-mode
                    // values are the untouched originals.
                    className="rounded-full border border-gray-300 bg-gray-100 dark:border-gray-700 dark:bg-gray-800/60 px-2 py-0.5 text-[10px] text-gray-700 dark:text-gray-200"
                  >
                    <span className="mr-1 uppercase tracking-wide text-gray-600 dark:text-gray-400">
                      {chip.label}
                    </span>
                    {chip.value}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[10px] text-gray-400 mt-1">
              Stored once and reused by every marketplace listing.
            </p>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              Card description
            </label>
            <Textarea
              bare
              {...descriptionField.inputProps}
              rows={3}
              readOnly={descriptionField.busy}
              aria-busy={descriptionField.busy || undefined}
              aria-invalid={descriptionField.error ? true : undefined}
              aria-describedby={
                [descriptionHintId, descriptionField.error ? descriptionErrorId : null]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              // a11y (audit fix, NEO-216/217): the shortcut this field
              // actually listens for (see `enterCommit: "modEnter"` above) —
              // a bare Enter is a newline here, unlike every other field in
              // this drawer where Enter commits. `aria-keyshortcuts` is the
              // ARIA-native way to expose that to AT that support it; the
              // visible hint below (wired via aria-describedby) covers
              // everyone else.
              aria-keyshortcuts="Control+Enter Meta+Enter"
              className={`${fieldClass("cardDescription")} w-full p-1.5 text-sm resize-y`}
              placeholder="Listing description reused across marketplaces"
              aria-label="Card description"
            />
            {/* a11y (audit fix): text-gray-500/text-gray-400, not a bare
                text-gray-400 — this panel is genuinely bi-themed
                (bg-white dark:bg-gray-800) and gray-400 alone measures
                2.6:1 against the light-mode background (fails WCAG 1.4.3's
                4.5:1). This pairing measures 4.84:1 light / 5.64:1 dark,
                matching FieldFeedback's own busy-text pair two lines below. */}
            <p
              id={descriptionHintId}
              className="mt-1 text-[10px] text-gray-500 dark:text-gray-400"
            >
              Enter adds a line break. ⌘/Ctrl+Enter or leaving the field saves.
            </p>
            <FieldFeedback
              busy={descriptionField.busy}
              error={descriptionField.error}
              errorId={descriptionErrorId}
            />
          </div>

          {/* Attributes */}
          <div>
            <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              <span>Attributes</span>
              {/* The busy state in words as well as the dimmed chips: a
                  disabled-looking pill is a colour-only signal, and this row is
                  the one control here with no text field to carry a note. */}
              {attributesBusy && <span className="normal-case">Saving…</span>}
            </div>
            <div
              className="flex flex-wrap gap-1.5"
              role="group"
              aria-label="Card attributes"
              aria-busy={attributesBusy || undefined}
              aria-describedby={
                attributesError ? attributesErrorId : undefined
              }
            >
              {EDITABLE_ATTRIBUTES.map((token) => {
                const active = attributes.includes(token);
                return (
                  <button
                    key={token}
                    type="button"
                    aria-label={`Toggle ${token}`}
                    aria-pressed={active}
                    // a11y (audit fix, NEO-216/217): NOT native `disabled`.
                    // The busy flag is shared by the whole row (see
                    // `toggleAttribute`'s comment), so setting it disables
                    // EVERY chip on the very next render — including the one
                    // just clicked. A native `disabled` attribute forces a
                    // browser blur on the instant it applies, dropping focus
                    // to `<body>` mid-toggle with zero warning to a keyboard
                    // user. `aria-disabled` keeps the button focusable and
                    // reachable while still announcing the state; the
                    // existing `if (attributesBusy) return` guard in
                    // `toggleAttribute` already makes a second click while
                    // busy a no-op, so nothing depends on the native
                    // click-blocking behaviour `disabled` would have added.
                    aria-disabled={attributesBusy || undefined}
                    onClick={() => void toggleAttribute(token)}
                    className={`text-xs px-2 py-0.5 rounded border transition-colors aria-disabled:cursor-progress aria-disabled:opacity-60 ${
                      active
                        ? "bg-[#00D558] text-black border-[#00D558] font-semibold"
                        : "bg-transparent text-gray-500 border-gray-300 dark:border-gray-600 hover:border-[#00D558] hover:text-[#00D558]"
                    }`}
                  >
                    {ATTRIBUTE_LABEL[token]}
                  </button>
                );
              })}
              {readOnlyTokens.map((token) => (
                <span
                  key={token}
                  title="Set during marketplace reconciliation — not editable here"
                  className="text-xs px-2 py-0.5 rounded border bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300 border-orange-300 dark:border-orange-700"
                >
                  {token === "unmatched-bsc"
                    ? "SL only"
                    : token === "unmatched-sl"
                      ? "BSC only"
                      : token}
                </span>
              ))}
            </div>
            <FieldFeedback
              busy={false}
              error={attributesError}
              errorId={attributesErrorId}
            />
          </div>

          {/* Print run / autograph. Autographed is the same features.autographed
              control CardFeaturesEditor uses elsewhere (via the shared
              CardFeatureRow), promoted to always-visible here instead of
              hidden behind "Show features" — this used to be a separate
              free-text autographType input with its own On-Card/Sticker/Cut
              vocabulary, disagreeing with this dropdown's None/On Card/
              Sticker/Label options. Removed in favor of one control. */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
                Print run (/N)
              </label>
              <Input
                bare
                {...printRunField.inputProps}
                type="number"
                readOnly={printRunField.busy}
                aria-busy={printRunField.busy || undefined}
                aria-invalid={printRunField.error ? true : undefined}
                aria-describedby={
                  printRunField.error ? printRunErrorId : undefined
                }
                className={`${fieldClass("printRun")} w-full p-1.5 text-sm`}
                placeholder="e.g. 99"
                aria-label="Print run"
                // 1, not 0: a print run of zero is not a card. Clearing the
                // field is how "not numbered" is expressed — see PRINT_RUN_MESSAGE.
                // `max` mirrors the server's own bound so the browser's stepper
                // cannot walk past a value the mutation would refuse.
                min={1}
                max={PRINT_RUN_MAX}
                step={1}
              />
              <FieldFeedback
                busy={printRunField.busy}
                error={printRunField.error}
                errorId={printRunErrorId}
              />
            </div>
            <CardFeatureRow
              feat={AUTOGRAPHED_FEATURE}
              cardValue={card.features?.autographed}
              cardIsRookie={undefined}
              onSave={async (value) => {
                await setCardFeature({
                  cardChecklistId: card._id,
                  key: "autographed",
                  value,
                });
                // a11y (audit fix, NEO-216/217): this row was silent — see
                // CardFeaturesEditor's `onFieldSaved` doc comment for why
                // that matters now that "None" is a real, clearable outcome.
                // This is a `toggleOptions` field (see AUTOGRAPHED_FEATURE):
                // its off-value is `options[0]` ("None"), never "" — unlike
                // the text/select rows, which spell "cleared" as "". Reads
                // `options[0]` rather than hardcoding "None" to match
                // ToggleOptionsValueControl's own `offValue` derivation
                // exactly (see CardFeaturesEditor's identical check).
                announce(
                  value === (AUTOGRAPHED_FEATURE.options?.[0] ?? "")
                    ? "Cleared Autographed"
                    : "Saved Autographed",
                );
              }}
              onSaveBoolean={async () => {}}
            />
          </div>
          <div>
            {/* NEO-101: warn-only. This is the field most likely to be sent as
                a marketplace item-specific value, which caps at 65 — but which
                NB field maps to which aspect is not settled, so the counter
                tells the truth and the save goes through either way. */}
            <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              <span>Variation</span>
              <TitleLengthMeter
                length={variationLength}
                max={ASPECT_VALUE_MAX}
              />
            </div>
            <Input
              bare
              {...variationInputProps}
              ref={(el) => {
                variationHookRef(el);
                variationInputRef.current = el;
              }}
              type="text"
              onChange={(e) => setVariationLength(e.target.value.length)}
              readOnly={variationField.busy}
              aria-busy={variationField.busy || undefined}
              className={`${fieldClass("cardVariation")} w-full p-1.5 text-sm`}
              placeholder="e.g. Gold Refractor"
              aria-label="Card variation"
              aria-invalid={variationField.error ? true : undefined}
              aria-describedby={
                [
                  variationLength > ASPECT_VALUE_MAX ? variationAlertId : null,
                  variationField.error ? variationErrorId : null,
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
            />
            <TitleLengthAlert
              id={variationAlertId}
              length={variationLength}
              max={ASPECT_VALUE_MAX}
              what="Variation"
              blocking={false}
            />
            <FieldFeedback
              busy={variationField.busy}
              error={variationField.error}
              errorId={variationErrorId}
            />
          </div>

          {/* NEO-189 — which card this one is a variation OF.

              The import derives this from the card number (BSC suffixes it,
              SportLots brackets the description), but that cannot cover a
              variation whose number shares no stem with its parent, or a set
              being built by hand. This is the escape hatch, and the only way a
              custom set gets variations at all.

              A CARD NUMBER, not a picker. A checklist runs to hundreds of
              cards, so a dropdown would be hundreds of options to scroll and
              toggle pills are not an option at that size. The operator already
              thinks "this is a variation of #1" — typing 1 is both faster and
              how they hold the problem. It is also keyboard-first, which this
              app requires.

              A choice made here is marked manual and the next sync leaves it
              alone — see setCardVariationParent. */}
          <div>
            {/* a11y: no `htmlFor` here — the Input primitive deliberately
                never emits its own `id` (see components/primitives/Input.tsx)
                because Maestro's resource-id falls back to aria-label when no
                id is set, and `.maestro/flows/set-selector/
                variation-link-group-and-unlink.yaml` targets this exact field
                by its aria-label text. Adding an id to satisfy `htmlFor` would
                switch Maestro's resource-id to that id and break the flow, so
                this label stays a purely visual caption — same pattern every
                other field in this panel already uses — and the input's own
                `aria-label` below carries the accessible name instead. */}
            <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              Variation of
            </label>
            {parentCard ? (
              <div className="flex items-center gap-2">
                <span className="text-sm flex-1 truncate">
                  #{parentCard.cardNumber} {parentCard.cardName}
                </span>
                <button
                  ref={clearButtonRef}
                  type="button"
                  onClick={() => void applyVariationParent("")}
                  className="text-xs px-2 py-1 rounded border border-gray-600 hover:bg-gray-700"
                  aria-label="Clear variation parent"
                >
                  Clear
                </button>
              </div>
            ) : (
              <Input
                bare
                ref={parentInputRef}
                type="text"
                value={parentNumber}
                onChange={(e) => setParentNumber(e.target.value)}
                onBlur={() => void applyVariationParent(parentNumber)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void applyVariationParent(parentNumber);
                  }
                }}
                className="w-full p-1.5 text-sm"
                placeholder="Card number, e.g. 1"
                aria-label="Card number this one is a variation of"
              />
            )}
            {parentError && (
              // a11y: NOT the brand `#FF2EB3` used for errors/destructive
              // actions elsewhere in this file — measured contrast for that
              // hex against this panel's own background is 3.34:1 on white and
              // 4.4:1 on dark:bg-gray-800, both under WCAG 1.4.3's 4.5:1
              // minimum for normal-size text. This is a systemic app-wide
              // issue (the same hex is used as text-on-light elsewhere
              // already), out of scope to fix everywhere here, but an *error
              // message* specifically has to be legible, so this instance uses
              // a darkened/lightened variant in the same hue: 5.55:1 on white,
              // 5.87:1 on dark:bg-gray-800.
              <p className="text-xs text-[#C2178A] dark:text-[#FF6FCB] mt-1" role="alert">
                {parentError}
              </p>
            )}
            {/* a11y: the only feedback a screen reader gets that the link
                (or clear) actually committed — see the effect that sets this
                and moves focus, above. `aria-live="polite"` rather than
                `role="alert"` because this is a success confirmation, not
                something demanding interruption. */}
            {parentStatus && !parentError && (
              <p
                className="text-xs text-gray-600 dark:text-gray-300 mt-1"
                role="status"
                aria-live="polite"
              >
                {parentStatus}
              </p>
            )}
          </div>

          {/* Players */}
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              Players
            </label>
            <PlayerPicker
              value={playerIds}
              onChange={(next) => void savePlayers(next)}
              sportId={ancestorSportId}
            />
            <FieldFeedback
              busy={playersPending !== null}
              error={playersError}
              errorId={playersErrorId}
            />
          </div>

          {/* Inherited from set (read-only) — where this card was printed.
              Cross-release membership is additive and lives in "Also appears
              in" below; these levels are never overridden per-card. */}
          {inheritedLevels.length > 0 && (
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
                Inherited from set
              </label>
              <dl className="rounded border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
                {inheritedLevels.map((lvl) => (
                  <div
                    key={lvl.level}
                    className="flex items-center justify-between px-2.5 py-1.5 text-xs"
                  >
                    <dt className="text-gray-400">{LEVEL_LABEL[lvl.level]}</dt>
                    <dd className="text-gray-500 dark:text-gray-400 truncate ml-3">
                      {lvl.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {/* NEO-21: guest sets this card also completes. Unlinking here drops
              only the junction row — the card itself stays in the set it was
              printed in, which is why this is separate from any delete. */}
          {crossListings && crossListings.length > 0 && (
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
                Also appears in
              </label>
              <ul className="rounded border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
                {crossListings.map((link) => (
                  <li
                    key={link._id}
                    className="flex items-center justify-between px-2.5 py-1.5 text-xs gap-3"
                  >
                    <span className="text-gray-500 dark:text-gray-400 truncate">
                      {link.setLabel}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        void removeCrossListing({ crossListingId: link._id });
                      }}
                      aria-label={`Unlink card from ${link.setLabel}`}
                      title="Remove this card from that set — the card itself is not deleted"
                      className="px-2 py-0.5 rounded text-[#FF2EB3] hover:bg-[#FF2EB3]/10 border border-transparent hover:border-[#FF2EB3]/50 shrink-0"
                    >
                      Unlink
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Images (bottom — display only; no fetch/upload here per the ticket) */}
          <div className="flex gap-3">
            {hasImages ? (
              <>
                {front && (
                  <img
                    src={front}
                    alt={`${card.cardName} front`}
                    className="h-40 w-auto rounded border border-gray-200 dark:border-gray-700 object-contain bg-gray-100 dark:bg-gray-900"
                  />
                )}
                {back && (
                  <img
                    src={back}
                    alt={`${card.cardName} back`}
                    className="h-40 w-auto rounded border border-gray-200 dark:border-gray-700 object-contain bg-gray-100 dark:bg-gray-900"
                  />
                )}
              </>
            ) : (
              <div className="h-40 w-28 rounded border border-dashed border-gray-300 dark:border-gray-600 flex items-center justify-center text-[10px] text-center text-gray-400 px-2">
                No image yet
              </div>
            )}
          </div>
        </div>

        {/* Footer.

            The Save and Cancel buttons are gone with the draft they served.
            What replaces them is not nothing: the rule has to be STATED
            (nobody guesses that a drawer with no Save button has already
            saved), and the last element in the dialog has to be focusable, or
            tabbing off the final field lands outside a modal that is still
            open — the NEO-189 stranding finding. "Done" is that element, and
            it does exactly what Escape and the × do. */}
        <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between gap-3">
          <span className="text-[10px] text-gray-500 dark:text-gray-400">
            Changes save as you leave each field.
          </span>
          <button
            onClick={onClose}
            aria-label="Done editing card"
            className="px-3 py-1.5 text-xs bg-[#00D558] text-black rounded hover:bg-[#00D558]/85 font-semibold"
          >
            Done
          </button>
        </div>
      </div>
    </div>
    </Theme>,
    document.body,
  );
}
