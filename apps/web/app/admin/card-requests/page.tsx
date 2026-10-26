import { useQuery } from "convex/react";
import { useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import RequestReview from "./RequestReview";

type Status = Doc<"cardRequests">["status"];

const FILTERS: { id: Status; label: string }[] = [
  { id: "waiting", label: "Waiting" },
  { id: "declined", label: "Not added" },
  { id: "added", label: "Added" },
];

/**
 * /admin/card-requests — NEO-361. What collectors asked us to add: a card in
 * a set we have, or a set we don't. Pick one to review it: approve it as a
 * catalog card (one already there, or one added here), approve a set once
 * it is built in the set builder, or decline with a note the collector
 * reads. Approving moves the collector's copies onto the catalog card;
 * declining leaves the card theirs, privately.
 *
 * The h1 lives in the section layout, so this heads its content with an h2.
 */
export default function AdminCardRequestsPage() {
  const [status, setStatus] = useState<Status>("waiting");
  const [openId, setOpenId] = useState<Id<"cardRequests"> | null>(null);
  const queue = useQuery(api.collectionRequests.queue, { status });
  const queueRef = useRef<HTMLElement>(null);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-1 text-2xl font-semibold">Card Requests</h2>
        <p className="text-sm text-ink-3">
          Cards and sets collectors asked us to add. Until we do, each one is theirs alone.
        </p>
      </div>

      <div role="group" aria-label="Show" className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={status === f.id}
            onClick={() => {
              setStatus(f.id);
              setOpenId(null);
            }}
            className={`min-h-11 rounded-full sm:min-h-9 border px-3 text-sm focus-outline ${
              status === f.id
                ? "border-selection bg-neon-blue text-on-neon-blue"
                : "border-field-rule text-ink-2 hover:border-neon-blue hover:text-neon-blue-text"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(16rem,22rem)_1fr]">
        <section ref={queueRef} tabIndex={-1} aria-label="Requests" className="space-y-2 rounded-md focus-outline">
          {queue === undefined ? (
            <p className="text-sm text-ink-3">Loading…</p>
          ) : queue.length === 0 ? (
            <p className="text-sm text-ink-3">
              {status === "waiting" ? "Nothing waiting. Nice." : "Nothing here."}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {queue.map((r) => (
                <li key={r._id}>
                  <button
                    type="button"
                    aria-current={openId === r._id ? "true" : undefined}
                    onClick={() => setOpenId(r._id)}
                    className={`w-full rounded-md border px-3 py-2 text-left focus-outline ${
                      openId === r._id ? "border-neon-blue bg-raised" : "border-rule-strong hover:border-neon-blue"
                    }`}
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
          )}
        </section>

        <section aria-label="Review">
          {openId ? (
            <RequestReview
              key={openId}
              requestId={openId}
              onDone={() => {
                setOpenId(null);
                // The review goes; the keyboard goes back to the queue.
                queueRef.current?.focus();
              }}
            />
          ) : (
            <p className="text-sm text-ink-3">Pick a request to review it.</p>
          )}
        </section>
      </div>
    </div>
  );
}
