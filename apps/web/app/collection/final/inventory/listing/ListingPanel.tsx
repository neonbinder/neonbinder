import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, TagIcon } from "@heroicons/react/24/outline";
import { Link } from "react-router";
import NeonButton from "@/components/modules/NeonButton";
import { FOCUS } from "../../../prototypes/p1/ui";
import { useListing, writeErrorMessage, type ListingExtension } from "../../data/store";
import type { Card, CardId, ListingPlatformSettings, ListingProblem, VariantId, VariantListingStatus } from "../../data/types";
import { usePageApi } from "../../pageApi";
import {
  BSC_NAME,
  CREDENTIALS_PATH,
  SELLER_CONFLICT_LINE,
  WHEN_IT_GOES_UP,
  problemCardName,
  problemSentence,
  whenSynced,
} from "./copy";
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
 *     "Can't list on BuySportsCards (M)", a disclosure naming each card held
 *     back and why.
 *
 * Leaving the checklist sends the collector's waiting changes up
 * (`useFlushOnLeave`), so they need not wait out the 15-minute sweep.
 *
 * Hidden entirely in a store with no listing (the demo).
 */
export default function ListingPanel(props: { variantId: VariantId; title: string; cards: Card[] | undefined }) {
  const listing = useListing();
  if (!listing) return null;
  return <Panel listing={listing} {...props} />;
}

/** Marks the Resync button (`data-listing-resync`), so focus can be parked on it without an id. */
const RESYNC_MARK = "data-listing-resync";

/** True when focus has fallen out of the page (its control was swapped out). */
function focusLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body;
}

/**
 * Send the collector's waiting changes up as they leave this checklist:
 * when it unmounts or swaps to another checklist, and (best effort) when the
 * tab is hidden or the page goes away. Once per leave: a hide, then the tab
 * closing, is one leave; coming back to the tab starts a new one. Only while
 * listing is on (read at leave time). React's development double mount is
 * not a leave: the deferred call is cancelled when the same checklist mounts
 * straight back.
 */
export function useFlushOnLeave(listing: ListingExtension, enabled: boolean, variantId: VariantId): void {
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  const deferred = useRef<{ variantId: VariantId; timer: ReturnType<typeof setTimeout> } | null>(null);

  useEffect(() => {
    if (deferred.current?.variantId === variantId) {
      clearTimeout(deferred.current.timer);
      deferred.current = null;
    }
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      if (!enabledRef.current) return;
      // Best effort: the 15-minute sweep sends anything this misses.
      listing.flushListing().catch(() => {});
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") leave();
      else left = false;
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", leave);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", leave);
      const timer = setTimeout(() => {
        if (deferred.current?.timer === timer) deferred.current = null;
        leave();
      }, 0);
      deferred.current = { variantId, timer };
    };
  }, [listing, variantId]);
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
  const enabled = settings?.enabled;
  useFlushOnLeave(listing, enabled === true, variantId);

  // Switching on swaps the switch out for the status line and Resync (and a
  // switch-off elsewhere swaps them back). Focus on the control that went
  // would fall to the page: park it on Resync, else on this group.
  const groupRef = useRef<HTMLDivElement>(null);
  const seenEnabled = useRef(enabled);
  useEffect(() => {
    const was = seenEnabled.current;
    seenEnabled.current = enabled;
    if (was === undefined || enabled === undefined || was === enabled || !focusLost()) return;
    const group = groupRef.current;
    if (!group) return;
    (group.querySelector<HTMLElement>(`[${RESYNC_MARK}]`) ?? group).focus();
  }, [enabled]);

  if (!settings) return <p className="h-5 text-sm text-ink-3">Checking {BSC_NAME}…</p>;

  return (
    <div
      ref={groupRef}
      role="group"
      aria-label={`${BSC_NAME} listing`}
      tabIndex={-1}
      className={`space-y-2 rounded-sm border-t border-rule pt-2 ${FOCUS}`}
    >
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

/** What the status line says about a checklist that lists on BSC. It carries the timing; toasts only confirm. */
export function statusLine(
  settings: Pick<ListingPlatformSettings, "paused" | "needsReauth"> & Partial<Pick<ListingPlatformSettings, "sellerConflict">>,
  status: VariantListingStatus,
  now: number = Date.now(),
): string {
  const { run, pending } = status;
  if (settings.sellerConflict) return SELLER_CONFLICT_LINE;
  if (settings.paused) return `${BSC_NAME} is on a break. Changes wait here and go up when it's back.`;
  // A dead sign-in sends nothing: never promise "soon" then.
  const soon =
    pending && run?.status !== "running"
      ? settings.needsReauth
        ? " Changes wait for your sign-in."
        : ` Syncing soon, ${WHEN_IT_GOES_UP}.`
      : "";
  if (!run) {
    if (!pending) return `Not on ${BSC_NAME} yet. Resync sends this checklist up.`;
    return settings.needsReauth
      ? `Waiting on your ${BSC_NAME} sign-in to go up.`
      : `Going up to ${BSC_NAME} ${WHEN_IT_GOES_UP}.`;
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
  const [problemsOpen, setProblemsOpen] = useState(false);
  const resyncRef = useRef<HTMLButtonElement>(null);
  const statusId = useId();
  const reauthId = useId();
  const running = status?.run?.status === "running";
  const blocked = settings.paused || settings.needsReauth || settings.sellerConflict;
  const working = busy || running;
  // aria-disabled, never native disabled: Resync keeps focus through a run,
  // and its description (the status line) stays reachable.
  const inert = working || blocked || status === undefined;

  // Belt and braces: had Resync the focus when a run began and the page lost
  // it meanwhile, hand it back when the run ends.
  const focusedAtStart = useRef(false);
  useEffect(() => {
    if (working) {
      focusedAtStart.current = document.activeElement === resyncRef.current;
      return;
    }
    if (focusedAtStart.current && focusLost()) resyncRef.current?.focus();
    focusedAtStart.current = false;
  }, [working]);

  const resync = () => {
    if (inert) return;
    setBusy(true);
    listing
      .resyncVariant(variantId)
      .then(
        ({ queued, ignored }) =>
          api.notify(
            ignored
              ? `Hang on: ${title} is syncing with ${BSC_NAME} or just did. Try again in a minute.`
              : queued > 0
                ? `Resyncing ${title} with ${BSC_NAME}.`
                : `Nothing in ${title} can go to ${BSC_NAME} yet.`,
          ),
        (error: unknown) => api.notify(writeErrorMessage(error)),
      )
      .finally(() => setBusy(false));
  };

  const problems = status?.run?.problems ?? [];
  const total = status?.run?.problemsTotal ?? 0;
  const toggleProblems = () => {
    // Open on an empty list (it emptied while open): closing it would take
    // the button with it, so park focus on Resync first.
    if (problemsOpen && total === 0) {
      setProblemsOpen(false);
      resyncRef.current?.focus();
      return;
    }
    setProblemsOpen((o) => !o);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p id={statusId} role="status" className="flex min-w-0 flex-1 items-start gap-1.5 text-sm text-ink-2">
          <TagIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-neon-yellow-text" />
          <span className="min-w-0">{status ? statusLine(settings, status) : `Checking ${BSC_NAME}…`}</span>
        </p>
        <NeonButton
          ref={resyncRef}
          type="button"
          size="1"
          variant="secondary"
          outline
          onClick={resync}
          aria-disabled={inert || undefined}
          aria-busy={working || undefined}
          aria-label={`Resync ${title} with ${BSC_NAME}`}
          aria-describedby={settings.needsReauth ? `${statusId} ${reauthId}` : statusId}
          data-listing-resync=""
          className={`${FOCUS} max-sm:min-h-11`}
        >
          Resync
        </NeonButton>
      </div>
      {settings.needsReauth && (
        <p id={reauthId} className="text-sm text-neon-yellow-text">
          Your {BSC_NAME} sign-in ran out, so nothing can go up.{" "}
          <Link to={CREDENTIALS_PATH} className="rounded-sm font-medium text-neon-blue-text underline focus-outline">
            Sign in to {BSC_NAME} again
          </Link>
        </p>
      )}
      {(total > 0 || problemsOpen) && (
        <Problems
          problems={problems}
          total={total}
          open={problemsOpen}
          onToggle={toggleProblems}
          cards={cards}
        />
      )}
    </>
  );
}

/** "Can't list on BuySportsCards (M)": each card held back, by number and player, and why. */
function Problems({
  problems,
  total,
  open,
  onToggle,
  cards,
}: {
  problems: ListingProblem[];
  total: number;
  open: boolean;
  onToggle: () => void;
  cards: Card[] | undefined;
}) {
  const listId = useId();
  const byId = useMemo(() => new Map<CardId, Card>((cards ?? []).map((c) => [c.id, c])), [cards]);
  return (
    <div className="space-y-1.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={onToggle}
        className={`inline-flex min-h-6 items-center gap-1 rounded text-sm font-medium text-neon-yellow-text hover:underline max-sm:min-h-11 ${FOCUS}`}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={`h-4 w-4 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
        Can&apos;t list on {BSC_NAME} ({total})
      </button>
      <div id={listId} hidden={!open}>
        {total === 0 ? (
          <p className="border-l-2 border-neon-green-text/60 pl-3 text-sm text-ink-2">
            All clear. Nothing&apos;s held back now.
          </p>
        ) : (
          <ul className="space-y-1.5 border-l-2 border-neon-yellow-text/60 pl-3">
            {problems.map((problem, i) => (
              <li key={`${problem.cardId ?? "unmatched"}-${problem.reason}-${i}`} className="text-sm">
                <span className="font-semibold text-ink">
                  {problemCardName(problem, problem.cardId ? byId.get(problem.cardId) : undefined)}
                </span>
                <span className="text-ink-2"> {problemSentence(problem)}</span>
              </li>
            ))}
          </ul>
        )}
        {total > problems.length && (
          <p className="mt-1.5 pl-3 text-xs text-ink-3">
            Showing the first {problems.length} of {total}. Fix these and Resync to see the rest.
          </p>
        )}
      </div>
    </div>
  );
}
