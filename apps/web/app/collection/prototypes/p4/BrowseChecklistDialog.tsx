import { useId, useRef, useState } from "react";
import {
  cardsInSet,
  getSet,
  leadTeam,
  playerNames,
  printRunLabel,
  setLabel,
  setsInOrder,
  teamNames,
  teamTextColor,
  variantLabel,
  type Card,
  type SetId,
  type VariantPath,
} from "../_shared/data";
import type { PrototypeStore } from "../_shared/usePrototypeStore";
import type { Scope } from "./counterSearch";
import Dialog from "./Dialog";
import { GO_BTN, QUIET_BTN, SELECT } from "./ui";

/**
 * NEO-350 prototype 4 — "Browse checklists": a read-only look at any set's
 * checklist from inside the counter, with Have / Need in words. Its one
 * action hands the set and variant to the omnibox as its scope, so the
 * dealer can go straight to keying numbers out of the box.
 */

function variantKey(path: VariantPath): string {
  return `${path.type}|${path.name ?? ""}`;
}

export default function BrowseChecklistDialog({
  store,
  initial,
  onClose,
  onWork,
}: {
  store: PrototypeStore;
  initial: Scope | null;
  onClose: () => void;
  onWork: (scope: Scope) => void;
}) {
  const sets = setsInOrder();
  const [setId, setSetId] = useState<SetId>(initial?.setId ?? sets[0].id);
  const set = getSet(setId);
  const [vKey, setVKey] = useState<string>(
    variantKey(initial?.variant ?? set.variants[0].path),
  );
  const variant =
    set.variants.find((v) => variantKey(v.path) === vKey)?.path ?? set.variants[0].path;
  const [onlyNeeds, setOnlyNeeds] = useState(false);
  const setSelectRef = useRef<HTMLSelectElement>(null);
  const tableCaptionId = useId();

  const completion = store.completion(setId, { type: variant.type, name: variant.name });
  const missing = new Set(completion.missing.map((c) => c.id));
  const rows: Card[] = cardsInSet(setId, { type: variant.type, name: variant.name }).filter(
    (c) => !onlyNeeds || missing.has(c.id),
  );

  return (
    <Dialog
      title="Checklists"
      description="Look up any set. Read-only here; key cards from the counter."
      onClose={onClose}
      initialFocus={setSelectRef}
      wide
    >
      <div className="space-y-3 px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block min-w-0 flex-1 basis-56">
            <span className="mb-1 block text-sm font-medium text-slate-300">Set</span>
            <select
              ref={setSelectRef}
              className={`${SELECT} w-full`}
              value={setId}
              onChange={(e) => {
                const next = getSet(e.target.value);
                setSetId(next.id);
                setVKey(variantKey(next.variants[0].path));
              }}
            >
              {sets.map((s) => (
                <option key={s.id} value={s.id}>
                  {setLabel(s)}
                </option>
              ))}
            </select>
          </label>
          <label className="block min-w-0 flex-1 basis-44">
            <span className="mb-1 block text-sm font-medium text-slate-300">
              Base, insert or parallel
            </span>
            <select
              className={`${SELECT} w-full`}
              value={variantKey(variant)}
              onChange={(e) => setVKey(e.target.value)}
            >
              {set.variants.map((v) => (
                <option key={variantKey(v.path)} value={variantKey(v.path)}>
                  {variantLabel(v.path)}
                  {v.printRun ? ` /${v.printRun}` : ""}
                  {v.path.type !== "Base" ? ` (${v.path.type.toLowerCase()})` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-slate-300">
            <span className="font-semibold text-white tabular-nums">
              {completion.owned} of {completion.total}
            </span>{" "}
            have, {completion.total - completion.owned} need ({completion.percent}%)
          </p>
          <button
            type="button"
            aria-pressed={onlyNeeds}
            onClick={() => setOnlyNeeds((v) => !v)}
            className={QUIET_BTN}
          >
            {onlyNeeds ? "Showing needs only" : "Show needs only"}
          </button>
        </div>

        <div className="relative max-h-[45vh] overflow-auto rounded-md border border-slate-800">
          <table className="w-full text-left text-sm" aria-describedby={tableCaptionId}>
            <caption id={tableCaptionId} className="sr-only">
              {setLabel(set)} {variantLabel(variant)} checklist
            </caption>
            <thead className="sticky top-0 bg-slate-900 text-xs text-slate-300">
              <tr>
                <th scope="col" className="px-3 py-2 font-semibold">#</th>
                <th scope="col" className="px-3 py-2 font-semibold">Player</th>
                <th scope="col" className="px-3 py-2 font-semibold">Team</th>
                <th scope="col" className="px-3 py-2 font-semibold">Have / Need</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {rows.map((c) => {
                const have = store.ownedCount(c.id);
                const run = printRunLabel(c);
                return (
                  <tr key={c.id}>
                    <td className="px-3 py-1.5 tabular-nums text-slate-200">{c.cardNumber}</td>
                    <td className="px-3 py-1.5 text-slate-100">
                      {playerNames(c)}
                      {c.variation ? (
                        <span className="text-slate-400">, {c.variation} variation</span>
                      ) : null}
                      {run ? <span className="text-slate-400"> {run}</span> : null}
                    </td>
                    <td
                      className="px-3 py-1.5"
                      style={{ color: teamTextColor(leadTeam(c), "#020617") }}
                    >
                      {teamNames(c)}
                    </td>
                    <td className="px-3 py-1.5">
                      {have > 0 ? (
                        <span className="font-medium text-white">
                          <span aria-hidden="true" className="mr-1 text-neon-green">✓</span>
                          Have{have > 1 ? ` ${have}` : ""}
                        </span>
                      ) : (
                        <span className="text-slate-400">Need</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && (
            <p className="px-3 py-4 text-sm text-slate-300">
              Nothing left to chase here. Set complete!
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-slate-800 px-4 py-3">
        <button type="button" onClick={onClose} className={QUIET_BTN}>
          Close
        </button>
        <button
          type="button"
          onClick={() => onWork({ setId, variant })}
          className={GO_BTN}
        >
          Key cards from this set
        </button>
      </div>
    </Dialog>
  );
}
