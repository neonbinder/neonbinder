import { useState } from "react";
import { InformationCircleIcon } from "@heroicons/react/24/outline";
import CardFace from "../_shared/CardFace";
import {
  cardLabel,
  cardsInSet,
  getBrand,
  getPlayer,
  getSport,
  playerNames,
  printRunLabel,
  setLabel,
  setsInOrder,
  teamNames,
  variantLabel,
  type CardId,
  type SportId,
  type VariantPath,
} from "../_shared/data";
import { useP5 } from "./context";

const SELECT =
  "w-full rounded-md border border-slate-600 bg-slate-900 px-3 py-2 text-base text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]";
const LABEL = "mb-1 block text-sm font-medium text-slate-300";

/**
 * The catalog, read-only. In the product this would be its own top-level tab
 * ("Checklists"), separate from the collection: you look a set up here and
 * jump to a player's PC from any card. Nothing here adds to the collection.
 */
export default function ChecklistsView() {
  const p5 = useP5();
  const all = setsInOrder();
  const [sport, setSport] = useState<SportId>("football");
  const years = [
    ...new Set(all.filter((s) => s.sportId === sport).map((s) => s.year)),
  ];
  const [yearRaw, setYear] = useState<number>(1996);
  const year = years.includes(yearRaw) ? yearRaw : years[0];
  const brands = [
    ...new Set(
      all
        .filter((s) => s.sportId === sport && s.year === year)
        .map((s) => s.brandId),
    ),
  ];
  const [brandRaw, setBrand] = useState<string>("brand-playoff");
  const brand = brands.includes(brandRaw) ? brandRaw : brands[0];
  const setOptions = all.filter(
    (s) => s.sportId === sport && s.year === year && s.brandId === brand,
  );
  const [setRaw, setSet] = useState<string>("1996-playoff-contenders");
  const set = setOptions.find((s) => s.id === setRaw) ?? setOptions[0];

  const [variantRaw, setVariant] = useState<VariantPath | null>(null);
  const variant =
    variantRaw &&
    set.variants.some(
      (v) => v.path.type === variantRaw.type && v.path.name === variantRaw.name,
    )
      ? variantRaw
      : set.variants[0].path;
  const list = cardsInSet(set.id, { type: variant.type, name: variant.name });
  const [picked, setPicked] = useState<CardId | null>(null);
  const pickedCard = list.find((c) => c.id === picked) ?? null;

  const inserts = set.variants.filter((v) => v.path.type === "Inserts").length;
  const parallels = set.variants.filter(
    (v) => v.path.type === "Parallels",
  ).length;
  const baseCount = cardsInSet(set.id, { type: "Base" }).length;

  return (
    <div>
      <p className="flex max-w-prose items-start gap-2 rounded-lg border border-neon-purple/60 bg-neon-purple/10 p-3 text-sm text-slate-200">
        <InformationCircleIcon
          aria-hidden="true"
          className="mt-0.5 h-5 w-5 shrink-0 text-neon-purple-text"
        />
        Mock entry: Checklists would be its own top-level tab, the whole
        catalog, read-only. Look a set up, then jump from any card to that
        player&apos;s PC.
      </p>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className={LABEL}>Sport</span>
          <select
            className={SELECT}
            value={sport}
            onChange={(e) => setSport(e.target.value as SportId)}
          >
            {[...new Set(all.map((s) => s.sportId))].map((id) => (
              <option key={id} value={id}>
                {getSport(id).name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={LABEL}>Year</span>
          <select
            className={SELECT}
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={LABEL}>Brand</span>
          <select
            className={SELECT}
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
          >
            {brands.map((id) => (
              <option key={id} value={id}>
                {getBrand(id).name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={LABEL}>Set</span>
          <select
            className={SELECT}
            value={set.id}
            onChange={(e) => setSet(e.target.value)}
          >
            {setOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <section
        aria-labelledby="p5-set-title"
        className="mt-6 rounded-xl border border-slate-700 bg-slate-950 p-4 sm:p-5"
      >
        <h2 id="p5-set-title" className="text-2xl font-bold text-white">
          {setLabel(set)}
        </h2>
        <p className="mt-1 text-sm text-slate-300">
          {getSport(set.sportId).name}, {getBrand(set.brandId).name}.{" "}
          {baseCount} base cards, {inserts}{" "}
          {inserts === 1 ? "insert set" : "insert sets"}, {parallels}{" "}
          {parallels === 1 ? "parallel" : "parallels"}.
        </p>

        <div
          role="group"
          aria-label="Part of the set"
          className="mt-4 flex flex-wrap gap-2"
        >
          {set.variants.map((v) => {
            const on =
              v.path.type === variant.type && v.path.name === variant.name;
            const run =
              v.printRun === null
                ? ""
                : v.printRun === 1
                  ? " 1/1"
                  : ` /${v.printRun}`;
            return (
              <button
                key={`${v.path.type}:${v.path.name}`}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  setVariant(v.path);
                  setPicked(null);
                }}
                className={`min-h-11 rounded-full border px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] sm:min-h-8 ${
                  on
                    ? "border-neon-blue bg-neon-blue text-black"
                    : "border-slate-600 text-slate-200 hover:border-slate-400"
                }`}
              >
                {variantLabel(v.path)}
                {run}
              </button>
            );
          })}
        </div>

        {pickedCard && (
          <div className="mt-5 flex flex-col gap-4 rounded-lg border border-slate-700 bg-black/50 p-4 sm:flex-row sm:items-center">
            <CardFace card={pickedCard} size="md" />
            <div className="min-w-0 flex-1">
              <p className="font-bold text-white">{playerNames(pickedCard)}</p>
              <p className="text-sm text-slate-300">{cardLabel(pickedCard)}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {pickedCard.playerIds.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => p5.goPc({ kind: "player", id })}
                    className="min-h-11 rounded-md bg-neon-green px-3 text-sm font-semibold text-black hover:bg-neon-green/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] focus-visible:ring-offset-2 focus-visible:ring-offset-black sm:min-h-9"
                  >
                    Go to {getPlayer(id).name} PC
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        <ul
          aria-label={`${variantLabel(variant)} checklist`}
          className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-x-3 gap-y-4"
        >
          {list.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                aria-pressed={picked === c.id}
                onClick={() => setPicked(picked === c.id ? null : c.id)}
                className={`block rounded-[7%] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] focus-visible:ring-offset-2 focus-visible:ring-offset-black ${
                  picked === c.id
                    ? "ring-2 ring-neon-blue ring-offset-2 ring-offset-slate-950"
                    : ""
                }`}
              >
                <CardFace card={c} size="sm" />
              </button>
              <p className="mt-1.5 truncate text-xs text-slate-200">
                <span className="tabular-nums text-slate-400">
                  #{c.cardNumber}
                </span>{" "}
                {getPlayer(c.playerIds[0]).name}
              </p>
              <p className="truncate text-xs text-slate-400">
                {teamNames(c)}
                {printRunLabel(c) ? ` ${printRunLabel(c)}` : ""}
                {c.variation ? `, ${c.variation}` : ""}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
