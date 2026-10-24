import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Input } from "@/components/primitives/Input";
import Modal from "../../prototypes/p2/Modal";
import type { Container, ContainerPatch } from "../data/types";
import { cardCount } from "./model";
import NeonButton from "@/components/modules/NeonButton";

/**
 * NEO-359 — "Rename or delete", from the cover of a binder or box the
 * collector made (Main, the Want List and Up for Trade have neither).
 *
 * Deleting is a second step inside the dialog, and it says what happens:
 * the cards go back to Main (out of their pockets or rows, trade flags kept)
 * and there is no undo, because the store keeps none.
 */

export default function EditContainerDialog({
  container,
  onSave,
  onDelete,
  onClose,
}: {
  container: Container;
  onSave: (patch: ContainerPatch) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const [name, setName] = useState(container.name);
  const [description, setDescription] = useState(container.description ?? "");
  const [tried, setTried] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  const noun = container.kind === "box" ? "box" : "binder";
  const trimmed = name.trim();
  const n = container.count?.copies ?? null;

  // Into the confirm, focus its safe answer; back out of it, the button that opened it.
  useEffect(() => {
    if (confirming) keepRef.current?.focus();
    else if (wasConfirming.current) deleteRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (!trimmed) return;
    const patch: ContainerPatch = {};
    if (trimmed !== container.name) patch.name = trimmed;
    if (description.trim() !== (container.description ?? "")) patch.description = description.trim();
    if (Object.keys(patch).length === 0) return onClose();
    onSave(patch);
  }

  const goes =
    n === null
      ? "Every card in it goes back to Main."
      : n === 0
        ? "It's empty, so nothing moves."
        : `${n === 1 ? "Its 1 card goes" : `Its ${cardCount(n)} go`} back to Main.`;

  return (
    <Modal labelledBy={titleId} onClose={onClose} className="max-w-lg">
      {confirming ? (
        <div
          className="p-5"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              // Escape steps back out of the confirm, not the whole dialog.
              e.stopPropagation();
              setConfirming(false);
            }
          }}
        >
          <h2 id={titleId} className="text-xl font-bold text-ink">
            Delete {container.name}?
          </h2>
          <p className="mt-2 text-ink-2">
            {goes} You can&apos;t undo this.
          </p>
          <div className="mt-6 flex flex-wrap justify-end gap-3">
            <NeonButton ref={keepRef} type="button" variant="secondary" outline onClick={() => setConfirming(false)} className="min-h-10">
              Keep it
            </NeonButton>
            <NeonButton type="button" variant="negative" onClick={onDelete} className="min-h-10">
              Yes, delete it
            </NeonButton>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="p-5" noValidate>
          <h2 id={titleId} className="text-xl font-bold text-ink">
            Rename or delete {container.name}
          </h2>
          <div className="mt-4 space-y-3">
            <Input
              label={container.kind === "box" ? "Box name" : "Binder name"}
              value={name}
              onChange={(e) => setName(e.target.value)}
              error={tried && !trimmed ? `Give the ${noun} a name.` : undefined}
              data-autofocus
            />
            <Input
              label="What's in it (optional)"
              placeholder={container.kind === "box" ? "Dupes for the card show" : "My Packers PC, every year"}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <NeonButton
              ref={deleteRef}
              type="button"
              variant="negative"
              outline
              onClick={() => setConfirming(true)}
              className="min-h-10"
            >
              Delete this {noun}
            </NeonButton>
            <div className="ml-auto flex flex-wrap gap-3">
              <NeonButton type="button" variant="negative" outline onClick={onClose} className="min-h-10">
                Cancel
              </NeonButton>
              <NeonButton type="submit" className="min-h-10">
                Save
              </NeonButton>
            </div>
          </div>
        </form>
      )}
    </Modal>
  );
}
