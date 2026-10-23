import { useState, type ReactNode } from "react";

/**
 * NEO-335 — the header every "tidy up this set" screen wears: the entity
 * review wizard before a save, and the post-save attention walker after one.
 *
 * Jason, 2026-10-10: one generic title, each screen type its own subtitle, and
 * ONE "Step x of y" counter that sums every screen still to come. No per-type
 * counts anywhere.
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ Tidy up this set                Step 3 of 12 │
 *   │ New team         2 more steps: teams for Jim │
 *   ├██████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░┤  ← the rail IS the header's edge
 *
 * The rail is the screen's single bold element: the neon green fill stands
 * where the header's grey divider used to be, so progress is literally the
 * line between "where am I" and "what is this". Everything else in the header
 * is quiet type.
 *
 * ## Motion
 *
 * The only motion is the rail's width, and only FORWARD. A step back (Back,
 * Change decision) or a total that grew (x/y drops) moves the fill without a
 * transition: a bar that visibly slides backwards reads as "you lost work".
 * Under `prefers-reduced-motion` there is no transition at all.
 *
 * ## Screen readers
 *
 * - The title is the dialog's name — the host points `aria-labelledby` at
 *   `titleId`.
 * - "Step x of y" is real text in a `role="status"` region, so it is read
 *   with the header and announced when it moves, as the "N of M reviewed"
 *   line it replaces was. One text node, so an E2E matcher on its visible
 *   text sees the whole phrase.
 * - The growth line ("2 more steps: teams for Jim Thome") is its own polite
 *   region, always mounted (a live region that mounts with its first message
 *   announces unreliably), and empty when there is nothing to say.
 * - The rail is `aria-hidden`: it repeats the counter, and a second
 *   progressbar would be read as a second, competing number.
 *
 * Every row of the header has a fixed height whatever it says, so the body
 * below it never moves when a growth line appears — the NEO-110 rule the
 * wizard's footer already lives by.
 */

export const WIZARD_TITLE = "Tidy up this set";

export interface WizardChromeProps {
  /** 1-based step on screen. */
  step: number;
  /** Steps in this sitting. 0 hides the counter and empties the rail. */
  total: number;
  /** The screen type — "New team", "Cards with no team", "Ready to save". */
  subtitle: string;
  /** Defaults to "Tidy up this set". */
  title?: string;
  /** Id for the title, so the host dialog can be `aria-labelledby` it. */
  titleId?: string;
  /** The polite growth line. Empty or absent says nothing. */
  announcement?: string;
  /** Anything the host needs under the subtitle row (kept out of the live regions). */
  children?: ReactNode;
}

/** "Step 3 of 12", one string. */
export function stepCounterText(step: number, total: number): string {
  return `Step ${step} of ${total}`;
}

/** The rail's fill, 0..1. */
export function railFraction(step: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.min(1, Math.max(0, step / total));
}

export default function WizardChrome({
  step,
  total,
  subtitle,
  title = WIZARD_TITLE,
  titleId,
  announcement,
  children,
}: WizardChromeProps) {
  const fraction = railFraction(step, total);
  /*
   * "Never animates backwards". The previous fraction is remembered with the
   * render-phase update React documents for "information from previous
   * renders", not a ref read during render: the transition class is part of
   * THIS render's output, so it must be decided before commit.
   */
  const [rail, setRail] = useState({ fraction, forward: false });
  if (rail.fraction !== fraction) {
    setRail({ fraction, forward: fraction > rail.fraction });
  }
  const forward = rail.fraction === fraction ? rail.forward : fraction > rail.fraction;

  return (
    <header className="shrink-0">
      <div className="px-6 pt-4 pb-3">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id={titleId} className="min-w-0 text-lg font-semibold text-ink">
            {title}
          </h2>
          {/* Always mounted, so the first step is announced as reliably as
              the rest. Empty while there is no count to give. */}
          <p role="status" className="shrink-0 text-sm tabular-nums text-ink-2">
            {total > 0 ? stepCounterText(step, total) : ""}
          </p>
        </div>
        {/* The growth line WRAPS — it is the line that carries a player's
            name, and clipping it hid exactly that (a11y audit). From `sm` up
            it shares the subtitle's row in its own column, and the row
            reserves two of its lines (`sm:min-h-8`), so a line arriving or
            wrapping never moves the body below. Narrower than its 12rem basis
            it drops under the subtitle instead. */}
        <div className="mt-0.5 flex min-h-5 flex-wrap items-baseline justify-between gap-x-4 sm:min-h-8">
          <p className="min-w-0 shrink-0 text-sm text-ink-3">{subtitle}</p>
          <p
            aria-live="polite"
            data-growth-line=""
            className="min-w-0 flex-1 basis-48 text-right text-xs text-ink-3 sm:whitespace-normal"
          >
            {announcement ?? ""}
          </p>
        </div>
        {children}
      </div>
      <div aria-hidden="true" className="relative h-[3px] w-full bg-rule">
        <div
          data-rail-fill=""
          data-rail-forward={forward ? "true" : "false"}
          className={[
            "absolute inset-y-0 left-0 bg-neon-green shadow-[0_0_10px_rgb(0_213_88/calc(0.65*var(--glow)))]",
            forward
              ? "transition-[width] duration-300 ease-out motion-reduce:transition-none"
              : "transition-none",
          ].join(" ")}
          style={{ width: `${(fraction * 100).toFixed(3)}%` }}
        />
      </div>
    </header>
  );
}
