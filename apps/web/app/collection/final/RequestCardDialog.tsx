import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/primitives/Button";
import { Input } from "@/components/primitives/Input";
import { Textarea } from "@/components/primitives/Textarea";
import Overlay from "../prototypes/p1/Overlay";
import { OUTLINE_BUTTON } from "../prototypes/p1/ui";
import type { CollectionStore } from "./store";

/**
 * "Can't find it? Ask us to add it." The collector describes the card; it
 * goes to an admin for review and stays private to them until it's added.
 * On this page it only lands in the store's local request list, shown below
 * the form as "Requested".
 */
export default function RequestCardDialog({
  store,
  searched,
  onClose,
}: {
  store: CollectionStore;
  /** What was in the search box, kept with the request for the admin. */
  searched: string;
  onClose: () => void;
}) {
  const headingId = useId();
  const [set, setSet] = useState("");
  const [cardNumber, setCardNumber] = useState("");
  const [player, setPlayer] = useState("");
  const [notes, setNotes] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const filled = [set, cardNumber, player, notes].some((v) => v.trim() !== "");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!filled) return;
    store.requestCard({
      set: set.trim(),
      cardNumber: cardNumber.trim().replace(/^#/, ""),
      player: player.trim(),
      notes: notes.trim(),
      searched: searched.trim() || undefined,
    });
    setSet("");
    setCardNumber("");
    setPlayer("");
    setNotes("");
    setSent("Sent! An admin will give it a look.");
  };

  return (
    <Overlay labelledBy={headingId} onClose={onClose} variant="modal">
      <div className="max-h-[calc(100vh-4rem)] space-y-4 overflow-y-auto">
        <div className="space-y-1">
          <h2 id={headingId} tabIndex={-1} className="text-lg font-bold text-white focus:outline-none">
            Ask us to add a card
          </h2>
          <p className="text-sm text-slate-300">
            Tell us what you&apos;ve got. It goes to an admin for review, and it stays private to you
            until it&apos;s added.
          </p>
          {searched.trim() && (
            <p className="text-xs text-slate-400">You searched “{searched.trim()}”. We&apos;ll send that along too.</p>
          )}
        </div>

        <form onSubmit={submit} className="space-y-3" aria-labelledby={headingId}>
          <Input
            surface="dark"
            label="Set"
            placeholder="1996 Playoff Contenders"
            value={set}
            onChange={(e) => setSet(e.target.value)}
            autoComplete="off"
            data-autofocus
          />
          <div className="grid grid-cols-[7rem_1fr] gap-3">
            <Input
              surface="dark"
              label="Card number"
              placeholder="41"
              value={cardNumber}
              onChange={(e) => setCardNumber(e.target.value)}
              autoComplete="off"
            />
            <Input
              surface="dark"
              label="Player"
              placeholder="Reggie White"
              value={player}
              onChange={(e) => setPlayer(e.target.value)}
              autoComplete="off"
            />
          </div>
          <Textarea
            label="Anything else"
            placeholder="Gold foil parallel, numbered /99…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <p role="status" className="min-h-[1.25rem] text-sm text-neon-green">
            {sent ?? ""}
          </p>
          <div className="flex flex-wrap justify-end gap-3">
            <button type="button" onClick={onClose} className={OUTLINE_BUTTON}>
              Done
            </button>
            <Button type="submit" variant="primary" disabled={!filled}>
              Send request
            </Button>
          </div>
        </form>

        {store.cardRequests.length > 0 && (
          <section aria-label="Requested" className="space-y-2 border-t border-slate-700 pt-3">
            <h3 className="text-sm font-semibold text-slate-200">Requested</h3>
            <ul className="space-y-1.5 text-sm">
              {store.cardRequests.map((r) => (
                <li key={r.id} className="rounded-md border border-slate-700 px-3 py-2">
                  <span className="block text-slate-100">
                    {[r.set, r.cardNumber && `#${r.cardNumber}`, r.player].filter(Boolean).join(" ") ||
                      r.notes}
                  </span>
                  <span className="block text-xs text-slate-400">Waiting on review · only you can see it</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Overlay>
  );
}
