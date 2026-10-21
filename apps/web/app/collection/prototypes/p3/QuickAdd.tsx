import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Input } from "@/components/primitives/Input";
import { cardsInSet, getSet, playerNames, variantLabel, type SetId } from "../_shared/data";
import { LABEL, PRIMARY_BUTTON, SELECT, FOCUS } from "./classes";
import { useP3 } from "./context";
import { parseRange } from "./rangeParse";
import { cardsNumbered, variantFilterOf, variantKey } from "./wallModel";

/**
 * NEO-350 prototype 3 — the two fast lanes onto the wall.
 *
 * "Type a number": the card in your hand. Matches light up on the wall; Enter
 * adds one copy. When several cards share the number (the base #1, its
 * insert #1 and its Blue Foil #1) the box lists every one to pick from.
 *
 * "Add a run": "1-50, -12, -33" against one row, previewed before it lands.
 */

export default function QuickAdd({
  setId,
  onSpot,
}: {
  setId: SetId;
  onSpot: (ids: string[]) => void;
}) {
  const api = useP3();
  const { store } = api;
  const set = getSet(setId);
  const numberHintId = useId();
  const rangeHelpId = useId();
  const choicesRef = useRef<HTMLUListElement>(null);

  // --- Type a number ---------------------------------------------------------
  const [numText, setNumText] = useState("");
  const matches = useMemo(() => cardsNumbered(setId, numText), [setId, numText]);
  const matchKey = matches.map((c) => c.id).join("|");
  useEffect(() => {
    onSpot(matchKey ? matchKey.split("|") : []);
  }, [matchKey, onSpot]);

  function statusOf(id: string) {
    const n = store.ownedCount(id);
    return n === 0 ? "need" : n === 1 ? "have" : `have ${n}`;
  }

  function onNumberKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape" && numText) {
      e.preventDefault();
      setNumText("");
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (matches.length === 1) {
      api.addOne(matches[0], "number box");
      setNumText("");
    } else if (matches.length > 1) {
      choicesRef.current?.querySelector("button")?.focus();
    }
  }

  let hint: string;
  const typed = numText.trim().replace(/^#/, "");
  if (!typed) hint = "Holding a card? Type its number. Enter adds it.";
  else if (matches.length === 0) hint = `No #${typed} in this set.`;
  else if (matches.length === 1) {
    const c = matches[0];
    hint = `${c.variantPath.name ?? "Base"} #${c.cardNumber} ${playerNames(c)}, ${statusOf(c.id)}. Enter adds one.`;
  } else hint = `${matches.length} cards are #${typed}. Pick the one in your hand:`;

  // --- Add a run -------------------------------------------------------------
  const [rowKey, setRowKey] = useState(() => variantKey(set.variants[0]));
  const [rangeText, setRangeText] = useState("");
  const [leftOut, setLeftOut] = useState<Set<string>>(new Set());
  const row = set.variants.find((v) => variantKey(v) === rowKey) ?? set.variants[0];
  const rowCards = useMemo(() => cardsInSet(setId, variantFilterOf(row)), [setId, row]);
  const plan = useMemo(() => parseRange(rangeText, rowCards), [rangeText, rowCards]);
  const picked = plan.cards.filter((c) => !leftOut.has(c.id));
  const toAdd = picked.filter((c) => store.ownedCount(c.id) === 0);
  const already = picked.length - toAdd.length;
  const rowName = variantLabel(row.path);

  function commitRange() {
    if (toAdd.length === 0) return;
    api.addMany(toAdd, `Lit up ${toAdd.length} ${toAdd.length === 1 ? "card" : "cards"} in ${rowName}.`);
    setRangeText("");
    setLeftOut(new Set());
  }

  return (
    <section
      aria-label="Quick add"
      className="mt-5 grid gap-4 rounded-2xl border border-slate-800 bg-slate-950 p-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
    >
      <div>
        <Input
          label="Type a number"
          inputMode="text"
          autoComplete="off"
          placeholder="27"
          value={numText}
          onChange={(e) => setNumText(e.target.value)}
          onKeyDown={onNumberKey}
          aria-describedby={numberHintId}
        />
        <p id={numberHintId} role="status" className="mt-2 text-sm text-slate-300">
          {hint}
        </p>
        {matches.length > 1 && (
          <ul ref={choicesRef} className="mt-2 flex flex-col gap-1.5">
            {matches.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => {
                    api.addOne(c, "number box");
                    setNumText("");
                  }}
                  className={`flex min-h-11 w-full items-center gap-2 rounded-md border border-slate-700 px-3 text-left text-sm text-slate-100 hover:border-neon-blue sm:min-h-9 ${FOCUS}`}
                >
                  <span className="font-bold text-white">{c.variantPath.name ?? "Base"}</span>
                  <span className="min-w-0 flex-1 truncate">
                    #{c.cardNumber} {playerNames(c)}
                    {c.variation ? `, ${c.variation} variation` : ""}
                  </span>
                  <span className={store.ownedCount(c.id) ? "text-neon-blue" : "text-slate-400"}>
                    {statusOf(c.id)}
                  </span>
                  <span className="sr-only">. Adds one.</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-[2_1_12rem]">
            <Input
              label="Add a run of numbers"
              autoComplete="off"
              placeholder="1-50, -12, -33"
              value={rangeText}
              onChange={(e) => {
                setRangeText(e.target.value);
                setLeftOut(new Set());
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitRange();
                } else if (e.key === "Escape" && rangeText) {
                  e.preventDefault();
                  setRangeText("");
                }
              }}
              aria-describedby={rangeHelpId}
            />
          </div>
          <div className="flex-[1_1_8rem]">
            <label className="block">
              <span className={LABEL}>In row</span>
              <select
              className={`${SELECT} w-full`}
              value={rowKey}
              onChange={(e) => {
                setRowKey(e.target.value);
                setLeftOut(new Set());
              }}
            >
              {set.variants.map((v) => (
                <option key={variantKey(v)} value={variantKey(v)}>
                  {variantLabel(v.path)}
                </option>
              ))}
              </select>
            </label>
          </div>
        </div>
        <p id={rangeHelpId} className="mt-2 text-xs text-slate-400">
          Commas between pieces. A minus leaves a number out.
        </p>

        {rangeText.trim() && (
          <div className="mt-3 rounded-lg border border-slate-700 bg-black/40 p-3">
            {plan.error ? (
              <p className="text-sm text-neon-yellow">{plan.error}</p>
            ) : (
              <>
                <p className="text-sm text-slate-200">
                  <strong className="text-lg text-white">
                    Adds {toAdd.length} {toAdd.length === 1 ? "card" : "cards"}
                  </strong>{" "}
                  to {rowName}.
                  {already > 0 && ` ${already} you already have stay as they are.`}
                </p>
                {plan.notFound.length > 0 && (
                  <p className="mt-1 text-sm text-slate-400">
                    Not on this checklist: #{plan.notFound.join(", #")}.
                  </p>
                )}
                {plan.ambiguous.map((group) => (
                  <div key={group.number} className="mt-2">
                    <p className="text-sm text-neon-yellow">
                      #{group.number} is {group.cards.length} different cards. {group.cards.length === 2 ? "Both are" : "All are"} in; tap one to leave it out.
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {group.cards.map((c) => {
                        const included = !leftOut.has(c.id);
                        return (
                          <button
                            key={c.id}
                            type="button"
                            aria-pressed={included}
                            onClick={() =>
                              setLeftOut((prev) => {
                                const next = new Set(prev);
                                if (next.has(c.id)) next.delete(c.id);
                                else next.add(c.id);
                                return next;
                              })
                            }
                            className={`min-h-11 rounded-full border px-3 text-sm sm:min-h-8 ${FOCUS} ${
                              included
                                ? "border-neon-blue bg-neon-blue text-black"
                                : "border-slate-600 text-slate-300 line-through"
                            }`}
                          >
                            #{c.cardNumber} {playerNames(c)}
                            {c.variation ? `, ${c.variation}` : ", regular"}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={commitRange}
                  disabled={toAdd.length === 0}
                  className={`${PRIMARY_BUTTON} mt-3`}
                >
                  {toAdd.length === 0
                    ? "Nothing new to add"
                    : `Add ${toAdd.length} ${toAdd.length === 1 ? "card" : "cards"}`}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
