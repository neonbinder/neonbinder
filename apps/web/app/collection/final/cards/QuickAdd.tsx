import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Input } from "@/components/primitives/Input";
import { cardsInSet, getSet, playerNames, variantLabel, type CardId, type SetId } from "../../prototypes/_shared/data";
import { parseRange } from "../../prototypes/p1/range";
import { FOCUS, LABEL, PRIMARY_BUTTON, SELECT } from "../../prototypes/p3/classes";
import { cardsNumbered, variantFilterOf, variantKey } from "../../prototypes/p3/wallModel";
import { useMyCards } from "./context";
import { blockedMessage, pickFirstLabel, runPlan } from "./model";

/**
 * NEO-350 — the two fast lanes onto the wall.
 *
 * "Type a number": the card in your hand. Matches light up on the wall; Enter
 * adds one copy only when exactly one card has that number. When several
 * share it (the base #1, its insert #1 and its Blue Foil #1) the box lists
 * every one to pick from.
 *
 * "Add a run": "1-50, -12, -33" against one row, previewed before it lands.
 * A number two cards share in that row (the regular #13 and its Sliding
 * variation) stops and asks which one is yours; nothing is added for it
 * until you pick.
 */
export default function QuickAdd({ setId, onSpot }: { setId: SetId; onSpot: (ids: string[]) => void }) {
  const api = useMyCards();
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
    const n = store.ownedInScope(id);
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
      api.addOne(matches[0]);
      setNumText("");
    } else if (matches.length > 1) {
      choicesRef.current?.querySelector("button")?.focus();
    }
  }

  let hint: string;
  const typed = numText.trim().replace(/^#/, "");
  if (!typed) hint = "Holding a card? Type its number. Enter adds it.";
  else if (matches.length === 0) hint = `No #${typed} in this set.`;
  else if (matches.length === 1) hint = `${api.label(matches[0])}, ${statusOf(matches[0].id)}. Enter adds one.`;
  else hint = `${matches.length} cards are #${typed}. Pick the one in your hand:`;

  // --- Add a run -------------------------------------------------------------
  const [rowKey, setRowKey] = useState(() => variantKey(set.variants[0]));
  const [rangeText, setRangeText] = useState("");
  /** For numbers several cards share: which of them the collector means. */
  const [picks, setPicks] = useState<Set<CardId>>(new Set());
  const row = set.variants.find((v) => variantKey(v) === rowKey) ?? set.variants[0];
  const rowCards = useMemo(() => cardsInSet(setId, variantFilterOf(row)), [setId, row]);
  const range = useMemo(
    () => (rangeText.trim() ? parseRange(rangeText, rowCards) : null),
    [rangeText, rowCards],
  );
  const plan = runPlan(range, picks, (id) => store.ownedInScope(id) > 0);
  const { toAdd, already, blocked } = plan;
  const rowName = variantLabel(row.path);
  const target = store.getBinder(store.targetBinderId)?.name ?? "Main";

  function commitRange() {
    if (blocked || toAdd.length === 0) return;
    const n = toAdd.length;
    api.addMany(toAdd, (into) => `Lit up ${n} ${n === 1 ? "card" : "cards"} in ${rowName}, into ${into}.`);
    setRangeText("");
    setPicks(new Set());
  }

  const addLabel =
    pickFirstLabel(plan) ??
    (toAdd.length === 0
      ? "Nothing new to add"
      : `Add ${toAdd.length} ${toAdd.length === 1 ? "card" : "cards"}`);

  return (
    <section
      aria-label="Quick add"
      className="mt-5 grid gap-4 rounded-2xl border border-rule bg-sheet p-4 shadow-offset md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
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
        <p id={numberHintId} role="status" className="mt-2 text-sm text-ink-2">
          {hint}
        </p>
        {matches.length > 1 && (
          <ul ref={choicesRef} className="mt-2 flex flex-col gap-1.5">
            {matches.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => {
                    api.addOne(c);
                    setNumText("");
                  }}
                  className={`flex min-h-11 w-full items-center gap-2 rounded-md border border-field-rule px-3 text-left text-sm text-ink hover:border-neon-blue sm:min-h-9 ${FOCUS}`}
                >
                  <span className="font-bold text-ink">{c.variantPath.name ?? "Base"}</span>
                  <span className="min-w-0 flex-1 truncate">
                    #{c.cardNumber} {playerNames(c)}
                    {c.variation ? `, ${c.variation} variation` : ""}
                  </span>
                  <span className={store.ownedInScope(c.id) ? "text-neon-blue-text" : "text-ink-3"}>
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
              spellCheck={false}
              placeholder="1-50, -12, -33"
              value={rangeText}
              onChange={(e) => {
                setRangeText(e.target.value);
                setPicks(new Set());
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
                  setPicks(new Set());
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
        <p id={rangeHelpId} className="mt-2 text-xs text-ink-3">
          Commas between pieces. A minus leaves a number out.
        </p>

        {range && (
          <div className="mt-3 rounded-lg border border-rule-strong bg-surface/40 p-3">
            {range.invalid ? (
              <p className="text-sm text-neon-yellow-text">
                Can&apos;t read that. Try numbers and runs like 1-50, -12.
              </p>
            ) : (
              <>
                <p className="text-sm text-ink-2">
                  <strong className="text-lg text-ink">
                    Adds {toAdd.length} {toAdd.length === 1 ? "card" : "cards"}
                  </strong>{" "}
                  to {rowName}, into {target}.{already > 0 && ` ${already} you already have stay as they are.`}
                </p>
                {range.unknown.length > 0 && (
                  <p className="mt-1 text-sm text-ink-3">Not on this checklist: {range.unknown.join(", ")}.</p>
                )}
                {blocked && <p className="mt-1 text-sm text-neon-yellow-text">{blockedMessage(plan)}</p>}
                {range.shared.map((group) => (
                  <div
                    key={group.number}
                    role="group"
                    aria-label={`Which #${group.number} is yours?`}
                    className="mt-2 rounded-md border border-neon-yellow/50 bg-neon-yellow/5 px-2 py-1.5"
                  >
                    <p className="text-sm text-ink-2">
                      #{group.number} is on {group.cards.length} cards. Which one&apos;s yours?
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {group.cards.map((c) => {
                        const on = picks.has(c.id);
                        return (
                          <button
                            key={c.id}
                            type="button"
                            aria-pressed={on}
                            onClick={() =>
                              setPicks((prev) => {
                                const next = new Set(prev);
                                if (on) next.delete(c.id);
                                else next.add(c.id);
                                return next;
                              })
                            }
                            className={`min-h-11 rounded-full border px-3 text-sm sm:min-h-8 ${FOCUS} ${
                              on
                                ? "border-selection bg-neon-blue text-on-neon-blue"
                                : "border-control text-ink-2 hover:border-neon-blue"
                            }`}
                          >
                            #{c.cardNumber} {playerNames(c)}
                            {c.variation ? `, ${c.variation} variation` : ", regular"}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={commitRange}
                  disabled={blocked || toAdd.length === 0}
                  className={`${PRIMARY_BUTTON} mt-3`}
                >
                  {addLabel}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
