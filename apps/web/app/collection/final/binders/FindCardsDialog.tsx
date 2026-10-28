import { useId, useMemo, useState } from "react";
import NeonButton from "@/components/modules/NeonButton";
import { Input } from "@/components/primitives/Input";
import Modal from "../../prototypes/p2/Modal";
import { cardLabel } from "../data/labels";
import { useCards, useDeclined, useFindCards } from "../data/store";
import type { Card, CardId, Container, Copy } from "../data/types";
import { describeSmartRule } from "./RuleBuilder";

/**
 * NEO-362 — "Find cards for this binder": every copy the collector already
 * has that fits the smart binder's rule, wherever it lives (another binder,
 * Main, a box), so they can pull each one in or turn it down. Nothing moves
 * on its own (Jason, 2026-10-27).
 *
 * - **Add** moves one line item in. A stack of more than one asks how many,
 *   1 by default. A copy in a box is for sale: moving it here takes it off
 *   sale, and the row says so first.
 * - **Not for this binder** declines the card: it stops showing up here,
 *   and the Declined list brings it back for another look.
 */

type Tab = "review" | "declined";

export default function FindCardsDialog({
  container,
  onAdd,
  onDecline,
  onUndecline,
  onClose,
}: {
  container: Container;
  /** Resolves once the move landed (or was refused, which the caller says). */
  onAdd: (card: Card | undefined, copy: Copy, quantity: number) => Promise<void>;
  onDecline: (cardId: CardId, card: Card | undefined) => Promise<void>;
  onUndecline: (cardId: CardId, card: Card | undefined) => Promise<void>;
  onClose: () => void;
}) {
  const titleId = useId();
  const [tab, setTab] = useState<Tab>("review");
  const found = useFindCards(container.id);
  const declined = useDeclined(container.id);
  const ids = useMemo(() => {
    const out = new Set<string>();
    for (const c of found?.copies ?? []) out.add(c.cardId);
    for (const d of declined ?? []) out.add(d.cardId);
    return out.size ? [...out] : null;
  }, [found, declined]);
  const cardList = useCards(ids);
  const cards = useMemo(() => {
    const map = new Map<string, Card>();
    for (const c of cardList ?? []) if (c) map.set(c.id, c);
    return map;
  }, [cardList]);
  const rule = container.smartRule;

  return (
    <Modal labelledBy={titleId} onClose={onClose} className="max-w-2xl">
      <div className="space-y-4 p-5">
        <div>
          <h2 id={titleId} className="text-xl font-bold text-ink">
            Find cards for {container.name}
          </h2>
          <p className="mt-1 text-sm text-ink-2">
            {rule
              ? `Cards you already have that fit: ${describeSmartRule(rule, container.ruleNames)}.`
              : "This binder has no rule yet."}
          </p>
        </div>

        <div role="tablist" aria-label="Find cards" className="flex gap-1 rounded-lg border border-control bg-field p-0.5">
          {(["review", "declined"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`focus-outline min-h-10 flex-1 rounded-md px-3 text-sm font-medium ${
                tab === t ? "bg-neon-blue text-on-neon-blue" : "text-ink-2 hover:text-ink"
              }`}
            >
              {t === "review" ? "To look at" : `Turned down${declined?.length ? ` (${declined.length})` : ""}`}
            </button>
          ))}
        </div>

        {tab === "review" ? (
          !found ? (
            <p className="py-6 text-center text-ink-2">Looking through your collection…</p>
          ) : found.copies.length === 0 ? (
            <p className="py-6 text-center text-ink-2">
              {found.done
                ? "Nothing else you have fits. New cards that fit can be filed here as you add them."
                : "Nothing yet. Still looking…"}
            </p>
          ) : (
            <ul className="divide-y divide-rule" aria-label="Cards that fit">
              {found.copies.map((copy) => (
                <FoundRow
                  key={copy.id}
                  copy={copy}
                  card={cards.get(copy.cardId)}
                  onAdd={(n) => onAdd(cards.get(copy.cardId), copy, n)}
                  onDecline={() => onDecline(copy.cardId, cards.get(copy.cardId))}
                />
              ))}
            </ul>
          )
        ) : !declined ? (
          <p className="py-6 text-center text-ink-2">Loading…</p>
        ) : declined.length === 0 ? (
          <p className="py-6 text-center text-ink-2">Nothing turned down. Cards you turn down wait here.</p>
        ) : (
          <ul className="divide-y divide-rule" aria-label="Turned down">
            {declined.map((d) => {
              const card = cards.get(d.cardId);
              return (
                <li key={d.cardId} className="flex flex-wrap items-center gap-3 py-3">
                  <span className="min-w-0 flex-1 text-sm text-ink">{card ? cardLabel(card) : "A card"}</span>
                  <NeonButton
                    type="button"
                    variant="secondary"
                    outline
                    aria-label={`Look at it again: ${card ? cardLabel(card) : "this card"}`}
                    onClick={() => void onUndecline(d.cardId, card)}
                    className="min-h-10"
                  >
                    Look at it again
                  </NeonButton>
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-rule-strong pt-4">
          {tab === "review" && found && !found.done && (
            <NeonButton type="button" variant="secondary" outline onClick={found.more} className="min-h-10">
              Look further
            </NeonButton>
          )}
          <NeonButton type="button" variant="secondary" outline onClick={onClose} className="min-h-10">
            Done
          </NeonButton>
        </div>
      </div>
    </Modal>
  );
}

function FoundRow({
  copy,
  card,
  onAdd,
  onDecline,
}: {
  copy: Copy;
  card: Card | undefined;
  onAdd: (quantity: number) => Promise<void>;
  onDecline: () => Promise<void>;
}) {
  const id = useId();
  const [asking, setAsking] = useState(false);
  const [count, setCount] = useState("1");
  const [busy, setBusy] = useState(false);
  const forSale = copy.homeKind === "box";
  const where = copy.homeName ?? (forSale ? "a box" : "a binder");
  const n = Math.floor(Number(count));
  const name = card ? cardLabel(card) : "this card";
  const valid = Number.isFinite(n) && n >= 1 && n <= copy.quantity;
  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">{card ? cardLabel(card) : "Loading the card…"}</p>
          <p className="text-sm text-ink-3">
            {forSale ? `For sale in ${where}` : `In ${where}`}
            {copy.quantity > 1 ? `, ${copy.quantity} copies` : ""}
            {copy.graded ? `, ${copy.graded.grader} ${copy.graded.grade}` : ""}
            {forSale ? ". Moving it here takes it off sale." : ""}
          </p>
        </div>
        {!asking && (
          <div className="flex flex-wrap gap-2">
            <NeonButton
              type="button"
              aria-label={`Add ${name} from ${where}`}
              aria-disabled={busy ? true : undefined}
              onClick={() => (copy.quantity > 1 ? setAsking(true) : void act(() => onAdd(1)))}
              className="min-h-10"
            >
              Add
            </NeonButton>
            <NeonButton
              type="button"
              variant="negative"
              outline
              aria-label={`Not for this binder: ${name}, in ${where}`}
              aria-disabled={busy ? true : undefined}
              onClick={() => void act(onDecline)}
              className="min-h-10"
            >
              Not for this binder
            </NeonButton>
          </div>
        )}
      </div>
      {asking && (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void act(() => onAdd(n));
          }}
        >
          <label className="block" htmlFor={`${id}-n`}>
            <span className="mb-1 block text-sm font-medium text-ink-2">How many of the {copy.quantity} to move?</span>
            <Input
              bare
              id={`${id}-n`}
              type="number"
              inputMode="numeric"
              min={1}
              max={copy.quantity}
              data-autofocus
              autoFocus
              aria-invalid={!valid || undefined}
              className="w-24 rounded-md px-3 py-2 text-base"
              value={count}
              onChange={(e) => setCount(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setAsking(false);
                }
              }}
            />
          </label>
          <NeonButton type="submit" aria-disabled={busy || !valid ? true : undefined} className="min-h-10">
            Move {valid ? n : ""} here
          </NeonButton>
          <NeonButton type="button" variant="negative" outline onClick={() => setAsking(false)} className="min-h-10">
            Cancel
          </NeonButton>
        </form>
      )}
    </li>
  );
}
