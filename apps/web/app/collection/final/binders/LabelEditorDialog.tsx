import { useId, useState, type FormEvent } from "react";
import Modal from "../../prototypes/p2/Modal";
import type { CollectionBinder } from "../store";
import { binderTeamPicks, defaultLabel, labelOf, sameLabel, validLabel, type BinderLabel } from "./label";
import LabelDesigner from "./LabelDesigner";
import NeonButton from "@/components/modules/NeonButton";

/**
 * "Edit label", from an open binder's cover: restyle its spine. Saving a
 * label that matches the binder's default stores nothing, so a smart binder
 * keeps following its rule: the team it names, else the team on most of its
 * cards. A smart binder's teams are offered as quick picks (the rule's own
 * team first); picking the one that is already its default and saving
 * stores nothing either.
 */

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
  const [teamPicks] = useState(() => binderTeamPicks(binder));

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
        <h2 id={titleId} className="text-xl font-bold text-ink">
          Spine label for {binder.name}
        </h2>
        <p className="mt-1 text-sm text-ink-2">Colors and lettering, the way the Print Shop does them.</p>

        <div className="mt-4">
          <LabelDesigner
            name={binder.name}
            draft={draft}
            teamPicks={teamPicks}
            onChange={(next) => {
              setDraft(next);
              setError(null);
            }}
          />
        </div>

        <p role="alert" className="mt-3 text-sm text-notice-warn-ink empty:hidden">
          {error ?? ""}
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => {
              setDraft(fallback);
              setError(null);
            }}
            className="mr-auto min-h-10 rounded-md px-1 text-sm text-ink-2 underline underline-offset-4 hover:text-ink focus-outline"
          >
            Back to the default
          </button>
          <NeonButton type="button" variant="negative" outline onClick={onClose} className="min-h-10">
            Cancel
          </NeonButton>
          <NeonButton type="submit" className="min-h-10">
            Save label
          </NeonButton>
        </div>
      </form>
    </Modal>
  );
}
