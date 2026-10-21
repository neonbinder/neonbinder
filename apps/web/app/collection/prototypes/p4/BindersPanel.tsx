import { useId, useState } from "react";
import { ArrowUturnLeftIcon, PlusIcon, SparklesIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { Input } from "@/components/primitives/Input";
import { LiveLine } from "@/components/modules/RunLedger";
import CardFace from "../_shared/CardFace";
import {
  cardLabel,
  compareCards,
  describeRule,
  getCard,
  playerNames,
  type Binder,
  type BinderId,
  type Copy,
} from "../_shared/data";
import type { PrototypeStore } from "../_shared/usePrototypeStore";
import RuleBuilder from "./RuleBuilder";
import { GO_BTN, PANEL, QUIET_BTN, RING, cardsWord, chipClass } from "./ui";

/**
 * NEO-350 prototype 4 — Binders: the list on the left, the open binder on
 * the right. A card can sit in any number of binders. Manual binders hold
 * the copies filed in them; smart binders are a rule over the checklist and
 * show haves AND needs, so a smart binder doubles as a want list.
 */

type Show = "all" | "have" | "need";
const MAX_FACES = 60;

export default function BindersPanel({ store }: { store: PrototypeStore }) {
  const headingId = useId();
  const binders = store.state.binders;
  const [openId, setOpenId] = useState<BinderId | null>(binders[0]?.id ?? null);
  const [mode, setMode] = useState<"view" | "smart" | "manual">("view");
  const [manualName, setManualName] = useState("");
  const [live, setLive] = useState("");
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);

  const open = binders.find((b) => b.id === openId) ?? null;

  function stats(b: Binder) {
    if (b.kind === "smart") {
      const list = store.binderCards(b);
      const have = list.filter((c) => store.ownedCount(c.id) > 0).length;
      return { text: `${list.length} cards, have ${have}`, have, total: list.length };
    }
    const copies = store.binderCopies(b);
    const n = copies.reduce((s, c) => s + c.quantity, 0);
    return { text: cardsWord(n), have: n, total: n };
  }

  function createManual() {
    const name = manualName.trim();
    if (!name) return;
    const b = store.createBinder({ kind: "manual", name });
    setManualName("");
    setMode("view");
    setOpenId(b.id);
    setLive(`Made ${name}. File cards in it from My Cards, or set it as a sticky detail at the Counter.`);
  }

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-xl font-bold text-white">
          Binders
        </h2>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            aria-expanded={mode === "manual"}
            onClick={() => setMode(mode === "manual" ? "view" : "manual")}
            className={QUIET_BTN}
          >
            <PlusIcon aria-hidden="true" className="h-4 w-4" />
            New binder
          </button>
          <button
            type="button"
            aria-expanded={mode === "smart"}
            onClick={() => setMode(mode === "smart" ? "view" : "smart")}
            className={GO_BTN}
          >
            <SparklesIcon aria-hidden="true" className="h-4 w-4" />
            New smart binder
          </button>
        </div>
      </div>

      {mode === "manual" && (
        <form
          className={`${PANEL} flex flex-wrap items-end gap-2 p-3`}
          onSubmit={(e) => {
            e.preventDefault();
            createManual();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setMode("view");
          }}
        >
          <div className="min-w-0 flex-1 basis-56">
            <Input
              autoFocus
              label="Binder name"
              placeholder="Show stock, Packers PC, '89 Upper Deck…"
              value={manualName}
              onChange={(e) => setManualName(e.target.value)}
            />
          </div>
          <button type="button" onClick={() => setMode("view")} className={QUIET_BTN}>
            Cancel
          </button>
          <button type="submit" disabled={!manualName.trim()} className={GO_BTN}>
            Make binder
          </button>
        </form>
      )}

      <div className="grid gap-3 md:grid-cols-[15rem_minmax(0,1fr)]">
        <nav aria-label="Your binders">
          <ul className="space-y-1">
            {binders.map((b) => {
              const s = stats(b);
              const current = b.id === openId && mode !== "smart";
              return (
                <li key={b.id}>
                  <button
                    type="button"
                    aria-current={current ? "true" : undefined}
                    onClick={() => {
                      setOpenId(b.id);
                      setMode("view");
                      setToast(null);
                    }}
                    className={`flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left min-h-11 ${RING} ${
                      current
                        ? "border-neon-blue bg-neon-blue/10"
                        : "border-slate-800 bg-slate-950 hover:border-slate-600"
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-white">{b.name}</span>
                      <span className="block text-xs text-slate-400">
                        {b.kind === "smart" ? "Smart, " : ""}
                        {s.text}
                      </span>
                    </span>
                    {b.kind === "smart" && (
                      <SparklesIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-neon-purple-text" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="min-w-0">
          {mode === "smart" ? (
            <RuleBuilder
              store={store}
              onCancel={() => setMode("view")}
              onSaved={(id, name, n) => {
                setOpenId(id);
                setMode("view");
                setLive(`Saved ${name}. It catches ${cardsWord(n)}.`);
              }}
            />
          ) : open ? (
            <BinderView
              key={open.id}
              binder={open}
              store={store}
              toast={toast}
              onToast={(t) => {
                setToast(t);
                setLive(t.text);
              }}
              onDismissToast={() => setToast(null)}
            />
          ) : (
            <p className={`${PANEL} p-4 text-sm text-slate-300`}>Pick a binder, or make one.</p>
          )}
        </div>
      </div>
      <LiveLine text={live} />
    </section>
  );
}

function BinderView({
  binder,
  store,
  toast,
  onToast,
  onDismissToast,
}: {
  binder: Binder;
  store: PrototypeStore;
  toast: { text: string; undo?: () => void } | null;
  onToast: (t: { text: string; undo?: () => void }) => void;
  onDismissToast: () => void;
}) {
  const [show, setShow] = useState<Show>("all");

  return (
    <div className={`${PANEL} space-y-3 p-4`}>
      <div>
        <h3 className="text-lg font-bold text-white">{binder.name}</h3>
        {binder.description && <p className="text-sm text-slate-400">{binder.description}</p>}
      </div>

      {toast && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100">
          <span className="mr-auto">{toast.text}</span>
          {toast.undo && (
            <button type="button" onClick={toast.undo} className={QUIET_BTN}>
              <ArrowUturnLeftIcon aria-hidden="true" className="h-4 w-4" />
              Undo
            </button>
          )}
          <button
            type="button"
            onClick={onDismissToast}
            className={`rounded-sm px-1 text-xs text-slate-400 hover:text-white ${RING}`}
          >
            Dismiss
          </button>
        </div>
      )}

      {binder.kind === "smart" ? (
        <SmartView binder={binder} store={store} show={show} setShow={setShow} />
      ) : (
        <ManualView binder={binder} store={store} onToast={onToast} />
      )}
    </div>
  );
}

function SmartView({
  binder,
  store,
  show,
  setShow,
}: {
  binder: Extract<Binder, { kind: "smart" }>;
  store: PrototypeStore;
  show: Show;
  setShow: (s: Show) => void;
}) {
  const all = store.binderCards(binder);
  const have = all.filter((c) => store.ownedCount(c.id) > 0);
  const list = show === "have" ? have : show === "need" ? all.filter((c) => store.ownedCount(c.id) === 0) : all;

  return (
    <>
      <p className="text-sm text-slate-300">
        <span className="text-slate-400">Rule:</span> {describeRule(binder.rule)}
      </p>
      <p className="text-base font-semibold text-white">
        Matches {cardsWord(all.length)} · you have {have.length}
      </p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
        {(
          [
            ["all", `All ${all.length}`],
            ["have", `Have ${have.length}`],
            ["need", `Need ${all.length - have.length}`],
          ] as [Show, string][]
        ).map(([k, l]) => (
          <button key={k} type="button" aria-pressed={show === k} onClick={() => setShow(k)} className={chipClass(show === k)}>
            {show === k && <span aria-hidden="true">✓</span>}
            {l}
          </button>
        ))}
      </div>
      <Faces
        items={list.map((c) => ({
          key: c.id,
          card: c,
          need: store.ownedCount(c.id) === 0,
          caption: store.ownedCount(c.id) > 0 ? `Have ${store.ownedCount(c.id)}` : "Need",
        }))}
      />
    </>
  );
}

function ManualView({
  binder,
  store,
  onToast,
}: {
  binder: Binder;
  store: PrototypeStore;
  onToast: (t: { text: string; undo?: () => void }) => void;
}) {
  const copies: Copy[] = [...store.binderCopies(binder)];
  if (binder.kind === "manual" && !binder.layout) {
    copies.sort((a, b) => compareCards(getCard(a.cardId), getCard(b.cardId)));
  }
  if (copies.length === 0) {
    return (
      <p className="text-sm text-slate-300">
        Empty. Select cards in My Cards and choose Move to binder, or set this binder as a sticky
        detail at the Counter.
      </p>
    );
  }
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-3">
      {copies.map((copy) => {
        const card = getCard(copy.cardId);
        return (
          <li key={copy.id} className="flex flex-col items-center gap-1">
            <CardFace card={card} size="fill" serial={copy.serialNumber} />
            <span className="w-full truncate text-center text-xs text-slate-300">
              #{card.cardNumber} {playerNames(card)}
            </span>
            <button
              type="button"
              aria-label={`Take ${cardLabel(card)} out of ${binder.name}`}
              onClick={() => {
                store.removeFromBinder(copy.id, binder.id);
                onToast({
                  text: `Took #${card.cardNumber} ${playerNames(card)} out of ${binder.name}. It's still in your collection.`,
                  undo: () => {
                    store.addToBinder(copy.id, binder.id);
                    onToast({ text: "Back in the binder." });
                  },
                });
              }}
              className={`inline-flex items-center gap-1 rounded px-1.5 text-xs text-slate-400 hover:text-white min-h-11 sm:min-h-6 ${RING}`}
            >
              <XMarkIcon aria-hidden="true" className="h-3.5 w-3.5" />
              Take out
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Faces({
  items,
}: {
  items: { key: string; card: ReturnType<typeof getCard>; need: boolean; caption: string }[];
}) {
  if (items.length === 0) return <p className="text-sm text-slate-300">Nothing here.</p>;
  return (
    <>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-3">
        {items.slice(0, MAX_FACES).map((it) => (
          <li key={it.key} className="flex flex-col items-center gap-1">
            <CardFace card={it.card} size="fill" state={it.need ? "need" : "owned"} />
            <span className="w-full truncate text-center text-xs text-slate-300">
              #{it.card.cardNumber} {playerNames(it.card)}
            </span>
            <span
              className={`text-xs font-semibold ${it.need ? "text-slate-400" : "text-white"}`}
              aria-hidden={it.need ? "true" : undefined}
            >
              {it.need ? "Need" : <><span aria-hidden="true">✓ </span>{it.caption}</>}
            </span>
          </li>
        ))}
      </ul>
      {items.length > MAX_FACES && (
        <p className="text-xs text-slate-400">and {items.length - MAX_FACES} more</p>
      )}
    </>
  );
}
