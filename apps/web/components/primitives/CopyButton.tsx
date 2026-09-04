import ModuleCopyButton from "../modules/CopyButton";

/**
 * NEO-212 (audit finding G10) — the icon presentation of the app's one
 * clipboard affordance.
 *
 * This file is an ADAPTER, not an implementation: it holds no clipboard code,
 * no timers and no live region of its own. All of that lives in
 * `components/modules/CopyButton`, which this renders with `variant="icon"`
 * and the icon wording. NEO-212 originally wrote a second, standalone copy
 * button here; two implementations of a control whose whole subtlety is the
 * *denied* branch — `navigator.clipboard.writeText` refuses silently, and a
 * from-scratch button ships the happy path only — is exactly the thing that
 * goes wrong later, so the two were merged and this became the thin shell.
 *
 * What survives is the ergonomics that make an icon-only copy button pleasant
 * to call: `label` says what the value IS and becomes the accessible name, and
 * the two announcements are supplied here rather than by every caller, because
 * for an icon button they are always the same two sentences.
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

export function CopyButton({
  value,
  label,
  className = "",
  size = "sm",
}: CopyButtonProps) {
  return (
    <ModuleCopyButton
      value={value}
      variant="icon"
      size={size}
      className={className}
      copyLabel={`Copy ${label}`}
      copiedMessage="Copied"
      // Not "select it and copy it" as a suggestion — it is the only route
      // left once the clipboard has refused, so say it as the instruction.
      failedMessage="Copy failed — select the text and copy manually"
    />
  );
}
