import {
  ClipboardDocumentCheckIcon,
  ClipboardDocumentIcon,
} from "@heroicons/react/24/outline";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

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

/**
 * The app's ONE clipboard affordance: a Copy control plus the live region that
 * says what happened. Two presentations, one implementation.
 *
 * Extracted from TrackingCode in NEO-121, when the public scan-page link became
 * a second thing a seller copies off Label History. NEO-212 (audit finding G10)
 * needed a copy control beside entity names in the review wizard and in
 * PlayerManagement, briefly shipped a second component for it, and folded it
 * back in here — because the interesting part has never been `writeText`, it is
 * the *denied* branch, and a second implementation is a second chance to ship
 * the happy path only. Clipboard access can be refused (permissions policy, an
 * iframe, an insecure context) and it refuses silently, so every caller has to
 * be able to tell the user what to do instead. That is why this is shared code
 * rather than a four-line hook each caller re-implements — and why there is
 * exactly one copy of it. `components/primitives/CopyButton` is a thin adapter
 * over this file that fixes `variant="icon"` and supplies the icon wording; it
 * contains no clipboard logic of its own.
 *
 * **`variant="text"` (the default)** renders a fragment of inline elements
 * (`<button>` + `<span>`) and no wrapper of its own, so a caller keeps full
 * control of its own layout and markup — TrackingCode's output is byte-for-byte
 * what it was before the extraction, and label history can drop it into a
 * `<dd>`.
 *
 * **`variant="icon"`** renders a fixed-size, icon-only button inside an
 * `inline-flex` span, so it can sit beside a name without the row reflowing
 * when the state changes: the glyph swaps, the box does not. `size="sm"` is
 * 24x24 CSS px, the WCAG 2.2 SC 2.5.8 floor; `size="md"` is 32x32 for
 * standalone use in a toolbar or card header. Being icon-only, its accessible
 * name is the only name it has, so `copyLabel` is effectively required there.
 *
 * The status span is per-control ON PURPOSE. Label History gives each row one
 * shared `role="status"` for its reprint/refresh results; routing copy results
 * there too would let a copy announcement overwrite a reprint failure. A copy
 * is a local, instant, self-explanatory outcome — it announces next to the
 * button that caused it. It is also ALWAYS MOUNTED, empty, from the first
 * render: a live region inserted at the same moment its text appears is
 * announced unreliably (notably VoiceOver).
 *
 * @param value the exact text placed on the clipboard.
 * @param copyLabel accessible name, for pages that render more than one. Without
 * it every button on a 25-row history announces as the same bare "Copy" and a
 * screen-reader user cannot tell which one they are about to press. The icon
 * variant has no visible text at all, so there it is the only name.
 * @param copiedMessage what to announce on success — name the thing copied, not
 * "Copied.", so it still means something read out of context.
 * @param failedMessage what to announce when the clipboard refused. It must name
 * the manual fallback (select the text, open the link), because the user has
 * no other way to learn the press did nothing.
 * @param children the text variant's visible label; ignored by the icon variant.
 * @param size icon variant only: `sm` (default) 24x24, `md` 32x32.
 * @param className icon variant only: extra classes on the wrapper span.
 */
export default function CopyButton({
  value,
  copyLabel,
  copiedMessage,
  failedMessage,
  children = "Copy",
  variant = "text",
  size = "sm",
  className = "",
}: {
  value: string;
  copyLabel?: string;
  copiedMessage: string;
  failedMessage: string;
  children?: ReactNode;
  variant?: "text" | "icon";
  size?: "sm" | "md";
  className?: string;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clearing on unmount matters more than usual for the icon variant: its
  // common host is a dialog, and dismissing it right after a copy would
  // otherwise leave a pending setState pointed at a gone component.
  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    [],
  );

  const settle = useCallback(
    (next: "copied" | "failed") => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
      setCopyState(next);

      // Only the icon variant reverts. There, the check mark is the
      // confirmation and a stale "Copied" is noise — success clears fast
      // (2s), while failure holds far longer (8s) ON PURPOSE, because its
      // text is an *instruction* the user has to act on and an instruction
      // that disappears in two seconds cannot be followed. The text variant
      // has no glyph: its status span IS the whole confirmation, it is placed
      // where it does not reflow anything, and NEO-121 deliberately leaves it
      // standing until the next press.
      if (variant !== "icon") return;
      resetTimer.current = setTimeout(
        () => setCopyState("idle"),
        next === "copied" ? COPIED_RESET_MS : FAILED_RESET_MS,
      );
    },
    [variant],
  );

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      settle("copied");
    } catch {
      // Denied (permissions policy, iframe, or an insecure context). Say so —
      // the alternative is a button that silently does nothing.
      settle("failed");
    }
  }, [value, settle]);

  const statusText =
    copyState === "copied"
      ? copiedMessage
      : copyState === "failed"
        ? failedMessage
        : "";

  if (variant === "icon") {
    const box = size === "md" ? "h-8 w-8" : "h-6 w-6";
    const glyph = size === "md" ? "h-5 w-5" : "h-4 w-4";
    const tone =
      copyState === "failed"
        ? "text-neon-pink hover:text-neon-pink/80"
        : "text-neon-teal hover:text-neon-teal/80";
    const Icon =
      copyState === "copied"
        ? ClipboardDocumentCheckIcon
        : ClipboardDocumentIcon;

    return (
      // `inline-flex` so the control sits on the text baseline of whatever row
      // it is dropped into rather than forcing a block of its own.
      <span className={`inline-flex items-center ${className}`.trim()}>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={copyLabel}
          className={`${box} ${tone} inline-flex shrink-0 items-center justify-center rounded-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-blue`}
        >
          {/* Both glyphs share heroicons' 24x24 box and render at one size, so
              the swap cannot change the button's width. */}
          <Icon className={glyph} aria-hidden="true" />
        </button>
        {/* One node, two presentations. Success is visually hidden — the check
            mark already said it, and an inline "Copied" would reflow the row.
            Failure is SHOWN, because its text is the recovery instruction and a
            pink icon on its own tells a sighted user nothing. Toggling the
            class rather than swapping the element keeps the region continuously
            mounted, which is the part that makes the announcement reliable. */}
        <span
          role="status"
          aria-live="polite"
          className={
            copyState === "failed" ? "ml-2 text-xs text-neon-pink" : "sr-only"
          }
        >
          {statusText}
        </span>
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copyLabel}
        // `p-2 -m-2`: grows the hit area to WCAG 2.5.8's 24px minimum without
        // shifting the layout around it.
        className="text-sm text-neon-teal hover:text-neon-teal/80 underline p-2 -m-2 focus:outline-none focus:ring-2 focus:ring-green-500 rounded-sm"
      >
        {children}
      </button>
      {/* Always mounted so the announcement is reliable: a live region
          inserted at the same moment its text appears is announced
          unreliably (notably VoiceOver). */}
      <span
        role="status"
        aria-live="polite"
        className="block text-xs text-slate-400"
      >
        {statusText}
      </span>
    </>
  );
}
