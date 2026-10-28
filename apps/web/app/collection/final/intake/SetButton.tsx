import { useRef, useState } from "react";
import NeonButton from "@/components/modules/NeonButton";
import Cascade from "../catalog/Cascade";
import { drillToCard, EMPTY_DRILL, type Drill } from "../catalog/drill";
import { useDrillState } from "../catalog/useDrillState";
import { useCard } from "../data/store";
import { SEED_CARD_ID, SET_LABEL } from "./sim";
import { RING } from "./ui";

/** What the run is pinned to: the picked variant, or nothing (the set comes from the photos). */
export interface SetPick {
  /** "2024 Topps Chrome Base". */
  title: string;
  /** The variant's own name ("Base", "Refractor"): the key for the common price. */
  variant: string;
}

/**
 * NEO-369 — the Add cards tab's set pick: the full set selector (the same
 * cascade as Checklists, sport to variant) behind one button. Jason
 * (2026-10-27): "a button click that opens the full selector widget and then
 * collapses back into just the button once selected", the way Defaults does.
 *
 * It opens on the demo pile's own set (2024 Topps Chrome Base) and offers
 * "Skip": then each card's set is found from its photo, and the prompt to pin
 * "all from this set" appears on the cards.
 */
export default function SetButton({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The variant picked, or null for Skip. */
  onPick: (pick: SetPick | null) => void;
}) {
  const seed = useCard(SEED_CARD_ID);
  const [drill, setDrill] = useState<Drill | null>(null);
  const [skipped, setSkipped] = useState(false);
  const shown = drill ?? (seed ? drillToCard(seed) : EMPTY_DRILL);
  const state = useDrillState(shown);
  const button = useRef<HTMLButtonElement>(null);
  const label = skipped ? "Set: from the photos" : `Set: ${state.checklistTitle ?? (state.pending ? SET_LABEL : "pick one")}`;

  const close = () => {
    onOpenChange(false);
    requestAnimationFrame(() => button.current?.focus());
  };

  return (
    <>
      <NeonButton
        ref={button}
        variant="secondary"
        outline
        aria-expanded={open}
        aria-controls="intake-set-panel"
        onClick={() => onOpenChange(!open)}
      >
        {label}
      </NeonButton>
      {open && (
        <div id="intake-set-panel" className="order-last w-full space-y-3 border-t border-rule pt-3">
          <p className="m-0 text-sm text-ink-2">
            Pick the set down to the variant. Matching is much surer with it; skip it for a mixed pile.
          </p>
          <Cascade
            state={state}
            onDrill={(next) => {
              setDrill(next);
              setSkipped(false);
            }}
            label="Sport, year, brand, set and variant"
            onReachedChecklist={() => {
              // A variant picked: the run takes it and the panel folds back
              // into the button, which takes the caret.
              if (!state.checklist) return false;
              onPick({ title: state.checklistTitle ?? state.checklist.name, variant: state.checklist.name });
              close();
              return true;
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setSkipped(true);
                onPick(null);
                close();
              }}
              className={`min-h-10 rounded-md px-2 text-sm text-ink-2 underline underline-offset-4 hover:text-ink ${RING}`}
            >
              Skip: find each card&apos;s set from its photo
            </button>
          </div>
        </div>
      )}
    </>
  );
}
