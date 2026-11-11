import { useState, type ReactNode } from "react";

/**
 * NEO-335 — the header every "tidy up" screen wears: the entity review
 * wizard before a save, and the post-save attention walker after one.
 *
 * Jason, 2026-10-10: one title, each screen type its own subtitle, and ONE
 * "Step x of y" counter that sums every screen still to come. No per-type
 * counts anywhere. NEO-497: the title names the set it is tidying ("Tidy up
 * 2024 Topps Chrome Base", `tidyUpTitleFromChain`) instead of "this set".
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ Tidy up 2024 Topps Chrome Base  Step 3 of 12 │
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
 *   `titleId`. A long set name wraps; past three lines it is clamped
 *   visually, but the heading's text stays whole, so its accessible name is
 *   the full title (also in its `title` attribute for a sighted hover).
 *   Below `sm` the counter sits on its own line under the title; from `sm`
 *   up it keeps a fixed-width column beside it.
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

/** The title while the set's names are still loading, or none is known. */
export const WIZARD_TITLE = "Tidy up this set";

/**
 * True when `text` opens with `token` as a whole word, case-folded: "2024
 * Topps Chrome" opens with "2024", "Unleashed Blue Ice" with "Unleashed",
 * but "Unleashed2" does not open with "Unleashed". A pure string check on NB's
 * own names, used only to keep the title from saying a word twice.
 */
function startsWithToken(text: string, token: string): boolean {
  if (token === "") return false;
  const haystack = text.toLowerCase();
  const needle = token.toLowerCase();
  if (!haystack.startsWith(needle)) return false;
  const next = haystack.charAt(needle.length);
  return next === "" || /\s/.test(next);
}

/**
 * NEO-497 — "Tidy up 2026 Donruss Unleashed Base": the year, the set and the
 * variant the checklist belongs to, so the operator always knows which set
 * the dialog is tidying. Each part is skipped when it is missing or blank,
 * and with none known (the chain still loading) the title stays
 * `WIZARD_TITLE`. A set whose own name already opens with the year ("2024
 * Topps Chrome") does not get the year twice. Display only: nothing reads
 * this string back.
 */
export function tidyUpTitle({
  year,
  setName,
  variant,
}: {
  year?: string | null;
  setName?: string | null;
  variant?: string | null;
}): string {
  const yearText = year?.trim() ?? "";
  const setText = setName?.trim() ?? "";
  const parts = [startsWithToken(setText, yearText) ? "" : yearText, setText, variant?.trim() ?? ""]
    .filter((part) => part !== "");
  return parts.length > 0 ? `Tidy up ${parts.join(" ")}` : WIZARD_TITLE;
}

/** The levels a checklist leaf can sit at below its set. */
const VARIANT_LEVELS: ReadonlySet<string> = new Set(["variantType", "insert", "parallel"]);

/**
 * The variant words for a leaf. A `parallel`-level row only ever sits under
 * an `insert`-level row (NEO-334: sub-variants live under Insert types; a
 * parallel of base is itself an `insert`-level row under the "Parallel"
 * type), and on its own "Gold" does not say WHICH insert's Gold. So a
 * parallel leaf is named after its insert first ("Future Stars Gold"),
 * unless its own name already opens with the insert's ("Unleashed Blue Ice"
 * under "Unleashed"). The `variantType` row ("Insert", "Parallel") is never
 * part of the name.
 */
function variantTitle(
  chain: ReadonlyArray<{ level: string; value: string }>,
): string | undefined {
  const leaf = chain.at(-1);
  if (!leaf || !VARIANT_LEVELS.has(leaf.level)) return undefined;
  const leafText = leaf.value.trim();
  if (leaf.level !== "parallel") return leafText;
  let insertText = "";
  for (let i = chain.length - 2; i >= 0; i--) {
    if (chain[i].level === "insert") {
      insertText = chain[i].value.trim();
      break;
    }
  }
  if (insertText === "" || startsWithToken(leafText, insertText)) return leafText;
  return leafText === "" ? insertText : `${insertText} ${leafText}`;
}

/**
 * `tidyUpTitle` read off a `getAncestorChain` result, which runs root first
 * and INCLUDES the leaf itself. The year and set come from their own levels
 * (the set is the `setName` row, not the manufacturer); the variant is the
 * leaf's own value (`variantTitle`: a parallel carries its insert's name),
 * and only when the leaf sits below the set, so a chain that ends at the set
 * never names it twice. Undefined (loading) gives `WIZARD_TITLE`.
 */
export function tidyUpTitleFromChain(
  chain: ReadonlyArray<{ level: string; value: string }> | null | undefined,
): string {
  if (!chain) return WIZARD_TITLE;
  return tidyUpTitle({
    year: chain.find((row) => row.level === "year")?.value,
    setName: chain.find((row) => row.level === "setName")?.value,
    variant: variantTitle(chain),
  });
}

export interface WizardChromeProps {
  /** 1-based step on screen. */
  step: number;
  /** Steps in this sitting. 0 hides the counter and empties the rail. */
  total: number;
  /** The screen type — "New team", "Cards with no team", "Ready to save". */
  subtitle: string;
  /** "Tidy up 2024 Topps Chrome Base" (`tidyUpTitle`); defaults to `WIZARD_TITLE`. */
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
        {/* The title's line count depends on the title alone, so the header
            never changes height between steps (a11y audit): below `sm` the
            title has the whole row and the counter drops to its own line;
            from `sm` up they share the row, and the counter's width is
            constant (sized for "Step 99 of 99"), so "Step 9" turning into
            "Step 10" never re-wraps the title. */}
        <div className="flex flex-wrap items-baseline justify-between gap-x-4">
          {/* A long set name wraps in balanced lines; `wrap-anywhere` breaks
              a single unbroken word. Past three lines it is clamped VISUALLY
              only: the text stays whole, so the heading's accessible name
              (and the dialog's, through `aria-labelledby`) is the full title,
              and `title` shows it on hover. */}
          <h2
            id={titleId}
            title={title}
            className="min-w-0 basis-full text-lg font-semibold text-ink text-balance wrap-anywhere line-clamp-3 sm:basis-auto sm:flex-1"
          >
            {title}
          </h2>
          {/* Always mounted, so the first step is announced as reliably as
              the rest. Empty while there is no count to give; `min-h-5`
              keeps its line when it is. */}
          <p
            role="status"
            className="ml-auto min-h-5 shrink-0 whitespace-nowrap text-right text-sm tabular-nums text-ink-2 sm:min-w-[6.5rem]"
          >
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
