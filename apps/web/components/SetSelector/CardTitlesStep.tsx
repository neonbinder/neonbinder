import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Textarea } from "../primitives/Textarea";
import type { TitleContext } from "../../convex/features/listingInputs";
import {
  ASPECT_VALUE_MAX,
  LISTING_TITLE_MAX,
  TitleLengthMeter,
} from "./TitleLengthMeter";
import {
  buildTitleGroups,
  titleDraftState,
  type CardTitleAssessment,
  type PreviewCardForTitles,
  type TitleAnswer,
  type TitleGroup,
  type TitleNameSources,
  type VariationGroup,
} from "./card-titles";
import type { TeamAnswer } from "./teams-on-cards";

/**
 * NEO-335 — the entity review wizard's "Card titles" step, after Teams.
 *
 * The sync-created title warnings (`titleTruncated`, `aspectValueOverLimit`),
 * asked BEFORE save on the cards that would be born with them, instead of by
 * the attention walker afterwards. `card-titles.ts` decides who is here and
 * what each title says; this draws it and reports the operator's edits up.
 *
 * Two short lists, the one that needs action first:
 *
 *   1. **Variations** too long to list — one field per distinct variation
 *      text, shared by every card that prints it, with a `72/65` meter. The
 *      operator trims it in place; untouched, the card saves as before and
 *      the walker's warn-only item stays.
 *   2. **Titles** trimmed to fit — grouped by what the trim left out, each
 *      card's title in its own field, kept by default and editable in place,
 *      with the same `78/80` meter the drawer and the walker use.
 *
 * ## It never blocks a save
 *
 * There is no Save here and nothing here can stop the wizard's. A title typed
 * past the cap says "Too long to list as-is." and is not sent: the card saves
 * with its generated title and the walker asks after save, as before. Same for
 * a variation still over 65.
 *
 * ## Edits are local until they settle
 *
 * Each keystroke updates this step only; the wizard hears about it when the
 * field blurs, on Enter, a beat after typing stops, and when the step
 * unmounts — so a long wizard does not re-render per character, and no edit
 * is lost to a Next press.
 *
 * ## Keyboard
 *
 * Tab walks the fields. Enter settles the field in place (it never reaches
 * the wizard's own Enter). Escape undoes what was typed since the field took
 * focus, in place; with nothing to undo it is the wizard's Escape. Focus is
 * never taken on mount.
 */

/** Approved copy (Jason, 2026-10-10). */
const TITLES_LEAD = "Trimmed to fit. Keep it, or make it yours.";
const VARIATION_LEAD = "Variation's too long to list. Trim it to 65.";
const TITLE_OVER = "Too long to list as-is.";

/**
 * A title is one line. The field wraps so the whole 80 characters are in view
 * (an `<input>` would scroll most of the title out of sight, and seeing it is
 * the point of the step), but a newline is never part of the value.
 */
const oneLine = (raw: string): string => raw.replace(/\s*[\r\n]+\s*/g, " ");

/**
 * Geometry for both fields: grows with its content (`field-sizing`), two lines
 * where that is unsupported, never resizable by hand.
 */
const FIELD_CLASS = "block w-full resize-none p-1.5 text-sm [field-sizing:content]";

/** How long typing pauses before the wizard hears about an edit. */
const SETTLE_MS = 300;

type Drafts = ReadonlyArray<TitleAnswer | undefined>;

const NO_POSITIONS: readonly number[] = [];

/** `answer` without `field`; undefined when nothing is left. */
function without(answer: TitleAnswer | undefined, field: keyof TitleAnswer): TitleAnswer | undefined {
  if (!answer) return undefined;
  const rest: TitleAnswer = { ...answer };
  delete rest[field];
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function sameDrafts(a: Drafts, b: Drafts): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => JSON.stringify(x ?? null) === JSON.stringify(b[i] ?? null));
}

/** "#12 Mike Trout" — and a count when the same words would name two rows. */
function rowNames(cards: readonly CardTitleAssessment[]): Map<number, string> {
  const base = (c: CardTitleAssessment) => `#${c.cardNumber} ${c.cardName}`.trim();
  const total = new Map<string, number>();
  for (const c of cards) total.set(base(c), (total.get(base(c)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const out = new Map<number, string>();
  for (const c of cards) {
    const name = base(c);
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    out.set(c.index, (total.get(name) ?? 0) > 1 ? `${name}, card ${n} of ${total.get(name)}` : name);
  }
  return out;
}

export default function CardTitlesStep({
  cards,
  titleContext,
  teamAnswers,
  names,
  existingIndexes,
  answers,
  onAnswersChange,
  disabled = false,
}: {
  /** The confirmed preview cards, in preview order. */
  cards: readonly PreviewCardForTitles[];
  /** `resolveChecklistEntities`' `titleContext`. */
  titleContext: TitleContext;
  /** The Teams step's answers, positionally aligned with `cards`. */
  teamAnswers?: ReadonlyArray<TeamAnswer | undefined>;
  /** The names decided in the wizard — see `TitleNameSources`. */
  names?: TitleNameSources;
  /** Positions that re-sync a stored row: never asked about. */
  existingIndexes?: readonly number[];
  /** The operator's edits so far, positionally aligned with `cards`. */
  answers: ReadonlyArray<TitleAnswer | undefined>;
  /** Told the whole edit list whenever an edit settles. */
  onAnswersChange: (answers: Array<TitleAnswer | undefined>) => void;
  /** A commit is in flight; the fields hold still. */
  disabled?: boolean;
}) {
  const uid = useId();
  const [drafts, setDrafts] = useState<Array<TitleAnswer | undefined>>(() =>
    Array.from({ length: cards.length }, (_, i) => answers[i]),
  );
  // The edits as the wizard last heard them.
  const settled = useRef<Drafts>(drafts);
  // Escape's undo point: the edits as they stood when a field took focus.
  // Not the settle point — that moves a beat after typing stops, and Escape
  // after a pause must still undo rather than fall through to the wizard.
  const undoPoint = useRef<Drafts>(drafts);
  const latest = useRef<Drafts>(drafts);
  // Synced after each render (never during one), and declared FIRST so every
  // effect below — the settle timer, the unmount flush — reads this render's.
  useEffect(() => {
    latest.current = drafts;
  }, [drafts]);

  const flush = useCallback(() => {
    const next = latest.current;
    if (sameDrafts(settled.current, next)) return;
    settled.current = next;
    onAnswersChange([...next]);
  }, [onAnswersChange]);

  useEffect(() => {
    const timer = setTimeout(flush, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [drafts, flush]);
  // The step leaving (Next, Back, Save) settles whatever was typed.
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);
  useEffect(() => () => flushRef.current(), []);

  const existing = existingIndexes ?? NO_POSITIONS;
  const { variationGroups, titleGroups } = useMemo(
    () =>
      buildTitleGroups(cards, titleContext, teamAnswers, {
        names,
        existingIndexes: existing,
        answers: drafts,
      }),
    [cards, titleContext, teamAnswers, names, existing, drafts],
  );

  const setField = (indexes: readonly number[], field: keyof TitleAnswer, value: string) => {
    setDrafts((prev) => {
      const next = [...prev];
      while (next.length < cards.length) next.push(undefined);
      for (const i of indexes) next[i] = { ...next[i], [field]: value };
      return next;
    });
  };
  const clearField = (indexes: readonly number[], field: keyof TitleAnswer) => {
    setDrafts((prev) => {
      const next = [...prev];
      for (const i of indexes) next[i] = without(next[i], field);
      return next;
    });
  };
  /** Undo to the focus-time value; true when there was something to undo. */
  const undo = (indexes: readonly number[], field: keyof TitleAnswer): boolean => {
    const changed = indexes.some(
      (i) => (latest.current[i]?.[field] ?? undefined) !== (undoPoint.current[i]?.[field] ?? undefined),
    );
    if (!changed) return false;
    setDrafts((prev) => {
      const next = [...prev];
      for (const i of indexes) {
        const was = undoPoint.current[i]?.[field];
        next[i] = was === undefined ? without(next[i], field) : { ...next[i], [field]: was };
      }
      return next;
    });
    return true;
  };

  /** Enter settles in place; Escape undoes in place, or is the wizard's. */
  const fieldKeys =
    (indexes: readonly number[], field: keyof TitleAnswer) =>
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        flush();
      } else if (event.key === "Escape" && undo(indexes, field)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

  if (variationGroups.length === 0 && titleGroups.length === 0) return null;

  return (
    <div
      className="space-y-5"
      onFocusCapture={() => {
        undoPoint.current = latest.current;
      }}
    >
      {variationGroups.length > 0 && (
        <section aria-labelledby={`${uid}-variations`}>
          <h3 id={`${uid}-variations`} className="text-sm font-normal text-gray-200">
            {VARIATION_LEAD}
          </h3>
          <ul className="mt-1 divide-y divide-gray-800">
            {variationGroups.map((group) => (
              <VariationLine
                key={group.key}
                group={group}
                leadId={`${uid}-variations`}
                value={drafts[group.cards[0].index]?.cardVariation ?? group.variation}
                onChange={(value) =>
                  setField(
                    group.cards.map((c) => c.index),
                    "cardVariation",
                    value,
                  )
                }
                onBlur={flush}
                onKeyDown={fieldKeys(
                  group.cards.map((c) => c.index),
                  "cardVariation",
                )}
                disabled={disabled}
              />
            ))}
          </ul>
        </section>
      )}

      {titleGroups.length > 0 && (
        <section aria-labelledby={`${uid}-titles`}>
          <h3 id={`${uid}-titles`} className="text-sm font-normal text-gray-200">
            {TITLES_LEAD}
          </h3>
          <TitleGroups
            groups={titleGroups}
            drafts={drafts}
            onChange={(index, value) => setField([index], "listingTitle", value)}
            onReset={(index) => clearField([index], "listingTitle")}
            onBlur={flush}
            keysFor={(index) => fieldKeys([index], "listingTitle")}
            disabled={disabled}
          />
        </section>
      )}
    </div>
  );
}

function cardsPhrase(cards: VariationGroup["cards"]): string {
  const first = `#${cards[0].cardNumber} ${cards[0].cardName}`.trim();
  if (cards.length === 1) return first;
  const more = cards.length - 1;
  return `${first} and ${more} more ${more === 1 ? "card" : "cards"}`;
}

function VariationLine({
  group,
  leadId,
  value,
  onChange,
  onBlur,
  onKeyDown,
  disabled,
}: {
  group: VariationGroup;
  leadId: string;
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  disabled: boolean;
}) {
  const meterId = useId();
  const length = value.trim().length;
  const owner = cardsPhrase(group.cards);
  return (
    <li className="space-y-1 py-2">
      <CardList cards={group.cards} owner={owner} />
      <Textarea
        bare
        rows={2}
        value={value}
        onChange={(e) => onChange(oneLine(e.target.value))}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        // No maxLength: the value arrives over the cap and must stay visible
        // to be trimmed. The meter says where the cap is.
        aria-label={`Variation for ${owner}`}
        aria-describedby={`${leadId} ${meterId}`}
        aria-invalid={length > ASPECT_VALUE_MAX || undefined}
        aria-disabled={disabled || undefined}
        readOnly={disabled}
        className={`${FIELD_CLASS} ${disabled ? "opacity-60" : ""}`}
      />
      <div id={meterId} className="flex justify-end text-[11px]">
        <TitleLengthMeter length={length} max={ASPECT_VALUE_MAX} surface="dark" />
      </div>
    </li>
  );
}

/** The card(s) a line is about: one inline, several behind a disclosure. */
function CardList({
  cards,
  owner,
}: {
  cards: VariationGroup["cards"];
  owner: string;
}) {
  if (cards.length === 1) {
    const card = cards[0];
    return (
      <p className="break-words text-xs text-gray-400">
        <span className="text-[#00D558]">#{card.cardNumber}</span> {card.cardName}
      </p>
    );
  }
  return (
    <details className="text-xs text-gray-400">
      {/* py-1 -my-1: a 24px target (SC 2.5.8) without moving the line. */}
      <summary className="-my-1 cursor-pointer rounded py-1 hover:text-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF]">
        <span className="tabular-nums">{cards.length}</span> cards
      </summary>
      <ul aria-label={`Cards for ${owner}`} className="mt-1 space-y-0.5 pl-3">
        {cards.map((card) => (
          <li key={card.index} className="break-words">
            <span className="text-[#00D558]">#{card.cardNumber}</span> {card.cardName}
          </li>
        ))}
      </ul>
    </details>
  );
}

function TitleGroups({
  groups,
  drafts,
  onChange,
  onReset,
  onBlur,
  keysFor,
  disabled,
}: {
  groups: TitleGroup[];
  drafts: ReadonlyArray<TitleAnswer | undefined>;
  onChange: (index: number, value: string) => void;
  onReset: (index: number) => void;
  onBlur: () => void;
  keysFor: (index: number) => (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  disabled: boolean;
}) {
  const labels = useMemo(() => rowNames(groups.flatMap((g) => g.cards)), [groups]);
  return (
    <ul className="mt-1 divide-y divide-gray-800">
      {groups.map((group) => (
        <li key={group.key} className="py-2">
          {/* The shared reason first, so a run of cards that lost the same
              words reads as one decision. TitleFixer's wording and tone.
              Absent when the only losses are each card's own names, which
              every row states for itself. */}
          {group.leftOut.length > 0 && (
            <p className="mb-1.5 break-words text-xs text-[#FFB020]">
              Left out to fit: {group.leftOut.join(", ")}
              {group.cards.length > 1 && (
                <span className="text-gray-400">
                  {" "}
                  (<span className="tabular-nums">{group.cards.length}</span> cards)
                </span>
              )}
            </p>
          )}
          <ul className="space-y-2">
            {group.cards.map((card) => (
              <TitleRow
                key={card.index}
                card={card}
                label={labels.get(card.index) ?? `#${card.cardNumber}`}
                draft={drafts[card.index]?.listingTitle}
                onChange={(value) => onChange(card.index, value)}
                onReset={() => onReset(card.index)}
                onBlur={onBlur}
                onKeyDown={keysFor(card.index)}
                disabled={disabled}
              />
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function TitleRow({
  card,
  label,
  draft,
  onChange,
  onReset,
  onBlur,
  onKeyDown,
  disabled,
}: {
  card: CardTitleAssessment;
  label: string;
  draft: string | undefined;
  onChange: (value: string) => void;
  onReset: () => void;
  onBlur: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  disabled: boolean;
}) {
  const meterId = useId();
  const alertId = useId();
  const value = draft ?? card.title;
  const state = titleDraftState(draft, card.title);
  const over = state.kind === "over";
  // Offered whenever the field no longer shows the trimmed title — including
  // a field cleared to nothing, which still saves the trimmed one.
  const edited = draft !== undefined && draft.trim() !== card.title;
  return (
    <li className="sm:grid sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] sm:items-start sm:gap-x-3">
      <p className="break-words pt-1.5 text-xs text-gray-400">
        <span className="text-[#00D558]">#{card.cardNumber}</span> {card.cardName}
      </p>
      <div className="min-w-0">
        <Textarea
          bare
          rows={2}
          value={value}
          onChange={(e) => onChange(oneLine(e.target.value))}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          // No maxLength: an over-long title must stay visible to be fixed.
          aria-label={`Title for ${label}`}
          aria-describedby={over ? `${meterId} ${alertId}` : meterId}
          aria-invalid={over || undefined}
          aria-disabled={disabled || undefined}
          readOnly={disabled}
          className={`${FIELD_CLASS} ${disabled ? "opacity-60" : ""}`}
        />
        {card.ownLeftOut.length > 0 && (
          // The card's own names the trim cost it — the loss an operator most
          // wants to put back, so it sits right under the field.
          <p className="mt-0.5 break-words text-[11px] text-[#FFB020]">
            Left out to fit: {card.ownLeftOut.join(", ")}
          </p>
        )}
        <div className="mt-0.5 flex flex-wrap items-center justify-between gap-x-3 text-[11px]">
          {edited ? (
            <button
              type="button"
              onClick={() => {
                if (!disabled) onReset();
              }}
              aria-label={`Use trimmed title for ${label}`}
              aria-disabled={disabled || undefined}
              className="-my-1 rounded py-1 text-[#00B7FF] underline decoration-dotted hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF]"
            >
              Use trimmed title
            </button>
          ) : (
            <span />
          )}
          <span id={meterId}>
            <TitleLengthMeter length={value.trim().length} max={LISTING_TITLE_MAX} soft surface="dark" />
          </span>
        </div>
        {/* Always mounted, so its text is announced when it appears (a live
            region inserted WITH its text often is not). Polite status, not
            an alert: the step never blocks, so nothing here stops work. Its
            text changes only when the title crosses the cap, so it speaks
            once per crossing rather than per keystroke. */}
        <p id={alertId} role="status" className="mt-0.5 text-[11px] text-[#FF2EB3] empty:hidden">
          {over ? TITLE_OVER : ""}
        </p>
      </div>
    </li>
  );
}
