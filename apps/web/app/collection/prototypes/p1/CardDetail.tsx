import { useState } from "react";
import CardFace from "../_shared/CardFace";
import CopyDetailsForm from "../_shared/CopyDetailsForm";
import {
  emptyCopyDetails,
  evaluateRule,
  getPlayer,
  getSet,
  getTeam,
  setLabel,
  variantLabel,
  type Card,
  type Copy,
  type CopyDetails,
} from "../_shared/data";
import type { PrototypeStore } from "../_shared/usePrototypeStore";
import { FeatureBadges } from "./ChecklistRow";
import type { Notify } from "./notice";
import {
  QUIET_BUTTON,
  copySummary,
  liveryOn,
  printRunText,
  shortCardName,
  shortDate,
} from "./ui";

/**
 * Everything about one card for the collector: the card, its facts, every
 * copy they own (each editable in place), and a full "Add a copy" form so
 * grade, cost, location and binders can go in at the moment of adding.
 *
 * Used by the Find Cards drawer and the My Cards detail column, so a copy
 * edits the same way wherever the collector meets it.
 */
export default function CardDetail({
  card,
  store,
  notify,
  onCancelAdd,
  headingLevel = 3,
}: {
  card: Card;
  store: PrototypeStore;
  notify: Notify;
  /** Escape / Cancel in the add form. */
  onCancelAdd: () => void;
  headingLevel?: 3 | 4;
}) {
  const Sub = headingLevel === 3 ? "h3" : "h4";
  const copies = store.copiesOf(card.id);
  const owned = store.ownedCount(card.id);
  const set = getSet(card.setId);
  const team = getTeam(card.teamIds[0]);
  const run = printRunText(card);
  const binders = store.state.binders;
  const name = shortCardName(card);

  const [draft, setDraft] = useState<CopyDetails>(() => emptyCopyDetails());
  const [editing, setEditing] = useState<{ id: string; value: CopyDetails } | null>(null);

  const inBinders = binders.filter((b) =>
    b.kind === "smart"
      ? evaluateRule(b.rule, card)
      : copies.some((c) => c.binderIds.includes(b.id)),
  );

  const add = (value: CopyDetails) => {
    const copy = store.addCopy(card.id, value);
    notify(`Added ${name}${value.quantity > 1 ? ` ×${value.quantity}` : ""}`, () =>
      store.removeCopy(copy.id),
    );
    setDraft(emptyCopyDetails());
  };

  const save = (copy: Copy, value: CopyDetails) => {
    const before: CopyDetails = { ...copy };
    store.updateCopy(copy.id, value);
    setEditing(null);
    notify(`Saved your copy of ${name}`, () => store.updateCopy(copy.id, before));
  };

  const remove = (copy: Copy) => {
    const removed = store.removeCopy(copy.id);
    if (removed) notify(`Removed a copy of ${name}`, () => store.restoreCopy(removed));
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-[6.5rem_1fr] gap-4 sm:grid-cols-[9rem_1fr]">
        <CardFace card={card} size="fill" state={owned > 0 ? "owned" : "need"} />
        <div className="min-w-0 space-y-2 text-sm">
          <p className="text-base font-semibold text-slate-100">
            {owned > 0 ? `You have ${owned}` : "Need it"}
            <span className="sr-only">.</span>
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-slate-400">Set</dt>
            <dd className="text-slate-200">{setLabel(set)}</dd>
            <dt className="text-slate-400">{card.variantPath.type === "Base" ? "Type" : card.variantPath.type.slice(0, -1)}</dt>
            <dd className="text-slate-200">{variantLabel(card.variantPath)}</dd>
            <dt className="text-slate-400">Team</dt>
            <dd style={{ color: liveryOn(card) }}>
              {card.teamIds.map((id) => {
                const t = getTeam(id);
                return `${t.location} ${t.name}`;
              }).join(" / ") || `${team.location} ${team.name}`}
            </dd>
            <dt className="text-slate-400">{card.playerIds.length > 1 ? "Players" : "Player"}</dt>
            <dd className="text-slate-200">
              {card.playerIds
                .map((id) => {
                  const p = getPlayer(id);
                  return p.hallOfFame ? `${p.name} (HoF)` : p.name;
                })
                .join(", ")}
            </dd>
            {run && (
              <>
                <dt className="text-slate-400">Print run</dt>
                <dd className="text-slate-200">{run === "1/1" ? "1 of 1" : `Numbered ${run}`}</dd>
              </>
            )}
            {card.variation && (
              <>
                <dt className="text-slate-400">Variation</dt>
                <dd className="text-slate-200">{card.variation}</dd>
              </>
            )}
          </dl>
          <FeatureBadges card={card} />
          {inBinders.length > 0 && (
            <p className="text-slate-300">
              <span className="text-slate-400">In binders: </span>
              {inBinders.map((b) => (b.kind === "smart" ? `${b.name} (smart)` : b.name)).join(", ")}
            </p>
          )}
        </div>
      </div>

      <section aria-label={`Your copies of ${name}`} className="space-y-2">
        <Sub className="text-base font-semibold text-slate-100">
          Your copies{copies.length > 0 ? ` (${copies.length})` : ""}
        </Sub>
        {copies.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-700 px-3 py-2 text-sm text-slate-400">
            None yet. Fill in what you know below and add it.
          </p>
        ) : (
          <ul className="divide-y divide-slate-800 rounded-md border border-slate-800">
            {copies.map((copy, i) =>
              editing?.id === copy.id ? (
                <li key={copy.id} className="p-2">
                  <CopyDetailsForm
                    card={card}
                    value={editing.value}
                    onChange={(value) => setEditing({ id: copy.id, value })}
                    onSave={(value) => save(copy, value)}
                    onCancel={() => setEditing(null)}
                    binders={binders}
                    heading={`Edit copy ${i + 1}`}
                    saveLabel="Save copy"
                  />
                </li>
              ) : (
                <li key={copy.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block text-slate-200">{copySummary(copy)}</span>
                    <span className="block text-xs text-slate-400">
                      Added {shortDate(copy.acquiredAt)}
                      {copy.binderIds.length > 0 &&
                        ` · ${copy.binderIds
                          .map((id) => binders.find((b) => b.id === id)?.name)
                          .filter(Boolean)
                          .join(", ")}`}
                      {copy.notes && ` · “${copy.notes}”`}
                    </span>
                  </span>
                  <button
                    type="button"
                    className={QUIET_BUTTON}
                    aria-label={`Edit copy ${i + 1} of ${name}`}
                    onClick={() => setEditing({ id: copy.id, value: { ...copy } })}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className={`${QUIET_BUTTON} hover:text-neon-pink`}
                    aria-label={`Remove copy ${i + 1} of ${name}`}
                    onClick={() => remove(copy)}
                  >
                    Remove
                  </button>
                </li>
              ),
            )}
          </ul>
        )}
      </section>

      <CopyDetailsForm
        card={card}
        value={draft}
        onChange={setDraft}
        onSave={add}
        onCancel={() => {
          setDraft(emptyCopyDetails());
          onCancelAdd();
        }}
        binders={binders}
        heading={copies.length > 0 ? "Add another copy" : "Add a copy"}
        saveLabel="Add to collection"
      />
    </div>
  );
}
