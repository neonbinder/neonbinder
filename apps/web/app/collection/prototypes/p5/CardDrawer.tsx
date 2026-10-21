import { useState } from "react";
import { PlusIcon, StarIcon, XMarkIcon } from "@heroicons/react/24/solid";
import CardFace from "../_shared/CardFace";
import CopyDetailsForm from "../_shared/CopyDetailsForm";
import {
  emptyCopyDetails,
  getCard,
  getPlayer,
  getSet,
  getTeam,
  printRunLabel,
  setLabel,
  teamTextColor,
  type Card,
  type CardId,
  type CopyDetails,
  type CopyId,
} from "../_shared/data";
import { useP5 } from "./context";
import CardTile from "./CardTile";
import {
  copyMeta,
  copySummary,
  countOwned,
  parallelName,
  rainbowOf,
  rainbowRoot,
} from "./model";

type Editing = {
  cardId: CardId;
  copyId: CopyId | null;
  draft: CopyDetails;
} | null;

const FEATURE_WORDS: Record<string, string> = {
  RC: "Rookie card",
  AU: "Autograph",
  Relic: "Relic",
  SP: "Short print",
};

const QUIET =
  "inline-flex min-h-11 items-center gap-1.5 rounded-md border border-slate-600 px-3 text-sm font-medium text-slate-200 hover:border-slate-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] sm:min-h-8";

/**
 * The card drawer: the face large, its rainbow, the copies, and the details
 * form. Rendered by the page inside its overlay layer, which owns the inert
 * background, the Tab trap and the focus return.
 */
export default function CardDrawer({
  cardId,
  onClose,
}: {
  cardId: CardId;
  onClose: () => void;
}) {
  const p5 = useP5();
  const { store, owned } = p5;
  const card = getCard(cardId);
  const set = getSet(card.setId);
  const copies = store.copiesOf(card.id);
  const rainbow = rainbowOf(card);
  const root = rainbowRoot(card);
  const chasing = p5.chased.includes(root.id);
  const [editingState, setEditing] = useState<Editing>(null);
  // Switching cards (a rainbow tap) drops an open form without an effect.
  const editing = editingState?.cardId === card.id ? editingState : null;

  const run = printRunLabel(card);
  const facts: string[] = [];
  if (card.variantPath.name)
    facts.push(
      `${card.variantPath.type === "Inserts" ? "Insert" : "Parallel"}: ${card.variantPath.name}`,
    );
  if (card.variation) facts.push(`${card.variation} image variation`);
  if (run) facts.push(run === "1/1" ? "One of one" : `Numbered ${run}`);
  for (const f of card.features) facts.push(FEATURE_WORDS[f]);

  function startNew() {
    setEditing({ cardId: card.id, copyId: null, draft: emptyCopyDetails() });
  }

  function save(value: CopyDetails) {
    if (!editing) return;
    if (editing.copyId) {
      store.updateCopy(editing.copyId, value);
      p5.announce("Copy saved.");
    } else {
      const copy = store.addCopy(card.id, value);
      p5.announce(
        `Added ${card.playerIds.map((id) => getPlayer(id).name).join(" / ")} to your collection.`,
        () => store.removeCopy(copy.id),
      );
    }
    setEditing(null);
  }

  function remove(copyId: CopyId, summary: string) {
    const gone = store.removeCopy(copyId);
    if (gone)
      p5.announce(`Removed the ${summary} copy.`, () =>
        store.restoreCopy(gone),
      );
    if (editing?.copyId === copyId) setEditing(null);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="p5-drawer-title"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
      className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-slate-700 bg-slate-950 shadow-2xl shadow-black sm:max-w-[30rem] motion-safe:animate-[p5-drawer-in_220ms_cubic-bezier(0.2,0.7,0.2,1)]"
    >
      <div className="flex items-start gap-3 border-b border-slate-800 px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-slate-400">
            {setLabel(set)}
            {card.variantPath.type === "Inserts" && card.variantPath.name
              ? ` ${card.variantPath.name}`
              : ""}{" "}
            #{card.cardNumber}
          </p>
          <h2
            id="p5-drawer-title"
            tabIndex={-1}
            className="text-xl font-bold text-white focus:outline-none"
          >
            {card.playerIds.map((id) => getPlayer(id).name).join(" / ")}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close card"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-slate-700 text-slate-200 hover:border-slate-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]"
        >
          <XMarkIcon aria-hidden="true" className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-10 pt-5">
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <CardFace
            card={card}
            size="lg"
            state={copies.length ? "owned" : "need"}
            className="max-w-full"
          />
          <div className="w-full min-w-0 flex-1 text-sm">
            <p className="font-semibold">
              {card.teamIds.map((id, i) => {
                const t = getTeam(id);
                return (
                  <span key={id}>
                    {i > 0 && " / "}
                    <span style={{ color: teamTextColor(t) }}>
                      {t.location} {t.name}
                    </span>
                  </span>
                );
              })}
            </p>
            <ul className="mt-2 space-y-1 text-slate-300">
              {facts.length === 0 && <li>Base card</li>}
              {facts.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            {card.playerIds.some((id) => getPlayer(id).hallOfFame) && (
              <p className="mt-3 inline-flex items-center gap-1 rounded-full bg-[#F5D77A] px-2.5 py-0.5 text-xs font-bold text-black">
                <StarIcon aria-hidden="true" className="h-3.5 w-3.5" />
                Hall of Famer
              </p>
            )}
            <p className="mt-3 font-semibold text-white">
              {copies.length ? (
                <span className="text-neon-blue">
                  Have {store.ownedCount(card.id)}
                </span>
              ) : (
                <span className="text-slate-300">Need</span>
              )}
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {card.playerIds.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    onClose();
                    p5.goPc({ kind: "player", id });
                  }}
                  className={QUIET}
                >
                  Go to {getPlayer(id).name} PC
                </button>
              ))}
            </div>
          </div>
        </div>

        {rainbow.length > 1 && (
          <section aria-labelledby="p5-rainbow-title" className="mt-7">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3
                id="p5-rainbow-title"
                className="text-lg font-bold text-white"
              >
                Rainbow{" "}
                <span className="text-sm font-normal tabular-nums text-slate-300">
                  {countOwned(rainbow, owned)} of {rainbow.length}
                </span>
              </h3>
              <button
                type="button"
                aria-pressed={chasing}
                onClick={() => p5.toggleChase(root.id)}
                className={`${QUIET} ${chasing ? "border-neon-blue text-neon-blue" : ""}`}
              >
                {chasing ? "Chasing this rainbow" : "Chase this rainbow"}
              </button>
            </div>
            <ul
              aria-label="Every parallel of this card"
              className="mt-3 grid grid-cols-3 gap-x-3 gap-y-4 min-[400px]:grid-cols-4"
            >
              {rainbow.map((c: Card) => (
                <li key={c.id}>
                  <CardTile
                    card={c}
                    size="sm"
                    current={c.id === card.id}
                    caption={
                      <>
                        <span className="block truncate">
                          {parallelName(c)}
                        </span>
                        {printRunLabel(c) && (
                          <span className="block font-semibold tabular-nums text-[#F5D77A]">
                            {printRunLabel(c)}
                          </span>
                        )}
                      </>
                    }
                  />
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="p5-copies-title" className="mt-7">
          <div className="flex items-center justify-between gap-2">
            <h3 id="p5-copies-title" className="text-lg font-bold text-white">
              Your copies
            </h3>
            {!editing && (
              <button
                type="button"
                onClick={startNew}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-neon-green px-3 text-sm font-semibold text-black hover:bg-neon-green/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 sm:min-h-9"
              >
                <PlusIcon aria-hidden="true" className="h-4 w-4" />
                Add a copy
              </button>
            )}
          </div>
          {copies.length === 0 && !editing && (
            <p className="mt-3 text-sm text-slate-300">
              None yet. Add one with details, or hit Add on the shelf for a
              quick raw copy.
            </p>
          )}
          <ul className="mt-3 space-y-2">
            {copies.map((copy) => {
              const summary = copySummary(copy);
              const binderNames = copy.binderIds
                .map((id) => store.getBinder(id)?.name)
                .filter(Boolean)
                .join(", ");
              return (
                <li
                  key={copy.id}
                  className="rounded-lg border border-slate-800 bg-black/40 p-3"
                >
                  <p className="font-semibold text-white">{summary}</p>
                  <p className="text-sm text-slate-300">{copyMeta(copy)}</p>
                  {binderNames && (
                    <p className="text-sm text-slate-300">In {binderNames}</p>
                  )}
                  {copy.notes && (
                    <p className="mt-1 text-sm italic text-slate-300">
                      {copy.notes}
                    </p>
                  )}
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      className={QUIET}
                      aria-label={`Edit the ${summary} copy`}
                      onClick={() =>
                        setEditing({
                          cardId: card.id,
                          copyId: copy.id,
                          draft: { ...copy },
                        })
                      }
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className={`${QUIET} hover:border-neon-pink hover:text-neon-pink`}
                      aria-label={`Remove the ${summary} copy`}
                      onClick={() => remove(copy.id, summary)}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          {editing && (
            <CopyDetailsForm
              className="mt-4"
              card={card}
              value={editing.draft}
              onChange={(draft) => setEditing({ ...editing, draft })}
              onSave={save}
              onCancel={() => setEditing(null)}
              binders={store.state.binders}
              heading={editing.copyId ? "Edit copy" : "New copy"}
              saveLabel={editing.copyId ? "Save copy" : "Add to collection"}
            />
          )}
        </section>
      </div>
    </div>
  );
}
