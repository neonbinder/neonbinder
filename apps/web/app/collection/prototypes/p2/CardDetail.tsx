import { useEffect, useId, useRef, useState } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import CardFace from "../_shared/CardFace";
import CopyDetailsForm from "../_shared/CopyDetailsForm";
import {
  evaluateRule,
  getSet,
  leadTeam,
  playerNames,
  printRunLabel,
  setLabel,
  teamNames,
  teamTextColor,
  type Card,
  type CopyDetails,
  type CopyId,
} from "../_shared/data";
import type { PrototypeStore } from "../_shared/usePrototypeStore";
import Modal from "./Modal";
import { copyFacts, money, shortName } from "./model";
import type { StatusNote } from "./PackTray";

/**
 * The card slid out of its sleeve: big on the left, every copy you own on the
 * right, each one editable with the shared details form. Adding from a pocket
 * never asks for details; this is where they go, whenever you feel like it.
 */

const FEATURE_WORDS: Record<string, string> = {
  RC: "Rookie card",
  AU: "Autograph",
  Relic: "Relic",
  SP: "Short print",
};

interface CardDetailProps {
  card: Card;
  store: PrototypeStore;
  onClose: () => void;
  onStatus: (note: Omit<StatusNote, "id">) => void;
  reducedMotion: boolean;
  fallbackFocus: () => HTMLElement | null;
}

export default function CardDetail({ card, store, onClose, onStatus: tellPage, fallbackFocus }: CardDetailProps) {
  const titleId = useId();
  // The page's status line sits behind this modal (inert), so the dialog
  // carries its own, with its own Undo. The page keeps the note for later.
  const [note, setNote] = useState<Omit<StatusNote, "id"> | null>(null);
  const onStatus = (n: Omit<StatusNote, "id">) => {
    setNote(n);
    tellPage(n);
  };
  const copies = store.copiesOf(card.id);
  const [editing, setEditing] = useState<{ id: CopyId; draft: CopyDetails } | null>(null);
  const team = leadTeam(card);
  const owned = copies.reduce((n, c) => n + c.quantity, 0);
  const smartHomes = store.state.binders.filter(
    (b) => b.kind === "smart" && evaluateRule(b.rule, card),
  );
  const binderName = (id: string) => store.getBinder(id)?.name ?? "a binder";
  const features = card.features.map((f) => FEATURE_WORDS[f] ?? f);
  const run = printRunLabel(card);

  // The control that held focus often unmounts (Edit swaps for the form, the
  // form swaps back, Remove drops the row), so say where focus goes next.
  const bodyRef = useRef<HTMLDivElement>(null);
  const focusNext = useRef<{ to: "form" } | { to: "edit"; id: CopyId } | { to: "add" } | null>(null);
  useEffect(() => {
    const next = focusNext.current;
    if (!next || !bodyRef.current) return;
    focusNext.current = null;
    const root = bodyRef.current;
    const target =
      next.to === "form"
        ? root.querySelector<HTMLElement>("form input, form select")
        : next.to === "edit"
          ? root.querySelector<HTMLElement>(`[data-edit="${next.id}"]`)
          : null;
    (target ?? root.querySelector<HTMLElement>("[data-add-copy]"))?.focus();
  });
  const closeForm = (id: CopyId) => {
    focusNext.current = { to: "edit", id };
    setEditing(null);
  };

  const startEdit = (id: CopyId) => {
    const copy = copies.find((c) => c.id === id);
    if (!copy) return;
    const { id: _id, cardId: _cardId, ...details } = copy;
    void _id;
    void _cardId;
    focusNext.current = { to: "form" };
    setEditing({ id, draft: details });
  };

  const addAnother = () => {
    const copy = store.addCopy(card.id);
    onStatus({
      text: `Another ${shortName(card)} in the pile. Add its details below, or don't.`,
      undo: () => store.removeCopy(copy.id),
    });
    const { id: _id, cardId: _cardId, ...details } = copy;
    void _id;
    void _cardId;
    focusNext.current = { to: "form" };
    setEditing({ id: copy.id, draft: details });
  };

  const remove = (id: CopyId) => {
    const gone = store.removeCopy(id);
    if (!gone) return;
    if (editing?.id === id) setEditing(null);
    focusNext.current = { to: "add" };
    onStatus({
      text: `Pulled a ${shortName(card)} out of your collection.`,
      undo: () => store.restoreCopy(gone),
    });
  };

  return (
    <Modal labelledBy={titleId} onClose={onClose} className="max-w-3xl" fallbackFocus={fallbackFocus}>
      <div className="relative grid gap-5 p-4 sm:grid-cols-[15rem_1fr] sm:p-6">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 inline-flex h-10 w-10 items-center justify-center rounded-md text-slate-300 hover:bg-slate-800 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]"
        >
          <XMarkIcon aria-hidden="true" className="h-5 w-5" />
        </button>

        <div className="mx-auto w-40 sm:w-60">
          <div className="p2-slide-out">
            <CardFace card={card} size="fill" state={owned ? "owned" : "need"} />
          </div>
        </div>

        <div ref={bodyRef} className="min-w-0 pr-8">
          <h2 id={titleId} className="text-2xl font-bold leading-tight">
            <span style={{ color: teamTextColor(team, "#020617") }}>{playerNames(card)}</span>
          </h2>
          <p className="mt-1 text-slate-300">
            {setLabel(getSet(card.setId))}
            {card.variantPath.name ? ` ${card.variantPath.name}` : ""} #{card.cardNumber}
            {card.variation ? `, ${card.variation} variation` : ""}
          </p>
          <p className="mt-1 text-sm text-slate-400">
            {[teamNames(card), run ? `Numbered ${run}` : null, ...features].filter(Boolean).join(", ")}
          </p>

          <p className="mt-4 font-bold text-white">
            {owned === 0
              ? "Not in your collection yet."
              : owned === 1
                ? "You have 1."
                : `You have ${owned}.`}
          </p>

          <div className={note ? "mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-slate-900 px-3 py-2" : ""}>
            <p role="status" className="min-w-0 flex-1 basis-48 text-sm text-slate-100">
              {note?.text}
            </p>
            {note?.undo && (
              <button
                type="button"
                onClick={() => {
                  note.undo?.();
                  setNote({ text: "Undone." });
                  tellPage({ text: "Undone." });
                }}
                className="min-h-8 rounded-md bg-neon-blue px-3 text-sm font-bold text-black hover:bg-[#4dd5ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                Undo
              </button>
            )}
          </div>

          <ul className="mt-3 space-y-3" aria-label="Your copies">
            {copies.map((copy, i) =>
              editing?.id === copy.id ? (
                <li key={copy.id}>
                  <CopyDetailsForm
                    card={card}
                    value={editing.draft}
                    onChange={(draft) => setEditing({ id: copy.id, draft })}
                    onSave={(value) => {
                      store.updateCopy(copy.id, value);
                      closeForm(copy.id);
                      onStatus({ text: `Saved the details on ${shortName(card)}.` });
                    }}
                    onCancel={() => closeForm(copy.id)}
                    binders={store.state.binders}
                    heading={`Copy ${i + 1}`}
                    saveLabel="Save details"
                  />
                </li>
              ) : (
                <li key={copy.id} className="rounded-lg border border-slate-700 bg-slate-900 p-3">
                  <p className="text-sm font-bold text-white">
                    Copy {i + 1}
                    {copy.quantity > 1 ? `, a stack of ${copy.quantity}` : ""}
                    {copy.forSale ? (
                      <span className="ml-2 rounded bg-neon-yellow px-1.5 py-0.5 text-xs text-black">
                        For sale{copy.askPrice !== undefined ? ` at ${money(copy.askPrice)}` : ""}
                      </span>
                    ) : null}
                  </p>
                  <ul className="mt-1 text-sm text-slate-300">
                    {copyFacts(copy, card).map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                    {copy.binderIds.length > 0 && (
                      <li>Filed in: {copy.binderIds.map(binderName).join(", ")}</li>
                    )}
                  </ul>
                  {copy.notes && <p className="mt-1 text-sm italic text-slate-300">{copy.notes}</p>}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      data-edit={copy.id}
                      onClick={() => startEdit(copy.id)}
                      aria-label={`Edit details of copy ${i + 1}`}
                      className="min-h-9 rounded-md bg-neon-green px-3 text-sm font-bold text-black hover:bg-[#33e07c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                    >
                      Edit details
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(copy.id)}
                      aria-label={`Remove copy ${i + 1}`}
                      className="min-h-9 rounded-md border border-neon-pink px-3 text-sm font-medium text-neon-pink hover:bg-neon-pink hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]"
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ),
            )}
          </ul>

          {smartHomes.length > 0 && (
            <p className="mt-3 text-sm text-slate-300">
              Smart binders it shows up in: {smartHomes.map((b) => b.name).join(", ")}.
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              data-add-copy
              onClick={addAnother}
              className="min-h-10 rounded-md border border-neon-green px-4 text-sm font-bold text-neon-green hover:bg-neon-green hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]"
            >
              {owned ? "Add another copy" : "Add it"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="min-h-10 rounded-md px-4 text-sm text-slate-300 underline underline-offset-4 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]"
            >
              Back in the sleeve
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
