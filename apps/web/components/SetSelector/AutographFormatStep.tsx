import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
  type RefObject,
} from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import NeonButton from "../modules/NeonButton";
import { userFacingMessage } from "@/lib/errors/user-facing-message";
import {
  AUTOGRAPH_CHOICE_LABEL,
  AUTOGRAPH_FORMATS,
  type AutographFormat,
} from "./entity-review-steps";
// The header prompt's words live in the pure prompt module, which the
// set-build tool's attention listing reads too (NEO-339).
import { autographPromptLine, autographPromptSaved } from "./autograph-prompt";

/**
 * NEO-345 — how a leaf's autographs are signed: on the card, or on a sticker.
 *
 * No marketplace says which, so it is NB data the operator supplies once per
 * synced leaf (the insert/parallel/base node whose cards are saved), and every
 * card on that leaf carrying the "AU" attribute inherits it as
 * `features.autographed`, with Signed By seeded from its players.
 *
 * Two places ask:
 *
 *  - **The wizard's "Autographed cards" step** (`AutographFormatStep`, the
 *    default export), between teams and titles, when a card the save will
 *    CREATE carries AU and the leaf has no format. The answer is required:
 *    the wizard's Next stays `aria-disabled` until one is picked, and the
 *    step cannot be walked past.
 *  - **The checklist header** (`AutographFormatPrompt`), for a leaf already
 *    stored with AU cards still marked "None": one line, two buttons, each a
 *    `setAutographFormat` on the leaf.
 *
 * Every user-visible string below is a PLACEHOLDER for Jason's wording and is
 * exported so the tests read it rather than restating it.
 */

/** The step's question, which also labels the radio group. */
export function autographStepQuestion(count: number): string {
  return count === 1
    ? "1 of these cards is autographed. How is it signed?"
    : `${count} of these cards are autographed. How are they signed?`;
}

/**
 * The two choices' visible names, keyed by the stored value. Lives in the
 * pure step module so Set details' select shows the same words.
 */
export { AUTOGRAPH_CHOICE_LABEL };

/**
 * Said (politely, under the tiles) when Next is pressed before a choice is
 * made, and part of Next's description from then on.
 */
export const AUTOGRAPH_NEXT_BLOCKED = "Pick how they're signed first";

/**
 * The checklist header's one line, for a stored leaf, and what it says once
 * the answer is saved: defined in `autograph-prompt.ts` so the set-build
 * tool's listing says the same words, re-exported for this step's callers.
 */
export { autographPromptLine, autographPromptSaved };

/** Said politely while the header prompt's write is in flight. */
export const AUTOGRAPH_PROMPT_SAVING = "Saving…";

/**
 * A small drawn card: the hobby's own picture of the question. On card, the
 * ink crosses the card itself; on a sticker, it sits on a label stuck on at a
 * slight angle. Decorative — the radio's name carries the meaning.
 */
function SignatureGlyph({ format }: { format: AutographFormat }) {
  const ink = "M9 36 C 13 26, 17 42, 21 32 S 29 26, 33 34";
  return (
    <svg
      viewBox="0 0 42 56"
      width="30"
      height="40"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <rect x="1.5" y="1.5" width="39" height="53" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="6" y="6" width="30" height="18" rx="1" fill="currentColor" opacity="0.18" />
      {format === "On Card" ? (
        <path d={ink} fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
      ) : (
        <g transform="rotate(-6 21 34)">
          <rect x="6" y="26" width="30" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.75" strokeDasharray="3 2" />
          <path d="M10 37 C 13 29, 17 41, 21 33 S 28 29, 32 35" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
        </g>
      )}
    </svg>
  );
}

/**
 * The wizard step's body: the question, then the two choices as an APG
 * single-select radio group (`role="radiogroup"` / `role="radio"` +
 * `aria-checked`, the `ChoiceList` pattern in SetShapeDialog).
 *
 * Keyboard: one Tab stop (the checked choice, else the first). The arrow keys
 * move focus with the selection, wrapping. Space or a click picks. Enter
 * picks AND moves on (`onEnter`), so the whole step is one keystroke; an
 * auto-repeated Enter is refused, so a held key cannot run on into Save.
 *
 * `choiceRef` lands on the tab-stop choice, which is where the wizard puts
 * focus while nothing is picked.
 *
 * `hintId` / `showBlockedHint` — a polite status line under the tiles,
 * mounted always (a live region must exist before it speaks) and empty until
 * the wizard's held Next is pressed with nothing picked. The wizard describes
 * Next by it, so the reason stays reachable after it has been said.
 */
export default function AutographFormatStep({
  count,
  value,
  onChange,
  onEnter,
  disabled = false,
  headingId,
  choiceRef,
  hintId,
  showBlockedHint = false,
}: {
  /** How many cards the answer applies to. */
  count: number;
  value: AutographFormat | undefined;
  onChange: (value: AutographFormat) => void;
  /** Enter on a choice: picked, now go on. */
  onEnter?: (value: AutographFormat) => void;
  disabled?: boolean;
  /** The question's id, so the wizard's Next can be described by it. */
  headingId: string;
  choiceRef?: Ref<HTMLButtonElement>;
  /** The blocked-Next hint's id, so the wizard's Next can be described by it. */
  hintId?: string;
  /** Next was pressed with nothing picked: say why it did nothing. */
  showBlockedHint?: boolean;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const tabStop = value ?? AUTOGRAPH_FORMATS[0];

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (disabled) return;
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step !== 0) {
      event.preventDefault();
      const next = (index + step + AUTOGRAPH_FORMATS.length) % AUTOGRAPH_FORMATS.length;
      onChange(AUTOGRAPH_FORMATS[next]);
      buttons.current[next]?.focus();
      return;
    }
    if (event.key === "Enter") {
      // Never the button's default click (a synthetic Enter has none, and a
      // real one would pick twice); never the wizard's own Enter either.
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const picked = AUTOGRAPH_FORMATS[index];
      onChange(picked);
      onEnter?.(picked);
    }
  };

  return (
    <div className="space-y-3">
      <h3 id={headingId} className="text-sm font-semibold text-gray-200">
        {autographStepQuestion(count)}
      </h3>
      <div
        role="radiogroup"
        aria-labelledby={headingId}
        aria-required="true"
        // One column on the narrowest phones (two tiles at 320px overflow),
        // side by side from 380px. DOM order is the same either way.
        className="grid max-w-md grid-cols-1 gap-3 min-[380px]:grid-cols-2"
      >
        {AUTOGRAPH_FORMATS.map((format, index) => {
          const checked = value === format;
          return (
            <button
              key={format}
              ref={(el) => {
                buttons.current[index] = el;
                if (format !== tabStop || !choiceRef) return;
                if (typeof choiceRef === "function") choiceRef(el);
                else choiceRef.current = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-disabled={disabled || undefined}
              tabIndex={format === tabStop ? 0 : -1}
              data-autograph-format={format}
              onClick={() => {
                if (!disabled) onChange(format);
              }}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={`flex items-center gap-3 rounded-lg border-2 px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF] focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900 ${
                checked
                  ? "border-[#00D558] bg-[#00D558]/10 text-[#00D558]"
                  : "border-slate-500 text-gray-300 hover:border-gray-300"
              } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
            >
              <SignatureGlyph format={format} />
              <span className="flex flex-1 items-baseline justify-between gap-2 text-sm font-semibold">
                <span>{AUTOGRAPH_CHOICE_LABEL[format]}</span>
                {/* 1.4.1 — checked is not colour alone. Beside the name,
                    never inside it, so the name stays exactly the label. */}
                {checked && <span aria-hidden="true">✓</span>}
              </span>
            </button>
          );
        })}
      </div>
      <p id={hintId} role="status" className="text-xs text-gray-300">
        {showBlockedHint && value === undefined ? AUTOGRAPH_NEXT_BLOCKED : null}
      </p>
    </div>
  );
}

/**
 * The prompt's slot once answered: says so, and holds focus for the button
 * that went. It takes focus ONLY when focus has nowhere else to be — on the
 * page itself (the pressed button just unmounted) or still inside the prompt
 * — never from a control the operator has moved to since, so a remount can
 * never steal focus.
 */
function SavedLine({
  value,
  slotRef,
}: {
  value: AutographFormat;
  slotRef: RefObject<HTMLDivElement | null>;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const active = document.activeElement;
    const homeless = active === null || active === document.body;
    if (homeless || (active && slotRef.current?.contains(active))) ref.current?.focus();
  }, [slotRef]);
  return (
    <p
      ref={ref}
      tabIndex={-1}
      role="status"
      className="mb-3 rounded-md border border-slate-500 px-3 py-2 text-sm text-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF]"
    >
      {autographPromptSaved(value)}
    </p>
  );
}

/**
 * The checklist header's prompt for a STORED leaf: its AU cards are still
 * "None" because nobody has said how they are signed. Two buttons, each a
 * `setAutographFormat` on the leaf, which writes the format and cascades it
 * to the leaf's AU cards server-side.
 *
 * Once saved, the host keeps this slot mounted (`saved`) so the line can say
 * so in place, and focus is parked on it — the button that was pressed is
 * gone, and focus must not fall to the page.
 */
export function AutographFormatPrompt({
  selectorOptionId,
  count,
  saved,
  onSaved,
}: {
  selectorOptionId: Id<"selectorOptions">;
  count: number;
  saved?: AutographFormat;
  onSaved: (value: AutographFormat) => void;
}) {
  const setAutographFormat = useMutation(api.autographFormat.setAutographFormat);
  const [busy, setBusy] = useState<AutographFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The slot both states render in, so the saved line can tell where focus is. */
  const slotRef = useRef<HTMLDivElement>(null);
  const errorId = useId();

  const choose = async (value: AutographFormat) => {
    if (busy) return;
    setBusy(value);
    setError(null);
    try {
      await setAutographFormat({ selectorOptionId, value });
      onSaved(value);
    } catch (e) {
      setError(userFacingMessage(e, "Could not save the autograph format"));
    } finally {
      setBusy(null);
    }
  };

  if (saved) {
    return (
      <div ref={slotRef}>
        <SavedLine value={saved} slotRef={slotRef} />
      </div>
    );
  }

  return (
    <div
      ref={slotRef}
      role="group"
      aria-labelledby="autograph-format-prompt"
      className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-[#00D558]/60 px-3 py-2"
    >
      {/* Glyph and line wrap as ONE item with a 16rem basis, the way the
          ReauthNotice / PausedNotice banners hold their text: on a phone the
          pair takes the whole row and the buttons drop beneath it, rather
          than the buttons squeezing the line until words break mid-word. */}
      <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
        <span className="shrink-0 text-[#00D558]">
          <SignatureGlyph format="On Card" />
        </span>
        <p id="autograph-format-prompt" className="min-w-0 flex-1 text-sm text-gray-200">
          {autographPromptLine(count)}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        {AUTOGRAPH_FORMATS.map((format) => (
          <NeonButton
            key={format}
            secondary
            aria-busy={busy === format || undefined}
            aria-disabled={busy !== null || undefined}
            aria-describedby={error ? errorId : undefined}
            onClick={() => void choose(format)}
          >
            {AUTOGRAPH_CHOICE_LABEL[format]}
          </NeonButton>
        ))}
      </div>
      {/* Both regions are mounted from the start — a live region that
          appears at the moment it speaks is often not heard — and collapse
          while empty. No whitespace inside: `empty:` needs no child nodes. */}
      <p role="status" className="basis-full text-xs text-gray-300 empty:hidden">
        {busy ? AUTOGRAPH_PROMPT_SAVING : null}
      </p>
      <p id={errorId} role="alert" className="basis-full text-xs text-[#FF2EB3] empty:hidden">
        {error}
      </p>
    </div>
  );
}
