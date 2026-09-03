import {
  ClipboardDocumentCheckIcon,
  ClipboardDocumentIcon,
} from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * NEO-212 (audit finding G10) — the shared copy-to-clipboard affordance.
 *
 * The pattern is lifted from `components/modules/TrackingCode.tsx` (NEO-213),
 * which is where it was first got right. Two details are the whole reason this
 * is a primitive rather than something each caller writes inline, because both
 * are invisible until they bite:
 *
 *  1. **The denied branch.** `navigator.clipboard.writeText` can be refused —
 *     permissions policy, a cross-origin iframe, an insecure context — and it
 *     refuses by rejecting, silently. A from-scratch copy button ships the
 *     happy path and leaves the user staring at an unchanged icon. The failure
 *     here says what to do instead: select the text and copy it by hand.
 *  2. **The live region is ALWAYS MOUNTED.** A live region inserted at the
 *     same instant its text appears is announced unreliably (notably
 *     VoiceOver). It has to exist, empty, before the click.
 *
 * The button is icon-only and fixed-size, so it can sit inline beside a name
 * without the row reflowing when the state changes: the icon swaps, the box
 * does not. `size="sm"` is 24x24 CSS px, the WCAG 2.2 SC 2.5.8 floor.
 */

/** Icon-only, so the accessible name is the only name — it must be supplied. */
export interface CopyButtonProps {
  /** The text placed on the clipboard. */
  value: string;
  /**
   * What `value` IS, e.g. "player name". Used verbatim in the accessible name
   * (`Copy {label}`) and in nothing else. Required because a page with more
   * than one of these — a roster, a checklist — otherwise announces every
   * button as a bare "Copy" and a screen-reader user cannot tell them apart.
   */
  label: string;
  className?: string;
  /**
   * `sm` (default) is a 24x24 target sized to sit inline next to a name in a
   * dialog; `md` is 32x32 for standalone use in a toolbar or a card header.
   */
  size?: "sm" | "md";
}

type CopyState = "idle" | "copied" | "failed";

/**
 * Success reverts fast — the check mark has already done its job and a stale
 * "Copied" is noise.
 */
const COPIED_RESET_MS = 2000;

/**
 * Failure holds longer ON PURPOSE. Its text is an *instruction* the user has
 * to act on ("select the text and copy manually"), and an instruction that
 * disappears in two seconds cannot be followed. Both still clear, so the
 * status never goes stale against a later attempt.
 */
const FAILED_RESET_MS = 8000;

const STATUS_TEXT: Record<CopyState, string> = {
  idle: "",
  copied: "Copied",
  failed: "Copy failed — select the text and copy manually",
};

export function CopyButton({
  value,
  label,
  className = "",
  size = "sm",
}: CopyButtonProps) {
  const [state, setState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clearing on unmount matters more than usual here: the common host is a
  // dialog, and dismissing it right after a copy would otherwise leave a
  // pending setState pointed at a gone component.
  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    [],
  );

  const settle = useCallback((next: Exclude<CopyState, "idle">) => {
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    setState(next);
    resetTimer.current = setTimeout(
      () => setState("idle"),
      next === "copied" ? COPIED_RESET_MS : FAILED_RESET_MS,
    );
  }, []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      settle("copied");
    } catch {
      settle("failed");
    }
  }, [value, settle]);

  const box = size === "md" ? "h-8 w-8" : "h-6 w-6";
  const glyph = size === "md" ? "h-5 w-5" : "h-4 w-4";
  const tone =
    state === "failed"
      ? "text-neon-pink hover:text-neon-pink/80"
      : "text-neon-teal hover:text-neon-teal/80";

  const Icon =
    state === "copied" ? ClipboardDocumentCheckIcon : ClipboardDocumentIcon;

  return (
    // `inline-flex` so the control sits on the text baseline of whatever row
    // it is dropped into rather than forcing a block of its own.
    <span className={`inline-flex items-center ${className}`.trim()}>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={`Copy ${label}`}
        className={`${box} ${tone} inline-flex shrink-0 items-center justify-center rounded-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-blue`}
      >
        {/* Both glyphs share heroicons' 24x24 box and render at one size, so
            the swap cannot change the button's width. */}
        <Icon className={glyph} aria-hidden="true" />
      </button>
      {/* Mounted from the first render, empty, so the announcement lands. See
          the module docblock.

          One node, two presentations. Success is visually hidden — the check
          mark already said it, and an inline "Copied" would reflow the row.
          Failure is SHOWN, because its text is the recovery instruction and a
          pink icon on its own tells a sighted user nothing. Toggling the class
          rather than swapping the element keeps the region continuously
          mounted, which is the part that makes the announcement reliable. */}
      <span
        role="status"
        aria-live="polite"
        className={
          state === "failed" ? "ml-2 text-xs text-neon-pink" : "sr-only"
        }
      >
        {STATUS_TEXT[state]}
      </span>
    </span>
  );
}
