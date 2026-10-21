import { cloneElement, type ReactElement, type ReactNode } from "react";
import { Tooltip } from "@radix-ui/themes";
import "./id-tooltip.css";

/**
 * The "what is this, exactly?" slip on the shelf: a spine or a card thumbnail
 * whose lettering is cut short gets its full identity on hover and on
 * keyboard focus. Built on Radix Themes' Tooltip, so it opens on focus as
 * well as hover, Escape dismisses it, the pointer can move onto it without
 * it closing, and it never opens from a touch (a tap still just taps).
 *
 * It sits above its trigger with room for a spine's hover lift, so it never
 * covers the thing being pointed at. Radix animates it only under
 * `prefers-reduced-motion: no-preference`; this slip adds no motion of its own.
 *
 * Screen readers: the trigger's accessible name already carries the full
 * identity, so by default the slip is NOT wired as a description (it would
 * read everything twice). Pass `description` when the slip shows something
 * the name does not, such as a smart binder's rule: only that text is
 * announced, as the trigger's description.
 *
 * The trigger must forward refs and props (a DOM element or a component that
 * spreads them). A trigger with its own `aria-describedby` (a drag handle's
 * instructions) keeps it.
 */
export default function IdTooltip({
  content,
  description,
  children,
}: {
  content: ReactNode;
  /** The part of `content` that the trigger's accessible name lacks. */
  description?: string;
  children: ReactElement<Record<string, unknown>>;
}) {
  // Radix sets aria-describedby on the trigger while open; the child's own
  // value (explicitly undefined by default) wins the merge.
  const trigger = description
    ? children
    : cloneElement(children, { "aria-describedby": children.props["aria-describedby"] });
  return (
    <Tooltip
      content={content}
      side="top"
      sideOffset={12}
      className="nb-idtip"
      maxWidth="300px"
      aria-label={description}
    >
      {trigger}
    </Tooltip>
  );
}

/** A slip's lines: the identity first and strong, then a quieter detail line or two. */
export function IdLines({ title, lines = [] }: { title: string; lines?: (string | null | undefined)[] }) {
  return (
    <>
      <span className="nb-idtip-title">{title}</span>
      {lines.filter(Boolean).map((line) => (
        <span key={line} className="nb-idtip-line">
          {line}
        </span>
      ))}
    </>
  );
}
