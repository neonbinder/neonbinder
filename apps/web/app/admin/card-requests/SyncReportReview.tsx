import { useMutation, useQuery } from "convex/react";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import NeonButton from "@/components/modules/NeonButton";
import { Textarea } from "@/components/primitives/Textarea";
import { serializeDrillPath } from "@/components/SetSelector/useDrillUrlState";
import { api } from "@/convex/_generated/api";
import { writeErrorMessage } from "@/app/collection/final/data/store";
import { problemCopyReadOnly } from "@/app/collection/final/inventory/listing/copy";
import { MAX_SYNC_REPORT_NOTE } from "@/lib/collection/sync-report";
import { PLATFORM_NAME } from "@/lib/marketplace/listing-copy";
import { alsoReportedSentence, heldBackWords } from "./syncReportCopy";

/** What the server says too, said first here so the admin isn't sent to it. */
export const NOT_A_BUG_NEEDS_A_NOTE = "Add a note saying why it isn't a bug. The collector reads it.";

const OUTCOME = {
  fixed: { label: "Fixed", cls: "border-neon-green/60 text-neon-green-text" },
  notABug: { label: "Not a bug", cls: "border-rule-strong text-ink-2" },
} as const;

/**
 * NEO-536 — one sync report, reviewed. A collector's set (one variant on one
 * listing platform) held cards back for a reason only the crew can fix: the
 * held cards by NB number and name with NB's reason, the sync's own detail
 * set apart (eBay's field name for `missingAspect`, the sync's sentence for
 * `rejected`; display-only, never NB data), the collector's note, when their
 * set last listed cleanly, and who else reported it.
 *
 * Close it as Fixed (note optional) or Not a bug (note required, the
 * collector reads it). A close settles every open report on the set and
 * platform, and its note goes to every one of those collectors, so with
 * others on the set the field says so. Their own note is the crew's alone.
 * A closed report shows how it closed and nothing to press.
 */
export default function SyncReportReview({ reportId, onDone }: { reportId: string; onDone: () => void }) {
  const r = useQuery(api.syncReports.review, { id: reportId });
  const chain = useQuery(api.selectorOptions.getAncestorChain, r ? { id: r.variantId } : "skip");
  const close = useMutation(api.syncReports.close);

  const heading = useRef<HTMLHeadingElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const problemId = useId();
  const helperId = useId();
  const heldId = useId();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [noteMissing, setNoteMissing] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const loaded = r !== undefined;
  useEffect(() => {
    if (loaded) heading.current?.focus();
  }, [loaded]);
  // The buttons go once the report is closed: land on the outcome.
  const outcome = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (done) outcome.current?.focus();
  }, [done]);

  if (r === undefined) return <p className="text-sm text-ink-3">Loading…</p>;
  if (r === null) {
    return <p className="text-sm text-ink-3">That report isn&apos;t there anymore. The collector may have withdrawn it.</p>;
  }

  const platform = PLATFORM_NAME[r.platform];
  const reasons = problemCopyReadOnly(r.platform);
  const also = r.status === "open" ? alsoReportedSentence(r.alsoReportedBy) : null;
  // The close note goes to everyone who reported the set, not only this one.
  const toEveryone = r.alsoReportedBy > 0;
  const notKept = r.heldBack - r.cards.length - r.cardsGone;
  const setBuilderHref = chain && chain.length > 0
    ? `/admin/set-builder?${serializeDrillPath(chain.map((c) => c._id))}`
    : "/admin/set-builder";

  const closeAs = async (how: "fixed" | "notABug") => {
    if (busy) return;
    const trimmed = note.trim();
    if (how === "notABug" && !trimmed) {
      setNoteMissing(true);
      setProblem(NOT_A_BUG_NEEDS_A_NOTE);
      noteRef.current?.focus();
      return;
    }
    setBusy(true);
    setProblem(null);
    setNoteMissing(false);
    try {
      const { closed } = await close({ id: r._id, outcome: how, ...(trimmed ? { note: trimmed } : {}) });
      const others = closed > 1 ? ` ${closed} reports on this set closed with it.` : "";
      setDone(how === "fixed" ? `Marked fixed.${others}` : `Closed as not a bug.${others}`);
    } catch (err) {
      setProblem(writeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-w-0 space-y-5 rounded-lg bg-raised p-4 shadow-offset [overflow-wrap:anywhere]">
      <div className="space-y-1">
        <h3 ref={heading} tabIndex={-1} className="rounded-sm text-lg font-semibold text-ink focus-outline">
          Sync report: {r.label}
        </h3>
        <p className="text-xs text-ink-3">
          {platform}, {heldBackWords(r.heldBack)}. Reported {new Date(r.reportedAt).toLocaleString()}
          {r.lastUpdated > r.reportedAt ? `, refreshed ${new Date(r.lastUpdated).toLocaleString()}` : ""}.
        </p>
        {also && <p className="text-sm font-semibold text-neon-blue-text">{also}</p>}
      </div>

      {r.status !== "open" && (
        <div className="space-y-1">
          <p className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
            <span className={`rounded-full border px-2 py-0.5 text-xs ${OUTCOME[r.status].cls}`}>{OUTCOME[r.status].label}</span>
            {r.closedAt !== undefined && <span>Closed {new Date(r.closedAt).toLocaleString()}</span>}
          </p>
          {r.closeNote && (
            <p className="text-sm text-ink-2">
              <span className="font-semibold text-ink">Our note:</span> {r.closeNote}
            </p>
          )}
        </div>
      )}

      {r.listedCleanlySince !== undefined && (
        <p className="rounded-md border border-neon-green/50 px-3 py-2 text-sm text-neon-green-text">
          Listed cleanly since {new Date(r.listedCleanlySince).toLocaleString()}. Their last sync held none of these back.
        </p>
      )}

      {r.note && (
        <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          <dt className="text-ink-3">Their note</dt>
          <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">
            {r.note}
            <span className="mt-0.5 block text-xs text-ink-3">Only our crew sees this.</span>
          </dd>
        </dl>
      )}

      <div className="space-y-2">
        <h4 id={heldId} className="text-sm font-semibold text-ink-2">
          Held back on {platform}
        </h4>
        {r.cards.length > 0 && (
          <ul className="space-y-1.5" aria-labelledby={heldId}>
            {r.cards.map((c) => (
              <li key={c.cardId} className="flex gap-3 rounded-md border border-rule-strong px-3 py-2">
                <span className="shrink-0 self-start rounded border border-field-rule px-1.5 py-0.5 text-xs font-semibold tabular-nums text-ink">
                  #{c.cardNumber}
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-sm text-ink [overflow-wrap:anywhere]">{c.cardLabel ?? "No name on this card"}</p>
                  <p className="text-xs text-ink-2">{reasons[c.reason]}</p>
                  {c.detail && (
                    <p className="border-l-2 border-neon-blue/60 pl-2 text-xs text-ink-2 [overflow-wrap:anywhere]">
                      <span className="text-ink-3">
                        {c.reason === "missingAspect" ? `${platform} asked for: ` : "The sync recorded: "}
                      </span>
                      “{c.detail}”
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {r.cardsGone > 0 && (
          <p className="text-xs text-ink-3">
            {r.cardsGone === 1
              ? "1 card in the report isn't in NeonBinder anymore."
              : `${r.cardsGone} cards in the report aren't in NeonBinder anymore.`}
          </p>
        )}
        {notKept > 0 && (
          <p className="text-xs text-ink-3">
            {notKept === 1 ? "1 more card was held back too" : `${notKept} more cards were held back too`}; the report keeps the first{" "}
            {r.cards.length + r.cardsGone}.
          </p>
        )}
      </div>

      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Link
          to={`/admin/sync-status?${new URLSearchParams({ owner: r.ownerId })}`}
          className="rounded-sm text-neon-blue-text underline underline-offset-2 focus-outline"
        >
          Open their Sync status
        </Link>
        <Link to={setBuilderHref} className="rounded-sm text-neon-blue-text underline underline-offset-2 focus-outline">
          Open the set builder
        </Link>
      </p>

      {r.status === "open" && !done && (
        <div className="space-y-3">
          {/* The helper is ours, not the primitive's, so the field is described by it as well as by a complaint. */}
          <div className="flex flex-col gap-2">
            <Textarea
              ref={noteRef}
              label={toEveryone ? "Note to every collector who reported this set" : "Note to the collector"}
              placeholder="Relinked #41 to the right card. Sync again and it goes up."
              value={note}
              maxLength={MAX_SYNC_REPORT_NOTE}
              aria-invalid={noteMissing || undefined}
              aria-describedby={noteMissing ? `${helperId} ${problemId}` : helperId}
              onChange={(e) => {
                setNote(e.target.value);
                if (noteMissing && e.target.value.trim()) {
                  setNoteMissing(false);
                  setProblem(null);
                }
              }}
            />
            <p id={helperId} className="text-sm text-ink-3">
              {toEveryone
                ? "Optional for Mark fixed. Not a bug needs one. Every collector who reported this set reads it."
                : "Optional for Mark fixed. Not a bug needs one: they read it."}
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <NeonButton
              type="button"
              variant="negative"
              outline
              aria-disabled={busy || undefined}
              onClick={() => void closeAs("notABug")}
            >
              Not a bug
            </NeonButton>
            <NeonButton type="button" variant="primary" aria-disabled={busy || undefined} onClick={() => void closeAs("fixed")}>
              Mark fixed
            </NeonButton>
          </div>
        </div>
      )}

      <p id={problemId} role="alert" className="min-h-[1.25rem] text-sm text-neon-pink-text">
        {problem ?? ""}
      </p>
      {/* Mounted from the start, so the outcome is announced. */}
      <div role="status" ref={outcome} tabIndex={-1} className="rounded-md focus-outline">
        {done && (
          <div className="flex flex-wrap items-center gap-3 text-sm text-neon-green-text">
            <span className="flex-1">{done}</span>
            <NeonButton type="button" variant="secondary" outline onClick={onDone}>
              Back to the list
            </NeonButton>
          </div>
        )}
      </div>
    </div>
  );
}
