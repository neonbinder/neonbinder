import {
  useEffect,
  useRef,
  type ComponentType,
  type SVGProps,
} from "react";
import {
  ArrowPathIcon,
  CheckIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  MinusCircleIcon,
  NoSymbolIcon,
  StopCircleIcon,
} from "@heroicons/react/24/outline";

/**
 * The run ledger — the spinner → check pattern NEO-312 built for the parallel
 * build (`ParallelBuildPanel`) and Jason approved for any multi-item run:
 * one line per item, a glyph per state, a strip of card-shaped sleeves that
 * fills like a binder page, and ONE polite live line that speaks the run
 * without reading every step aloud.
 *
 * Extracted on its second use (NEO-325: the Reconcile dialog's check of each
 * pending parallel against the saved Base). The parallel build's markup is
 * byte-identical through these pieces; a caller on another surface passes its
 * own tones (the Reconcile dialog is always dark, and the defaults below are
 * the light/dark pairs of the blue banner the build panel sits in).
 */

/** Every state a ledger line can be in. The parallel build uses all eight. */
export type RunLineKind =
  | "waiting"
  | "building"
  | "built"
  | "skipped"
  | "blocked"
  | "stopped"
  | "failed"
  | "unfinished";

type HeroIcon = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * Each state's glyph and colour. The glyph is `aria-hidden`: the line's text
 * says the state in words, so colour and shape are never the only signal
 * (SC 1.4.1). Colours are the `-700` / `-300` pairs this file's banner family
 * already clears 4.5:1 with on `blue-100` and `blue-900/30`-over-`gray-800`.
 */
export const RUN_GLYPH: Record<RunLineKind, { icon: HeroIcon; tone: string }> = {
  waiting: { icon: ClockIcon, tone: "text-blue-700 dark:text-blue-300" },
  building: {
    icon: ArrowPathIcon,
    tone: "text-blue-700 dark:text-[#00C2FF] motion-safe:animate-spin",
  },
  built: { icon: CheckIcon, tone: "text-green-700 dark:text-[#00D558]" },
  skipped: { icon: MinusCircleIcon, tone: "text-blue-700 dark:text-blue-300" },
  blocked: { icon: NoSymbolIcon, tone: "text-amber-700 dark:text-amber-300" },
  stopped: { icon: StopCircleIcon, tone: "text-blue-700 dark:text-blue-300" },
  failed: {
    icon: ExclamationTriangleIcon,
    tone: "text-pink-700 dark:text-pink-300",
  },
  unfinished: { icon: ClockIcon, tone: "text-amber-700 dark:text-amber-300" },
};

/**
 * One line's glyph. `tones` replaces the colour only — the shape is the
 * state, everywhere — for a surface that is not the blue banner.
 */
export function RunGlyph({
  kind,
  tones,
}: {
  kind: RunLineKind;
  tones?: Record<RunLineKind, string>;
}) {
  const glyph = RUN_GLYPH[kind];
  const Icon = glyph.icon;
  const tone = tones ? tones[kind] : glyph.tone;
  return (
    <Icon
      aria-hidden="true"
      className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`}
    />
  );
}

/**
 * The sleeve strip — one card-shaped slot per item, filling like a binder
 * page as each one lands. Decorative (the ledger says everything in words),
 * so the whole strip is `aria-hidden`; a slot's `title` repeats its line for
 * a pointer. The Base-parallels section's pre-run strip (NEO-321) draws the
 * same sleeves the run then fills.
 */
export const SLEEVE_TONE: Record<RunLineKind, string> = {
  waiting: "border-blue-400 dark:border-blue-500 bg-transparent",
  building: "border-[#00C2FF] bg-[#00C2FF]/40 motion-safe:animate-pulse",
  built: "border-green-700 dark:border-[#00D558] bg-[#00D558]",
  skipped: "border-blue-300 dark:border-blue-700 bg-blue-300/40 dark:bg-blue-700/40",
  blocked: "border-amber-700 dark:border-amber-400 bg-amber-400",
  stopped: "border-blue-300 dark:border-blue-700 bg-blue-300/40 dark:bg-blue-700/40",
  failed: "border-pink-700 dark:border-pink-400 bg-[#FF2E9A]",
  unfinished: "border-amber-700 dark:border-amber-400 bg-transparent",
};

export type SleeveItem = { key: string; kind: RunLineKind; title: string };

/**
 * The strip itself. `more` (optional) is a count of items past what the
 * caller drew, shown as a quiet "+N" after the last sleeve — still inside the
 * `aria-hidden` strip, because the caller's own counter says it in words.
 */
export function SleeveStrip({
  items,
  tones = SLEEVE_TONE,
  more = 0,
  moreClassName,
}: {
  items: readonly SleeveItem[];
  tones?: Record<RunLineKind, string>;
  more?: number;
  moreClassName?: string;
}) {
  return (
    <div aria-hidden="true" className="mt-2 flex flex-wrap gap-1">
      {items.map((item) => (
        <span
          key={item.key}
          title={item.title}
          className={`h-3.5 w-2.5 rounded-[2px] border ${tones[item.kind]}`}
        />
      ))}
      {more > 0 && (
        <span className={moreClassName ?? "text-[10px] leading-[14px]"}>
          +{more}
        </span>
      )}
    </div>
  );
}

/**
 * The one live line, POLITE for everything it says.
 *
 * a11y (NEO-321 audit) — it must be EMPTY when it enters the tree: a screen
 * reader registers a live region on insertion and speaks only later CHANGES,
 * so a region that mounts already holding text says nothing. React renders
 * the node with no children and the effect writes the text after the commit —
 * on mount that is the change that gets spoken, and every later text is a
 * change too. The node's text is owned here, never by React, so the two
 * cannot fight over it.
 */
export function LiveLine({ text }: { text: string }) {
  const liveRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (liveRef.current) liveRef.current.textContent = text;
  }, [text]);
  return <p ref={liveRef} className="sr-only" role="status" />;
}

/** The live line's periodic pulse on a large run: "12 of 40 done". */
export function pulseText(done: number, total: number): string {
  return `${done} of ${total} done`;
}
