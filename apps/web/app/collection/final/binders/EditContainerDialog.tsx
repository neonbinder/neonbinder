import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Input } from "@/components/primitives/Input";
import Modal from "../../prototypes/p2/Modal";
import type { Container, ContainerPatch } from "../data/types";
import { cardCount } from "./model";
import NeonButton from "@/components/modules/NeonButton";

/**
 * NEO-359 — "Rename or delete", from a binder's settings or a box's cover, for one the
 * collector made (Main, the Want List and Up for Trade have neither).
 *
 * Deleting is a second step inside the dialog, and it says what happens:
 * a binder's cards go back to Main, a box's into Unsorted, still for sale
 * (out of their pockets or rows, trade flags kept), and there is no undo,
 * because the store keeps none.
 *
 * Both writes wait in the dialog: while one is out its buttons say busy and
 * ignore presses (`aria-disabled`, never native `disabled`, so focus stays
 * put), and a refusal is said inside the dialog, tied to the button that
 * asked. On success the caller closes it.
 */

export default function EditContainerDialog({
  container,
  onSave,
  onDelete,
  onClose,
}: {
  container: Container;
  /** Resolves with null when saved (the caller closes the dialog), or why it was refused. */
  onSave: (patch: ContainerPatch) => Promise<string | null>;
  /** Resolves with null when deleted (the caller closes the dialog), or why it was refused. */
  onDelete: () => Promise<string | null>;
  onClose: () => void;
}) {
  const titleId = useId();
  const confirmId = useId();
  const errorId = useId();
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setTried(true);
    if (!trimmed) return;
    const patch: ContainerPatch = {};
    if (trimmed !== container.name) patch.name = trimmed;
    if (description.trim() !== (container.description ?? "")) patch.description = description.trim();
    if (Object.keys(patch).length === 0) return onClose();
    setError(null);
    setBusy("save");
    const refused = await onSave(patch);
    setBusy(null);
    if (refused) setError(refused);
  }

  async function remove() {
    if (busy) return;
    setError(null);
    setBusy("delete");
    const refused = await onDelete();
    setBusy(null);
    if (refused) setError(refused);
  }

  const errorLine = (
    <p id={errorId} role="alert" className="mt-3 text-sm text-neon-pink-text empty:hidden">
      {error ?? ""}
    </p>
  );
  /** A button that waits on a write: says busy, ignores presses, keeps focus. */
  const waiting = (which: "save" | "delete") => ({
    "aria-disabled": busy ? true : undefined,
    "aria-busy": busy === which ? true : undefined,
    "aria-describedby": error && busy === null ? errorId : undefined,
  });

  // Where the cards land, in the status line's words: a box's go to
  // Unsorted and stay for sale (the inventory's Main), a binder's to Main.
  const goes =
    n === 0
      ? "It's empty, so nothing moves."
      : container.kind === "box"
        ? `${n === null ? "Every card in it goes" : n === 1 ? "Its 1 card goes" : `Its ${cardCount(n)} go`} into Unsorted, still for sale.`
        : `${n === null ? "Every card in it goes" : n === 1 ? "Its 1 card goes" : `Its ${cardCount(n)} go`} back to Main.`;

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
          <p id={confirmId} className="mt-2 text-ink-2">
            {goes} You can&apos;t undo this.
          </p>
          {errorLine}
          <div className="mt-6 flex flex-wrap justify-end gap-3">
            <NeonButton
              ref={keepRef}
              type="button"
              variant="secondary"
              outline
              aria-describedby={confirmId}
              onClick={() => {
                if (!busy) setConfirming(false);
              }}
              className="min-h-10 max-sm:min-h-11"
            >
              Keep it
            </NeonButton>
            <NeonButton type="button" variant="negative" onClick={() => void remove()} {...waiting("delete")} className="min-h-10 max-sm:min-h-11">
              Yes, delete it
            </NeonButton>
          </div>
        </div>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="p-5" noValidate>
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
            {/* NEO-360 — a binder's share link is its own; a rename never moves it. */}
            {container.slug && (
              <p className="text-sm text-ink-2">Renaming keeps its share link. Change the link from Share.</p>
            )}
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <NeonButton
              ref={deleteRef}
              type="button"
              variant="negative"
              outline
              onClick={() => {
                if (busy) return;
                setError(null);
                setConfirming(true);
              }}
              aria-disabled={busy ? true : undefined}
              className="min-h-10 max-sm:min-h-11"
            >
              Delete this {noun}
            </NeonButton>
            <div className="ml-auto flex flex-wrap gap-3">
              <NeonButton type="button" variant="negative" outline onClick={onClose} className="min-h-10 max-sm:min-h-11">
                Cancel
              </NeonButton>
              <NeonButton type="submit" {...waiting("save")} className="min-h-10 max-sm:min-h-11">
                Save
              </NeonButton>
            </div>
          </div>
          {errorLine}
        </form>
      )}
    </Modal>
  );
}
