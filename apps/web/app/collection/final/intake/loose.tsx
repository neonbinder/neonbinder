import { useState } from "react";
import NeonButton from "@/components/modules/NeonButton";
import CardFace from "../../prototypes/_shared/CardFace";
import { getCard } from "../../prototypes/_shared/data";
import type { IntakeSim, Loose } from "./sim";

/**
 * NEO-369 — scans with no partner: a front still waiting for its back, or
 * the halves of a pair the user split. Pairing by hand is a pick of one front
 * and one back (checkboxes, so it is keyboard-native; the placeholder
 * review grid made the same call over drag-and-drop).
 */
export default function LoosePile({ sim, dense = false }: { sim: IntakeSim; dense?: boolean }) {
  const [front, setFront] = useState<string | null>(null);
  const [back, setBack] = useState<string | null>(null);
  if (sim.loose.length === 0) return null;
  const pick = (l: Loose) => {
    if (l.as === "front") setFront((f) => (f === l.id ? null : l.id));
    else setBack((b) => (b === l.id ? null : l.id));
  };
  return (
    <section aria-labelledby="loose-heading" className="space-y-2">
      <h3 id="loose-heading" className="text-sm font-semibold text-ink">
        Waiting for a partner <span className="font-normal text-ink-3">({sim.loose.length})</span>
      </h3>
      <p className="m-0 text-xs text-ink-3">
        Scan the missing side and it pairs itself, or pick one front and one back to pair them now.
      </p>
      <ul className={`m-0 flex list-none flex-wrap gap-3 p-0 ${dense ? "" : ""}`}>
        {sim.loose.map((l) => {
          const checked = l.id === front || l.id === back;
          const card = l.truth ? getCard(l.truth) : null;
          return (
            <li key={l.id}>
              <label
                className={`flex cursor-pointer flex-col items-center gap-1 rounded-md border p-2 text-xs ${
                  checked ? "border-neon-blue-text bg-pick-blue text-pick-blue-ink" : "border-rule text-ink-2"
                }`}
              >
                <input type="checkbox" className="focus-outline" checked={checked} onChange={() => pick(l)} />
                {l.as === "front" && card ? (
                  <CardFace card={card} size="sm" />
                ) : (
                  <span className="grid h-[7.7rem] w-[5.5rem] place-items-center rounded-md border border-rule bg-sheet text-ink-3">Back</span>
                )}
                <span>
                  {l.as} · {l.side.file}
                </span>
                {l.read.player && <span className="text-ink-3">{l.read.player}</span>}
              </label>
            </li>
          );
        })}
      </ul>
      <NeonButton
        size="1"
        variant="secondary"
        disabled={!front || !back}
        onClick={() => {
          if (front && back) sim.actions.pairLoose(front, back);
          setFront(null);
          setBack(null);
        }}
      >
        Pair these two
      </NeonButton>
    </section>
  );
}
