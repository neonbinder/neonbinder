import { CARD_NOTES_MAX } from "../../convex/cardNotes";

/**
 * NEO-367 — the Notes box's live length, so the cap is never a surprise. Over
 * the cap (the drawer lets an admin type past it; the server refuses) the
 * count turns the negative role and says so in words, not colour alone.
 */
export function NotesLengthMeter({ length }: { length: number }) {
  const over = length > CARD_NOTES_MAX;
  return (
    <span className={`tabular-nums normal-case ${over ? "text-neon-pink-text" : "text-ink-3"}`}>
      {length}/{CARD_NOTES_MAX}
      {over ? " · too long" : ""}
    </span>
  );
}
