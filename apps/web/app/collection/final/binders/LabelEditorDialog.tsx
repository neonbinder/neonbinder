import { useId, useState, type FormEvent } from "react";
import Modal from "../../prototypes/p2/Modal";
import type { CollectionBinder } from "../store";
import { defaultLabel, labelOf, validLabel, type BinderLabel } from "./label";
import LabelDesigner from "./LabelDesigner";

/**
 * "Edit label", from an open binder's cover: restyle its spine. Saving a
 * label that matches the binder's default stores nothing, so a smart binder
 * keeps following its rule's team.
 */

function sameLabel(a: BinderLabel, b: BinderLabel): boolean {
  return (
    a.background.toLowerCase() === b.background.toLowerCase() &&
    a.text.toLowerCase() === b.text.toLowerCase() &&
    a.fontId === b.fontId
  );
}

export default function LabelEditorDialog({
  binder,
  onSave,
  onClose,
}: {
  binder: CollectionBinder;
  /** Null: back to the default. */
  onSave: (label: BinderLabel | null) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const [draft, setDraft] = useState<BinderLabel>(() => labelOf(binder));
  const [error, setError] = useState<string | null>(null);
  const fallback = defaultLabel(binder);

  function submit(e: FormEvent) {
    e.preventDefault();
    const label = validLabel(draft);
    if (!label) {
      setError("Both colors need to be hex, like #203731.");
      return;
    }
    onSave(sameLabel(label, fallback) ? null : label);
  }

  return (
    <Modal labelledBy={titleId} onClose={onClose} className="max-w-xl">
      <form onSubmit={submit} className="p-5">
        <h2 id={titleId} className="text-xl font-bold text-white">
          Spine label for {binder.name}
        </h2>
        <p className="mt-1 text-sm text-slate-300">Colors and lettering, the way the Print Shop does them.</p>

        <div className="mt-4">
          <LabelDesigner
            name={binder.name}
            draft={draft}
            onChange={(next) => {
              setDraft(next);
              setError(null);
            }}
          />
        </div>

        <p role="alert" className="mt-3 text-sm text-amber-300 empty:hidden">
          {error ?? ""}
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => {
              setDraft(fallback);
              setError(null);
            }}
            className="mr-auto min-h-10 rounded-md px-1 text-sm text-slate-300 underline underline-offset-4 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]"
          >
            Back to the default
          </button>
          <button
            type="button"
            onClick={onClose}
            className="min-h-10 rounded-md border border-slate-600 px-4 text-sm font-medium text-slate-200 hover:border-slate-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="min-h-10 rounded-md bg-neon-green px-4 text-sm font-bold text-black hover:bg-[#33e07c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
          >
            Save label
          </button>
        </div>
      </form>
    </Modal>
  );
}
