import { useId, useState } from "react";
import { writeErrorMessage, type ListingExtension } from "../data/store";
import type { Container } from "../data/types";

/**
 * NEO-370 Rev 4 — a box's one listing setting, "Listed on marketplaces", on
 * the open box in My Boxes. On (the default, and what an existing box reads
 * as): everything in it lists on every marketplace the collector lists on.
 * Off: in-person inventory only, every copy in it counts 0 on every
 * marketplace. Per box, never per copy: to hold one card back, move it to an
 * in-person box. Binders never show it.
 *
 * Drawn as the binder settings' checkbox row (`BinderSettingsDialog`): a
 * native checkbox, so Space flips it; "Listed on marketplaces" is its name
 * and the line under it (what on or off means) its description. It saves as it is flipped and the status line says so. While the
 * write is out the box shows the new state and ignores presses
 * (`aria-disabled`, never native `disabled`, so focus stays put); a refusal
 * puts it back and says why.
 */

const CHOICE =
  "flex cursor-pointer items-start gap-2 rounded-md border border-field-rule bg-field px-3 py-2 text-sm text-ink-2 has-[:checked]:border-selection has-[:checked]:text-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus has-[[aria-disabled=true]]:cursor-progress";

/** What the status line says once the box's setting has saved. */
export function listedToast(name: string, listed: boolean): string {
  return listed
    ? `${name} lists on your marketplaces again. Its cards go up on the next sync.`
    : `${name} is in-person only now. Its cards come off your marketplaces on the next sync.`;
}

export default function BoxListedToggle({
  box,
  listing,
  notify,
}: {
  box: Container;
  listing: ListingExtension;
  notify: (message: string) => void;
}) {
  const noteId = useId();
  const inputId = useId();
  const listed = box.listedOnMarketplaces !== false;
  // The state being saved, shown at once; cleared when the write settles.
  const [saving, setSaving] = useState<boolean | null>(null);
  const shown = saving ?? listed;

  const flip = () => {
    if (saving !== null) return;
    const next = !shown;
    setSaving(next);
    listing
      .setContainerListed(box.id, next)
      .then(
        () => notify(listedToast(box.name, next)),
        (error: unknown) => notify(writeErrorMessage(error)),
      )
      .finally(() => setSaving(null));
  };

  return (
    <div className={`${CHOICE} mb-3 max-w-xl`}>
      <input
        id={inputId}
        type="checkbox"
        className="mt-0.5 h-4 w-4 cursor-pointer accent-selection"
        checked={shown}
        aria-disabled={saving !== null || undefined}
        aria-busy={saving !== null || undefined}
        aria-describedby={noteId}
        // A press while saving must not even flicker the box.
        onClick={(e) => {
          if (saving !== null) e.preventDefault();
        }}
        onChange={flip}
      />
      <span>
        <label htmlFor={inputId} className="block cursor-pointer font-medium">
          Listed on marketplaces
        </label>
        <span id={noteId} className="block text-ink-3">
          {shown
            ? "Everything in this box lists on the marketplaces you sell on."
            : "In-person only. Nothing in this box lists online: its cards count 0 on every marketplace."}
        </span>
      </span>
    </div>
  );
}
