import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Input } from "@/components/primitives/Input";
import { FOCUS, LABEL, PRIMARY_BUTTON, SELECT } from "../../prototypes/p3/classes";
import { copiesByCard } from "../catalog/home";
import { playerNames, variantLabel } from "../data/labels";
import { useCopiesInVariant, useVariantCards } from "../data/store";
import type { CardId, Variant } from "../data/types";
import { useMyCards } from "./context";
import { blockedMessage, pickFirstLabel, runPlan } from "./model";
import { parseRange } from "./range";

/**
 * NEO-350 / NEO-358 — the two fast lanes onto the wall, both against one
 * checklist of the set (picked in "Checklist"; Base to start).
 *
 * "Type a number": the card in your hand. Matches light up on the wall; Enter
 * adds one copy only when exactly one card has that number. When several
 * share it (the regular #13 and its Sliding variation) the box lists every
 * one to pick from.
 *
 * "Add a run": "1-50, -12, -33", previewed before it lands. A number two
 * cards share stops and asks which one is yours; nothing is added for it, or
 * for the rest of the run, until you pick (or take it out with -N).
 */
export default function QuickAdd({ variants, onSpot }: { variants: Variant[]; onSpot: (ids: string[]) => void }) {
  const api = useMyCards();
  const numberHintId = useId();
  const rangeHelpId = useId();
  const choicesRef = useRef<HTMLUListElement>(null);

  const [rowId, setRowId] = useState(() => variants[0]?.id ?? "");
  const row = variants.find((v) => v.id === rowId) ?? variants[0];
  const rowCards = useVariantCards(row?.id ?? null);
  const rowCopies = useCopiesInVariant(row?.id ?? null);
  const byCard = useMemo(() => copiesByCard(rowCopies), [rowCopies]);
  const ownedOf = (id: string) => (byCard.get(id) ?? []).reduce((n, c) => n + c.quantity, 0);
  const rowName = row ? variantLabel(row) : "";

  // --- Type a number ---------------------------------------------------------
  const [numText, setNumText] = useState("");
  const typed = numText.trim().replace(/^#/, "").toLowerCase();
  const matches = useMemo(
    () => (typed && rowCards ? rowCards.filter((c) => c.cardNumber.toLowerCase() === typed) : []),
    [typed, rowCards],
  );
  const matchKey = matches.map((c) => c.id).join("|");
  useEffect(() => {
    onSpot(matchKey ? matchKey.split("|") : []);
  }, [matchKey, onSpot]);

  function statusOf(id: string) {
    const n = ownedOf(id);
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
      api.addOne(matches[0], ownedOf(matches[0].id));
      setNumText("");
    } else if (matches.length > 1) {
      choicesRef.current?.querySelector("button")?.focus();
    }
  }

  const shown = numText.trim().replace(/^#/, "");
  let hint: string;
  if (!shown) hint = "Holding a card? Type its number. Enter adds it.";
  else if (!rowCards) hint = "Dealing out the checklist…";
  else if (matches.length === 0) hint = `No #${shown} in ${rowName}.`;
  else if (matches.length === 1) hint = `${api.label(matches[0])}, ${statusOf(matches[0].id)}. Enter adds one.`;
  else hint = `${matches.length} cards are #${shown}. Pick the one in your hand:`;

  // --- Add a run -------------------------------------------------------------
  const [rangeText, setRangeText] = useState("");
  /** For numbers several cards share: which of them the collector means. */
  const [picks, setPicks] = useState<Set<CardId>>(new Set());
  const range = useMemo(
    () => (rangeText.trim() && rowCards ? parseRange(rangeText, rowCards) : null),
    [rangeText, rowCards],
  );
  const plan = runPlan(range, picks, (id) => byCard.has(id));
  const { toAdd, already, blocked } = plan;

  function commitRange() {
    if (blocked || toAdd.length === 0) return;
    const n = toAdd.length;
    api.addMany(toAdd, (into) => `Lit up ${n} ${n === 1 ? "card" : "cards"} in ${rowName}, into ${into}.`);
    setRangeText("");
    setPicks(new Set());
  }

  const addLabel =
    pickFirstLabel(plan) ??
    (toAdd.length === 0 ? "Nothing new to add" : `Add ${toAdd.length} ${toAdd.length === 1 ? "card" : "cards"}`);

  if (!row) return null;

  return (
    <section
      aria-label="Quick add"
      className="mt-5 grid gap-4 rounded-2xl border border-rule bg-sheet p-4 shadow-offset md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
    >
      <div className="md:col-span-2">
        <label className="block max-w-sm">
          <span className={LABEL}>Checklist</span>
          <select
            className={`${SELECT} w-full`}
            value={row.id}
            onChange={(e) => {
              setRowId(e.target.value);
              setPicks(new Set());
            }}
          >
            {variants.map((v) => (
              <option key={v.id} value={v.id}>
                {variantLabel(v)}
              </option>
            ))}
          </select>
        </label>
      </div>
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
                    api.addOne(c, ownedOf(c.id));
                    setNumText("");
                  }}
                  className={`flex min-h-11 w-full items-center gap-2 rounded-md border border-field-rule px-3 text-left text-sm text-ink hover:border-neon-blue sm:min-h-9 ${FOCUS}`}
                >
                  <span className="font-bold text-ink">{rowName}</span>
                  <span className="min-w-0 flex-1 truncate">
                    #{c.cardNumber} {playerNames(c)}
                    {c.cardVariation ? `, ${c.cardVariation} variation` : ""}
                  </span>
                  <span className={ownedOf(c.id) ? "text-neon-blue-text" : "text-ink-3"}>{statusOf(c.id)}</span>
                  <span className="sr-only">. Adds one.</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
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
        <p id={rangeHelpId} className="mt-2 text-xs text-ink-3">
          Commas between pieces. A minus leaves a number out.
        </p>

        {range && (
          <div className="mt-3 rounded-lg border border-rule-strong bg-surface/40 p-3">
            {range.invalid ? (
              <p className="text-sm text-neon-yellow-text">Can&apos;t read that. Try numbers and runs like 1-50, -12.</p>
            ) : (
              <>
                <p className="text-sm text-ink-2">
                  <strong className="text-lg text-ink">
                    Adds {toAdd.length} {toAdd.length === 1 ? "card" : "cards"}
                  </strong>{" "}
                  to {rowName}, into {api.into}.{already > 0 && ` ${already} you already have stay as they are.`}
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
                              on ? "border-selection bg-neon-blue text-on-neon-blue" : "border-control text-ink-2 hover:border-neon-blue"
                            }`}
                          >
                            #{c.cardNumber} {playerNames(c)}
                            {c.cardVariation ? `, ${c.cardVariation} variation` : ", regular"}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                <button type="button" onClick={commitRange} disabled={blocked || toAdd.length === 0} className={`${PRIMARY_BUTTON} mt-3`}>
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
