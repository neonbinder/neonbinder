import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import NeonButton from "@/components/modules/NeonButton";
import { Input } from "@/components/primitives/Input";
import { Textarea } from "@/components/primitives/Textarea";
import PlayerPicker from "@/components/SetSelector/PlayerPicker";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { writeErrorMessage } from "@/app/collection/final/data/store";
import SetPick from "./SetPick";

/**
 * NEO-361 — one request, reviewed. For a card: what the collector typed and
 * photographed, the cards in that set already carrying its number (pick one
 * when it is the same card), or add it to its checklist here. For a set:
 * build it in the set builder, then pick it; the collector's cards whose
 * number names exactly one card in it move across on their own. Either can
 * be declined with a note the collector reads.
 */
export default function RequestReview({
  requestId,
  onDone,
}: {
  requestId: Id<"cardRequests">;
  onDone: () => void;
}) {
  const r = useQuery(api.collectionRequests.review, { requestId });
  const approveCard = useMutation(api.collectionRequests.approveCard);
  const approveSet = useMutation(api.collectionRequests.approveSet);
  const decline = useMutation(api.collectionRequests.decline);
  const addCustomCard = useMutation(api.selectorOptions.addCustomCard);

  const heading = useRef<HTMLHeadingElement>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [cardNumber, setCardNumber] = useState<string | null>(null);
  const [cardName, setCardName] = useState<string | null>(null);
  const [playerIds, setPlayerIds] = useState<Array<Id<"players">>>([]);
  const [setId, setSetId] = useState<Id<"selectorOptions"> | null>(null);

  const loaded = r !== undefined;
  useEffect(() => {
    if (loaded) heading.current?.focus();
  }, [loaded]);
  // The button that acted goes with the form it was in: land on the outcome.
  const outcome = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (done) outcome.current?.focus();
  }, [done]);

  if (r === undefined) return <p className="text-sm text-ink-3">Loading…</p>;
  if (r === null) return <p className="text-sm text-ink-3">That request isn&apos;t there anymore.</p>;

  const card = r.privateCard;
  const open = r.status !== "added";
  const noteArg = note.trim() ? { note: note.trim() } : {};

  const act = async (what: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      setDone(await what());
    } catch (err) {
      setProblem(writeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const approveAs = (cardId: Id<"cardChecklist">) =>
    act(async () => {
      const { moved } = await approveCard({ requestId: r._id, cardId, ...noteArg });
      return `Added. ${moved === 1 ? "One line" : `${moved} lines`} of their copies moved onto it.`;
    });

  const addAndApprove = () =>
    act(async () => {
      if (!card?.variant) throw new Error("Pick a checklist first.");
      const number = (cardNumber ?? card.cardNumber).trim();
      const name = (cardName ?? card.player).trim();
      if (!number || !name) throw new Error("Add the card number and its title.");
      const cardId = await addCustomCard({
        selectorOptionId: card.variant._id,
        cardNumber: number,
        cardName: name,
        ...(playerIds.length > 0 ? { playerIds } : {}),
      });
      const { moved } = await approveCard({ requestId: r._id, cardId, ...noteArg });
      return `Added #${number} to ${card.variant.name}. ${moved === 1 ? "One line" : `${moved} lines`} of their copies moved onto it.`;
    });

  const setBuilderLink = (() => {
    const set = card?.set;
    if (set?.sport && set.year && set.manufacturer) {
      const q = new URLSearchParams({
        sport: set.sport._id,
        year: set.year._id,
        brand: set.manufacturer._id,
        set: set._id,
      });
      return `/admin/set-builder?${q}`;
    }
    const sport = r.privateSet?.sport;
    return sport ? `/admin/set-builder?${new URLSearchParams({ sport: sport._id })}` : "/admin/set-builder";
  })();

  return (
    <div className="space-y-5 rounded-lg bg-raised p-4 shadow-offset">
      <div className="space-y-1">
        <h3 ref={heading} tabIndex={-1} className="text-lg font-semibold text-ink focus:outline-none">
          {r.kind === "set" ? "Set: " : "Card: "}
          {r.label}
        </h3>
        <p className="text-xs text-ink-3">
          Asked {new Date(r.requestedAt).toLocaleString()} · they hold {r.copies} {r.copies === 1 ? "copy" : "copies"}
        </p>
      </div>

      <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-sm">
        {card && (
          <>
            <dt className="text-ink-3">Set</dt>
            <dd className="text-ink">{card.set ? `${card.set.season} ${card.set.name}` : (card.privateSet?.name ?? "")}</dd>
            <dt className="text-ink-3">Checklist</dt>
            <dd className="text-ink">
              {card.variant ? card.variant.name : <>“{card.variantName}” (typed, not in the set yet)</>}
            </dd>
            <dt className="text-ink-3">Number</dt>
            <dd className="text-ink">#{card.cardNumber}</dd>
            <dt className="text-ink-3">Player</dt>
            <dd className="text-ink">{card.player}</dd>
          </>
        )}
        {r.privateSet && (
          <>
            <dt className="text-ink-3">Sport</dt>
            <dd className="text-ink">{r.privateSet.sport?.name ?? "?"}</dd>
            <dt className="text-ink-3">Year</dt>
            <dd className="text-ink">{r.privateSet.year}</dd>
            <dt className="text-ink-3">Brand</dt>
            <dd className="text-ink">{r.privateSet.brand}</dd>
            <dt className="text-ink-3">Set</dt>
            <dd className="text-ink">{r.privateSet.name}</dd>
          </>
        )}
        {r.searched && (
          <>
            <dt className="text-ink-3">They searched</dt>
            <dd className="text-ink">“{r.searched}”</dd>
          </>
        )}
        {(r.notes || card?.notes) && (
          <>
            <dt className="text-ink-3">Their notes</dt>
            <dd className="text-ink">{r.notes ?? card?.notes}</dd>
          </>
        )}
        {r.decisionNote && (
          <>
            <dt className="text-ink-3">Our note</dt>
            <dd className="text-ink">{r.decisionNote}</dd>
          </>
        )}
      </dl>

      {card && (card.frontImageUrl || card.backImageUrl) && (
        <ul className="flex flex-wrap gap-3" aria-label="Their photos">
          {card.frontImageUrl && (
            <li>
              <a href={card.frontImageUrl} target="_blank" rel="noreferrer" className="block rounded focus-outline">
                <span className="sr-only">(opens in a new tab)</span>
                <img src={card.frontImageUrl} alt="Front of the card" className="h-48 w-auto rounded border border-rule-strong" />
              </a>
            </li>
          )}
          {card.backImageUrl && (
            <li>
              <a href={card.backImageUrl} target="_blank" rel="noreferrer" className="block rounded focus-outline">
                <span className="sr-only">(opens in a new tab)</span>
                <img src={card.backImageUrl} alt="Back of the card" className="h-48 w-auto rounded border border-rule-strong" />
              </a>
            </li>
          )}
        </ul>
      )}

      {r.privateSetCards.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-sm font-semibold text-ink-2">Cards they filed from it ({r.privateSetCards.length})</h4>
          <ul className="max-h-48 overflow-y-auto text-sm text-ink">
            {r.privateSetCards.map((c) => (
              <li key={c._id}>
                {c.variantName ? `${c.variantName} ` : ""}#{c.cardNumber} {c.player}
              </li>
            ))}
          </ul>
        </div>
      )}

      {open && (
        <>
          {card && r.sameNumber.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-semibold text-ink-2">Already in the set with #{card.cardNumber}</h4>
              <p className="text-xs text-ink-3">Often a parallel or a misread. Approve as one only if it is the same card.</p>
              <ul className="space-y-1.5">
                {r.sameNumber.map((c) => (
                  <li key={c._id} className="flex flex-wrap items-center gap-2 rounded-md border border-rule-strong px-3 py-2">
                    <span className="min-w-0 flex-1 text-sm text-ink">
                      {c.variant?.name} #{c.cardNumber} {c.cardName}
                    </span>
                    <NeonButton
                      type="button"
                      variant="primary"
                      outline
                      aria-disabled={busy || undefined}
                      aria-label={`This is the card: ${c.variant?.name ?? ""} #${c.cardNumber} ${c.cardName}`}
                      onClick={() => void approveAs(c._id)}
                    >
                      This is the card
                    </NeonButton>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {card?.variant && (
            <fieldset className="space-y-3 rounded-md border border-rule-strong p-3">
              <legend className="px-1 text-sm font-semibold text-ink-2">Add it to {card.variant.name}</legend>
              <div className="grid grid-cols-[7rem_1fr] gap-3">
                <Input
                  surface="panel"
                  label="Card number"
                  value={cardNumber ?? card.cardNumber}
                  onChange={(e) => setCardNumber(e.target.value)}
                  autoComplete="off"
                />
                <Input
                  surface="panel"
                  label="Card title"
                  value={cardName ?? card.player}
                  onChange={(e) => setCardName(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <PlayerPicker
                value={playerIds}
                onChange={setPlayerIds}
                sportId={card.set?.sport?._id}
              />
              <div className="flex justify-end">
                <NeonButton type="button" variant="primary" aria-disabled={busy || undefined} onClick={() => void addAndApprove()}>
                  Add and approve
                </NeonButton>
              </div>
            </fieldset>
          )}

          {(r.kind === "set" || (card && !card.variant)) && (
            <div className="space-y-3 rounded-md border border-rule-strong p-3">
              <p className="text-sm text-ink-2">
                {r.kind === "set"
                  ? "Build the set in the set builder, then pick it here."
                  : "Its checklist isn't in the set yet. Add it in the set builder; the card then shows above to approve."}{" "}
                <Link to={setBuilderLink} className="text-neon-blue-text underline underline-offset-2 focus-outline rounded-sm">
                  Open the set builder
                </Link>
              </p>
              {r.kind === "set" && (
                <>
                  <SetPick sportId={r.privateSet?.sport?._id ?? null} value={setId} onChange={setSetId} />
                  <div className="flex justify-end">
                    <NeonButton
                      type="button"
                      variant="primary"
                      aria-disabled={busy || !setId || undefined}
                      onClick={() =>
                        setId &&
                        void act(async () => {
                          const { matched, left } = await approveSet({ requestId: r._id, setId, ...noteArg });
                          return left === 0
                            ? `Added. All ${matched} of their cards moved onto it.`
                            : `Added. ${matched} of their cards moved; ${left} didn't match one card and wait for them to file.`;
                        })
                      }
                    >
                      Approve as this set
                    </NeonButton>
                  </div>
                </>
              )}
            </div>
          )}

          <div className="space-y-3">
            <Textarea
              label="Note to the collector (optional)"
              placeholder="We added it as the Gold parallel…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            {r.status === "waiting" && (
              <div className="flex justify-end">
                <NeonButton
                  type="button"
                  variant="negative"
                  outline
                  aria-disabled={busy || undefined}
                  onClick={() =>
                    void act(async () => {
                      await decline({ requestId: r._id, ...noteArg });
                      return "Declined. It stays theirs, just for them.";
                    })
                  }
                >
                  Decline
                </NeonButton>
              </div>
            )}
          </div>
        </>
      )}

      <p role="alert" className="min-h-[1.25rem] text-sm text-neon-pink-text">
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
