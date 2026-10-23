import { useEffect, useRef, useState } from "react";
import { StarIcon as StarSolid } from "@heroicons/react/20/solid";
import { StarIcon as StarOutline } from "@heroicons/react/24/outline";
import CardFace from "../prototypes/_shared/CardFace";
import CopyDetailsForm from "../prototypes/_shared/CopyDetailsForm";
import {
  emptyCopyDetails,
  evaluateRule,
  getPlayer,
  getSet,
  getTeam,
  setLabel,
  variantLabel,
  type BinderId,
  type Card,
  type Copy,
  type CopyDetails,
  type CopyId,
} from "../prototypes/_shared/data";
import { FeatureBadges } from "../prototypes/p1/ChecklistRow";
import { FOCUS, QUIET_BUTTON, liveryOn, useLiverySurface, printRunText, shortCardName, shortDate } from "../prototypes/p1/ui";
import { lineNames, lineSummary } from "./lineItems";
import type { CollectionStore, Notify } from "./store";

/**
 * Everything about one card: the card, its facts, the Want toggle, every
 * line item you own (each editable in place), and an "Add a copy" form so
 * grade, cost, location and binders go in at the moment of adding. The
 * form's binders are Main, Up for Trade and your own manual binders, with
 * the current "Binder" pick ticked.
 */
export default function CardDetail({
  card,
  store,
  notify,
  onCancelAdd,
  mode = "view",
  focusCopyId,
  addBinderId,
}: {
  card: Card;
  store: CollectionStore;
  notify: Notify;
  /** Escape / Cancel in the add form. */
  onCancelAdd: () => void;
  /** "add" scrolls to the Add a copy form and puts the caret in it. */
  mode?: "view" | "add";
  /** Ring this line item in "Your copies". */
  focusCopyId?: CopyId;
  /**
   * Tick this binder in the add form instead of the page's target (the
   * binder a want is for). Ignored unless a copy can be filed there.
   */
  addBinderId?: BinderId;
}) {
  const copies = store.copiesOf(card.id);
  const owned = store.ownedCount(card.id);
  const set = getSet(card.setId);
  const team = getTeam(card.teamIds[0]);
  const panel = useLiverySurface("raised");
  const run = printRunText(card);
  const binders = store.state.binders;
  const formBinders = store.fileableBinders;
  const name = shortCardName(card);
  const names = lineNames(copies, binders);
  const wanted = store.isWanted(card.id);
  const wantsFor = store.wants.filter((w) => w.cardId === card.id);

  const addTo =
    addBinderId && formBinders.some((b) => b.id === addBinderId) ? addBinderId : store.targetBinderId;
  const freshDraft = (): CopyDetails => ({ ...emptyCopyDetails(), binderIds: [addTo] });
  const [draft, setDraft] = useState<CopyDetails>(freshDraft);
  const [editing, setEditing] = useState<{ id: string; value: CopyDetails } | null>(null);

  const addRef = useRef<HTMLDivElement>(null);
  const copyRefs = useRef(new Map<CopyId, HTMLLIElement>());
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (mode === "add") {
        addRef.current?.scrollIntoView({ block: "start" });
        addRef.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
      } else if (focusCopyId) {
        copyRefs.current.get(focusCopyId)?.scrollIntoView({ block: "nearest" });
      }
    });
    return () => cancelAnimationFrame(frame);
    // Once per open: the drawer remounts this per card and per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inBinders = binders.filter((b) =>
    b.kind === "smart"
      ? evaluateRule(b.rule, card)
      : copies.some((c) => c.binderIds.includes(b.id)),
  );

  const add = (value: CopyDetails) => {
    const { copy, merged, undo } = store.addLineItem(card.id, value);
    notify(
      merged
        ? `Stacked it: ${name} is ×${copy.quantity} now`
        : `Added ${name}, ${lineSummary(copy, binders)}`,
      undo,
    );
    setDraft(freshDraft());
  };

  const save = (copy: Copy, value: CopyDetails) => {
    const before: CopyDetails = { ...copy };
    store.updateCopy(copy.id, value);
    setEditing(null);
    notify(`Saved ${name}, ${lineSummary({ ...copy, ...value }, binders)}`, () =>
      store.updateCopy(copy.id, before),
    );
  };

  const remove = (copy: Copy) => {
    const removed = store.removeCopy(copy.id);
    if (removed) {
      notify(`Removed ${name}, ${lineSummary(removed, binders)}`, () => store.restoreCopy(removed));
    }
  };

  const toggleWant = () => {
    const undo = store.toggleWant(card.id);
    notify(wanted ? `${name} is off your Want List` : `${name} is on your Want List`, undo);
  };

  const wantWhere = wantsFor
    .map((w) => (w.binderId ? `for ${store.getBinder(w.binderId)?.name ?? "a binder"}` : "for the collection"))
    .join(", ");

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-[6.5rem_1fr] gap-4 sm:grid-cols-[9rem_1fr]">
        <CardFace card={card} size="fill" state={owned > 0 ? "owned" : "need"} />
        <div className="min-w-0 space-y-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-base font-semibold text-ink">
              {owned > 0 ? `You have ${owned}` : "Need it"}
              <span className="sr-only">.</span>
            </p>
            <button
              type="button"
              aria-pressed={wanted}
              onClick={toggleWant}
              className={`inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-semibold ${FOCUS} ${
                wanted
                  ? "border-neon-yellow-text bg-neon-yellow/10 text-neon-yellow-text"
                  : "border-control text-ink-2 hover:border-ink-3 hover:text-ink"
              }`}
            >
              {wanted ? (
                <StarSolid aria-hidden="true" className="h-4 w-4" />
              ) : (
                <StarOutline aria-hidden="true" className="h-4 w-4" />
              )}
              Want
            </button>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-ink-3">Set</dt>
            <dd className="text-ink-2">{setLabel(set)}</dd>
            <dt className="text-ink-3">{card.variantPath.type === "Base" ? "Type" : card.variantPath.type.slice(0, -1)}</dt>
            <dd className="text-ink-2">{variantLabel(card.variantPath)}</dd>
            <dt className="text-ink-3">Team</dt>
            <dd style={{ color: liveryOn(card, panel) }}>
              {card.teamIds
                .map((id) => {
                  const t = getTeam(id);
                  return `${t.location} ${t.name}`;
                })
                .join(" / ") || `${team.location} ${team.name}`}
            </dd>
            <dt className="text-ink-3">{card.playerIds.length > 1 ? "Players" : "Player"}</dt>
            <dd className="text-ink-2">
              {card.playerIds
                .map((id) => {
                  const p = getPlayer(id);
                  return p.hallOfFame ? `${p.name} (HoF)` : p.name;
                })
                .join(", ")}
            </dd>
            {run && (
              <>
                <dt className="text-ink-3">Print run</dt>
                <dd className="text-ink-2">{run === "1/1" ? "1 of 1" : `Numbered ${run}`}</dd>
              </>
            )}
            {card.variation && (
              <>
                <dt className="text-ink-3">Variation</dt>
                <dd className="text-ink-2">{card.variation}</dd>
              </>
            )}
          </dl>
          <FeatureBadges card={card} />
          {inBinders.length > 0 && (
            <p className="text-ink-2">
              <span className="text-ink-3">In binders: </span>
              {inBinders.map((b) => (b.kind === "smart" ? `${b.name} (smart)` : b.name)).join(", ")}
            </p>
          )}
          {wantsFor.length > 0 && (
            <p className="text-ink-2">
              <span className="text-ink-3">Wanted: </span>
              {wantWhere}
            </p>
          )}
        </div>
      </div>

      <section aria-label={`Your copies of ${name}`} className="space-y-2">
        <h3 className="text-base font-semibold text-ink">
          Your copies{copies.length > 0 ? ` (${copies.length} ${copies.length === 1 ? "line" : "lines"})` : ""}
        </h3>
        {copies.length === 0 ? (
          <p className="rounded-md border border-dashed border-rule-strong px-3 py-2 text-sm text-ink-3">
            None yet. Fill in what you know below and add it.
          </p>
        ) : (
          <ul className="divide-y divide-rule rounded-md border border-rule">
            {copies.map((copy, i) =>
              editing?.id === copy.id ? (
                <li key={copy.id} className="p-2">
                  <CopyDetailsForm
                    card={card}
                    value={editing.value}
                    onChange={(value) => setEditing({ id: copy.id, value })}
                    onSave={(value) => save(copy, value)}
                    onCancel={() => setEditing(null)}
                    binders={formBinders}
                    heading={`Edit ${names[i]}`}
                    saveLabel="Save copy"
                  />
                </li>
              ) : (
                <li
                  key={copy.id}
                  ref={(el) => {
                    if (el) copyRefs.current.set(copy.id, el);
                    else copyRefs.current.delete(copy.id);
                  }}
                  className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm ${
                    copy.id === focusCopyId ? "bg-pick-blue/20 ring-2 ring-inset ring-selection" : ""
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-ink">
                      {lineSummary(copy, binders)}
                      {store.isUpForTrade(copy) && (
                        <span className="ml-2 rounded border border-neon-green/60 px-1 text-xs text-neon-green-text">
                          Up for trade
                        </span>
                      )}
                    </span>
                    <span className="block text-xs text-ink-3">
                      Added {shortDate(copy.acquiredAt)}
                      {copy.costBasis !== undefined && ` · paid $${copy.costBasis.toFixed(2)}`}
                      {copy.location && ` · ${copy.location}`}
                      {copy.forSale && ` · For sale${copy.askPrice !== undefined ? ` $${copy.askPrice.toFixed(2)}` : ""}`}
                      {copy.notes && ` · “${copy.notes}”`}
                    </span>
                  </span>
                  <button
                    type="button"
                    className={QUIET_BUTTON}
                    aria-label={`Edit ${name}, ${names[i]}`}
                    onClick={() => setEditing({ id: copy.id, value: { ...copy } })}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className={`${QUIET_BUTTON} hover:text-neon-pink-text`}
                    aria-label={`Remove ${name}, ${names[i]}`}
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

      <div ref={addRef} className="scroll-mt-4">
        <CopyDetailsForm
          card={card}
          value={draft}
          onChange={setDraft}
          onSave={add}
          onCancel={() => {
            setDraft(freshDraft());
            onCancelAdd();
          }}
          binders={formBinders}
          heading={copies.length > 0 ? "Add another copy" : "Add a copy"}
          saveLabel="Add to collection"
        />
      </div>
    </div>
  );
}
