import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import NeonButton from "../modules/NeonButton";
import { ConfirmDialog } from "../modules/confirm-dialog";
import { Input } from "../primitives/Input";
import { countPairingEdits } from "./pairing-session-edits";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";
import { keyboardAwareCollision } from "@/lib/dnd/keyboard-aware-collision";
import { isEditableTarget } from "../../lib/dom/is-editable-target";
// NEO-339: the reducer, its seed and the Confirm payload live in
// lib/set-build/pairing.ts, shared with the set-building tool.
import {
  buildPairingResult,
  candidateKey,
  nameConflictOf,
  pairingReducer as reducer,
  playersConflictOf,
  seedMatched,
  seedPairingState as seedState,
  type MatchedPair,
  type PairingCard,
  type PairingInitialData,
  type PairingResult,
} from "@/lib/set-build/pairing";
// NEO-251 security review — the two bounds the server enforces on every path a
// player name can take, applied here as well so the operator finds out while
// the field is still in front of them rather than at the end of a 900-card
// commit. `MAX_CARD_PLAYERS` comes through the same `card-attention` seam the
// rest of this screen's shared card rules do.
import { MAX_CARD_PLAYERS } from "./card-attention";
import { MAX_PLAYER_NAME_LENGTH } from "../../lib/players/name-limits";

export type {
  PairingCard,
  PairingConflicts,
  PairingResult,
} from "@/lib/set-build/pairing";

/**
 * NEO-137 — card-level pairing, before any NB card exists.
 *
 * Deliberately the same three-bucket screen the operator already knows from
 * set reconciliation (ReconciliationModal): matched pairs, unmatched-BSC,
 * unmatched-SL, plus a keep shelf for a card that legitimately lives on only
 * one marketplace. The vocabulary is identical because the problem is:
 * "these two lists describe the same things, tell me which line up".
 *
 * Why this exists at all: when two NB rows share one SportLots set — 1996
 * Score's Dugout Collection Artist's Proofs Series 1 and 2 both mapping to the
 * single SL "Dugout Collection Artists Proofs" — the sibling row's cards come
 * back in this row's SL fetch. Materialising them would invent bogus cards
 * under this row. Here they simply sit in unmatched-SL and are dropped unless
 * the operator deliberately keeps one, which is the same rule set
 * reconciliation already uses for marketplace noise.
 *
 * Nothing is written until Confirm. Cards are generated from confirmed pairs
 * plus kept singles, and only then do the player/team/Wikidata syncs run.
 *
 * Keyboard model (matches ReconciliationModal):
 *   Tab    — cycles filters, rows, footer buttons
 *   Enter  — confirm when focus is on Confirm
 *   Escape — cancel
 */

/**
 * `candidateKey` reduced to characters that are legal in a DOM id.
 *
 * The name-conflict row needs a per-row handle for two things — the `id` its
 * `aria-describedby` points at, and the `[data-name-conflict=…]` selector
 * `refocusSelectedRadio` re-queries after a dispatch. Both were keyed on the
 * card NUMBER, which is not unique here for the same reason it is not unique
 * anywhere else on this screen: a card and its variation share one. Two
 * conflicting pairs on the same number therefore emitted a duplicate `id`
 * (invalid HTML — `aria-describedby` resolves to whichever came first) and
 * sent the arrow-key focus into the FIRST row's radiogroup no matter which row
 * the operator was working in.
 *
 * A ref can contain spaces and `#` (SportLots refs are whole card titles), and
 * an id containing a space is not addressable by `aria-describedby` at all,
 * hence the fold to `[A-Za-z0-9_-]`.
 */
function domKey(c: PairingCard): string {
  return candidateKey(c).replace(/[^A-Za-z0-9_-]+/g, "-");
}

/**
 * NEO-189 operator feedback — the two unmatched columns are drag-and-drop.
 *
 * Click-to-select-then-click was the only way to link a BSC-only card to a
 * SportLots-only one, and nothing on screen said so: a row highlighted cyan
 * with no other affordance, in an app that uses drag-and-drop for exactly this
 * "these two lists describe the same thing" gesture everywhere else
 * (ReconciliationModal pairs marketplace SETS by drag; ParallelGroupingModal
 * groups parallels by drag). This column pair is the same gesture one level
 * down, so it now behaves the same way.
 *
 * The click path is NOT replaced. It is the keyboard/assistive-tech path —
 * dnd-kit's pointer drag has no keyboard equivalent that survives this
 * dialog's focus trap — and it is what the Maestro flow drives. Drag is an
 * addition on top of it.
 */
type DragSide = "bsc" | "sl";

/**
 * A drag id is `side:candidateKey`. The SIDE has to travel with the key
 * because a drop is only a link when the two ends are on OPPOSITE sides, and
 * `candidateKey` alone cannot say which column a row came from — a SportLots
 * ref is a whole card title and a BSC ref is an opaque id, with no shared
 * shape to test.
 *
 * Split on the FIRST colon only: a SportLots ref can contain one
 * ("#227 Carl Yastrzemski [ VAR: SSSP ]"), the two side prefixes cannot.
 */
function dragId(side: DragSide, key: string): string {
  return `${side}:${key}`;
}

function parseDragId(
  id: string,
): { side: DragSide; key: string } | undefined {
  const i = id.indexOf(":");
  if (i < 0) return undefined;
  const side = id.slice(0, i);
  if (side !== "bsc" && side !== "sl") return undefined;
  return { side, key: id.slice(i + 1) };
}

/** "1 pairing" / "2 pairings". */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * One unmatched row: draggable, and a drop target for the other column.
 *
 * Both hooks share one id and one node, which is what makes linking work in
 * either direction for the price of one component — a BSC row dropped on a
 * SportLots row and a SportLots row dropped on a BSC row are the same link,
 * and `handleDragEnd` sorts out which end is which.
 *
 * `attributes` from `useDraggable` are deliberately NOT spread. They carry
 * `role="button"` and `tabIndex=0`, and this row is an <li> that already
 * contains two real <button>s:
 *   - `role="button"` on the wrapper makes those children presentational to
 *     assistive tech (ARIA hides nested widgets inside a widget), which would
 *     take the select/link/keep controls off the AT path entirely — the exact
 *     path this change is supposed to leave untouched.
 *   - `tabIndex=0` would add one dead tab stop per row to the dialog's focus
 *     trap (its Tab handler queries `[tabindex]:not([tabindex="-1"])`), so a
 *     900-row set would grow 900 stops that do nothing when activated.
 * The listeners alone are what the PointerSensor needs; the accessible
 * affordance for the same action is the click path, which is untouched.
 *
 * Plain clicks on the inner buttons still work because the PointerSensor's
 * 5px activation constraint means a drag never starts from a stationary press
 * (same reasoning as ParallelGroupingModal).
 *
 * NEO-300 — the <li> is also the drag's ACTIVATOR node. Without one, dnd-kit's
 * KeyboardSensor takes a Space or Enter bubbling up from ANY child as "lift
 * this row": it preventDefaults the key, so the Select / Link / Keep button
 * never fires, and a drag starts instead. That broke the keyboard path this
 * row's comment above calls the accessible one. With the <li> as the
 * activator, only a key pressed on the <li> itself lifts it — and the <li>
 * is deliberately not focusable, so keyboard users link by Select + Link,
 * exactly as before.
 */
function PairableRow({
  side,
  cardKey,
  children,
}: {
  side: DragSide;
  cardKey: string;
  children: React.ReactNode;
}) {
  const id = dragId(side, cardKey);
  const {
    listeners,
    setNodeRef: setDragRef,
    setActivatorNodeRef,
    isDragging,
  } = useDraggable({ id });
  const { setNodeRef: setDropRef, isOver, active } = useDroppable({ id });
  const setRef = useCallback(
    (node: HTMLLIElement | null) => {
      setDragRef(node);
      setDropRef(node);
      setActivatorNodeRef(node);
    },
    [setDragRef, setDropRef, setActivatorNodeRef],
  );
  // Highlight only for a drop that would actually DO something. A row is its
  // own droppable, and same-column drops are no-ops, so an unconditional
  // `isOver` would promise a link that `handleDragEnd` then declines to make.
  const isLinkTarget =
    isOver &&
    typeof active?.id === "string" &&
    parseDragId(active.id)?.side !== side;

  return (
    <li
      ref={setRef}
      {...listeners}
      className={`flex items-center gap-2 rounded cursor-grab active:cursor-grabbing ${
        isDragging ? "opacity-40" : ""
      } ${isLinkTarget ? "ring-2 ring-[#00B7FF] bg-[#00B7FF]/10" : ""}`}
    >
      {children}
    </li>
  );
}

/** How a roster reads inside a pill: "Alec Bohm / Spencer Howard". */
function joinPlayers(players: string[]): string {
  return players.join(" / ");
}

/**
 * How a roster reads inside the EDIT field: "Alec Bohm | Spencer Howard".
 *
 * Deliberately not `joinPlayers`. The field's own label names `|` as the
 * separator, and a field pre-filled with a separator its label does not
 * mention teaches the operator the wrong thing about what they may type. The
 * pills keep ` / ` because they are prose, not input.
 */
function joinCustomPlayers(players: string[]): string {
  return players.join(" | ");
}

/**
 * The custom-roster field's own separator, and the one its label names.
 *
 * ` / ` is accepted too because it is what the pills show, and an operator
 * copying a pill's text into the field should not be punished for it. Split on
 * a SPACED slash only: "Ken Griffey Jr./Sr." is one name, and an unspaced
 * slash inside a name is not a separator.
 */
function splitPlayers(text: string): string[] {
  return text
    .split(/\||\s+\/\s+/)
    .map((name) => name.trim())
    .filter(Boolean);
}

/**
 * NEO-189 — a variation's NAME is part of its label, not decoration.
 *
 * Without it a set's variations are indistinguishable in this list: 2021 Topps
 * shows "#1b Fernando Tatis Jr." and "#1c Fernando Tatis Jr.", and three
 * "#13x Mookie Betts" rows, with nothing to tell them apart. An operator
 * pairing by hand has to pick the right one and cannot.
 *
 * The name is already on the card — BSC's "Sliding" / "In Dugout", SportLots'
 * bracketed equivalent — it just was not being shown. Folding it into `label`
 * rather than a badge means it reaches the aria-labels and the Maestro targets
 * too, which is where the ambiguity would bite hardest.
 */
function label(card: PairingCard): string {
  const base = `#${card.cardNumber} ${card.cardName}`.trim();
  return card.cardVariation ? `${base} · ${card.cardVariation}` : base;
}

/**
 * NEO-201 — what to call a name-conflict row out loud, when the card number
 * cannot do the job on its own.
 *
 * The conflict region and its radiogroup were named `#227c` alone. Two
 * conflicting pairs on one number therefore announced two identically-named
 * regions and two identically-named radiogroups — precisely the ambiguity
 * `label()` exists to kill in the unmatched columns, left standing in the one
 * place on this screen where the operator is being asked to make a decision.
 *
 * The obvious fix — reuse `label()` — is wrong. `label()` reads `cardName`,
 * and `cardName` is the exact thing this control CHANGES: the region would
 * rename itself under the operator the instant they picked the other name. A
 * region whose accessible name mutates while you are using it is worse than
 * one that is merely ambiguous, because a screen reader re-announces it and
 * the thing you were just in appears to have become something else.
 *
 * So the disambiguator has to be stable across the choice, which rules out
 * every name-derived candidate. What is left:
 *
 *  - `cardVariation` — stable, and the only candidate that MEANS anything
 *    ("#227 · Sliding" / "#227 · In Dugout" is how the two rows differ on the
 *    printed card). Not always available: the row that motivated this had BSC
 *    filing #227c with an empty variation description, and two rows can also
 *    share one.
 *  - an ordinal — always available, stable now that `compareCards` gives the
 *    list a total order, but says nothing about WHICH card.
 *  - the marketplace ref — unique and stable, and unusable: SportLots refs are
 *    whole card titles ("#227 Carl Yastrzemski [ VAR SSSP ]"), so it reads as
 *    machine noise and re-announces the name that is under dispute.
 *
 * Hence: prefer the variation, fall back to an ordinal. The fallback is
 * decided PER NUMBER, not per row, so a group never mixes "· Sliding" with
 * "(2 of 2)" — a half-meaningful naming scheme is harder to follow than a
 * uniformly dull one, and "#227" versus "#227 · Sliding" distinguishes the two
 * rows only by an absence, which is not something you can hear.
 *
 * A number with a single conflict on it is not ambiguous and gets NO suffix:
 * "(1 of 1)" is noise on every ordinary row, and leaving the common case
 * byte-identical is also what keeps the existing Maestro selectors valid.
 *
 * Returned keyed by `candidateKey` because that is the row's identity;
 * `state.matched` is re-sorted after every dispatch, so an index would not
 * survive the trip to the render.
 */
function conflictScopeLabels(matched: MatchedPair[]): Map<string, string> {
  const byNumber = new Map<string, MatchedPair[]>();
  for (const m of matched) {
    // NEO-251: EITHER conflict puts the row in the naming scheme. The scope is
    // a property of the ROW, not of which field is disputed — two rows on one
    // number need telling apart whichever control they are carrying, and the
    // two controls on a single row must agree about what that row is called.
    if (!m.nameConflict && !m.playersConflict) continue;
    const rows = byNumber.get(m.card.cardNumber);
    if (rows) rows.push(m);
    else byNumber.set(m.card.cardNumber, [m]);
  }

  const labels = new Map<string, string>();
  for (const [cardNumber, rows] of byNumber) {
    if (rows.length === 1) {
      labels.set(candidateKey(rows[0].card), `#${cardNumber}`);
      continue;
    }
    const variations = rows.map((m) => (m.card.cardVariation ?? "").trim());
    // Usable only if it actually separates every row in the group — an empty
    // one, or two rows sharing a description, and the whole group falls back.
    const useVariation =
      variations.every((v) => v.length > 0) &&
      new Set(variations).size === rows.length;
    rows.forEach((m, i) => {
      labels.set(
        candidateKey(m.card),
        useVariation
          ? `#${cardNumber} · ${variations[i]}`
          : `#${cardNumber} (${i + 1} of ${rows.length})`,
      );
    });
  }
  return labels;
}

/**
 * NEO-251 — ONE "the two marketplaces disagree, pick one" control.
 *
 * Extracted verbatim from the name-conflict block NEO-189 built, and then used
 * for the roster conflict too. The extraction is the point: the two controls
 * are the same decision about different fields, and a second hand-written copy
 * is how a screen ends up with two radiogroups that behave differently under
 * the arrow keys, announce themselves differently, and drift apart the first
 * time either is fixed. The name-conflict markup is byte-for-byte what it was
 * — same classes, same aria, same DOM order — because the Maestro flow and
 * roughly forty unit assertions address it by its rendered text.
 *
 * `handleAttr` is a data attribute rather than an id because the focus helper
 * re-queries this subtree AFTER a dispatch: `ordered()` re-sorts
 * `state.matched` on every action, so an index or an element ref captured
 * beforehand cannot be trusted to still mean the same row.
 *
 * Deliberately NOT parameterised: the accent. Both conflicts use the same pink
 * rail and the same ⚠. A second alert colour on one row would make the two
 * controls compete for the operator's eye and dilute what pink means on this
 * screen — the words and the accessible names are what say which decision is
 * which.
 */
type ConflictSide = "bsc" | "sportlots" | "custom";

function ConflictRadioGroup({
  handleAttr,
  handleKey,
  groupLabel,
  warningId,
  warning,
  radioGroupLabel,
  options,
  chosen,
  onChoose,
  children,
}: {
  /** e.g. `data-name-conflict` — the row handle the focus helper re-queries. */
  handleAttr: string;
  handleKey: string;
  /** Names the region: "Name conflict on #227c". */
  groupLabel: string;
  warningId: string;
  /** The sentence explaining why there is a choice at all. */
  warning: string;
  /** Names the radiogroup: "Name for #227c". */
  radioGroupLabel: string;
  options: Array<{ side: ConflictSide; label: string; ariaLabel: string }>;
  chosen: ConflictSide;
  /**
   * `viaKeyboard` exists because the two ways of choosing need different
   * follow-through: an arrow key moves focus WITH selection (the APG pattern),
   * so the caller has to re-focus the newly-checked radio after the render; a
   * click already left focus on the right element.
   */
  onChoose: (side: ConflictSide, viaKeyboard: boolean) => void;
  /** Extra controls under the pills — the roster conflict's own text field. */
  children?: React.ReactNode;
}) {
  return (
    <div
      role="group"
      // Named by the row's SCOPE, not by `label(m.card)`: see
      // `conflictScopeLabels`. The name has to hold still while the operator
      // uses the control it names.
      aria-label={groupLabel}
      // COLUMN, not a wrapping row. As `flex flex-wrap` the warning sentence
      // and the pills sat side by side when they happened to fit and dropped
      // below when they did not, so the same control was laid out differently
      // on adjacent rows purely as a function of how long the two values were
      // — the operator has to re-find the pills on every row. The sentence is
      // the explanation and the pills are the decision; they read
      // top-to-bottom, always. (The pills themselves still wrap — see the
      // radiogroup's own `flex flex-wrap` below.)
      className="flex flex-col items-start gap-1.5 border-l-2 border-[#FF2EB3] pl-2 py-1"
      {...{ [handleAttr]: handleKey }}
    >
      <span id={warningId} className="text-xs text-[#FF2EB3]">
        {/* Decorative — the sentence itself carries the meaning, so AT
            shouldn't also be made to announce "warning sign" first. */}
        <span aria-hidden="true">⚠</span> {warning}
      </span>
      {/*
        a11y (NEO-189 audit) — this is a mutually exclusive,
        always-exactly-one-chosen set, i.e. exactly the case the WAI-ARIA APG
        radio-group pattern is for, not independent aria-pressed toggles (which
        carry no guarantee, semantic or enforced, that they're mutually
        exclusive, and give a keyboard user no arrow-key way to move between
        them as a set). Kept visually as pill buttons per the design — only the
        semantics and keyboard handling changed.
      */}
      <div
        role="radiogroup"
        aria-label={radioGroupLabel}
        aria-describedby={warningId}
        className="flex flex-wrap items-center gap-2"
        onKeyDown={(e) => {
          if (
            !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
          ) {
            return;
          }
          // The APG pattern moves focus WITH selection on a single-select
          // radio group, and wraps at both ends. This used to be a toggle,
          // which was only correct while there were exactly two options — an
          // operator-typed value makes a third, and a toggle would have made
          // it unreachable by keyboard while leaving it clickable by mouse.
          // The order matches the rendered order, so "next" means the pill to
          // the right.
          e.preventDefault();
          const at = options.findIndex((o) => o.side === chosen);
          const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
          const next =
            options[(at + step + options.length) % options.length];
          onChoose(next.side, true);
        }}
      >
        {options.map((option) => (
          <button
            key={option.side}
            type="button"
            role="radio"
            aria-checked={chosen === option.side}
            // Roving tabindex: only the checked radio is a Tab stop, matching
            // native radio-group behaviour and the APG pattern.
            tabIndex={chosen === option.side ? 0 : -1}
            // The accessible name STARTS WITH the visible label so it
            // satisfies WCAG 2.5.3 Label in Name — a speech-input user saying
            // "click BSC: <value>" has to match what is actually announced.
            aria-label={option.ariaLabel}
            onClick={() => onChoose(option.side, false)}
            className={`text-xs rounded px-2 py-1.5 ${
              chosen === option.side
                ? "bg-cyan-900/60 text-cyan-100 ring-2 ring-[#00B7FF]"
                : "bg-gray-700/60 text-gray-300"
            }`}
          >
            {/* 1.4.1 Use of Color — the cyan/gray fill pair differs by hue
                only (~1:1 lightness contrast), indistinguishable to a
                colour-blind operator deciding which value wins. The checkmark
                + ring give a non-colour cue for the state colour alone was
                carrying. */}
            {chosen === option.side && <span aria-hidden="true">✓ </span>}
            {option.label}
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}

/**
 * NEO-195 / NEO-330 a11y — the visible streaming sentence. Static text, NOT a
 * live region: it ticks "(7 of 20 done)" on every card, and a live region
 * re-reading the whole sentence per tick drowns the operator. The coarse
 * announcements below speak for it instead. Exported for the test.
 */
export function pairingStreamingSentence(progress?: { ready: number; total: number }): string {
  const count =
    progress && progress.total > 0 ? ` (${progress.ready} of ${progress.total} done)` : "";
  return `Pair away — teams are still resolving in the background${count}. Confirm unlocks when the fetch finishes.`;
}

/** Said at each quarter of the way through: "Teams resolving — 10 of 20 done." */
export function pairingStreamProgressAnnouncement(ready: number, total: number): string {
  return `Teams resolving — ${ready} of ${total} done.`;
}

/** Said once when the stream ends with the dialog open, then cleared. */
export const PAIRING_STREAM_DONE_ANNOUNCEMENT = "Teams are in. Confirm is ready.";

/** Said instead of the done announcement when some teams missed the wait. */
export function pairingStreamLateAnnouncement(teamsLateNotice: string): string {
  return `Confirm is ready. ${teamsLateNotice}`;
}

/** How long the done announcement stays in the region before it is cleared. */
export const PAIRING_STREAM_DONE_CLEAR_MS = 5000;

/**
 * Delay before the opening announcement, so the region (mounted with the
 * dialog) is in the accessibility tree before its text changes — text present
 * at insertion is not reliably announced.
 */
const PAIRING_STREAM_START_DELAY_MS = 150;

export default function CardPairingModal({
  isOpen,
  onClose,
  onConfirm,
  setLabel,
  initialData,
  isStreaming,
  streamSettled,
  streamProgress,
  teamsLateNotice,
  restoreFocusRef,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (result: PairingResult) => Promise<void>;
  /** e.g. "Dugout Collection Artist's Proofs Series 1" — for the heading. */
  setLabel?: string;
  initialData: PairingInitialData;
  /**
   * NEO-195 — the fetch is still running and more candidates are coming.
   *
   * Review may begin, but Confirm is BLOCKED while this is true: committing
   * mid-stream would save a partial checklist and silently discard every card
   * that had not arrived yet. Early review is the point; early commit is a bug.
   */
  isStreaming?: boolean;
  /**
   * NEO-341 — the parent has SEEN this fetch's whole batch with every team
   * lookup landed (`streamedBatchSettled`). Confirm stays blocked until it
   * has, even after `isStreaming` goes false: the fetch action's promise
   * resolves before the client necessarily has its last team writes, and a
   * card confirmed without its team skips the entity-review wizard.
   *
   * Omitted means "nothing to wait for" — a caller that does not stream.
   */
  streamSettled?: boolean;
  /** Progress for the streaming banner: cards released / cards found so far. */
  streamProgress?: { ready: number; total: number };
  /**
   * NEO-330 — what to say when the wait has ENDED with some teams still
   * out (`streamProgress.ready < total` once Confirm is no longer blocked —
   * `isStreaming` false and, NEO-341, `streamSettled` latched: exactly the
   * owner's "teams late" condition). The owner passes its
   * `TEAMS_LATE_NOTICE`, so the sync banner behind this modal and the line in
   * its footer say one sentence from one source. The line shows only while it
   * is true — a team that lands afterwards takes it away, the same rule the
   * owner's Confirm wrapper applies.
   */
  teamsLateNotice?: string;
  /**
   * a11y (NEO-221) — where to send keyboard focus when this dialog closes,
   * PREFERRED over this component's own `document.activeElement`-at-mount
   * capture.
   *
   * That capture is correct the FIRST time this opens (a plain click, nothing
   * unmounts in between). It is not reliable when `CardChecklist` reopens this
   * same modal via the entity wizard's "Back to matching": that click unmounts
   * the wizard (removing whatever had focus — the "Back to matching" button
   * itself) in the same state update that flips `isOpen` back to true, so by
   * the time this component's mount effect runs, the browser has already
   * blurred to `<body>` — capturing that "restores" focus to nowhere. Mirrors
   * `SyncReviewModal`'s own `restoreFocusRef` for the identical reason.
   * Optional and additive: omitting it keeps the original capture-on-mount
   * behavior for every existing caller/test.
   */
  restoreFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [state, dispatch] = useReducer(reducer, initialData, seedState);
  const [selectedBsc, setSelectedBsc] = useState<string | null>(null);
  /**
   * NEO-189 follow-up — which matched row's title is open for editing, keyed
   * on `candidateKey`.
   *
   * NOT the array index, for the reason `LINK`, `KEEP` and `refocusSelectedRadio`
   * all avoid indexes: `ordered()` re-sorts `state.matched` after every
   * dispatch, and `ABSORB` inserts rows into it while the operator works. A
   * held index would silently come to mean a DIFFERENT row — so an `UNLINK`
   * or a streamed arrival elsewhere in the list would leave an open text field
   * sitting on someone else's card, which is the same class of bug as
   * number-keyed KEEP moving the wrong row to the shelf.
   *
   * A key that no longer matches any row (its row was unlinked out of
   * `matched`) simply matches nothing and no editor renders — the state is
   * self-cancelling rather than dangling.
   */
  const [editingKey, setEditingKey] = useState<string | null>(null);
  /** The in-progress text. Only meaningful while `editingKey` is set. */
  const [editDraft, setEditDraft] = useState("");
  /**
   * NEO-251 — the in-progress text of ONE roster field, keyed on
   * `candidateKey` for the same reason `editingKey` is: `ordered()` re-sorts
   * `state.matched` after every dispatch and `ABSORB` inserts rows into it, so
   * a held index would come to mean a different row and leave a half-typed
   * roster sitting on somebody else's card.
   *
   * One draft at a time rather than a map: only one field can have focus, and
   * a map would keep stale text alive for rows the operator has moved on from.
   * With no draft the field simply renders the row's current roster, so
   * `CHOOSE_PLAYERS` is reflected in it immediately.
   *
   * Unlike the title editor this field is always mounted, so Escape does not
   * unmount it and there is no removal-blur to race — hence no
   * `editSessionDoneRef` equivalent.
   */
  const [playersDraft, setPlayersDraft] = useState<{
    key: string;
    text: string;
  } | null>(null);
  /**
   * a11y (accessibility audit, NEO-251) — WCAG 3.3.1 Error Identification for
   * the two silent-refusal paths `RENAME` and `EDIT_PLAYERS` added over an
   * unbounded field: an over-length name or an over-count roster used to be
   * discarded with the input simply reverting to its old value and NOTHING
   * announced, sighted or not. These hold the message to show (and, for the
   * roster field, block the draft-clearing that was erasing what the operator
   * typed) until they correct it or move on. Keyed like `editingKey` /
   * `playersDraft` for the same reason: only one field can be in error at a
   * time, and a stale key must not paint an error on a row the operator has
   * moved off of.
   */
  const [nameError, setNameError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [playersError, setPlayersError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  /**
   * Has the OPEN edit session already been settled?
   *
   * `finishEdit` has two triggers that a real browser fires as a PAIR, not as
   * alternatives: a browser dispatches `blur` when the focused element is
   * removed from the DOM, and settling an edit removes the field. So Escape
   * produces keydown → unmount → blur, and the blur arrives at a handler that
   * commits — resurrecting the draft the operator just cancelled. Enter has
   * the same shape; it is merely harmless there because both calls commit the
   * same text.
   *
   * A ref rather than state on purpose: it has to be readable and writable
   * synchronously WITHIN one browser event sequence, before React has
   * re-rendered anything. A state flag would still be stale when the blur
   * lands, which is exactly the window this closes.
   *
   * Reset when a new edit opens, not when one closes, so the flag's meaning is
   * "this session is spoken for" rather than "no edit is open" — the stray
   * blur arrives after `editingKey` is already null, so the latter could not
   * distinguish it from anything else.
   *
   * jsdom does not model removal-blur, so this is pinned by a test that
   * dispatches the two events explicitly inside one `act()`.
   */
  const editSessionDoneRef = useRef(false);
  const [bscFilter, setBscFilter] = useState("");
  const [slFilter, setSlFilter] = useState("");
  // Collapsed by default ONLY when there is unmatched work to do — the point
  // of collapsing is to put the operator's attention on the columns below.
  // With nothing unmatched there are no columns, and a collapsed dialog shows
  // three empty sections and a "▶ Matched (220)" the operator has to expand to
  // see anything at all.
  const [matchedCollapsed, setMatchedCollapsed] = useState(
    initialData.unmatchedBsc.length > 0 || initialData.unmatchedSl.length > 0,
  );
  const [confirming, setConfirming] = useState(false);
  /**
   * NEO-220 — is the "throw this session away?" confirm on screen?
   *
   * Distinct from `confirming`, which means "the commit is in flight". They are
   * mutually exclusive in practice (Cancel is not reachable mid-save) but they
   * are opposite questions, and one flag for both would make Escape during a
   * save open a discard dialog.
   */
  const [discardOpen, setDiscardOpen] = useState(false);

  // NEO-195: fold in candidates that became ready after the modal opened.
  // Append-only (see the ABSORB case), so nothing the operator has already
  // decided is disturbed.
  useEffect(() => {
    dispatch({
      type: "ABSORB",
      // Same normalisation as the seed — a conflict on a card that streamed in
      // late is no less a conflict (NEO-199).
      autoMatched: seedMatched(initialData.autoMatched),
      unmatchedBsc: initialData.unmatchedBsc,
      unmatchedSl: initialData.unmatchedSl,
      settled: streamSettled === true,
    });
  }, [initialData, streamSettled]);
  /**
   * NEO-195 / NEO-341 — Confirm is blocked while the fetch runs AND until the
   * reducer holds the end of its team lookups. Everything that used to read
   * `isStreaming` for the gate reads this.
   */
  const confirmBlocked =
    isStreaming === true ||
    (streamSettled !== undefined && !state.streamSettled);
  // Everything paired and nothing set aside: the columns and keep shelf have
  // nothing to show and only add noise. Derived from CURRENT state, not the
  // initial snapshot, so unlinking a pair brings the columns straight back.
  const nothingToReconcile =
    state.unmatchedBsc.length === 0 &&
    state.unmatchedSl.length === 0 &&
    state.keptBsc.length === 0 &&
    state.keptSl.length === 0;
  // NEO-189: how many merged rows the marketplaces disagree about the name on.
  // Surfaced on the section header too, because the Matched list is COLLAPSED
  // by default whenever there is unmatched work — which is exactly the state
  // manual pairing happens in — and a warning inside a closed section is not a
  // warning.
  const nameConflictCount = state.matched.filter((m) => m.nameConflict).length;
  // NEO-251: counted SEPARATELY rather than folded into one "conflicts" total.
  // They are two different decisions on two different fields, and a single
  // number would tell the operator how much work there is without telling them
  // what kind — which is the half that decides whether to expand the section.
  const playersConflictCount = state.matched.filter(
    (m) => m.playersConflict,
  ).length;
  // NEO-201: how each conflict row is named to assistive tech. Derived from
  // the WHOLE matched list rather than per row, because whether a row needs a
  // disambiguator at all is a property of its number's group, not of the row.
  const conflictScopes = useMemo(
    () => conflictScopeLabels(state.matched),
    [state.matched],
  );
  const bscFieldClass = useFieldTestClass();
  const slFieldClass = useFieldTestClass();

  // A11y — the dialog asserts role="dialog" + aria-modal, so it has to behave
  // like one. Without this, Escape only worked once focus happened to be
  // inside, and a keyboard user had to Tab through the whole page behind the
  // dialog to reach it (WCAG 2.4.3 / 4.1.2).
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);
  const bscFilterRef = useRef<HTMLInputElement | null>(null);
  const slFilterRef = useRef<HTMLInputElement | null>(null);
  const matchedToggleRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    // Remember what opened us so focus can go back there on close, rather
    // than falling to <body>. Prefers the caller's durable trigger (see
    // restoreFocusRef's own doc comment) — falls back to the original
    // document.activeElement capture when the prop is absent.
    const restoreTarget = restoreFocusRef?.current;
    triggerRef.current = restoreTarget ?? (document.activeElement as HTMLElement | null);
    const id = requestAnimationFrame(() => cancelBtnRef.current?.focus());
    return () => {
      cancelAnimationFrame(id);
      triggerRef.current?.focus?.();
    };
  }, [isOpen, restoreFocusRef]);

  /**
   * Every action below removes the very <li> holding the button that was
   * clicked, so React unmounts it and focus silently falls to <body>. Move
   * focus to a stable neighbour instead — the column the item moved to or
   * from, which is where the operator's attention already is.
   */
  const refocus = useCallback((el: HTMLElement | null) => {
    requestAnimationFrame(() => el?.focus());
  }, []);

  /**
   * NEO-189/a11y — focus the now-checked radio in a conflict radiogroup, by
   * `domKey` rather than by array index.
   *
   * NEO-251 generalised it over the row HANDLE (`data-name-conflict` /
   * `data-players-conflict`) rather than hard-coding the name one: a row can
   * now carry two conflict controls, and sending an arrow key in the roster
   * group to the title group's radio would move the operator's focus to a
   * different decision than the one they were making.
   *
   * Keyed by `domKey` rather than by array index because: the
   * radiogroup's own arrow-key handler dispatches CHOOSE_NAME first, and by
   * the time this runs the DOM has to be re-queried anyway (the CHOSEN radio
   * — the one that must end up focused — only exists post-render), and
   * `state.matched` is re-sorted by `ordered()` after every dispatch, so a
   * captured index or element ref from before the dispatch cannot be trusted
   * to still point at the same row afterward.
   */
  const refocusSelectedRadio = useCallback(
    (handleAttr: string, key: string) => {
      requestAnimationFrame(() => {
        dialogRef.current
          ?.querySelector<HTMLElement>(
            `[${handleAttr}="${key}"] [role="radio"][tabindex="0"]`,
          )
          ?.focus();
      });
    },
    [],
  );

  /**
   * NEO-189 follow-up — put focus back on the title button a rename just
   * closed.
   *
   * Same shape and same reasoning as `refocusSelectedRadio`: the button the
   * operator activated to open the editor does not exist while the editor is
   * open, so there is no element ref to keep — it has to be re-queried after
   * the render that swaps the input back out. Keyed by `domKey`, which a
   * rename cannot change (it is derived from the marketplace ref), so the
   * lookup still finds the row it was called for.
   *
   * Without it, committing or cancelling an edit drops focus to <body>, which
   * for a keyboard operator part-way down a 220-row list means losing their
   * place entirely.
   */
  const refocusCardTitle = useCallback((key: string) => {
    requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>(`[data-card-title="${key}"]`)
        ?.focus();
    });
  }, []);

  /**
   * Settle the open roster edit, if it belongs to this row.
   *
   * The reducer decides whether the typed list is actually a change (see
   * `EDIT_PLAYERS`): blank, over-length and unchanged all return the same state
   * object, so committing a field the operator only tabbed through is genuinely
   * nothing rather than a rewrite to the same value. That is what makes
   * commit-on-blur safe to wire up.
   */
  const commitPlayersDraft = (index: number, key: string) => {
    if (!playersDraft || playersDraft.key !== key) return;
    const { text } = playersDraft;
    const players = splitPlayers(text);
    // a11y (accessibility audit, NEO-251) — mirror `EDIT_PLAYERS`'s own two
    // bounds BEFORE dispatching. The reducer already refuses these silently
    // (by design — see its comment), but until now this caller cleared
    // `playersDraft` unconditionally right above, so a refusal erased the
    // operator's typed roster with no error shown, sighted or not (WCAG
    // 3.3.1). On a refusal here the draft is left in place — the field keeps
    // showing exactly what was typed — and a `role="alert"` message is
    // rendered next to it (see the field's `aria-describedby` below).
    if (players.length > 0) {
      if (players.length > MAX_CARD_PLAYERS) {
        setPlayersError({
          key,
          message: `A card can carry at most ${MAX_CARD_PLAYERS} players — remove some to save.`,
        });
        return;
      }
      const overLong = players.find(
        (name) => name.length > MAX_PLAYER_NAME_LENGTH,
      );
      if (overLong) {
        setPlayersError({
          key,
          message: `Player names are limited to ${MAX_PLAYER_NAME_LENGTH} characters — shorten it to save.`,
        });
        return;
      }
    }
    setPlayersError(null);
    setPlayersDraft(null);
    dispatch({ type: "EDIT_PLAYERS", index, players });
  };

  const visibleBsc = useMemo(
    () =>
      state.unmatchedBsc.filter((c) =>
        label(c).toLowerCase().includes(bscFilter.toLowerCase()),
      ),
    [state.unmatchedBsc, bscFilter],
  );
  const visibleSl = useMemo(
    () =>
      state.unmatchedSl.filter((c) =>
        label(c).toLowerCase().includes(slFilter.toLowerCase()),
      ),
    [state.unmatchedSl, slFilter],
  );

  /**
   * Link one BSC-only card to one SportLots-only card.
   *
   * Extracted so the two ways an operator can ask for a link — click-to-select
   * then click, and drag one row onto the other — are the SAME operation
   * rather than two implementations that can drift. The conflict handling in
   * particular is not incidental: NEO-189's rule is that a link whose two
   * sides name the card differently must be visible the moment it is made, and
   * manual pairing always happens with the Matched section collapsed, so the
   * auto-expand is what makes the warning a warning. A drag path that dropped
   * it would silently reintroduce the defect that feature exists to fix.
   *
   * `slSide` is looked up rather than passed because the drag path has only a
   * key; the click path's `c` is the same object out of the same array.
   */
  const performLink = useCallback(
    (bscKey: string, slKey: string) => {
      const bscSide = state.unmatchedBsc.find(
        (x) => candidateKey(x) === bscKey,
      );
      const slSide = state.unmatchedSl.find((x) => candidateKey(x) === slKey);
      const nameConflict = !!(
        bscSide &&
        slSide &&
        nameConflictOf(bscSide, slSide)
      );
      // NEO-251: a roster disagreement is as much a reason to open the section
      // as a title one. Manual pairing always happens with Matched collapsed,
      // so the auto-expand is what makes the warning a warning — a path that
      // raised only one of the two would silently reintroduce the defect for
      // the other.
      const playersConflict = !!(
        bscSide &&
        slSide &&
        playersConflictOf(bscSide, slSide)
      );
      const createsConflict = nameConflict || playersConflict;
      // Only ever opens — never closes a section the operator deliberately
      // expanded.
      if (createsConflict) {
        setMatchedCollapsed(false);
      }
      dispatch({ type: "LINK", bscKey, slKey });
      setSelectedBsc(null);
      // a11y (NEO-189 audit) — the <li> holding the control that was just
      // activated is about to unmount: it moved from a column into matched.
      // Left alone that drops focus to <body> at the exact moment a brand-new
      // decision (which name to keep) appears for the operator to make.
      if (createsConflict && bscSide) {
        // The TITLE group when there is one: it is the first control in the
        // row and the one whose value names the card. A roster-only conflict
        // sends focus to its own group instead.
        refocusSelectedRadio(
          nameConflict ? "data-name-conflict" : "data-players-conflict",
          domKey(bscSide),
        );
      }
    },
    [state.unmatchedBsc, state.unmatchedSl, refocusSelectedRadio],
  );

  // ── Drag-and-drop linking ────────────────────────────────────────────────
  // The 5px activation constraint is load-bearing, not cosmetic: without it a
  // stationary press on a row's inner <button> starts a drag and the button's
  // onClick never fires, which would break the click-to-select path (and the
  // Maestro flow that drives it) the moment the listeners went on.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragId(null);
      const { active, over } = event;
      if (!over) return;
      const from = parseDragId(String(active.id));
      const to = parseDragId(String(over.id));
      if (!from || !to) return;
      // A row is its own drop target, and two rows in the same column are not
      // a pair — only a cross-column drop is a link.
      if (from.side === to.side) return;
      const bscKey = from.side === "bsc" ? from.key : to.key;
      const slKey = from.side === "sl" ? from.key : to.key;
      performLink(bscKey, slKey);
    },
    [performLink],
  );

  const handleDragCancel = useCallback(() => setActiveDragId(null), []);

  /** What the drag overlay shows: the dragged card's own row label. */
  const activeDragLabel = useMemo(() => {
    if (!activeDragId) return null;
    const parsed = parseDragId(activeDragId);
    if (!parsed) return null;
    const pool =
      parsed.side === "bsc" ? state.unmatchedBsc : state.unmatchedSl;
    const card = pool.find((c) => candidateKey(c) === parsed.key);
    return card ? label(card) : null;
  }, [activeDragId, state.unmatchedBsc, state.unmatchedSl]);

  const handleConfirm = useCallback(async () => {
    if (confirming) return;
    // NEO-195: never commit a partial checklist. The button is disabled while
    // streaming; this is the guard for a keyboard or programmatic path.
    // NEO-341: nor one whose last team lookups have not reached us yet.
    if (confirmBlocked) return;
    setConfirming(true);
    try {
      // NEO-339: the payload is built in lib/set-build/pairing.ts — the same
      // function the set-building tool sends — from the state as it stands.
      await onConfirm(buildPairingResult(state));
    } finally {
      setConfirming(false);
    }
  }, [confirming, confirmBlocked, onConfirm, state]);

  /**
   * NEO-220 — how much of this session a dismissal would throw away.
   *
   * Nothing on this screen is written until Confirm, so Escape and Cancel are
   * both silent discards of everything the operator has linked, kept and
   * renamed. `countPairingEdits` is pure and separately tested; see
   * `pairing-session-edits.ts` for what does and does not count.
   */
  const pendingEdits = useMemo(
    () => countPairingEdits(state, candidateKey),
    [state],
  );

  /**
   * The single door out. Every dismissal path goes through here — root Escape
   * and the footer Cancel — so "was anything lost?" is asked in exactly one
   * place and cannot be forgotten on the next path someone adds.
   *
   * A clean session closes immediately: a confirm over nothing is a dialog that
   * teaches operators to dismiss confirms without reading them.
   */
  const requestClose = useCallback(() => {
    if (pendingEdits === 0) {
      onClose();
      return;
    }
    setDiscardOpen(true);
  }, [onClose, pendingEdits]);

  /**
   * NEO-330 a11y — the streaming announcements, written straight into an
   * always-mounted `role="status"` region (it renders no React children, so
   * nothing here fights reconciliation, and no announcement costs a render).
   *
   *   start     — the visible sentence, once, shortly after the stream is seen
   *   progress  — at each quarter (25/50/75%) of `ready / total`, never again
   *               for a quarter already said (a growing `total` can lower the
   *               fraction; it does not re-announce)
   *   done      — "Teams are in. Confirm is ready.", cleared after a few
   *               seconds so a later re-read of the region is not stale
   *
   * The visible "(X of Y done)" keeps ticking in the static sentence.
   */
  const liveRegionRef = useRef<HTMLDivElement | null>(null);
  const streamAnnounceRef = useRef<{ streaming: boolean; quarter: number }>({
    streaming: false,
    quarter: -1,
  });
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamReady = streamProgress?.ready ?? 0;
  const streamTotal = streamProgress?.total ?? 0;
  /**
   * The wait ended with teams still out — see `teamsLateNotice`. NEO-341:
   * "ended" is Confirm unblocking (`confirmBlocked`), which outlasts
   * `isStreaming` until this run's teams have landed or the owner gave up.
   */
  const teamsLate =
    !!teamsLateNotice && !confirmBlocked && streamTotal > 0 && streamReady < streamTotal;
  useEffect(() => {
    const say = (text: string, delay = 0) => {
      if (liveTimerRef.current !== null) clearTimeout(liveTimerRef.current);
      liveTimerRef.current = null;
      const write = () => {
        if (liveRegionRef.current) liveRegionRef.current.textContent = text;
      };
      if (delay > 0) liveTimerRef.current = setTimeout(write, delay);
      else write();
    };
    if (!isOpen) {
      // Closed: the region is gone. Start over on the next open.
      streamAnnounceRef.current = { streaming: false, quarter: -1 };
      return;
    }
    const seen = streamAnnounceRef.current;
    const quarter =
      streamTotal > 0 ? Math.min(3, Math.floor((streamReady / streamTotal) * 4)) : 0;
    // NEO-341 — the stream is "on" for as long as Confirm is blocked, so
    // "Confirm is ready" is said when it is, not when the fetch's promise
    // resolved with teams still on their way.
    if (confirmBlocked) {
      if (!seen.streaming) {
        streamAnnounceRef.current = { streaming: true, quarter };
        say(
          pairingStreamingSentence(
            streamTotal > 0 ? { ready: streamReady, total: streamTotal } : undefined,
          ),
          PAIRING_STREAM_START_DELAY_MS,
        );
      } else if (streamTotal > 0 && quarter > seen.quarter) {
        streamAnnounceRef.current = { streaming: true, quarter };
        say(pairingStreamProgressAnnouncement(streamReady, streamTotal));
      }
      return;
    }
    if (seen.streaming) {
      streamAnnounceRef.current = { streaming: false, quarter: -1 };
      // "Teams are in" would be false when some missed the wait: say what
      // happened instead, once, and leave the footer line to hold it.
      const done = teamsLate
        ? pairingStreamLateAnnouncement(teamsLateNotice ?? "")
        : PAIRING_STREAM_DONE_ANNOUNCEMENT;
      say(done);
      liveTimerRef.current = setTimeout(() => {
        liveTimerRef.current = null;
        if (liveRegionRef.current?.textContent === done) {
          liveRegionRef.current.textContent = "";
        }
      }, PAIRING_STREAM_DONE_CLEAR_MS);
    }
  }, [isOpen, confirmBlocked, streamReady, streamTotal, teamsLate, teamsLateNotice]);
  useEffect(
    () => () => {
      if (liveTimerRef.current !== null) clearTimeout(liveTimerRef.current);
    },
    [],
  );

  if (!isOpen) return null;

  const totalToSave =
    state.matched.length + state.keptBsc.length + state.keptSl.length;

  return createPortal(
    <Theme>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="card-pairing-heading"
        ref={dialogRef}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            // NEO-220: the discard confirm owns Escape while it is open. It is
            // a sibling in this portal, not a descendant, so a keypress inside
            // it never reaches here — this covers the case where focus is
            // somehow still behind it.
            if (discardOpen) return;
            // NEO-220 (D8): inside a text field Escape already means something
            // smaller — clear the filter, abandon the rename — and those
            // handlers stop propagation. Anything that reaches here from a
            // field is a field with no local meaning for the key, and closing
            // the whole dialog is not what the operator asked for.
            if (isEditableTarget(e.target)) return;
            // Escape during a drag CANCELS THE DRAG (dnd-kit's own document
            // listener), so it must not also close the modal — one keypress
            // that both aborts the gesture and throws away every unsaved
            // pairing is the worst possible reading of "cancel". `activeDragId`
            // is still set here whichever listener runs first: dnd-kit's cancel
            // only clears it via a React state update, which cannot land
            // mid-event.
            if (activeDragId) return;
            requestClose();
            return;
          }
          if (e.key !== "Tab") return;
          // Keep Tab inside the dialog — aria-modal="true" promises this.
          const root = dialogRef.current;
          if (!root) return;
          const focusable = root.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), [href], select, textarea, [tabindex]:not([tabindex="-1"])',
          );
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-5xl max-h-[92vh] flex flex-col">
          <header className="p-4 border-b border-gray-700">
            <h2
              id="card-pairing-heading"
              className="text-lg font-semibold text-gray-100"
            >
              Match Cards{setLabel ? ` — ${setLabel}` : ""}
            </h2>
            <p className="text-xs text-gray-400 mt-1">
              {nothingToReconcile
                ? "Every card paired across both marketplaces. Review and confirm — no cards are saved until you do."
                : "No cards are saved until you confirm. Anything left in a column below is discarded — keep a card to save it as single-marketplace."}
            </p>
            {/* NEO-195: cards arrive as they become reviewable, so say so.
                Without this the list silently grows under the operator and a
                disabled Confirm looks broken rather than deliberate.
                NEO-330 a11y: the sentence is static (Confirm's description
                points at it); the coarse announcements go through the
                always-mounted status region beside it. NEO-341: shown for as
                long as Confirm is blocked, which outlasts the fetch itself
                until this run's teams have landed (`confirmBlocked`). */}
            {confirmBlocked && (
              <p id="pairing-streaming-status" className="text-xs text-[#00B7FF] mt-1">
                {pairingStreamingSentence(streamProgress)}
              </p>
            )}
            <div
              ref={liveRegionRef}
              id="pairing-streaming-announcer"
              role="status"
              className="sr-only"
            />
          </header>

          {/* TWO deliberate details on this scroller, both in service of the
              sticky Matched header below.

              `px-4 pb-4` and NOT `p-4`. The top padding used to live here, and
              OBSERVED (Jason's screenshot): the stuck bar sat 16px below the
              scrollport's top edge and rows slid up through the strip between
              the dialog header and the bar, visible ABOVE it — "it looks funny
              with the list scrolling behind it". The 16px is the scroller's own
              `pt-4`. Rather than cancel it with a negative `top` — which
              depends on exactly where `top: 0` resolves against a padded
              scrollport, and over-shoots into a clipped bar if that assumption
              is wrong — the padding is MOVED INTO the bar as its own `pt-4`.
              With no top padding on the scroller there is no band between the
              scrollport top and the bar for anything to show through: the 16px
              is now opaque bar. That holds however the offset resolves, which
              is why it is the fix rather than a tuned constant. Spacing at rest
              is unchanged, because the matched section is this scroller's first
              child and the 16px simply moved inside it.

              `scroll-pt-12` is what makes the bar safe for the OTHER way this
              list scrolls. Linking a pair calls `refocusSelectedRadio`, and
              `.focus()` makes the browser scroll the merged row into view on
              its own — with a sticky bar and no scroll-padding that lands the
              row UNDER the bar, so the operator is sent to a decision they
              cannot see. `scroll-padding-top` on the scroller is honoured by
              focus-driven scrolling as well as by `scrollIntoView`, so it
              covers both of Jason's causes (manual scroll, and the auto-scroll
              after a drag or click link) with one declaration rather than a
              scroll-margin on every row. 48px clears the bar's ~43px (pt-4 +
              text-sm line box + py-1.5 + border). */}
          <div className="flex-1 overflow-y-auto scroll-pt-12 px-4 pb-4 flex flex-col gap-4">
            {/* Matched */}
            <section>
              {/* NEO-189 operator feedback — the collapse control follows you
                  down the list.

                  Jason: "when I scroll the matched line should lock to the
                  top… that will allow somebody to quickly collapse again."
                  With 220 matched rows the toggle is the only way back to the
                  columns, and it scrolled off after the first screenful, so
                  collapsing meant scrolling all the way back up first.

                  Sticky, not fixed: the containing block is this <section>, so
                  the bar un-sticks when the matched list's end scrolls past
                  and does NOT hover over the unmatched columns below — the
                  default behaviour is the wanted behaviour, which is why the
                  section is the right place for it and nothing between here
                  and the scroll container may introduce its own overflow,
                  transform or containment.

                  A WRAPPER rather than the button itself: the bar has to be
                  an opaque box spanning the WHOLE scrollport for rows to read
                  as passing under it, and the button is only as wide as its
                  text and as tall as its own line. So the wrapper owns every
                  edge a row could show through:
                    - `-mx-4 px-4` bleeds it across the scroller's horizontal
                      padding, so nothing peeks at the sides;
                    - `pt-4` is the scroller's former `pt-4`, moved here so
                      nothing peeks above it either (see the note on the
                      scroller);
                    - `bg-gray-900` matches the dialog body exactly, so at rest
                      the bar is invisible and only its border reads.
                  `z-20` puts it over the static rows and the draggable
                  unmatched rows, and under dnd-kit's DragOverlay (fixed,
                  z-999) so a dragged card still passes over the top. The
                  shadow is what makes a row read as travelling UNDER the bar
                  rather than being clipped by it — Tailwind's own `shadow-*`
                  are tuned for light backgrounds and are invisible on
                  gray-900, hence the explicit value.

                  It never covers the first row: sticky keeps the element in
                  flow, so at scroll-top the bar occupies its own space and
                  offsets only once the section scrolls — collapsed or short,
                  there is nothing to cover. */}
              <div className="sticky top-0 z-20 -mx-4 px-4 pt-4 mb-2 bg-gray-900 border-b border-gray-700/60 shadow-[0_6px_8px_-6px_rgba(0,0,0,0.8)]">
              <button
                type="button"
                ref={matchedToggleRef}
                className="text-sm font-semibold text-gray-200 px-2 py-1.5"
                onClick={() => setMatchedCollapsed((v) => !v)}
                // The count is appended ONLY when there is a conflict: an
                // aria-label overrides the button's own text for assistive
                // tech, so a silent label would hide the very thing the
                // visible badge exists to announce.
                // NEO-251 adds a SECOND clause rather than replacing the
                // first, and puts it BEFORE the name-conflict clause: the
                // Maestro flow addresses this label with the full-match regex
                // `Collapse matched cards, .* with a name conflict`, so the
                // name-conflict wording must stay the LAST thing in the
                // string (PR #236 run 1 failed on exactly that). A row with no
                // roster conflict still produces the string it always did.
                aria-label={
                  `${matchedCollapsed ? "Expand" : "Collapse"} matched cards` +
                  (playersConflictCount > 0
                    ? `, ${playersConflictCount} with a player conflict`
                    : "") +
                  (nameConflictCount > 0
                    ? `, ${nameConflictCount} with a name conflict`
                    : "")
                }
              >
                {matchedCollapsed ? "▶" : "▼"} Matched ({state.matched.length})
                {nameConflictCount > 0 && (
                  <span className="text-[#FF2EB3] ml-2">
                    {/* The glyph is decorative — "name conflict(s)" already
                        carries the meaning in words, so AT shouldn't also be
                        made to announce "warning sign" on top of that. */}
                    <span aria-hidden="true">⚠</span> {nameConflictCount} name
                    conflict
                    {nameConflictCount === 1 ? "" : "s"}
                  </span>
                )}
                {/* NEO-251: its OWN line, not a second clause on the name
                    badge. The two counts are two different kinds of work, and
                    "⚠ 3 name conflicts ⚠ 2 player conflicts" run together on
                    one line reads as one number the eye has to parse apart. */}
                {playersConflictCount > 0 && (
                  <span className="block text-[#FF2EB3]">
                    <span aria-hidden="true">⚠</span> {playersConflictCount}{" "}
                    player conflict
                    {playersConflictCount === 1 ? "" : "s"}
                  </span>
                )}
              </button>
              </div>
              {!matchedCollapsed && (
                <ul className="flex flex-col gap-1">
                  {state.matched.map((m, i) => {
                    const rowKey = candidateKey(m.card);
                    // NEO-201/NEO-251: what to call this row out loud. Derived
                    // once because BOTH conflict controls have to agree about
                    // it — two regions on one row naming that row differently
                    // is worse than the ambiguity the scope exists to remove.
                    const scope =
                      conflictScopes.get(rowKey) ?? `#${m.card.cardNumber}`;
                    const editing = editingKey === rowKey;
                    /**
                     * Close the editor, optionally committing what was typed.
                     *
                     * `commit` is true for Enter and for blur, false for
                     * Escape. The reducer decides whether the typed name is
                     * actually a change (see RENAME): blank, whitespace-only
                     * and unchanged all return the same state object, so
                     * "commit" on a field the operator only tabbed through is
                     * genuinely a no-op rather than a rename to the same value.
                     *
                     * Focus goes back to the title button either way. It does
                     * not exist yet at this point — it is re-rendered by the
                     * state change on the next line — so the helper re-queries
                     * it by `domKey` after the paint.
                     */
                    const finishEdit = (commit: boolean) => {
                      // First call wins. See `editSessionDoneRef`: the browser
                      // fires a blur at the field this call is about to
                      // unmount, so without this an Escape would be followed
                      // by a commit of the very draft it cancelled.
                      if (editSessionDoneRef.current) return;
                      // a11y (NEO-251 audit) — mirror the reducer's own
                      // length bound BEFORE dispatching, so an over-length
                      // name can be reported instead of vanishing into
                      // `RENAME`'s silent no-op. Checked ahead of the
                      // `editSessionDoneRef` flip and the `setEditingKey`
                      // below: on a refusal neither runs, so the editor stays
                      // open, the typed text is untouched, and the field's own
                      // autofocus-on-render effect (below) pulls focus back in
                      // if a blur already carried it away.
                      if (commit && editDraft.trim().length > MAX_PLAYER_NAME_LENGTH) {
                        setNameError({
                          key: rowKey,
                          message: `Card names are limited to ${MAX_PLAYER_NAME_LENGTH} characters — shorten it to save.`,
                        });
                        return;
                      }
                      editSessionDoneRef.current = true;
                      setNameError(null);
                      if (commit) {
                        dispatch({
                          type: "RENAME",
                          index: i,
                          cardName: editDraft,
                        });
                      }
                      setEditingKey(null);
                      refocusCardTitle(domKey(m.card));
                    };
                    return (
                    <li
                      key={candidateKey(m.card)}
                      className="flex flex-col gap-1 text-sm text-gray-200 bg-gray-800/60 rounded px-2 py-1"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-2">
                          {editing ? (
                            <>
                              {/* The number is rendered STATICALLY beside the
                                  field rather than being part of it. It is the
                                  one thing on the row that says which card is
                                  being renamed — a card and its variation share
                                  a name far more often than they share nothing —
                                  and it is not the operator's to edit: it is
                                  BSC's number, and `candidateKey`, `domKey` and
                                  `compareCards` are all derived from it. */}
                              <span className="text-gray-400 shrink-0">
                                #{m.card.cardNumber}
                              </span>
                              <Input
                                bare
                                ref={(el) => {
                                  // Autofocus with the text selected: the
                                  // common edit is replacing a wrong name
                                  // outright, not amending it, so typing
                                  // should overwrite. Done on the ref rather
                                  // than with `autoFocus` because `autoFocus`
                                  // gives no selection.
                                  if (el && document.activeElement !== el) {
                                    el.focus();
                                    el.select();
                                  }
                                }}
                                className="min-w-0 flex-1 text-sm px-1.5 py-0.5"
                                type="text"
                                value={editDraft}
                                onChange={(e) => setEditDraft(e.target.value)}
                                // Named by the row's SCOPE, not by
                                // `label(m.card)`: the name is what this
                                // control changes, and a field that renames
                                // itself as you type is re-announced mid-edit.
                                // Same reasoning as `conflictScopeLabels`.
                                //
                                // NEO-272 — the scope, not the bare card
                                // NUMBER it used to be. Product invariant 7:
                                // a card number is never unique at any scope,
                                // and on THIS screen that is not an edge case
                                // but the premise — a card and its variations
                                // share one number, which is the whole reason
                                // the operator is here pairing them by hand.
                                // `conflictScopeLabels` already computes the
                                // stable disambiguator, and both of its forms
                                // (`· <variation>`, or an ordinal when no
                                // variation separates the group) sit beside
                                // THIS field on THIS row: the number is the
                                // static span to the left, the variation the
                                // static span to the right. So the field now
                                // names itself with what the operator can
                                // actually see, and nothing name-derived —
                                // which is what SC 2.5.3 asks for and what
                                // keeps the label still mid-edit.
                                //
                                // DEGRADATION: `scope` falls back to
                                // `#<number>` for a number carrying a single
                                // conflict and for every row carrying none at
                                // all, so the ordinary row's label is
                                // byte-identical to what it has always been —
                                // no trailing separator, nothing appended.
                                //
                                // "EDIT name for", not "Name for": the
                                // radiogroup below is already `Name for
                                // <scope>` — now the very same scope — so the
                                // obvious label would put two differently-roled
                                // controls with one accessible name on the
                                // same row, which is the ambiguity
                                // `conflictScopeLabels` exists to remove. It
                                // would also make the Maestro selector
                                // `id: "Name for #FS-1"` (already used
                                // against the radiogroup in
                                // checklist-pairing-dialog-cancel.yaml) match
                                // two elements.
                                aria-label={`Edit name for ${scope}`}
                                aria-invalid={
                                  nameError?.key === rowKey || undefined
                                }
                                aria-describedby={
                                  nameError?.key === rowKey
                                    ? `name-edit-error-${domKey(m.card)}`
                                    : undefined
                                }
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    finishEdit(true);
                                    return;
                                  }
                                  if (e.key === "Escape") {
                                    // MUST stop here. The dialog root's own
                                    // onKeyDown closes the whole modal on
                                    // Escape, so without this, abandoning a
                                    // rename would throw away every pairing
                                    // decision on the screen.
                                    e.stopPropagation();
                                    finishEdit(false);
                                  }
                                  // Everything else — arrows included — is
                                  // left alone. The radiogroup's arrow handler
                                  // is on a sibling subtree, not an ancestor
                                  // of this field, so it never sees these
                                  // keys; the dialog's Tab trap is the only
                                  // other handler above us and Tab out of a
                                  // field is exactly what it should do.
                                }}
                                onBlur={() => finishEdit(true)}
                              />
                              {m.card.cardVariation && (
                                <span className="text-gray-400 shrink-0">
                                  · {m.card.cardVariation}
                                </span>
                              )}
                              {nameError?.key === rowKey && (
                                // role="alert" — an assertive live region that
                                // announces itself the instant it mounts, which
                                // is when a refusal happens (see `finishEdit`).
                                // A `<p aria-describedby>` alone would only be
                                // heard if the field were re-focused, and the
                                // field never lost the DOM in this path.
                                <span
                                  id={`name-edit-error-${domKey(m.card)}`}
                                  role="alert"
                                  className="text-xs text-[#FF2EB3]"
                                >
                                  {nameError.message}
                                </span>
                              )}
                            </>
                          ) : (
                            <button
                              type="button"
                              // Re-queried by `refocusCardTitle` after the
                              // editor closes; keyed like `data-name-conflict`
                              // and for the same reason.
                              data-card-title={domKey(m.card)}
                              className="text-left border-b border-dotted border-gray-600 hover:border-[#00B7FF] hover:text-white"
                              onClick={() => {
                                // Prefilled with `cardName` ALONE — not
                                // `label()`. The number and the variation
                                // description are separate fields on the card;
                                // a field prefilled with "#461 Noah Cameron"
                                // invites an operator to retype the number into
                                // the name, and the commit would take it.
                                setEditDraft(m.card.cardName);
                                setEditingKey(rowKey);
                                setNameError(null);
                                // A fresh session is unsettled, whatever the
                                // last one did.
                                editSessionDoneRef.current = false;
                              }}
                              aria-label={`Edit name for ${label(m.card)}`}
                            >
                              {label(m.card)}
                            </button>
                          )}
                          {m.confidence > 0 && m.confidence < 1 && (
                            <span className="text-xs text-amber-400 shrink-0">
                              {Math.round(m.confidence * 100)}%
                            </span>
                          )}
                        </span>
                        <button
                          type="button"
                          className="text-xs text-gray-400 hover:text-red-400 px-2 py-1.5"
                          onClick={() => {
                            dispatch({ type: "UNLINK", index: i });
                            refocus(matchedToggleRef.current);
                          }}
                          aria-label={`Unlink ${label(m.card)}`}
                        >
                          Unlink
                        </button>
                      </div>
                      {/* NEO-189: the marketplaces name this card differently.
                          Show BOTH, say which one is currently winning, and
                          let the operator switch — the ambiguity is reported,
                          never resolved by heuristic. */}
                      {m.nameConflict && (
                        <ConflictRadioGroup
                          handleAttr="data-name-conflict"
                          handleKey={domKey(m.card)}
                          groupLabel={`Name conflict on ${scope}`}
                          warningId={`name-conflict-warning-${domKey(m.card)}`}
                          warning="These marketplaces name this card differently — pick the right one before it is listed."
                          radioGroupLabel={`Name for ${scope}`}
                          chosen={m.nameConflict.chosen}
                          // NEO-272 — each pill's "which card is this
                          // for" qualifier is the row's SCOPE, the same
                          // one naming the group and the radiogroup
                          // above it, and not the bare card number it
                          // used to be. A number carrying two conflicts
                          // is precisely the shape `conflictScopeLabels`
                          // exists for, and the marketplaces routinely
                          // file one name across a card and its
                          // variation — so on that row the two BSC pills
                          // announced one identical sentence, leaving
                          // the operator no way to hear which card
                          // either would rename. The scope is also the
                          // only qualifier that can go here: everything
                          // name-derived is the value under dispute.
                          // Unchanged on an unambiguous number, where
                          // the scope IS `#<number>`.
                          options={[
                            {
                              side: "bsc",
                              label: `BSC: ${m.nameConflict.bsc}`,
                              ariaLabel: `BSC: ${m.nameConflict.bsc} — use this name for ${scope}`,
                            },
                            {
                              side: "sportlots",
                              label: `SportLots: ${m.nameConflict.sportlots}`,
                              ariaLabel: `SportLots: ${m.nameConflict.sportlots} — use this name for ${scope}`,
                            },
                            // The operator's own name, once they have typed one
                            // that is neither marketplace's. Present on the SAME
                            // `custom !== undefined` condition the reducer
                            // guards `CHOOSE_NAME side:"custom"` and the
                            // arrow-key cycle on, so "every option in the group
                            // is reachable and exactly one is checked" holds by
                            // construction rather than by three places agreeing.
                            ...(m.nameConflict.custom !== undefined
                              ? [
                                  {
                                    side: "custom" as const,
                                    label: `Custom: ${m.nameConflict.custom}`,
                                    ariaLabel: `Custom: ${m.nameConflict.custom} — use this name for ${scope}`,
                                  },
                                ]
                              : []),
                          ]}
                          onChoose={(side, viaKeyboard) => {
                            dispatch({ type: "CHOOSE_NAME", index: i, side });
                            if (viaKeyboard) {
                              refocusSelectedRadio(
                                "data-name-conflict",
                                domKey(m.card),
                              );
                            }
                          }}
                        />
                      )}
                      {/* NEO-251: and the same for WHO IS ON the card. A
                          separate control because it is a separate decision —
                          the two marketplaces can agree about the title and
                          disagree about the roster, and the roster is what
                          becomes `playerIds` and therefore what a buyer is
                          shown. */}
                      {m.playersConflict && (
                        <ConflictRadioGroup
                          handleAttr="data-players-conflict"
                          handleKey={domKey(m.card)}
                          groupLabel={`Players conflict on ${scope}`}
                          warningId={`players-conflict-warning-${domKey(m.card)}`}
                          warning="These marketplaces list different players on this card — pick the right ones before it is listed."
                          radioGroupLabel={`Players for ${scope}`}
                          chosen={m.playersConflict.chosen}
                          // Scoped exactly like the name pills above,
                          // and for the same NEO-272 reason — the two
                          // controls on one row have to agree about what
                          // that row is called, or the agreement
                          // `conflictScopeLabels` bought is spent again
                          // one level down.
                          options={[
                            {
                              side: "bsc",
                              label: `BSC: ${joinPlayers(m.playersConflict.bsc)}`,
                              ariaLabel: `BSC: ${joinPlayers(m.playersConflict.bsc)} — use these players for ${scope}`,
                            },
                            {
                              side: "sportlots",
                              label: `SportLots: ${joinPlayers(m.playersConflict.sportlots)}`,
                              ariaLabel: `SportLots: ${joinPlayers(m.playersConflict.sportlots)} — use these players for ${scope}`,
                            },
                            ...(m.playersConflict.custom !== undefined
                              ? [
                                  {
                                    side: "custom" as const,
                                    label: `Custom: ${joinPlayers(m.playersConflict.custom)}`,
                                    ariaLabel: `Custom: ${joinPlayers(m.playersConflict.custom)} — use these players for ${scope}`,
                                  },
                                ]
                              : []),
                          ]}
                          onChoose={(side, viaKeyboard) => {
                            dispatch({ type: "CHOOSE_PLAYERS", index: i, side });
                            if (viaKeyboard) {
                              refocusSelectedRadio(
                                "data-players-conflict",
                                domKey(m.card),
                              );
                            }
                          }}
                        >
                          {/* NEO-251 — what NeonBinder ALREADY stores for this
                              card, when that is one of the two answers on
                              offer.

                              It is evidence, not a decision: the operator
                              settled this same disagreement on an earlier sync
                              and the NB row still carries their answer. Shown
                              rather than applied, and in gray rather than pink,
                              because pre-checking a radio from it would make an
                              untouched row read as reviewed — and because NB
                              owning the answer is exactly what stops a
                              marketplace becoming the source of truth. */}
                          {m.playersConflict.preferred && (
                            <span className="text-xs text-gray-400">
                              NeonBinder currently stores:{" "}
                              {joinPlayers(
                                m.playersConflict.preferred === "sportlots"
                                  ? m.playersConflict.sportlots
                                  : m.playersConflict.bsc,
                              )}
                            </span>
                          )}
                          {/* The operator's own roster. Rendered inline rather
                              than behind a click-to-edit affordance like the
                              title's: the card's players are not otherwise on
                              this row, so there is nothing to click, and a
                              roster the operator can see is half of what makes
                              the choice above answerable. */}
                          <Input
                            bare
                            // a11y/correctness (audit, NEO-251) — this field
                            // holds a `|`-joined LIST of names, and
                            // `MAX_PLAYER_NAME_LENGTH` bounds a single one. A
                            // native `maxLength` here capped the whole joined
                            // string at one name's limit, which silently
                            // truncated (no message, nothing announced) any
                            // roster of a few ordinarily-named players well
                            // before it hit the per-name or per-count bound
                            // the reducer actually enforces below — making
                            // `EDIT_PLAYERS`'s own over-length message
                            // unreachable by typing. The real bounds are
                            // reported, with a message, by `commitPlayersDraft`
                            // instead.
                            className="w-full min-w-0 text-xs px-1.5 py-0.5"
                            type="text"
                            // a11y (audit, NEO-251) — WCAG 3.3.2: the field
                            // carries no visible label at all, only the
                            // `aria-label` below, so a sighted operator who
                            // has not opened a screen reader has nothing
                            // telling them what to type or how to separate
                            // names. The placeholder repeats the
                            // `aria-label`'s own instruction rather than
                            // inventing new wording.
                            placeholder="Name | Name | Name"
                            ref={(el) => {
                              // Refocus after a refusal: `commitPlayersDraft`
                              // runs on blur too (tabbing away), by which
                              // point the browser has already moved focus
                              // elsewhere. Re-pulling it back — same trick the
                              // name editor's ref uses above — means the error
                              // message just rendered is announced from a
                              // field the operator can immediately correct,
                              // not one they have already left.
                              if (
                                el &&
                                playersError?.key === rowKey &&
                                document.activeElement !== el
                              ) {
                                el.focus();
                              }
                            }}
                            value={
                              playersDraft?.key === rowKey
                                ? playersDraft.text
                                : joinCustomPlayers(m.card.players ?? [])
                            }
                            onChange={(e) => {
                              setPlayersDraft({
                                key: rowKey,
                                text: e.target.value,
                              });
                              if (playersError?.key === rowKey) {
                                setPlayersError(null);
                              }
                            }}
                            // Named by the row's SCOPE and distinguished from
                            // the radiogroup above it, which is `Players for
                            // <scope>`: two differently-roled controls sharing
                            // one accessible name on one row is the ambiguity
                            // `conflictScopeLabels` exists to remove. The
                            // parenthetical is also where the separator is
                            // stated, since nothing else on screen says it.
                            aria-label={`Players for ${scope} (separate names with |)`}
                            aria-invalid={
                              playersError?.key === rowKey || undefined
                            }
                            aria-describedby={
                              playersError?.key === rowKey
                                ? `players-edit-error-${domKey(m.card)}`
                                : undefined
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                commitPlayersDraft(i, rowKey);
                                return;
                              }
                              if (e.key === "Escape") {
                                // MUST stop here — the dialog root's own
                                // Escape handler would otherwise throw away
                                // every pairing decision on the screen.
                                e.stopPropagation();
                                setPlayersDraft(null);
                                setPlayersError(null);
                              }
                            }}
                            onBlur={() => commitPlayersDraft(i, rowKey)}
                          />
                          {playersError?.key === rowKey && (
                            // role="alert" for the same reason as the name
                            // editor's: this mounts at the instant of refusal,
                            // so it needs to announce itself rather than wait
                            // to be discovered.
                            <span
                              id={`players-edit-error-${domKey(m.card)}`}
                              role="alert"
                              className="text-xs text-[#FF2EB3]"
                            >
                              {playersError.message}
                            </span>
                          )}
                        </ConflictRadioGroup>
                      )}
                    </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* Unmatched columns — omitted entirely when both are empty.
                Two headers reading "(0)" over two dead filter inputs is not
                information; it just buries the matched list the operator
                actually came to review. */}
            {!nothingToReconcile && (
            <DndContext
              sensors={sensors}
              // NEO-300 — not bare `pointerWithin`, which finds nothing for a
              // drag with no pointer; shared with the set builder's other
              // drag-and-drop dialogs.
              collisionDetection={keyboardAwareCollision}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              {/* The affordance has to be SAID. Operator feedback on NEO-189:
                  a row that highlights on click, with nothing on screen naming
                  the gesture, is not discoverable — and the app's other
                  two-column pairing screens are drag-and-drop, so the missing
                  instruction was also the surprising one. Placed ABOVE the
                  columns rather than under them: below the lists it is past
                  the fold on any set with real unmatched counts, which is
                  every set where it matters.

                  Shown whenever either column has a card, not only when both
                  do. One lonely unmatched card is exactly when an operator is
                  most likely to be stuck, and the sentence still describes the
                  screen — the columns are what "the other column" means. */}
              {(state.unmatchedBsc.length > 0 ||
                state.unmatchedSl.length > 0) && (
                <p className="text-xs text-gray-400 mb-2">
                  Drag a card onto its match in the other column to link them
                  (or click one, then click its match).
                </p>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <section>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-gray-200">
                    BSC only ({state.unmatchedBsc.length})
                  </h3>
                  <button
                    type="button"
                    className="text-xs text-gray-400 hover:text-cyan-300 disabled:opacity-40 px-2 py-1.5"
                    disabled={state.unmatchedBsc.length === 0}
                    onClick={() => {
                      dispatch({ type: "KEEP_ALL", side: "bsc" });
                      refocus(bscFilterRef.current);
                    }}
                    aria-label="Keep all BSC-only cards"
                  >
                    Keep all
                  </button>
                </div>
                <Input
                  bare
                  ref={bscFilterRef}
                  className={`${bscFieldClass()} w-full`}
                  type="text"
                  value={bscFilter}
                  onChange={(e) => setBscFilter(e.target.value)}
                  // NEO-220 (D8): Escape in a filter clears the filter. It is
                  // the reflex every other search box on the web has trained,
                  // and letting it reach the dialog root instead means the
                  // operator loses the session to a keystroke they meant as
                  // "undo my typing".
                  onKeyDown={(e) => {
                    if (e.key !== "Escape") return;
                    e.preventDefault();
                    e.stopPropagation();
                    setBscFilter("");
                  }}
                  placeholder="Filter BSC cards"
                  aria-label="Filter BSC cards"
                />
                <ul className="flex flex-col gap-1 mt-2">
                  {visibleBsc.map((c) => (
                    <PairableRow
                      key={candidateKey(c)}
                      side="bsc"
                      cardKey={candidateKey(c)}
                    >
                      <button
                        type="button"
                        className={`flex-1 text-left text-sm rounded px-2 py-1 ${
                          selectedBsc === candidateKey(c)
                            ? "bg-cyan-900/60 text-cyan-100"
                            : "bg-gray-800/60 text-gray-200"
                        }`}
                        onClick={() =>
                          setSelectedBsc(
                            selectedBsc === candidateKey(c) ? null : candidateKey(c),
                          )
                        }
                        // Selection was conveyed by background colour alone.
                        aria-pressed={selectedBsc === candidateKey(c)}
                        aria-label={
                          selectedBsc === candidateKey(c)
                            ? `${label(c)}, selected. Press to deselect.`
                            : `Select BSC card ${label(c)}`
                        }
                      >
                        {label(c)}
                      </button>
                      <button
                        type="button"
                        className="text-xs text-gray-400 hover:text-cyan-300 px-2 py-1.5"
                        onClick={() => {
                          dispatch({
                            type: "KEEP",
                            side: "bsc",
                            key: candidateKey(c),
                          });
                          refocus(bscFilterRef.current);
                        }}
                        aria-label={`Keep ${label(c)} as BSC-only`}
                      >
                        Keep
                      </button>
                    </PairableRow>
                  ))}
                </ul>
              </section>

              <section>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-gray-200">
                    SportLots only ({state.unmatchedSl.length})
                  </h3>
                  <button
                    type="button"
                    className="text-xs text-gray-400 hover:text-cyan-300 disabled:opacity-40 px-2 py-1.5"
                    disabled={state.unmatchedSl.length === 0}
                    onClick={() => {
                      dispatch({ type: "KEEP_ALL", side: "sl" });
                      refocus(slFilterRef.current);
                    }}
                    aria-label="Keep all SportLots-only cards"
                  >
                    Keep all
                  </button>
                </div>
                <Input
                  bare
                  ref={slFilterRef}
                  className={`${slFieldClass()} w-full`}
                  type="text"
                  value={slFilter}
                  onChange={(e) => setSlFilter(e.target.value)}
                  // Same as the BSC filter above (NEO-220 D8).
                  onKeyDown={(e) => {
                    if (e.key !== "Escape") return;
                    e.preventDefault();
                    e.stopPropagation();
                    setSlFilter("");
                  }}
                  placeholder="Filter SportLots cards"
                  aria-label="Filter SportLots cards"
                />
                <ul className="flex flex-col gap-1 mt-2">
                  {visibleSl.map((c) => (
                    <PairableRow
                      key={candidateKey(c)}
                      side="sl"
                      cardKey={candidateKey(c)}
                    >
                      <button
                        type="button"
                        disabled={!selectedBsc}
                        className="flex-1 text-left text-sm rounded px-2 py-1 bg-gray-800/60 text-gray-200 disabled:opacity-60"
                        onClick={() => {
                          if (!selectedBsc) return;
                          // Same operation the drag path performs — including
                          // NEO-189's auto-expand of the Matched section when
                          // the link creates a name disagreement. See
                          // `performLink`.
                          performLink(selectedBsc, candidateKey(c));
                        }}
                        aria-label={`Link selected BSC card to ${label(c)}`}
                      >
                        {label(c)}
                      </button>
                      <button
                        type="button"
                        className="text-xs text-gray-400 hover:text-cyan-300 px-2 py-1.5"
                        onClick={() => {
                          dispatch({
                            type: "KEEP",
                            side: "sl",
                            key: candidateKey(c),
                          });
                          refocus(slFilterRef.current);
                        }}
                        aria-label={`Keep ${label(c)} as SportLots-only`}
                      >
                        Keep
                      </button>
                    </PairableRow>
                  ))}
                </ul>
              </section>
              </div>

              {/* Matches ReconciliationModal / ParallelGroupingModal exactly —
                  the same card, following the cursor. */}
              <DragOverlay>
                {activeDragLabel && (
                  <div className="px-3 py-2 rounded-lg border bg-gray-800 border-[#00B7FF] ring-2 ring-[#00B7FF] shadow-lg text-sm font-medium">
                    <span className="text-gray-200">{activeDragLabel}</span>
                  </div>
                )}
              </DragOverlay>
            </DndContext>
            )}

            {/* Keep shelf — same affordance the set-level dialog has. Hidden
                alongside the columns: with nothing unmatched there is nothing
                that could be kept, so "Nothing kept — every unmatched card
                above will be discarded" describes cards that do not exist. */}
            {!nothingToReconcile && (
            <section className="border-t border-gray-700 pt-3">
              <h3 className="text-sm font-semibold text-gray-200 mb-2">
                Keeping ({state.keptBsc.length + state.keptSl.length})
              </h3>
              {state.keptBsc.length + state.keptSl.length === 0 ? (
                <p className="text-xs text-gray-400 italic">
                  Nothing kept — every unmatched card above will be discarded.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {state.keptBsc.map((c) => (
                    <li
                      key={`kb-${candidateKey(c)}`}
                      className="flex items-center justify-between text-sm text-gray-200"
                    >
                      <span>BSC: {label(c)}</span>
                      <button
                        type="button"
                        className="text-xs text-gray-400 hover:text-red-400 px-2 py-1.5"
                        onClick={() => {
                          dispatch({
                            type: "UNKEEP",
                            side: "bsc",
                            key: candidateKey(c),
                          });
                          refocus(bscFilterRef.current);
                        }}
                        aria-label={`Remove ${label(c)} from save list`}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                  {state.keptSl.map((c) => (
                    <li
                      key={`ks-${candidateKey(c)}`}
                      className="flex items-center justify-between text-sm text-gray-200"
                    >
                      <span>SL: {label(c)}</span>
                      <button
                        type="button"
                        className="text-xs text-gray-400 hover:text-red-400 px-2 py-1.5"
                        onClick={() => {
                          dispatch({
                            type: "UNKEEP",
                            side: "sl",
                            key: candidateKey(c),
                          });
                          refocus(slFilterRef.current);
                        }}
                        aria-label={`Remove ${label(c)} from save list`}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            )}
          </div>

          <footer className="p-4 border-t border-gray-700 flex items-center justify-between gap-4">
            <div className="min-w-0 space-y-0.5">
              <span className="block text-xs text-gray-400">
                {totalToSave} card{totalToSave === 1 ? "" : "s"} will be saved
              </span>
              {/* NEO-330 — teams that missed the wait. The streaming line is
                  gone once Confirm unlocks, and the sync banner that says
                  this is behind the modal, so it is said here too, beside the
                  button it is about. Quiet and static (the status region
                  announced it once); Confirm's description points at it. */}
              {teamsLate && (
                <p id="pairing-teams-late" className="text-xs text-gray-300">
                  {teamsLateNotice}
                </p>
              )}
            </div>
            <div className="flex gap-2">
              <NeonButton
                secondary
                size="2"
                onClick={requestClose}
                // Specific, matching every other dialog in this directory —
                // CardChecklist renders a "Cancel new card" button on the same
                // page, so a bare "Cancel" would be ambiguous to assistive
                // tech and to Maestro's accessibility-tree selectors.
                aria-label="Cancel card matching"
              >
                Cancel
              </NeonButton>
              <NeonButton
                size="2"
                onClick={handleConfirm}
                // NEO-189/a11y: `disabled` only for the real terminal state
                // (already saving). While merely streaming, the button stays
                // FOCUSABLE — a native `disabled` button is pulled out of the
                // tab order entirely, so a keyboard user tabbing through the
                // footer would never even land on Confirm to learn why it
                // isn't doing anything, and `title` tooltips aren't reliably
                // announced by screen readers and can't be triggered by
                // keyboard on an unfocusable control either way. aria-disabled
                // keeps it reachable; handleConfirm's own confirmBlocked guard
                // (above) makes activating it a no-op, so this is safe.
                disabled={confirming}
                aria-disabled={confirmBlocked || undefined}
                // Ties the reason to the control itself so it's available the
                // moment Confirm receives focus, rather than depending on the
                // operator having caught the coarse status announcements
                // (NEO-330: the sentence itself is no longer live).
                aria-describedby={
                  confirmBlocked
                    ? "pairing-streaming-status"
                    : teamsLate
                      ? "pairing-teams-late"
                      : undefined
                }
                aria-label="Confirm card matches"
                title={
                  confirmBlocked
                    ? "Still loading teams…"
                    : undefined
                }
              >
                {confirming
                  ? "Saving…"
                  : confirmBlocked
                    ? "Loading…"
                    : "Confirm"}
              </NeonButton>
            </div>
          </footer>
        </div>
      </div>
      {/* NEO-220 — a SIBLING of the overlay, not a child of it.
          The overlay stack in this directory closes on backdrop click, and a
          confirm nested inside one would hand its own backdrop click straight
          to the thing it is protecting: click "no, keep working" on the
          backdrop and lose the session anyway. Rendered here it is also outside
          the modal root's `onKeyDown`, so ConfirmDialog's Escape is its own. */}
      {discardOpen && (
        <ConfirmDialog
          title={`Discard ${plural(pendingEdits, "pairing")}?`}
          description="Closing throws away every link, keep and name choice on this screen. No cards have been saved."
          confirmLabel={`Discard ${plural(pendingEdits, "pairing")}`}
          // Nothing is written on this path, so there is no in-flight window to
          // label — the same string keeps ConfirmDialog's contract honest.
          busyLabel={`Discard ${plural(pendingEdits, "pairing")}`}
          busy={false}
          onConfirm={() => {
            setDiscardOpen(false);
            onClose();
          }}
          onCancel={() => setDiscardOpen(false)}
        />
      )}
    </Theme>,
    document.body,
  );
}
