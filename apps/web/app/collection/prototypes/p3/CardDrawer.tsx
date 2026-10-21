import { useState } from "react";
import { PencilSquareIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import CardFace from "../_shared/CardFace";
import CopyDetailsForm from "../_shared/CopyDetailsForm";
import {
  cardLabel,
  emptyCopyDetails,
  getSet,
  leadTeam,
  playerNames,
  setLabel,
  teamNames,
  teamTextColor,
  type Card,
  type Copy,
  type CopyDetails,
} from "../_shared/data";
import P3Dialog from "./Dialog";
import { useP3 } from "./context";
import { useMediaQuery } from "./hooks";

/**
 * NEO-350 prototype 3 — the "⋯" drawer: the card face, every copy you hold
 * of it, and the full details form for adding or editing one.
 */

type Mode =
  | { kind: "list" }
  | { kind: "add"; value: CopyDetails }
  | { kind: "edit"; copyId: string; value: CopyDetails };

export interface CardDrawerProps {
  card: Card;
  adding?: boolean;
  note?: string;
  onClose: () => void;
}

export default function CardDrawer({ card, adding, note, onClose }: CardDrawerProps) {
  const api = useP3();
  const { store } = api;
  const copies = store.copiesOf(card.id);
  const owned = store.ownedCount(card.id);
  const wide = useMediaQuery("(min-width: 640px)");
  const [mode, setMode] = useState<Mode>(
    adding || copies.length === 0
      ? { kind: "add", value: emptyCopyDetails() }
      : { kind: "list" },
  );
  const team = leadTeam(card);
  const set = getSet(card.setId);

  function save(value: CopyDetails) {
    if (mode.kind === "add") {
      const copy = store.addCopy(card.id, value);
      api.notify(
        `Added ${value.quantity > 1 ? `${value.quantity}× ` : ""}${card.variantPath.name ?? "Base"} #${card.cardNumber} ${playerNames(card)}.`,
        () => store.removeCopy(copy.id),
      );
    } else if (mode.kind === "edit") {
      const before = copies.find((c) => c.id === mode.copyId);
      store.updateCopy(mode.copyId, value);
      api.notify(
        "Copy details saved.",
        before ? () => store.updateCopy(before.id, before) : undefined,
      );
    }
    setMode({ kind: "list" });
  }

  return (
    <P3Dialog title={playerNames(card)} subtitle={cardLabel(card)} onClose={onClose}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <CardFace
          card={card}
          size={wide ? "md" : "sm"}
          state={owned > 0 ? "owned" : "need"}
          className="mx-auto sm:mx-0"
        />
        <dl className="grid flex-1 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-slate-400">Set</dt>
          <dd className="text-slate-100">{setLabel(set)}</dd>
          <dt className="text-slate-400">Row</dt>
          <dd className="text-slate-100">
            {card.variantPath.name ?? "Base"}
            {card.printRun !== null && ` (${card.printRun === 1 ? "1/1" : `/${card.printRun}`})`}
          </dd>
          <dt className="text-slate-400">Team</dt>
          <dd className="font-medium" style={{ color: teamTextColor(team, "#020617") }}>
            {teamNames(card)}
          </dd>
          {card.variation && (
            <>
              <dt className="text-slate-400">Variation</dt>
              <dd className="text-slate-100">{card.variation}</dd>
            </>
          )}
          {card.features.length > 0 && (
            <>
              <dt className="text-slate-400">Flags</dt>
              <dd className="text-slate-100">{card.features.join(", ")}</dd>
            </>
          )}
          <dt className="text-slate-400">Status</dt>
          <dd className={owned > 0 ? "font-bold text-neon-blue" : "font-bold text-slate-200"}>
            {owned > 0 ? `Have ${owned}` : "Need"}
          </dd>
        </dl>
      </div>

      {note && (
        <p className="mt-4 rounded-md border border-neon-yellow/60 bg-neon-yellow/10 px-3 py-2 text-sm text-neon-yellow">
          {note}
        </p>
      )}

      {copies.length > 0 && (
        <section aria-label="Your copies" className="mt-5">
          <h3 className="text-sm font-bold text-slate-200">
            Your copies <span className="font-normal text-slate-400">({copies.length})</span>
          </h3>
          <ul className="mt-2 flex flex-col gap-2">
            {copies.map((copy, i) => (
              <CopyRow
                key={copy.id}
                copy={copy}
                index={i + 1}
                editing={mode.kind === "edit" && mode.copyId === copy.id}
                onEdit={() => {
                  const { id: _id, cardId: _card, ...details } = copy;
                  void _id;
                  void _card;
                  setMode({ kind: "edit", copyId: copy.id, value: details });
                }}
                onRemove={() => api.removeCopy(copy)}
              />
            ))}
          </ul>
        </section>
      )}

      {mode.kind === "list" ? (
        <button
          type="button"
          onClick={() => setMode({ kind: "add", value: emptyCopyDetails() })}
          className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-md border border-neon-green px-4 text-sm font-medium text-neon-green hover:bg-neon-green hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] sm:min-h-9"
        >
          <PlusIcon aria-hidden="true" className="size-4" />
          {owned > 0 ? "Add another copy" : "Add to my collection"}
        </button>
      ) : (
        <CopyDetailsForm
          className="mt-4"
          card={card}
          value={mode.value}
          onChange={(value) => setMode({ ...mode, value })}
          onSave={save}
          onCancel={() => (copies.length === 0 ? onClose() : setMode({ kind: "list" }))}
          binders={store.state.binders}
          heading={mode.kind === "add" ? (owned > 0 ? "Another copy" : "Add it") : "Edit this copy"}
          saveLabel={mode.kind === "add" ? "Add to my collection" : "Save changes"}
        />
      )}
    </P3Dialog>
  );
}

function CopyRow({
  copy,
  index,
  editing,
  onEdit,
  onRemove,
}: {
  copy: Copy;
  index: number;
  editing: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const api = useP3();
  const binderNames = copy.binderIds
    .map((id) => api.store.getBinder(id)?.name)
    .filter(Boolean)
    .join(", ");
  const facts = [
    copy.quantity > 1 ? `${copy.quantity} cards` : null,
    copy.graded
      ? `${copy.graded.grader} ${copy.graded.grade}${copy.graded.cert ? `, cert ${copy.graded.cert}` : ""}`
      : `Raw${copy.condition ? `, ${copy.condition}` : ""}`,
    copy.serialNumber ? `Serial ${copy.serialNumber}` : null,
    copy.location ? `In ${copy.location}` : null,
    copy.costBasis !== undefined ? `Paid $${copy.costBasis}` : null,
  ].filter(Boolean);
  const name = `copy ${index}`;
  return (
    <li
      className={`flex items-start gap-3 rounded-lg border px-3 py-2 ${editing ? "border-neon-blue" : "border-slate-800"} bg-slate-900/60`}
    >
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium text-slate-100">{facts.join(". ")}</p>
        <p className="text-slate-400">
          Got it {copy.acquiredAt}
          {binderNames && `. Binders: ${binderNames}`}
        </p>
        {copy.notes && <p className="mt-0.5 italic text-slate-300">“{copy.notes}”</p>}
      </div>
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit ${name}`}
        className="grid size-11 place-items-center rounded-md text-slate-300 hover:bg-slate-800 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] sm:size-8"
      >
        <PencilSquareIcon aria-hidden="true" className="size-4" />
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${name}`}
        className="grid size-11 place-items-center rounded-md text-neon-pink hover:bg-neon-pink hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] sm:size-8"
      >
        <TrashIcon aria-hidden="true" className="size-4" />
      </button>
    </li>
  );
}
