import { useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { PLATFORM_NAME } from "@/lib/marketplace/listing-copy";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import RequestReview from "./RequestReview";
import SyncReportReview from "./SyncReportReview";
import { alsoReportedLine, heldBackWords, waitedFor } from "./syncReportCopy";

type Status = Doc<"cardRequests">["status"];

const FILTERS: { id: Status; label: string }[] = [
  { id: "waiting", label: "Waiting" },
  { id: "declined", label: "Not added" },
  { id: "added", label: "Added" },
];

/** `?kind=sync`: the Sync reports list in place of card and set requests. */
export const SYNC_KIND = "sync";

/** What the list shows: card and set requests by status, or open sync reports. */
type View = { kind: "requests"; status: Status } | { kind: "sync" };

function viewOf(params: URLSearchParams): View {
  if (params.get("kind") === SYNC_KIND) return { kind: "sync" };
  const status = params.get("status");
  const known = FILTERS.find((f) => f.id === status);
  return { kind: "requests", status: known ? known.id : "waiting" };
}

/** The URL for a view, with nothing open. Waiting requests is the bare page. */
function paramsOf(view: View): URLSearchParams {
  const next = new URLSearchParams();
  if (view.kind === "sync") next.set("kind", SYNC_KIND);
  else if (view.status !== "waiting") next.set("status", view.status);
  return next;
}

/** History state on an entry opened from the bare list, so "Back to the list" can step back to it. */
type OpenState = { fromList?: boolean } | null;

/**
 * /admin/card-requests — NEO-361. What collectors asked us to add: a card in
 * a set we have, or a set we don't. Pick one to review it: approve it as a
 * catalog card (one already there, or one added here), approve a set once
 * it is built in the set builder, or decline with a note the collector
 * reads. Approving moves the collector's copies onto the catalog card;
 * declining leaves the card theirs, privately.
 *
 * NEO-536 — and the held-back sets collectors reported (`?kind=sync`), one
 * row per set and platform; closing one as Fixed or Not a bug closes every
 * open report on it.
 *
 * The view lives in the URL so Back works: the filters (`?status=`,
 * `?kind=sync`) replace the entry, and opening one item (`?open=<id>`, a
 * cardRequests id, or a syncReports id under `kind=sync`) pushes one, so
 * Back returns to the list. The dashboard links straight to one item.
 *
 * The h1 lives in the section layout, so this heads its content with an h2.
 */
export default function AdminCardRequestsPage() {
  useDocumentTitle("Card Requests · Admin");
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const view = viewOf(params);
  const openId = params.get("open")?.trim() || null;
  const sync = view.kind === "sync";

  const requests = useQuery(api.collectionRequests.queue, view.kind === "requests" ? { status: view.status } : "skip");
  const reports = useQuery(api.syncReports.queue, sync ? {} : "skip");
  const queueRef = useRef<HTMLElement>(null);

  // "Back to the list": the review goes, and the keyboard goes back to the
  // queue once the URL has caught up.
  const toQueue = useRef(false);
  useEffect(() => {
    if (openId === null && toQueue.current) {
      toQueue.current = false;
      queueRef.current?.focus();
    }
  }, [openId]);

  const showView = (next: View) => setParams(paramsOf(next), { replace: true });
  const openItem = (id: string) => {
    if (id === openId) return;
    const next = new URLSearchParams(params);
    next.set("open", id);
    setParams(next, { state: { fromList: openId === null } satisfies OpenState });
  };
  const backToList = () => {
    toQueue.current = true;
    if ((location.state as OpenState)?.fromList) {
      void navigate(-1);
      return;
    }
    const next = new URLSearchParams(params);
    next.delete("open");
    setParams(next, { replace: true });
  };

  // Ages count from when the page opened; a refresh brings them up to date.
  const [now] = useState(() => Date.now());
  const itemClass = (open: boolean) =>
    `w-full rounded-md border px-3 py-2 text-left focus-outline ${
      open ? "border-neon-blue bg-raised" : "border-rule-strong hover:border-neon-blue"
    }`;
  const chipClass = (on: boolean) =>
    `min-h-11 rounded-full sm:min-h-9 border px-3 text-sm focus-outline ${
      on
        ? "border-selection bg-neon-blue text-on-neon-blue"
        : "border-field-rule text-ink-2 hover:border-neon-blue hover:text-neon-blue-text"
    }`;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-1 text-2xl font-semibold">Card Requests</h2>
        <p className="text-sm text-ink-3">
          {sync
            ? "Sets collectors reported as held back. Closing one closes every report on that set."
            : "Cards and sets collectors asked us to add. Until we do, each one is theirs alone."}
        </p>
      </div>

      <div role="group" aria-label="Show" className="flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const on = view.kind === "requests" && view.status === f.id;
          return (
            <button
              key={f.id}
              type="button"
              aria-pressed={on}
              onClick={() => showView({ kind: "requests", status: f.id })}
              className={chipClass(on)}
            >
              {f.label}
            </button>
          );
        })}
        <button type="button" aria-pressed={sync} onClick={() => showView({ kind: "sync" })} className={chipClass(sync)}>
          Sync reports
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(16rem,22rem)_1fr]">
        <section
          ref={queueRef}
          tabIndex={-1}
          aria-label={sync ? "Reports" : "Requests"}
          className="space-y-2 rounded-md focus-outline"
        >
          {view.kind === "requests" ? (
            requests === undefined ? (
              <p className="text-sm text-ink-3">Loading…</p>
            ) : requests.length === 0 ? (
              <p className="text-sm text-ink-3">{view.status === "waiting" ? "Nothing waiting. Nice." : "Nothing here."}</p>
            ) : (
              <ul className="space-y-1.5">
                {requests.map((r) => (
                  <li key={r._id}>
                    <button
                      type="button"
                      aria-current={openId === r._id ? "true" : undefined}
                      onClick={() => openItem(r._id)}
                      className={itemClass(openId === r._id)}
                    >
                      <span className="block text-sm text-ink">
                        <span className="text-ink-3">{r.kind === "set" ? "Set: " : "Card: "}</span>
                        {r.label}
                      </span>
                      <span className="block text-xs text-ink-3">
                        {new Date(r.requestedAt).toLocaleDateString()}
                        {r.hasPhotos ? " · photos" : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : reports === undefined ? (
            <p className="text-sm text-ink-3">Loading…</p>
          ) : reports.reports.length === 0 ? (
            <p className="text-sm text-ink-3">No sync reports open. Smooth sailing.</p>
          ) : (
            <>
              <ul className="space-y-1.5">
                {reports.reports.map((r) => {
                  const also = alsoReportedLine(r.alsoReportedBy);
                  return (
                    <li key={r._id}>
                      <button
                        type="button"
                        aria-current={openId === r._id ? "true" : undefined}
                        onClick={() => openItem(r._id)}
                        className={itemClass(openId === r._id)}
                      >
                        <span className="block text-sm text-ink">
                          <span className="text-ink-3">{PLATFORM_NAME[r.platform]}: </span>
                          {r.label}
                        </span>
                        <span className="block text-xs text-ink-3">
                          {heldBackWords(r.heldBack)}, {waitedFor(r.reportedAt, now)}
                          {also && <span className="font-semibold text-neon-blue-text"> {also}</span>}
                        </span>
                        {r.note && <span className="mt-1 block line-clamp-2 text-xs text-ink-2">“{r.note}”</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {reports.more && (
                <p className="text-xs text-ink-3">More waiting past these. Close a few and they move up.</p>
              )}
            </>
          )}
        </section>

        <section aria-label="Review">
          {openId ? (
            sync ? (
              <SyncReportReview key={openId} reportId={openId} onDone={backToList} />
            ) : (
              <RequestReview key={openId} requestId={openId as Id<"cardRequests">} onDone={backToList} />
            )
          ) : (
            <p className="text-sm text-ink-3">{sync ? "Pick a report to review it." : "Pick a request to review it."}</p>
          )}
        </section>
      </div>
    </div>
  );
}
