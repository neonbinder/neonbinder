import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useId, useRef, useState } from "react";
import NeonButton from "@/components/modules/NeonButton";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { LABEL, SELECT_PANEL } from "../../prototypes/p1/ui";
import { SkeletonBars } from "../catalog/Skeleton";
import { writeErrorMessage } from "../data/store";
import { PLATFORM_NAME } from "@/lib/marketplace/listing-copy";

type Mine = FunctionReturnType<typeof api.collectionRequests.mine>[number];
type MyReport = FunctionReturnType<typeof api.syncReports.mine>[number];

const STATUS: Record<Doc<"cardRequests">["status"], { label: string; cls: string }> = {
  waiting: { label: "Waiting", cls: "border-neon-blue/60 text-neon-blue-text" },
  added: { label: "Added", cls: "border-neon-green/60 text-neon-green-text" },
  declined: { label: "Not added", cls: "border-rule-strong text-ink-2" },
};

/**
 * NEO-361 — My requests: each card and set asked for, where it stands, and
 * our crew's note. NEO-536: below them, the held-back sets reported to the
 * crew (`syncReports.mine`). A waiting request can be withdrawn and a declined one
 * removed; either deletes the cards it made and every copy of them, behind
 * a confirm that says how many. An added set whose cards didn't all match
 * lists the leftovers to file by hand.
 */
export default function MyRequests() {
  const mine = useQuery(api.collectionRequests.mine, {});
  const reports = useQuery(api.syncReports.mine, {});
  // A withdrawn row goes away under the keyboard: once the list has redrawn
  // without it, focus lands on the list (or its empty line).
  const landing = useRef<HTMLElement | null>(null);
  const [gone, setGone] = useState(0);
  const [withdrawn, setWithdrawn] = useState<string | null>(null);
  const count = mine?.length;
  useEffect(() => {
    if (gone > 0) landing.current?.focus();
  }, [gone, count]);
  if (mine === undefined) return <SkeletonBars rows={3} />;
  const hasReports = !!reports && reports.length > 0;
  // Once one is withdrawn the section stays, even empty, so the keyboard and
  // the announcement have somewhere to land.
  const showReports = !!reports && (hasReports || withdrawn !== null);
  return (
    <div className="space-y-5">
      {mine.length === 0 ? (
        <p
          ref={(el) => {
            landing.current = el;
          }}
          tabIndex={-1}
          className="rounded-md text-sm text-ink-2 focus-outline"
        >
          {hasReports ? "No card or set requests yet." : "Nothing asked for yet. Your requests show up here."}
        </p>
      ) : (
        <ul
          ref={(el) => {
            landing.current = el;
          }}
          tabIndex={-1}
          className="space-y-2 rounded-md focus-outline"
          aria-label="My requests"
        >
          {mine.map((r) => (
            <RequestRow key={r._id} request={r} onGone={() => setGone((n) => n + 1)} />
          ))}
        </ul>
      )}
      {showReports && reports && <MySyncReports reports={reports} withdrawn={withdrawn} onWithdrawn={setWithdrawn} />}
    </div>
  );
}

const REPORT_STATUS: Record<MyReport["status"], { label: string; cls: string }> = {
  open: { label: "Waiting on our crew", cls: "border-neon-blue/60 text-neon-blue-text" },
  fixed: { label: "Fixed", cls: "border-neon-green/60 text-neon-green-text" },
  notABug: { label: "Not a bug", cls: "border-rule-strong text-ink-2" },
};

/**
 * NEO-536 — the held-back sets the collector told the crew about (from the
 * dashboard's Sync status), every status, newest first: where each stands
 * and the crew's note on a closed one. An open one can be withdrawn; that
 * deletes only the report, nothing of theirs, so it takes one press.
 */
function MySyncReports({
  reports,
  withdrawn,
  onWithdrawn,
}: {
  reports: MyReport[];
  withdrawn: string | null;
  onWithdrawn: (message: string) => void;
}) {
  // A withdrawn report goes away under the keyboard: land on the heading.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (withdrawn) heading.current?.focus();
  }, [withdrawn]);
  return (
    <div className="space-y-2">
      <h3 ref={heading} tabIndex={-1} className="rounded-sm text-sm font-semibold text-ink focus-outline">
        Sets you reported
      </h3>
      {reports.length === 0 ? (
        <p className="text-sm text-ink-2">No reports left. The crew&apos;s queue thanks you.</p>
      ) : (
        <ul className="space-y-2" aria-label="My sync reports">
          {reports.map((r) => (
            <SyncReportRow key={r._id} report={r} onWithdrawn={(label) => onWithdrawn(`Withdrew the report on ${label}.`)} />
          ))}
        </ul>
      )}
      {/* Mounted from the start, so it is announced; empty, it cancels its own gap. */}
      <p role="status" className="text-sm text-neon-green-text empty:-mt-2">
        {withdrawn ?? ""}
      </p>
    </div>
  );
}

function SyncReportRow({ report: r, onWithdrawn }: { report: MyReport; onWithdrawn: (label: string) => void }) {
  const withdraw = useMutation(api.syncReports.withdraw);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const status = REPORT_STATUS[r.status];
  const platform = PLATFORM_NAME[r.platform];
  const run = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await withdraw({ id: r._id });
      onWithdrawn(`${r.label} (${platform})`);
    } catch (err) {
      setProblem(writeErrorMessage(err));
      setBusy(false);
    }
  };
  return (
    <li className="space-y-2 rounded-md border border-rule-strong px-3 py-2">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <p className="text-sm text-ink">
            <span className="text-ink-3">{platform}: </span>
            {r.label}
          </p>
          <p className="text-xs text-ink-3">
            {r.heldBack === 1 ? "1 card held back" : `${r.heldBack} cards held back`}, reported{" "}
            {new Date(r.reportedAt).toLocaleDateString()}
          </p>
          {r.note && <p className="text-xs text-ink-3">Your note: {r.note}</p>}
        </div>
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${status.cls}`}>{status.label}</span>
      </div>
      {r.closeNote && (
        <p className="text-sm text-ink-2 [overflow-wrap:anywhere]">
          <span className="font-semibold text-ink">From our crew:</span> {r.closeNote}
        </p>
      )}
      {r.status === "fixed" && (
        <p className="text-xs text-ink-3">Those cards go up next sync.</p>
      )}
      {r.status === "open" && (
        <div className="flex justify-end">
          {/* The words on it lead its name (WCAG 2.5.3); which report it is, a reader hears after. */}
          <NeonButton
            type="button"
            variant="negative"
            outline
            aria-disabled={busy || undefined}
            onClick={() => void run()}
          >
            {busy ? "Withdrawing…" : "Withdraw"}
            <span className="sr-only">
              {" "}
              the report on {r.label} ({platform})
            </span>
          </NeonButton>
        </div>
      )}
      {/* Mounted from the start, so a refusal is announced; empty, it cancels its own gap. */}
      <p role="alert" className="text-sm text-neon-pink-text empty:-mt-2">
        {problem}
      </p>
    </li>
  );
}

function RequestRow({ request: r, onGone }: { request: Mine; onGone: () => void }) {
  const withdraw = useMutation(api.collectionRequests.withdraw);
  const [confirming, setConfirming] = useState(false);
  const keepButton = useRef<HTMLButtonElement>(null);
  const askButton = useRef<HTMLButtonElement>(null);
  const warningId = useId();
  // The keyboard follows the question: onto "Keep it" (Enter never destroys
  // by default), and back to the ask when kept.
  const opened = useRef(false);
  useEffect(() => {
    if (confirming) keepButton.current?.focus();
    else if (opened.current) askButton.current?.focus();
    opened.current = confirming;
  }, [confirming]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const status = STATUS[r.status];
  const kind = r.kind === "set" ? "Set" : "Card";
  const leftovers = r.status === "added" && r.kind === "set" && r.privateSetId && r.cards > 0;
  const verb = r.status === "waiting" ? "Withdraw" : "Remove";

  const goes =
    r.copies === 0
      ? r.kind === "set" && r.cards > 0
        ? `The ${r.cards === 1 ? "card you filed from it goes" : `${r.cards} cards you filed from it go`} too.`
        : "You don't have any copies of it filed."
      : `Your ${r.copies === 1 ? "copy" : `${r.copies} copies`} of ${r.kind === "set" ? "its cards" : "it"} ${
          r.copies === 1 ? "goes" : "go"
        } too.`;

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await withdraw({ requestId: r._id });
      // The row is about to go; keep the keyboard in the list.
      onGone();
    } catch (err) {
      setProblem(writeErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <li className="space-y-2 rounded-md border border-rule-strong px-3 py-2">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-ink">
            <span className="text-ink-3">{kind}: </span>
            {r.label}
          </p>
          {r.notes && <p className="text-xs text-ink-3">Your notes: {r.notes}</p>}
        </div>
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${status.cls}`}>{status.label}</span>
      </div>
      {r.decisionNote && (
        <p className="text-sm text-ink-2">
          <span className="font-semibold text-ink">From our crew:</span> {r.decisionNote}
        </p>
      )}
      {r.status === "declined" && (
        <p className="text-xs text-ink-3">It stays in your collection, just for you.</p>
      )}
      {leftovers && <Leftovers privateSetId={r.privateSetId!} count={r.cards} />}
      {r.status !== "added" &&
        (confirming ? (
          <div
            role="group"
            aria-label={`${verb} ${r.label}?`}
            aria-describedby={warningId}
            className="space-y-2 rounded-md border border-neon-pink/50 p-2"
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              // Escape answers the question, never the dialog behind it.
              e.preventDefault();
              if (!busy) setConfirming(false);
            }}
          >
            <p id={warningId} className="text-sm text-ink">
              {verb} this request? {goes} This can&apos;t be undone.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <NeonButton
                ref={keepButton}
                type="button"
                variant="secondary"
                outline
                onClick={() => !busy && setConfirming(false)}
                aria-disabled={busy || undefined}
              >
                Keep it
              </NeonButton>
              <NeonButton type="button" variant="negative" onClick={() => void run()} aria-disabled={busy || undefined}>
                {busy ? `${verb === "Withdraw" ? "Withdrawing" : "Removing"}…` : verb}
              </NeonButton>
            </div>
          </div>
        ) : (
          <div className="flex justify-end">
            <NeonButton
              ref={askButton}
              type="button"
              variant="negative"
              outline
              aria-label={`${verb} ${r.label}`}
              onClick={() => setConfirming(true)}
            >
              {verb}
            </NeonButton>
          </div>
        ))}
      {problem && (
        <p role="alert" className="text-sm text-neon-pink-text">
          {problem}
        </p>
      )}
    </li>
  );
}

/** The cards from an added set that didn't match on their own: pick which NB card each one is. */
function Leftovers({ privateSetId, count }: { privateSetId: Id<"privateSets">; count: number }) {
  const cards = useQuery(api.collectionRequests.privateSetCards, { privateSetId });
  // A filed card leaves the list under the keyboard: land on the block, and say so.
  const block = useRef<HTMLDivElement>(null);
  const [filed, setFiled] = useState<string | null>(null);
  return (
    <div ref={block} tabIndex={-1} className="space-y-2 rounded-md border border-dashed border-neon-blue/60 p-2 focus-outline">
      <p className="text-sm text-ink-2">
        {count === 1 ? "One of your cards" : `${count} of your cards`} from it didn&apos;t match on their own. Pick which card each one is.
      </p>
      {cards === undefined ? (
        <SkeletonBars rows={2} />
      ) : (
        <ul className="space-y-2">
          {cards.map((c) => (
            <Leftover
              key={c._id}
              id={c._id}
              label={`${c.variantName ? `${c.variantName} ` : ""}#${c.cardNumber} ${c.player}`}
              onFiled={(label) => {
                setFiled(`Filed ${label}.`);
                block.current?.focus();
              }}
            />
          ))}
        </ul>
      )}
      <p role="status" className="text-sm text-neon-green-text">
        {filed ?? ""}
      </p>
    </div>
  );
}

function Leftover({ id, label, onFiled }: { id: Id<"privateCards">; label: string; onFiled: (label: string) => void }) {
  const candidates = useQuery(api.collectionRequests.fileCandidates, { privateCardId: id });
  const fileAs = useMutation(api.collectionRequests.fileAs);
  const [pick, setPick] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const file = async () => {
    if (!pick || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await fileAs({ privateCardId: id, cardId: pick as Id<"cardChecklist"> });
      onFiled(label);
    } catch (err) {
      setProblem(writeErrorMessage(err));
      setBusy(false);
    }
  };
  return (
    <li className="space-y-1">
      {candidates && candidates.length === 0 ? (
        <p className="text-sm text-ink-2">
          {label}: no card with that number in the set yet. It stays yours as it is.
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <label className="block min-w-0 flex-1">
            <span className={LABEL}>{label} is</span>
            <select
              className={SELECT_PANEL}
              value={pick}
              disabled={!candidates}
              aria-busy={candidates === undefined || undefined}
              onChange={(e) => setPick(e.target.value)}
            >
              <option value="">{candidates === undefined ? "Loading…" : "Pick the card"}</option>
              {candidates?.map((c) => (
                <option key={c._id} value={c._id}>
                  {[c.variant?.name, `#${c.cardNumber}`, c.cardName].filter(Boolean).join(" ")}
                </option>
              ))}
            </select>
          </label>
          <NeonButton
            type="button"
            variant="primary"
            aria-label={`File it: ${label}`}
            aria-disabled={!pick || busy || undefined}
            onClick={() => void file()}
          >
            File it
          </NeonButton>
        </div>
      )}
      {problem && (
        <p role="alert" className="text-sm text-neon-pink-text">
          {problem}
        </p>
      )}
    </li>
  );
}
