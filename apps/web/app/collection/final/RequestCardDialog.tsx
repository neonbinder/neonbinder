import { useId, useState, type FormEvent } from "react";
import NeonButton from "@/components/modules/NeonButton";
import { Input } from "@/components/primitives/Input";
import { Textarea } from "@/components/primitives/Textarea";
import Overlay from "../prototypes/p1/Overlay";
import { useCollectionMode } from "./mode";
import type { DemoExtension } from "./data/store";

/**
 * "Can't find it? Ask us to add it." The collector describes the card. In a
 * real collection it would go to our crew to add; this page is a demo in
 * both modes, so it only lands in the store's local request list, shown
 * below the form as "Requested". Every line says so, rather than promise a
 * review that never happens.
 */
export default function RequestCardDialog({
  store,
  searched,
  onClose,
}: {
  store: Pick<DemoExtension, "cardRequests" | "requestCard">;
  /** What was in the search box, kept with the request for the admin. */
  searched: string;
  onClose: () => void;
}) {
  const { mode } = useCollectionMode();
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
    setSent("Got it! This is the demo, so it stays right here on the list.");
  };

  return (
    <Overlay labelledBy={headingId} onClose={onClose} variant="modal">
      <div className="max-h-[calc(100vh-4rem)] space-y-4 overflow-y-auto">
        <div className="space-y-1">
          <h2 id={headingId} tabIndex={-1} className="text-lg font-bold text-ink focus:outline-none">
            Ask us to add a card
          </h2>
          <p className="text-sm text-ink-2">
            {mode === "public"
              ? "Tell us what you've got. With an account, your requests go to our crew to add."
              : "Tell us what you've got. These binders are a demo, so for now your request stays on the list below."}
          </p>
          {searched.trim() && (
            <p className="text-xs text-ink-3">You searched “{searched.trim()}”. We&apos;ll keep that with it.</p>
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
          <p role="status" className="min-h-[1.25rem] text-sm text-neon-green-text">
            {sent ?? ""}
          </p>
          <div className="flex flex-wrap justify-end gap-3">
            <NeonButton type="button" variant="secondary" outline onClick={onClose}>
              Done
            </NeonButton>
            <NeonButton type="submit" variant="primary" disabled={!filled}>
              Send request
            </NeonButton>
          </div>
        </form>

        {store.cardRequests.length > 0 && (
          <section aria-label="Requested" className="space-y-2 border-t border-rule-strong pt-3">
            <h3 className="text-sm font-semibold text-ink-2">Requested</h3>
            <ul className="space-y-1.5 text-sm">
              {store.cardRequests.map((r) => (
                <li key={r.id} className="rounded-md border border-rule-strong px-3 py-2">
                  <span className="block text-ink">
                    {[r.set, r.cardNumber && `#${r.cardNumber}`, r.player].filter(Boolean).join(" ") ||
                      r.notes}
                  </span>
                  <span className="block text-xs text-ink-3">Demo request · only you can see it</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Overlay>
  );
}
