import { useEffect, useId, useRef } from "react";
import { ConvexError, type Value } from "convex/values";
import NeonButton from "../modules/NeonButton";

/**
 * NEO-463 — "Just Walker? We've got Devin Walker."
 *
 * A one-word name that is a piece of a fuller name already on file in the
 * sport is, nearly always, a checklist or a typist dropping the first name.
 * Creating it mints a second row for a man we already have, and no later
 * lookup can tell "Walker" from "Devin Walker". So every surface that creates
 * a player stops on such a name and asks: one of these, or genuinely a
 * one-name player (Ichiro, Pelé)?
 *
 * The server decides what counts as a fragment (`players.nameFragmentCheck`,
 * and the same rule refusing `findOrCreate` / `createByAdmin` with
 * `PLAYER_NAME_FRAGMENT`). This panel only presents the answer; it holds no
 * rule of its own.
 *
 * ## The visual grammar
 *
 * The blue left rule and tint `SameNamePlayerPanel` and `NearMatchPanel`
 * wear: the app's "one we already have" accent. The choices are the answer
 * the panel is asking for, so they lead; the one-name create is the
 * exception and is the secondary (blue) button, never the green primary.
 */

/** One fuller-named player the typed name is a piece of. */
export interface NameFragmentMatch {
  _id: string;
  name: string;
}

/** How many fuller names the sentence spells out before "and N more". */
const NAMED_IN_MESSAGE = 2;

/**
 * The panel's one sentence, kept whole so a screen reader and an E2E text
 * match both read it as a unit.
 *
 * With no matches in hand (a refusal that landed before the check did), it
 * still says what happened and offers the one action it can.
 */
export function nameFragmentMessage(
  name: string,
  matches: ReadonlyArray<NameFragmentMatch>,
): string {
  const typed = name.trim();
  if (matches.length === 0) {
    return `Just ${typed}? That's part of a fuller name we've got. Type the whole name to find them, or add ${typed} as a one-name player.`;
  }
  const names = matches.map((m) => m.name);
  const shown = names.slice(0, NAMED_IN_MESSAGE);
  const rest = names.length - shown.length;
  const list =
    rest > 0
      ? `${shown.join(", ")} and ${rest} more`
      : shown.length === 2
        ? `${shown[0]} and ${shown[1]}`
        : shown[0];
  // "Ken Griffey Jr." already ends the sentence; a second stop reads as a typo.
  const stop = list.endsWith(".") ? "" : ".";
  return `Just ${typed}? We've got ${list}${stop} Pick one, or add ${typed} as a one-name player.`;
}

/** The confirm action's words, shared by every surface. */
export const ONE_NAME_PLAYER_LABEL = "Add as a one-name player";

/**
 * The server's fragment refusal, wherever it surfaces (a race: the name was
 * created as a fragment's twin between the check and the press). Keyed on the
 * structured code, never the message text.
 */
export function isNameFragmentRefusal(err: unknown): boolean {
  if (!(err instanceof ConvexError)) return false;
  const data = err.data as unknown;
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { code?: unknown }).code === "PLAYER_NAME_FRAGMENT"
  );
}

/**
 * The matches a fragment refusal carried, when it carried any in the shape
 * the panel reads. Anything else is an empty list, and the caller falls back
 * to its own `nameFragmentCheck` answer.
 */
export function fragmentRefusalMatches(err: unknown): NameFragmentMatch[] {
  if (!isNameFragmentRefusal(err)) return [];
  const raw = ((err as ConvexError<Value>).data as { matches?: unknown })
    .matches;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (m): m is NameFragmentMatch =>
      typeof m === "object" &&
      m !== null &&
      typeof (m as NameFragmentMatch)._id === "string" &&
      typeof (m as NameFragmentMatch).name === "string",
  );
}

/**
 * Distinct accessible names for the choices. Two people can share a full name
 * ("Devin Walker" twice), and two buttons reading the same are a guess for a
 * screen reader and a locator alike, so a repeated name takes its position.
 */
function choiceLabels(
  matches: ReadonlyArray<NameFragmentMatch>,
  pickLabel: (name: string) => string,
): string[] {
  const counts = new Map<string, number>();
  for (const m of matches) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return matches.map((m) => {
    const total = counts.get(m.name) ?? 1;
    if (total === 1) return pickLabel(m.name);
    const n = (seen.get(m.name) ?? 0) + 1;
    seen.set(m.name, n);
    return `${pickLabel(m.name)}, option ${n} of ${total}`;
  });
}

export default function NameFragmentPanel({
  name,
  matches,
  onPick,
  pickLabel = (n) => `Link to ${n}`,
  onConfirm,
  confirmBusy,
  disabled,
  autoFocus,
  onDismiss,
  compact,
  panelRef,
}: {
  /** The one-word name as typed. */
  name: string;
  matches: ReadonlyArray<NameFragmentMatch>;
  onPick: (id: string) => void;
  /**
   * Each choice's accessible name. The visible text is the player's name and
   * always sits inside this string (SC 2.5.3). Defaults to the wizard's
   * `Link to {name}`; a surface whose press does something else says so.
   */
  pickLabel?: (name: string) => string;
  /**
   * The one-name create. Omitted where the surface puts that action somewhere
   * else (the wizard's footer primary), so the panel never shows two.
   */
  onConfirm?: () => void;
  confirmBusy?: boolean;
  /** Another decision is in flight: every control `aria-disabled`. */
  disabled?: boolean;
  /**
   * Take focus on mount. True where the panel appears in answer to a press
   * (a Create that stopped), so the sentence is announced and the next Tab
   * reaches the first choice. False where it is part of a screen that already
   * manages its own focus.
   */
  autoFocus?: boolean;
  /** Escape inside the panel. The caller decides where focus goes back to. */
  onDismiss?: () => void;
  /** The popover's tighter spacing. */
  compact?: boolean;
  /** The panel's element, for a caller that moves focus to it later. */
  panelRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const messageId = useId();
  const ownRef = useRef<HTMLDivElement | null>(null);
  const rootRef = panelRef ?? ownRef;
  const labels = choiceLabels(matches, pickLabel);

  useEffect(() => {
    if (!autoFocus) return;
    rootRef.current?.focus({ preventScroll: true });
    // Mount only: a re-render with new matches must not pull focus back off a
    // choice the operator has tabbed to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={rootRef}
      role="group"
      aria-labelledby={messageId}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !onDismiss) return;
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      }}
      className={`rounded-md border border-neon-blue-text/40 border-l-4 border-l-selection bg-neon-blue/5 focus-outline ${
        compact ? "p-2 space-y-1.5" : "mt-2 p-3 space-y-2"
      }`}
    >
      <p
        id={messageId}
        className={compact ? "text-xs text-ink-2" : "text-sm text-ink-2"}
      >
        {nameFragmentMessage(name, matches)}
      </p>
      {matches.length > 0 && (
        <ul className="space-y-0.5" aria-label={`Fuller names for ${name.trim()}`}>
          {matches.map((m, i) => (
            <li key={m._id}>
              <button
                type="button"
                // aria-disabled, never `disabled`: a disabled control leaves
                // the tab order and drops a keyboard operator out of the list.
                aria-disabled={disabled || undefined}
                aria-label={labels[i]}
                onClick={() => {
                  if (disabled) return;
                  onPick(m._id);
                }}
                className={`flex min-h-6 w-full items-center rounded px-2 text-left text-ink transition-colors hover:bg-neon-blue/10 focus-outline aria-disabled:opacity-40 ${
                  compact ? "py-1 text-sm" : "py-1.5 text-sm"
                }`}
              >
                <span className="min-w-0 truncate">{m.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {onConfirm && (
        <div className="pt-0.5">
          <NeonButton
            type="button"
            variant="secondary"
            size="1"
            aria-disabled={disabled || confirmBusy || undefined}
            aria-busy={confirmBusy || undefined}
            onClick={() => {
              if (disabled || confirmBusy) return;
              onConfirm();
            }}
          >
            {confirmBusy ? "Adding…" : ONE_NAME_PLAYER_LABEL}
          </NeonButton>
        </div>
      )}
    </div>
  );
}
