import { useId, useMemo, useState } from "react";
import { ChevronRightIcon, TagIcon } from "@heroicons/react/24/outline";
import { Link } from "react-router";
import NeonButton from "@/components/modules/NeonButton";
import { FOCUS } from "../../../prototypes/p1/ui";
import { useListing, writeErrorMessage, type ListingExtension } from "../../data/store";
import type { Card, CardId, ListingPlatformSettings, ListingRun, VariantId, VariantListingStatus } from "../../data/types";
import { usePageApi } from "../../pageApi";
import { BSC_NAME, BSC_SHORT, CREDENTIALS_PATH, problemCardName, problemSentence, whenSynced } from "./copy";
import ListingSwitch from "./ListingSwitch";

/**
 * NEO-370 — a checklist's BuySportsCards listing, under its common price on
 * the inventory side. NB is the only truth: BSC shows NB's box count, so the
 * panel only reports how the last push went and offers Resync. Nothing here
 * edits a listing by hand.
 *
 *   - listing off: the "List on BuySportsCards" switch, in its short form;
 *   - on: one status line (how many are listed, when it last synced,
 *     "Syncing soon" while a change waits, or what went wrong), Resync, and
 *     "Can't list on BSC (M)", a disclosure naming each card held back and why.
 *
 * Hidden entirely in a store with no listing (the demo).
 */
export default function ListingPanel(props: { variantId: VariantId; title: string; cards: Card[] | undefined }) {
  const listing = useListing();
  if (!listing) return null;
  return <Panel listing={listing} {...props} />;
}

function Panel({
  listing,
  variantId,
  title,
  cards,
}: {
  listing: ListingExtension;
  variantId: VariantId;
  title: string;
  cards: Card[] | undefined;
}) {
  const settings = listing.useSettings()?.bsc;
  const status = listing.useVariantStatus(settings?.enabled ? variantId : null);

  if (!settings) return <p className="h-5 text-sm text-ink-3">Checking {BSC_NAME}…</p>;

  return (
    <div role="group" aria-label={`${BSC_NAME} listing`} className="space-y-2 border-t border-rule pt-2">
      {settings.enabled ? (
        <Listed
          listing={listing}
          settings={settings}
          status={status}
          variantId={variantId}
          title={title}
          cards={cards}
        />
      ) : (
        <ListingSwitch listing={listing} settings={settings} compact />
      )}
    </div>
  );
}

/** What the status line says about a checklist that lists on BSC. */
export function statusLine(
  settings: Pick<ListingPlatformSettings, "paused" | "needsReauth">,
  status: VariantListingStatus,
  now: number = Date.now(),
): string {
  const { run, pending } = status;
  const soon = pending && run?.status !== "running" ? " Syncing soon." : "";
  if (settings.paused) return `${BSC_NAME} is on a break. Changes wait here and go up when it's back.`;
  if (!run) {
    return pending
      ? `Going up to ${BSC_NAME} in about a minute.`
      : `Not on ${BSC_NAME} yet. Resync sends this checklist up.`;
  }
  if (run.status === "running") return `Syncing with ${BSC_NAME} now…`;
  if (run.status === "error") {
    const when = run.lastRunAt ? ` (${whenSynced(run.lastRunAt, now)})` : "";
    return `The last sync hit a snag${when}: ${run.lastError ?? `${BSC_NAME} didn't answer`}. Resync to try again.${soon}`;
  }
  const listed = run.listed ?? 0;
  const head = `${listed} listed on ${BSC_NAME}.`;
  const synced = run.lastSuccessAt
    ? ` Synced ${whenSynced(run.lastSuccessAt, now)}.`
    : run.lastRunAt
      ? ` Last sent ${whenSynced(run.lastRunAt, now)}.`
      : "";
  return `${head}${synced}${soon}`;
}

function Listed({
  listing,
  settings,
  status,
  variantId,
  title,
  cards,
}: {
  listing: ListingExtension;
  settings: ListingPlatformSettings;
  status: VariantListingStatus | undefined;
  variantId: VariantId;
  title: string;
  cards: Card[] | undefined;
}) {
  const api = usePageApi();
  const [busy, setBusy] = useState(false);
  const running = status?.run?.status === "running";
  const blocked = settings.paused || settings.needsReauth;

  const resync = () => {
    if (busy || running || blocked) return;
    setBusy(true);
    listing
      .resyncVariant(variantId)
      .then(
        (queued) =>
          api.notify(
            queued > 0
              ? `Resyncing ${title} with ${BSC_NAME}. It goes up in about a minute.`
              : `Nothing in ${title} can go to ${BSC_NAME} yet.`,
          ),
        (error: unknown) => api.notify(writeErrorMessage(error)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p role="status" className="flex min-w-0 flex-1 items-start gap-1.5 text-sm text-ink-2">
          <TagIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-neon-yellow-text" />
          <span className="min-w-0">{status ? statusLine(settings, status) : `Checking ${BSC_NAME}…`}</span>
        </p>
        <NeonButton
          type="button"
          size="1"
          variant="secondary"
          outline
          onClick={resync}
          disabled={busy || running || blocked || status === undefined}
          aria-label={`Resync ${title} with ${BSC_NAME}`}
          className={`${FOCUS} max-sm:min-h-11`}
        >
          {busy ? "Resyncing…" : "Resync"}
        </NeonButton>
      </div>
      {settings.needsReauth && (
        <p className="text-sm text-neon-yellow-text">
          Your {BSC_NAME} sign-in ran out, so nothing can go up.{" "}
          <Link to={CREDENTIALS_PATH} className="rounded-sm font-medium text-neon-blue-text underline focus-outline">
            Sign in to {BSC_NAME} again
          </Link>
        </p>
      )}
      {status?.run && status.run.problemsTotal > 0 && <Problems run={status.run} cards={cards} />}
    </>
  );
}

/** "Can't list on BSC (M)": each card held back, by number and player, and why. */
function Problems({ run, cards }: { run: ListingRun; cards: Card[] | undefined }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const byId = useMemo(() => new Map<CardId, Card>((cards ?? []).map((c) => [c.id, c])), [cards]);
  const total = run.problemsTotal;
  return (
    <div className="space-y-1.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex min-h-6 items-center gap-1 rounded text-sm font-medium text-neon-yellow-text hover:underline max-sm:min-h-11 ${FOCUS}`}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={`h-4 w-4 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
        Can&apos;t list on {BSC_SHORT} ({total})
      </button>
      <div id={listId} hidden={!open}>
        <ul className="space-y-1.5 border-l-2 border-neon-yellow-text/60 pl-3">
          {run.problems.map((problem, i) => (
            <li key={`${problem.cardId ?? problem.platformCardId ?? "row"}-${problem.reason}-${i}`} className="text-sm">
              <span className="font-semibold text-ink">
                {problemCardName(problem, problem.cardId ? byId.get(problem.cardId) : undefined)}
              </span>
              <span className="text-ink-2"> {problemSentence(problem)}</span>
            </li>
          ))}
        </ul>
        {total > run.problems.length && (
          <p className="mt-1.5 pl-3 text-xs text-ink-3">
            Showing the first {run.problems.length} of {total}. Fix these and Resync to see the rest.
          </p>
        )}
      </div>
    </div>
  );
}
