import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useId, useRef, useState } from "react";
import NeonButton from "@/components/modules/NeonButton";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { LABEL, SELECT_PANEL } from "../../prototypes/p1/ui";
import { SkeletonBars } from "../catalog/Skeleton";
import { writeErrorMessage } from "../data/store";

type Mine = FunctionReturnType<typeof api.collectionRequests.mine>[number];

const STATUS: Record<Doc<"cardRequests">["status"], { label: string; cls: string }> = {
  waiting: { label: "Waiting", cls: "border-neon-blue/60 text-neon-blue-text" },
  added: { label: "Added", cls: "border-neon-green/60 text-neon-green-text" },
  declined: { label: "Not added", cls: "border-rule-strong text-ink-2" },
};

/**
 * NEO-361 — My requests: each card and set asked for, where it stands, and
 * our crew's note. A waiting request can be withdrawn and a declined one
 * removed; either deletes the cards it made and every copy of them, behind
 * a confirm that says how many. An added set whose cards didn't all match
 * lists the leftovers to file by hand.
 */
export default function MyRequests() {
  const mine = useQuery(api.collectionRequests.mine, {});
  // A withdrawn row goes away under the keyboard: once the list has redrawn
  // without it, focus lands on the list (or its empty line).
  const landing = useRef<HTMLElement | null>(null);
  const [gone, setGone] = useState(0);
  const count = mine?.length;
  useEffect(() => {
    if (gone > 0) landing.current?.focus();
  }, [gone, count]);
  if (mine === undefined) return <SkeletonBars rows={3} />;
  if (mine.length === 0) {
    return (
      <p
        ref={(el) => {
          landing.current = el;
        }}
        tabIndex={-1}
        className="rounded-md text-sm text-ink-2 focus-outline"
      >
        Nothing asked for yet. Your requests show up here.
      </p>
    );
  }
  return (
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
