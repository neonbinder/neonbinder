import { useCallback, useState } from "react";

/**
 * NEO-224 — the keyboard cursor of a combobox: which option Enter would pick.
 *
 * Extracted from the ArrowDown cursor `TeamPicker` and `PlayerPicker` each
 * carry (`highlightIdx`, reset to 0 whenever the query changes, clamped at both
 * ends). Those two still run their own copy; the Set Builder's columns are the
 * first adopter.
 *
 * ## Keyed, not indexed
 *
 * The cursor is an option KEY (a row id), not a position, so it survives the
 * list re-ordering or a reactive query re-emitting the same rows as a new
 * array. A position would silently land on a different row.
 *
 * ## Derived, with no effect
 *
 * The highlight is the caller's `seed` until the operator presses an arrow,
 * and the arrow move is remembered only for the `seedOn` value it was made
 * under. So changing `seedOn` (a new filter, the list being shown again)
 * discards the move and the highlight falls back to the new seed in the same
 * render, with no `setState` in an effect and no one-frame flash of the stale
 * row. A remembered key that has left `keys` (its row was deleted, or filtered
 * out) also falls back to the seed rather than pointing at nothing.
 *
 * ## What the caller owns
 *
 * - `keys`: every option, in display order.
 * - `seed`: where the cursor rests before any arrow press — `null` for none
 *   (no option matches), in which case Enter must do nothing.
 * - `seedOn`: a string that changes exactly when the cursor should re-seed.
 *
 * Up/Down never wrap: running off the end and reappearing at the top reads as
 * a dropped keypress (the APG's default for a listbox). From no highlight,
 * Down lands on the first option and Up on the last.
 */
export type ComboboxHighlight = {
  /** The highlighted option's key, or null when nothing is highlighted. */
  highlighted: string | null;
  /**
   * Move the cursor one option. Returns the key it lands on (unchanged at
   * either end), or null when there are no options.
   */
  move: (delta: 1 | -1) => string | null;
};

export function useComboboxHighlight({
  keys,
  seed,
  seedOn,
}: {
  keys: readonly string[];
  seed: string | null;
  seedOn: string;
}): ComboboxHighlight {
  const [moved, setMoved] = useState<{ key: string; seedOn: string } | null>(
    null,
  );

  const seeded = seed !== null && keys.includes(seed) ? seed : null;
  const highlighted =
    moved && moved.seedOn === seedOn && keys.includes(moved.key)
      ? moved.key
      : seeded;

  const move = useCallback(
    (delta: 1 | -1): string | null => {
      if (keys.length === 0) return null;
      const from = highlighted === null ? -1 : keys.indexOf(highlighted);
      let to: number;
      if (from < 0) {
        to = delta === 1 ? 0 : keys.length - 1;
      } else {
        to = Math.max(0, Math.min(keys.length - 1, from + delta));
      }
      const key = keys[to];
      setMoved({ key, seedOn });
      return key;
    },
    [keys, highlighted, seedOn],
  );

  return { highlighted, move };
}
