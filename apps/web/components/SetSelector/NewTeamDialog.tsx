import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { userFacingMessage } from "../../lib/errors/user-facing-message";
import NeonButton from "../modules/NeonButton";
import { parseAliases } from "./NewLeagueForm";
import NewTeamForm, {
  draftFullName,
  newTeamPrefill,
  type NewTeamDraft,
} from "./NewTeamForm";

/**
 * NEO-236 — creating a team, from anywhere a picker can reach.
 *
 * Jason, 2026-09-05: "we should also remove the Location box from New Players
 * as we should only be selecting existing teams or entering it in the singular
 * field which would trigger that new team dialog."
 *
 * So `TeamPicker` is back to ONE box — search, or type a name nothing matches —
 * and the three questions a `teams` row actually needs (Location, Name, League)
 * are asked here instead. The picker's job is to find a team; this dialog's job
 * is to create one. Collapsing the two is what produced the inline two-field
 * form this replaces, which had no room for the League and so silently filed
 * every new team under the sport's default.
 *
 * ## Why a portal, and why z-60
 *
 * The picker's popover is `absolute … z-10` inside whatever container hosts it,
 * and two of those containers are themselves scrolling dialogs — the card
 * attention walker's `overflow-y-auto` body, and the card drawer. An
 * absolutely-positioned child is clipped by a scrolling ancestor, which is what
 * NEO-236's earlier `scrollIntoView` workaround existed to paper over. A portal
 * to `document.body` is not clipped by anything, so the workaround is gone
 * rather than tuned. `z-60` puts it over the walker's own `z-50` overlay: a
 * modal underneath the thing that opened it is not a modal.
 *
 * `<Theme>` inside the portal for the same reason `EntityReviewWizard` needs
 * one — a portal escapes the root Theme's CSS scope.
 *
 * ## The keyboard contract, and where it differs from `ConfirmDialog`
 *
 * Escape closes, Tab is trapped, focus returns to whatever opened it. Focus
 * opens on the NAME field rather than on Cancel, because nothing here is
 * destructive: creating a team is additive, and the safe thing and the thing
 * the operator came to do are the same thing. That is the same reasoning
 * `AddLeagueDialog` gives for the same departure.
 *
 * **Enter creates.** The picker's Enter on a no-match query OPENS this dialog
 * with the name pre-filled; Enter inside it creates. Two presses for a team
 * that needs no editing, which is one more than before and buys the League
 * question — and every flow that created a team with a single Enter now says so
 * explicitly. Escape and the scrim are refused while the create is in flight,
 * so the result never lands on an unmounted host.
 */
/**
 * The eras a `TEAM_ERA_EXISTS` refusal carries, or null for any other error.
 *
 * NEO-254 — recognised by a structured `code`, not by its prose. Matching on
 * message text would couple the dialog's control flow to a sentence somebody
 * will reword, and it would fail SILENTLY: the confirmation would simply stop
 * arming, and the operator would meet a dead-end error where a confirmable one
 * used to be. Same convention as `NAME_TAKEN:<id>` in `teams.saveTeamFields`.
 *
 * Narrowed structurally rather than trusted: `data` crosses a network boundary,
 * and a client that destructured it blindly would turn a malformed payload into
 * a render crash on the one screen an operator is already being refused on.
 */
function teamEraRefusal(err: unknown): Array<{ years: string }> | null {
  if (!(err instanceof ConvexError)) return null;
  const data = err.data as { code?: unknown; eras?: unknown } | null;
  if (!data || typeof data !== "object" || data.code !== "TEAM_ERA_EXISTS") {
    return null;
  }
  if (!Array.isArray(data.eras)) return null;
  return data.eras.flatMap((era: unknown) =>
    era &&
    typeof era === "object" &&
    typeof (era as { years?: unknown }).years === "string"
      ? [{ years: (era as { years: string }).years }]
      : [],
  );
}

export default function NewTeamDialog({
  sportId,
  /** The name the operator typed in the picker. Becomes Name; Location starts
   *  blank unless `espnLocation` splits off its front. */
  initialName,
  /**
   * A location from an enrichment lookup the HOST already has in hand. Used
   * only when `splitTeamName` finds it as a whole-word prefix — there is no
   * first-token heuristic here and there must never be one.
   */
  espnLocation,
  /** A league name a lookup proposed, for the form's extra pill. */
  leagueSuggestion,
  onCreated,
  onClose,
}: {
  sportId: Id<"selectorOptions">;
  initialName: string;
  espnLocation?: string;
  leagueSuggestion?: string;
  /** The team that now exists. The host attaches it; this dialog does not know
   *  what "attach" means for its caller. */
  onCreated: (teamId: Id<"teams">) => void;
  onClose: () => void;
}) {
  const findOrCreate = useMutation(api.teams.findOrCreate);
  /*
   * NEO-254 — the picker has no batch to stage into and no later step, so a
   * league named here is CREATED, with the whole record `NewLeagueForm`
   * collects. `createByAdmin` is the same path the Leagues page uses, so the
   * two produce identical rows and share one set of bounds.
   */
  const createLeague = useMutation(api.leagues.createByAdmin);
  const [draft, setDraft] = useState<NewTeamDraft>(() =>
    newTeamPrefill({ name: initialName, location: espnLocation }),
  );
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  /** Where focus goes for the length of the create — see the effect below. */
  const createButtonRef = useRef<HTMLButtonElement | null>(null);
  const errorId = useId();
  /**
   * The heading's id, and the ONLY generated id in this dialog.
   *
   * Deliberately not passed down to the fields: maestro-web reads
   * `resource-id = node.id || node.ariaLabel`, so a generated id on an input
   * replaces the label every `.maestro` selector targets. `NewTeamForm` wraps
   * its labels when it is given no ids, which is accessible and leaves the
   * `aria-label` intact. A heading is not a target, so it may have one.
   */
  const titleId = useId();

  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement | null;
    // Opens on the field the operator came to type in, not on Cancel: nothing
    // here is destructive, so the safe thing and the intended thing coincide.
    // Same departure from `ConfirmDialog`, and the same reasoning, as
    // `AddLeagueDialog`.
    nameInputRef.current?.focus();
    return () => {
      const trigger = triggerRef.current;
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  /**
   * a11y (SC 2.4.3 Focus Order, and what keeps `aria-modal` true) — hold focus
   * inside the dialog for the length of the create.
   *
   * Enter inside a field is the documented way to submit this dialog, so the
   * focused element at the moment `creating` flips true is normally one of the
   * two text inputs — and `disabled={creating}` reaches every input and every
   * League pill through `NewTeamForm`. Disabling the CURRENTLY FOCUSED element
   * blurs it, and the browser drops focus to `<body>`: outside the portal, so
   * this dialog's `onKeyDown` (a React-tree handler) stops firing entirely and
   * neither the Tab trap nor Escape works until the round-trip finishes.
   *
   * The Create button is the one control that deliberately stays focusable
   * (`aria-disabled`, never native `disabled`), and its accessible name while
   * busy is "Creating team <name>" — so it is both a valid focus target and the
   * announcement of what is happening.
   */
  useEffect(() => {
    if (creating) createButtonRef.current?.focus();
  }, [creating]);

  const fullName = draftFullName(draft);
  /**
   * Why Create cannot fire, or null. Only ever a blank name: it is the one
   * thing that composes to nothing, the server refuses it anyway, and the
   * operator can fix it where they are standing. The length cap is left to the
   * server, which reports it with the number in it.
   */
  const blocked = draft.name.trim() ? null : "Enter a team name.";

  /**
   * NEO-254 — "yes, I mean a second era of a name we already hold."
   *
   * A sport can hold two teams under one name — the 1972-1996 Winnipeg Jets and
   * the 2011- Jets — and creating the second is a real, necessary act. It is
   * also exactly what a typo looks like, so the server refuses the first
   * attempt and NAMES the eras already on file; this holds the operator's
   * answer to that refusal, and the next press re-sends with it.
   *
   * State rather than a silent retry: an operator must see which team they are
   * about to sit beside before they agree to it. Reset whenever the name or
   * location changes, because the refusal was about THAT name — carrying a
   * stale confirmation past an edit is how a typo would slip through the guard
   * it just triggered.
   */
  const [confirmNewEra, setConfirmNewEra] = useState(false);
  const draftIdentity = `${draft.location.trim()}|${draft.name.trim()}`;
  const [confirmedFor, setConfirmedFor] = useState(draftIdentity);
  if (confirmedFor !== draftIdentity) {
    setConfirmedFor(draftIdentity);
    setConfirmNewEra(false);
  }

  const create = async () => {
    if (creating) return;
    if (blocked) {
      // The button is `aria-disabled`, not `disabled`, so it stays focusable
      // and clickable on purpose — which means activating it has to SAY
      // something rather than doing nothing visible.
      setError(blocked);
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const location = draft.location.trim();
      const id = await findOrCreate({
        name: draft.name.trim(),
        sportId,
        // Omitted rather than sent empty: the server models "no location" as an
        // absent optional, and an empty string would be a third state meaning
        // the same thing.
        ...(location ? { location } : {}),
        // Only ever one of the two — `NewTeamForm` clears the other on every
        // pick. `leagueId: null` is sent VERBATIM, because null is the
        // operator's "no league" and the server tells it apart from "not
        // answered" (which is what an omitted key means, and what still lets
        // the sport default apply).
        ...(draft.leagueId !== undefined ? { leagueId: draft.leagueId } : {}),
        ...(draft.leagueName ? { leagueName: draft.leagueName } : {}),
        // NEO-254 — the era, and the operator's confirmation of it. Both
        // omitted rather than sent empty, for the same reason `location` is.
        ...(draft.yearsActive ? { yearsActive: draft.yearsActive } : {}),
        ...(confirmNewEra ? { newEra: true } : {}),
      });
      onCreated(id);
      onClose();
    } catch (err) {
      // The ConvexError's `data`, never `.message`: production redacts a plain
      // Error, and a surviving message arrives wrapped in request-id noise.
      /**
       * NEO-254: the "this name already has eras" refusal is a QUESTION, not a
       * failure, and it is recognised by its structured `code` rather than by
       * its prose.
       *
       * Matching on message text would couple this control flow to a sentence
       * somebody will reword — silently, because the arming would simply stop
       * happening and the operator would meet a dead-end error instead of a
       * confirmable one. The server sends the eras as data (`TEAM_ERA_EXISTS`,
       * mirroring `NAME_TAKEN:<id>`) and the copy is composed here, which is
       * also where it belongs: the server does not write UI strings.
       */
      const existing = teamEraRefusal(err);
      if (existing) {
        setConfirmNewEra(true);
        setError(
          `${fullName || draft.name.trim()} already exists for ${existing
            .map((era) => era.years || "no years yet")
            .join(", ")}. Create again to add this as a second era.`,
        );
      } else {
        setError(userFacingMessage(err, "Could not create team."));
      }
    } finally {
      setCreating(false);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      // Escape must not reach the host behind this dialog: in the attention
      // walker Escape means "defer this card", and closing a team form should
      // never also defer the card the operator is fixing.
      event.stopPropagation();
      if (!creating) onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    // `:not([tabindex="-1"])` on the element selectors as well as the attribute
    // one: `NewTeamForm`'s League pills are real `<button>`s carrying a roving
    // tabindex, so all but one of them are deliberately NOT Tab stops. Matching
    // them as `button:not([disabled])` would have put unreachable elements into
    // the list this computes `first` and `last` from.
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), a[href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <Theme>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 outline-none"
        onKeyDown={onKeyDown}
        onClick={() => {
          if (!creating) onClose();
        }}
      >
        {/*
          NEO-254 — header / body / footer, with only the BODY scrolling.

          The panel used to be one box that grew as tall as its contents, inside
          a centred flex container with no maximum. That was survivable while the
          form was four fields; the era fields added ~60px, and an expanded
          league pill list adds a scroll box of its own, which between them push
          the button row and the `role="alert"` refusal off the bottom of the
          1024x629 viewport CI runs at. An operator cannot press a button they
          cannot reach, and a refusal nobody can see reads as the dialog doing
          nothing.

          So the panel is capped at the viewport and the FIELDS scroll inside it,
          while the title, the error and the actions sit outside that region and
          are always on screen. Same header/body/footer split the review wizard
          uses, and for the same reason. `min-h-0` on the scroller is what makes
          it actually shrink inside a flex column — without it the child's
          content height wins and the cap does nothing.
        */}
        <div
          className="flex max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col rounded-lg border border-gray-700 bg-gray-900 shadow-xl"
          onClick={(event) => event.stopPropagation()}
        >
          <h2
            id={titleId}
            className="shrink-0 px-5 pt-5 pb-4 text-lg font-semibold text-gray-100"
          >
            {/* The name the operator typed, so the dialog is visibly about the
                thing they were doing rather than a generic form. */}
            New team{initialName.trim() ? `: ${initialName.trim()}` : ""}
          </h2>

          <div
            data-testid="new-team-dialog-body"
            className="min-h-0 flex-1 overflow-y-auto px-5"
          >
            <NewTeamForm
              sportId={sportId}
              draft={draft}
              onChange={(patch) => {
                // A refusal described the values that were in the boxes; the next
                // keystroke makes it stale, so it goes with them.
                setError(null);
                setDraft((prev) => ({ ...prev, ...patch }));
              }}
              leagueSuggestion={leagueSuggestion}
              onCreateLeague={async (leagueDraft) => {
                const { id } = await createLeague({
                  name: leagueDraft.name.trim(),
                  sportId,
                  ...(leagueDraft.abbreviation.trim()
                    ? { abbreviation: leagueDraft.abbreviation.trim() }
                    : {}),
                  ...(leagueDraft.level ? { level: leagueDraft.level } : {}),
                  ...(leagueDraft.fromYear.trim()
                    ? {
                        yearsActive: {
                          from: Number(leagueDraft.fromYear.trim()),
                          ...(leagueDraft.toYear.trim()
                            ? { to: Number(leagueDraft.toYear.trim()) }
                            : {}),
                        },
                      }
                    : {}),
                  ...(parseAliases(leagueDraft.aliases).length
                    ? { aliases: parseAliases(leagueDraft.aliases) }
                    : {}),
                  ...(leagueDraft.wikidataId.trim()
                    ? { wikidataId: leagueDraft.wikidataId.trim() }
                    : {}),
                });
                return { id, name: leagueDraft.name.trim() };
              }}
              onLeagueStatus={(status) =>
                setError(status.isError ? status.text : null)
              }
              describedBy={error ? errorId : undefined}
              // No field ids: see `titleId`. The fields are addressed by their
              // aria-labels, which is what the flows target.
              nameInputRef={nameInputRef}
              disabled={creating}
              onSubmit={() => void create()}
            />
          </div>

          {/* Outside the scroll region, both of them.

              The refusal because a message the operator has to scroll to find
              is a message they will not find — and this one is now a QUESTION
              ("adds a second era") whose answer is the button directly below
              it. The actions because a dialog whose primary action can leave
              the viewport is a dialog that cannot be completed. */}
          <div className="shrink-0 space-y-4 border-t border-gray-800 px-5 pt-4 pb-5">
            {error && (
              <p id={errorId} role="alert" className="text-sm text-[#FF2EB3]">
                {error}
              </p>
            )}

            <div className="flex items-center gap-3">
              <NeonButton
                ref={createButtonRef}
                type="button"
                // `aria-disabled`, not `disabled`: a keyboard operator who has
                // tabbed here must not be ejected from the dialog for the length
                // of a round-trip, and the reason a blank name blocks the create
                // has to stay reachable.
                aria-disabled={creating || blocked !== null ? true : undefined}
                // The accessible name every `.maestro` flow targets. It carries
                // the COMPOSED name, so a screen reader announces exactly the row
                // about to be written — and a team with no location reads exactly
                // as it did before this dialog existed.
                aria-label={
                  creating
                    ? `Creating team${fullName ? ` ${fullName}` : ""}`
                    : fullName
                      ? `Create team ${fullName}`
                      : "Create team"
                }
                onClick={() => void create()}
              >
                {creating ? "Creating…" : "Create team"}
              </NeonButton>
              <NeonButton
                cancel
                type="button"
                onClick={onClose}
                disabled={creating}
              >
                Cancel
              </NeonButton>
            </div>
          </div>
        </div>
      </div>
    </Theme>,
    document.body,
  );
}
