import { useId, useState } from "react";
import { Link } from "react-router";
import { writeErrorMessage, type ListingExtension } from "../../data/store";
import type { ListingPlatformSettings } from "../../data/types";
import { usePageApi } from "../../pageApi";
import { BSC_NAME, CREDENTIALS_PATH } from "./copy";

/**
 * NEO-370 — "List on BuySportsCards": the collector's own switch, off until
 * they turn it on. On, every card in their boxes goes up at its box count
 * and keeps in step as the boxes change; sales come back to the Sales tab.
 * Off stops the updates and leaves what BSC already shows alone (the note
 * says so before they flip it).
 *
 * A native checkbox with `role="switch"`: Space flips it, and the label is
 * its name. With no saved BSC sign-in it is disabled and points at Profile;
 * a sign-in that ran out, or BSC paused for everyone, is said beside it.
 */
export default function ListingSwitch({
  listing,
  settings,
  compact = false,
}: {
  listing: ListingExtension;
  settings: ListingPlatformSettings;
  /** The checklist panel's one-line form: no long description. */
  compact?: boolean;
}) {
  const api = usePageApi();
  const [busy, setBusy] = useState(false);
  const noteId = useId();
  const on = settings.enabled;
  const disabled = busy || (!on && !settings.connected);

  const flip = () => {
    if (disabled) return;
    const next = !on;
    setBusy(true);
    listing
      .setEnabled("bsc", next)
      .then(
        () =>
          api.notify(
            next
              ? `Listing on ${BSC_NAME} is on. Your boxes go up in about a minute.`
              : `Listing on ${BSC_NAME} is off. Anything already up there stays put.`,
          ),
        (error: unknown) => api.notify(writeErrorMessage(error)),
      )
      .finally(() => setBusy(false));
  };

  const note = !settings.connected
    ? null
    : settings.paused
      ? `${BSC_NAME} is on a break. Your changes wait here and go up when it's back.`
      : compact
        ? null
        : on
          ? `Your box counts go up about a minute after you change them, and sales land in Sales. Switching off stops the updates; anything already on ${BSC_NAME} stays there.`
          : `Every card in your boxes lists at its box count, priced at its minimum or the checklist's common price.`;

  return (
    <div className="space-y-1.5">
      <label className="inline-flex cursor-pointer items-center gap-3 has-[:disabled]:cursor-not-allowed">
        <span className="relative inline-flex shrink-0">
          <input
            type="checkbox"
            role="switch"
            className="peer sr-only"
            checked={on}
            disabled={disabled}
            aria-describedby={note || !settings.connected || settings.needsReauth ? noteId : undefined}
            onChange={flip}
          />
          <span
            aria-hidden="true"
            className={`flex h-6 w-11 items-center rounded-full border transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus peer-disabled:opacity-50 ${
              on ? "border-neon-yellow-text bg-neon-yellow" : "border-control bg-control"
            }`}
          >
            <span
              className={`h-5 w-5 rounded-full border border-rule-strong bg-raised shadow transition-transform motion-reduce:transition-none ${
                on ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </span>
        </span>
        <span className="text-sm font-medium text-ink">List on {BSC_NAME}</span>
      </label>
      <div id={noteId} className="space-y-1 text-sm text-ink-2">
        {!settings.connected ? (
          <p>
            Save your {BSC_NAME} sign-in first.{" "}
            <Link to={CREDENTIALS_PATH} className="rounded-sm font-medium text-neon-blue-text underline focus-outline">
              Connect {BSC_NAME} on your Profile
            </Link>
          </p>
        ) : (
          settings.needsReauth && (
            <p className="text-neon-yellow-text">
              Your {BSC_NAME} sign-in ran out, so nothing can go up.{" "}
              <Link to={CREDENTIALS_PATH} className="rounded-sm font-medium text-neon-blue-text underline focus-outline">
                Sign in to {BSC_NAME} again
              </Link>
            </p>
          )
        )}
        {note && <p className={settings.paused ? "text-neon-yellow-text" : undefined}>{note}</p>}
      </div>
    </div>
  );
}
