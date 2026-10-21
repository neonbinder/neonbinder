import { useState } from "react";
import { Link } from "react-router";
import { PlusIcon } from "@heroicons/react/24/outline";
import {
  cardsInSet,
  getBrand,
  getSet,
  getSport,
  setLabel,
  variantLabel,
  type SetId,
} from "../_shared/data";
import { FOCUS } from "./classes";
import { useP3 } from "./context";
import SetPicker from "./SetPicker";
import { printRunText, variantFilterOf, variantKey } from "./wallModel";

/**
 * NEO-350 prototype 3 — "Sets I'm building": one LED board per set. The base
 * percentage is the big number; under it, one strip of bulbs per row of the
 * checklist (base, each insert, each parallel), one bulb per card.
 */

export default function Scoreboard() {
  const { store } = useP3();
  const [picking, setPicking] = useState(false);
  const building = store.state.buildingSetIds;

  return (
    <section aria-labelledby="p3-board-heading">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="p3-board-heading" className="text-xl font-bold text-white">
          Sets I&apos;m building
        </h2>
        <p className="text-sm text-slate-400">
          {building.length} on the board
        </p>
      </div>

      <ul className="mt-3 grid gap-4 md:grid-cols-2">
        {building.map((id) => (
          <li key={id}>
            <ScoreCard setId={id} />
          </li>
        ))}
        <li>
          <button
            type="button"
            onClick={() => setPicking(true)}
            className={`flex size-full min-h-40 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-600 p-6 text-slate-200 hover:border-neon-blue hover:text-white ${FOCUS}`}
          >
            <PlusIcon aria-hidden="true" className="size-8 text-neon-blue" />
            <span className="text-base font-bold">Start building a set</span>
            <span className="text-sm text-slate-400">
              {building.length === 0
                ? "Nothing on the board yet. Pick a set and light it up."
                : "Put another checklist on the board."}
            </span>
          </button>
        </li>
      </ul>

      {picking && <SetPicker onClose={() => setPicking(false)} />}
    </section>
  );
}

function ScoreCard({ setId }: { setId: SetId }) {
  const { store } = useP3();
  const set = getSet(setId);
  const base = store.completion(setId, { type: "Base" });
  const complete = base.total > 0 && base.owned === base.total;

  return (
    <article className="p3-led relative flex h-full flex-col gap-3 rounded-2xl border border-slate-800 p-4 transition-colors focus-within:border-neon-blue hover:border-neon-blue">
      <div>
        <p className="text-xs text-slate-400">
          {getSport(set.sportId).name}, {getBrand(set.brandId).name}
        </p>
        <h3 className="text-lg font-bold leading-tight text-white">
          <Link
            to={{ search: `?set=${encodeURIComponent(setId)}` }}
            className="after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none"
          >
            {setLabel(set)}
          </Link>
        </h3>
      </div>

      <div className="flex items-end justify-between gap-3">
        <p>
          <span
            className={`p3-percent block text-6xl ${complete ? "text-neon-green" : "text-neon-blue"}`}
            data-complete={complete}
          >
            {base.percent}%
          </span>
          <span className="text-xs text-slate-300">{complete ? "Base set complete!" : "of the base set"}</span>
        </p>
        <dl className="flex gap-4 text-right">
          <div>
            <dt className="text-xs text-slate-400">Have</dt>
            <dd className="text-2xl font-bold tabular-nums text-white">{base.owned}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Need</dt>
            <dd className="text-2xl font-bold tabular-nums text-white">{base.total - base.owned}</dd>
          </div>
        </dl>
      </div>

      <ul aria-label={`${setLabel(set)} by row`} className="flex flex-col gap-2">
        {set.variants.map((v) => {
          const list = cardsInSet(setId, variantFilterOf(v));
          const owned = list.filter((c) => store.ownedCount(c.id) > 0).length;
          const run = printRunText(v);
          return (
            <li key={variantKey(v)} className="grid grid-cols-[7.5rem_1fr_auto] items-center gap-2 text-xs">
              <span className="truncate text-slate-300" title={variantLabel(v.path)}>
                {variantLabel(v.path)}
                {run && <span className="text-slate-400"> {run}</span>}
              </span>
              <span aria-hidden="true" className="flex flex-wrap gap-[3px]">
                {list.map((c) =>
                  store.ownedCount(c.id) > 0 ? (
                    <span key={c.id} className="size-[7px] rounded-full bg-neon-blue shadow-[0_0_4px_rgba(0,194,255,0.8)]" />
                  ) : (
                    <span key={c.id} className="size-[7px] rounded-full border border-slate-600" />
                  ),
                )}
              </span>
              <span className="tabular-nums text-slate-200">
                {owned}
                <span className="text-slate-400">/{list.length}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </article>
  );
}
