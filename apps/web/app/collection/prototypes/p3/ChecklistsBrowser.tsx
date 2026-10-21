import { useEffect, useRef, useState } from "react";
import { ChevronLeftIcon, InformationCircleIcon } from "@heroicons/react/24/outline";
import CardFace from "../_shared/CardFace";
import {
  brands,
  cardLabel,
  cardsInSet,
  getBrand,
  getSet,
  getSport,
  setLabel,
  setsInOrder,
  sports,
  variantLabel,
  type CardSet,
} from "../_shared/data";
import Chip from "./Chip";
import { FOCUS, LABEL, QUIET_BUTTON, SELECT } from "./classes";
import { useP3 } from "./context";
import { useMediaQuery } from "./hooks";
import { printRunText, variantFilterOf, variantKey } from "./wallModel";

/**
 * NEO-350 prototype 3 — the catalogue answer: Checklists is its OWN top-level
 * area, not a tab inside Collection. This view stands in for that tab: browse
 * any set read-only (sport → year → brand → set), see its rows and cards,
 * and put it on your board.
 */

export default function ChecklistsBrowser({ focusOnMount }: { focusOnMount: boolean }) {
  const api = useP3();
  const { store } = api;
  const heading = useRef<HTMLHeadingElement>(null);
  const wide = useMediaQuery("(min-width: 640px)");
  const all = setsInOrder();

  const [sportId, setSportId] = useState<string>("football");
  const inSport = all.filter((s) => s.sportId === sportId);
  const years = [...new Set(inSport.map((s) => s.year))];
  const [year, setYear] = useState<number>(years[0]);
  const inYear = inSport.filter((s) => s.year === year);
  const brandIds = [...new Set(inYear.map((s) => s.brandId))];
  const [brandId, setBrandId] = useState<string>(brandIds[0]);
  const inBrand = inYear.filter((s) => s.brandId === brandId);
  const [setId, setSetId] = useState<string>(inBrand[0]?.id ?? all[0].id);
  const [variant, setVariant] = useState<string>("Base:");

  useEffect(() => {
    if (focusOnMount) heading.current?.focus();
  }, [focusOnMount]);

  // Cascade: a parent change picks the first child that exists under it.
  function chooseSport(next: string) {
    setSportId(next);
    const s = all.find((x) => x.sportId === next)!;
    cascadeFrom(s);
  }
  function chooseYear(next: number) {
    setYear(next);
    cascadeFrom(inSport.find((x) => x.year === next)!);
  }
  function chooseBrand(next: string) {
    setBrandId(next);
    cascadeFrom(inYear.find((x) => x.brandId === next)!);
  }
  function cascadeFrom(s: CardSet) {
    setYear(s.year);
    setBrandId(s.brandId);
    setSetId(s.id);
    setVariant("Base:");
  }

  const set = getSet(setId);
  const row = set.variants.find((v) => variantKey(v) === variant) ?? set.variants[0];
  const list = cardsInSet(setId, variantFilterOf(row));
  const building = store.isBuilding(setId);
  const base = store.completion(setId, { type: "Base" });

  return (
    <section aria-labelledby="p3-checklists-heading">
      <button
        type="button"
        onClick={() => api.go("home")}
        className={`mb-3 inline-flex min-h-11 items-center gap-1 rounded-md pr-2 text-sm text-slate-300 hover:text-white sm:min-h-8 ${FOCUS}`}
      >
        <ChevronLeftIcon aria-hidden="true" className="size-4" />
        Back to my collection
      </button>

      <h2
        id="p3-checklists-heading"
        ref={heading}
        tabIndex={-1}
        className="text-2xl font-bold text-white focus:outline-none"
      >
        Checklists
      </h2>
      <p className="mt-2 flex gap-2 rounded-lg border border-neon-purple/70 bg-neon-purple/10 px-3 py-2 text-sm text-slate-200">
        <InformationCircleIcon aria-hidden="true" className="size-5 shrink-0 text-neon-purple-text" />
        <span>
          Prototype stand-in. In the real build this is its own binder tab at{" "}
          <code className="text-neon-purple-text">/checklists</code>, next to Collection. Browse any set here,
          read-only; your cards live in Collection.
        </span>
      </p>

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <label className="block">
          <span className={LABEL}>Sport</span>
          <select className={`${SELECT} w-full`} value={sportId} onChange={(e) => chooseSport(e.target.value)}>
            {sports.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={LABEL}>Year</span>
          <select className={`${SELECT} w-full`} value={year} onChange={(e) => chooseYear(Number(e.target.value))}>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={LABEL}>Brand</span>
          <select className={`${SELECT} w-full`} value={brandId} onChange={(e) => chooseBrand(e.target.value)}>
            {brandIds.map((id) => (
              <option key={id} value={id}>
                {brands.find((b) => b.id === id)?.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={LABEL}>Set</span>
          <select
            className={`${SELECT} w-full`}
            value={setId}
            onChange={(e) => {
              setSetId(e.target.value);
              setVariant("Base:");
            }}
          >
            {inBrand.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-5 flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-950 p-4 md:flex-row">
        <div className="min-w-0 flex-1">
          <h3 className="text-xl font-bold text-white">{setLabel(set)}</h3>
          <p className="text-sm text-slate-400">
            {getSport(set.sportId).name}, {getBrand(set.brandId).name}. Season {set.season}.
          </p>
          <ul className="mt-3 grid gap-1 text-sm text-slate-200 sm:grid-cols-2">
            {set.variants.map((v) => {
              const run = printRunText(v);
              const n = cardsInSet(setId, variantFilterOf(v)).length;
              return (
                <li key={variantKey(v)}>
                  {v.path.type !== "Base" && (
                    <span className="text-slate-400">{v.path.type === "Inserts" ? "Insert" : "Parallel"}: </span>
                  )}
                  {variantLabel(v.path)}
                  {run && ` ${run}`} <span className="text-slate-400">({n} cards)</span>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="flex flex-col items-start gap-2 md:items-end">
          <p className="text-sm text-slate-300">
            You have <strong className="text-white">{base.owned}</strong> of {base.total} base.
          </p>
          <button
            type="button"
            aria-pressed={building}
            onClick={() => {
              store.toggleBuilding(setId);
              api.notify(
                building ? `Took ${setLabel(set)} off the board.` : `${setLabel(set)} is on the board. Go light it up!`,
                () => store.toggleBuilding(setId),
              );
            }}
            className={`min-h-11 rounded-full border px-4 text-sm font-medium sm:min-h-9 ${FOCUS} ${
              building ? "border-neon-blue bg-neon-blue text-black" : "border-slate-600 text-slate-200 hover:border-neon-blue"
            }`}
          >
            {building ? "On my board" : "Build this set"}
          </button>
          {building && (
            <button type="button" onClick={() => api.openSet(setId)} className={QUIET_BUTTON}>
              Open its wall
            </button>
          )}
        </div>
      </div>

      <div role="group" aria-label="Checklist row" className="mt-4 flex flex-wrap gap-1.5">
        {set.variants.map((v) => (
          <Chip key={variantKey(v)} pressed={variantKey(v) === variantKey(row)} onClick={() => setVariant(variantKey(v))}>
            {variantLabel(v.path)}
          </Chip>
        ))}
      </div>

      <ul
        aria-label={`${setLabel(set)} ${variantLabel(row.path)}, ${list.length} cards`}
        className={`mt-4 grid gap-4 ${wide ? "grid-cols-[repeat(auto-fill,minmax(9rem,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))]"}`}
      >
        {list.map((c) => {
          const n = store.ownedCount(c.id);
          return (
            <li key={c.id} className="relative flex flex-col items-center gap-1">
              <CardFace
                card={c}
                size={wide ? "md" : "sm"}
                label={`${cardLabel(c)}${n > 0 ? `, in your collection` : ""}`}
              />
              {n > 0 && (
                <span aria-hidden="true" className="rounded bg-neon-blue px-1.5 text-[11px] font-bold text-black">
                  Have {n}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
