import { useId, useState, type FormEvent } from "react";
import { ArrowLeftIcon, BoltIcon, RectangleStackIcon } from "@heroicons/react/24/outline";
import { Input } from "@/components/primitives/Input";
import NeonButton from "@/components/modules/NeonButton";
import {
  describeRule,
  getCard,
  teamNames,
  type Binder,
  type BinderRule,
  type Card,
  type SmartBinder,
} from "../_shared/data";
import type { PrototypeStore } from "../_shared/usePrototypeStore";
import ChecklistRow from "./ChecklistRow";
import type { Notify } from "./notice";
import Overlay from "./Overlay";
import SleeveStrip from "./SleeveStrip";
import {
  FOCUS,
  LABEL,
  OUTLINE_BUTTON,
  QUIET_BUTTON,
  SELECT,
  copySummary,
  liveryOn,
  setAndVariant,
  shortCardName,
} from "./ui";

/** A smart binder's rule as chips: the top-level "and" splits, the rest reads as words. */
function ruleChips(rule: BinderRule): string[] {
  return rule.kind === "and" ? rule.rules.map(describeRule) : [describeRule(rule)];
}

/**
 * Binders: the admin hub's card grid, one card per binder. A manual binder
 * opens to the copies filed in it; a smart one shows its rule, read-only, and
 * every card the rule matches, have and need alike. A card can sit in as many
 * binders as the collector likes.
 */
export default function Binders({
  store,
  notify,
  onOpen,
  onToggleHave,
}: {
  store: PrototypeStore;
  notify: Notify;
  onOpen: (card: Card, list: Card[]) => void;
  onToggleHave: (card: Card) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const open = openId ? store.getBinder(openId) : undefined;

  if (open) {
    return (
      <BinderDetail
        binder={open}
        store={store}
        notify={notify}
        onBack={() => setOpenId(null)}
        onOpen={onOpen}
        onToggleHave={onToggleHave}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-100">Binders</h2>
        <NeonButton type="button" onClick={() => setCreating(true)}>
          New binder
        </NeonButton>
      </div>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {store.state.binders.map((b) => {
          const smart = b.kind === "smart";
          const Icon = smart ? BoltIcon : RectangleStackIcon;
          const cards = store.binderCards(b);
          const have = smart ? cards.filter((c) => store.ownedCount(c.id) > 0).length : 0;
          return (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => setOpenId(b.id)}
                className={`group flex h-full w-full gap-4 rounded-lg border border-slate-800 bg-slate-900/40 p-5 text-left transition-colors hover:bg-slate-900 hover:border-neon-blue/50 ${FOCUS}`}
              >
                <Icon
                  className={`w-8 h-8 shrink-0 ${smart ? "text-neon-purple-text" : "text-neon-blue"}`}
                  aria-hidden="true"
                />
                <span className="min-w-0 space-y-1">
                  <span className="block text-lg font-semibold text-slate-100">{b.name}</span>
                  <span className="block text-xs text-slate-300">
                    {smart ? "Smart binder: fills itself" : "Your picks"}
                  </span>
                  {b.description && <span className="block text-sm text-slate-400">{b.description}</span>}
                  <span className="block pt-1 text-sm text-slate-200 tabular-nums">
                    {smart
                      ? `Have ${have} · Need ${cards.length - have}`
                      : `${store.binderCopies(b).length} ${store.binderCopies(b).length === 1 ? "copy" : "copies"}`}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {creating && (
        <NewBinderDialog
          onClose={() => setCreating(false)}
          onCreate={(name, description) => {
            const b = store.createBinder({ kind: "manual", name, description: description || undefined });
            setCreating(false);
            setOpenId(b.id);
            notify(`Made a new binder: ${name}`);
          }}
        />
      )}
    </div>
  );
}

function NewBinderDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, description: string) => void;
}) {
  const headingId = useId();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) onCreate(name.trim(), description.trim());
  };
  return (
    <Overlay labelledBy={headingId} onClose={onClose} variant="modal">
      <form onSubmit={submit} className="space-y-4">
        <h2 id={headingId} tabIndex={-1} className="text-lg font-semibold focus:outline-none">
          New binder
        </h2>
        <Input
          surface="dark"
          label="Binder name"
          placeholder="Show binder"
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-autofocus=""
          autoComplete="off"
        />
        <Input
          surface="dark"
          label="What goes in it (optional)"
          placeholder="Cards I bring to the Sunday show"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          autoComplete="off"
        />
        <p className="text-sm text-slate-400">
          File cards in it from any card&apos;s details. Smart binders that fill themselves
          from a rule are coming soon.
        </p>
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} className={OUTLINE_BUTTON}>
            Cancel
          </button>
          <NeonButton type="submit" variant="primary" disabled={!name.trim()} className={FOCUS}>
            Make binder
          </NeonButton>
        </div>
      </form>
    </Overlay>
  );
}

function BinderDetail({
  binder,
  store,
  notify,
  onBack,
  onOpen,
  onToggleHave,
}: {
  binder: Binder;
  store: PrototypeStore;
  notify: Notify;
  onBack: () => void;
  onOpen: (card: Card, list: Card[]) => void;
  onToggleHave: (card: Card) => void;
}) {
  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className={`inline-flex items-center gap-1.5 ${QUIET_BUTTON} text-sm`}>
        <ArrowLeftIcon className="h-4 w-4" aria-hidden="true" />
        All binders
      </button>
      <div>
        <h2 className="text-xl font-semibold text-slate-100">{binder.name}</h2>
        <p className="text-sm text-slate-400">
          {binder.kind === "smart" ? "Smart binder. " : ""}
          {binder.description}
        </p>
      </div>
      {binder.kind === "smart" ? (
        <SmartDetail binder={binder} store={store} onOpen={onOpen} onToggleHave={onToggleHave} />
      ) : (
        <ManualDetail binder={binder} store={store} notify={notify} onOpen={onOpen} />
      )}
    </div>
  );
}

function SmartDetail({
  binder,
  store,
  onOpen,
  onToggleHave,
}: {
  binder: SmartBinder;
  store: PrototypeStore;
  onOpen: (card: Card, list: Card[]) => void;
  onToggleHave: (card: Card) => void;
}) {
  const cards = store.binderCards(binder);
  const ownedIds = new Set(cards.filter((c) => store.ownedCount(c.id) > 0).map((c) => c.id));
  const chips = ruleChips(binder.rule);
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-800 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold text-slate-100">Rule</h3>
          <button
            type="button"
            aria-disabled="true"
            title="Rule editing is coming soon"
            className={`${OUTLINE_BUTTON} cursor-not-allowed opacity-60`}
          >
            Edit rules (coming soon)
          </button>
        </div>
        <ul aria-label="Rule" className="flex flex-wrap items-center gap-2">
          {chips.map((chip, i) => (
            <li key={chip} className="flex items-center gap-2">
              {i > 0 && <span className="text-xs text-slate-400">and</span>}
              <span className="rounded-full border border-neon-purple/60 bg-slate-900 px-2.5 py-1 text-sm text-slate-100">
                {chip}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-sm text-slate-300 tabular-nums">
          Have {ownedIds.size} of {cards.length} · Need {cards.length - ownedIds.size}
        </p>
        <SleeveStrip cards={cards} ownedIds={ownedIds} />
      </div>
      <ul className="space-y-1.5 rounded-lg bg-gray-800 p-3 sm:p-4">
        {cards.map((card) => (
          <ChecklistRow
            key={card.id}
            card={card}
            owned={store.ownedCount(card.id)}
            showSet
            onToggleHave={() => onToggleHave(card)}
            onOpen={() => onOpen(card, cards)}
          />
        ))}
      </ul>
    </div>
  );
}

function ManualDetail({
  binder,
  store,
  notify,
  onOpen,
}: {
  binder: Binder;
  store: PrototypeStore;
  notify: Notify;
  onOpen: (card: Card, list: Card[]) => void;
}) {
  const filed = store.binderCopies(binder);
  const unfiled = store.state.copies.filter((c) => !c.binderIds.includes(binder.id));
  const [pick, setPick] = useState("");
  const pockets =
    binder.kind === "manual" && binder.layout
      ? {
          pages: binder.layout.length,
          filled: binder.layout.reduce((n, p) => n + p.slots.filter(Boolean).length, 0),
        }
      : null;
  const cards = filed.map((c) => getCard(c.cardId));

  const file = () => {
    const copy = unfiled.find((c) => c.id === pick);
    if (!copy) return;
    store.addToBinder(copy.id, binder.id);
    setPick("");
    notify(`Filed ${shortCardName(getCard(copy.cardId))} in ${binder.name}`, () =>
      store.removeFromBinder(copy.id, binder.id),
    );
  };

  return (
    <div className="space-y-4">
      {pockets && (
        <p className="text-sm text-slate-300">
          {pockets.pages} nine-pocket pages · {pockets.filled} of {pockets.pages * 9} pockets filled
        </p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className="block w-full sm:w-96">
          <span className={LABEL}>File a card here</span>
          <select className={SELECT} value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Pick one of your cards…</option>
            {unfiled.map((c) => {
              const card = getCard(c.cardId);
              return (
                <option key={c.id} value={c.id}>
                  {`${shortCardName(card)} · ${setAndVariant(card)}${c.graded ? ` · ${c.graded.grader} ${c.graded.grade}` : ""}`}
                </option>
              );
            })}
          </select>
        </label>
        <NeonButton type="button" variant="primary" disabled={!pick} onClick={file} className={FOCUS}>
          File it
        </NeonButton>
      </div>
      {filed.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-700 px-3 py-2 text-sm text-slate-400">
          Empty binder. File a card above, or tick this binder in any card&apos;s details.
        </p>
      ) : (
        <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
          {filed.map((copy) => {
            const card = getCard(copy.cardId);
            return (
              <li key={copy.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                <span className="w-12 shrink-0 text-right font-mono text-slate-400">#{card.cardNumber}</span>
                <button
                  type="button"
                  onClick={() => onOpen(card, cards)}
                  className={`min-w-0 flex-1 text-left rounded-sm ${FOCUS}`}
                >
                  <span className="block truncate text-slate-100">
                    {shortCardName(card).replace(/^#\S+ /, "")}
                  </span>
                  <span className="block truncate text-xs text-slate-400">
                    {setAndVariant(card)} ·{" "}
                    <span style={{ color: liveryOn(card, "#020617") }}>{teamNames(card)}</span> ·{" "}
                    {copySummary(copy)}
                  </span>
                </button>
                <button
                  type="button"
                  className={`${QUIET_BUTTON} hover:text-neon-pink`}
                  aria-label={`Take ${shortCardName(card)} out of ${binder.name}`}
                  onClick={() => {
                    store.removeFromBinder(copy.id, binder.id);
                    notify(`Took ${shortCardName(card)} out of ${binder.name}`, () =>
                      store.addToBinder(copy.id, binder.id),
                    );
                  }}
                >
                  Take out
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
