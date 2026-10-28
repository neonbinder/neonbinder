import { useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import ModeRadioGroup from "@/components/primitives/ModeRadioGroup";
import type { Condition } from "@/app/collection/final/data/types";

/**
 * Settings → Collection — NEO-380. The condition a raw card gets when the
 * collector adds it without naming one: Excellent until they pick their own.
 * Every raw copy has a condition (the marketplaces list by it, NEO-370); the
 * copy form starts on this one, and quick counts in a box count and add it.
 *
 * A pick shows at once (an optimistic update on `getDefaultCondition`) and is
 * saved to the profile. Picks can overlap (arrow keys choose as they move),
 * so only the latest reports; a failed save is rolled back by Convex itself,
 * focus follows the restored option, and an alert says so.
 */

const CONDITION_OPTIONS: ReadonlyArray<{ value: Condition; label: string }> = [
  { value: "Mint", label: "Mint" },
  { value: "Near Mint", label: "Near Mint" },
  { value: "Excellent", label: "Excellent" },
  { value: "Very Good", label: "Very Good" },
  { value: "Good", label: "Good" },
  { value: "Poor", label: "Poor" },
];

type SaveState = "idle" | "saving" | "saved" | "failed";

export default function DefaultConditionSection() {
  const condition = useQuery(api.userProfile.getDefaultCondition, {});
  const save = useMutation(api.userProfile.setDefaultCondition).withOptimisticUpdate((local, args) => {
    local.setQuery(api.userProfile.getDefaultCondition, {}, args.condition);
  });
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const latestPick = useRef(0);
  const groupRef = useRef<HTMLDivElement>(null);
  const [rollbacks, setRollbacks] = useState(0);

  useLayoutEffect(() => {
    if (rollbacks === 0) return;
    const group = groupRef.current;
    // Only while focus is still in the group; never pull it back from elsewhere.
    if (!group || !group.contains(document.activeElement)) return;
    group.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
  }, [rollbacks]);

  const choose = async (next: Condition) => {
    if (next === condition) return;
    const pick = ++latestPick.current;
    setSaveState("saving");
    try {
      await save({ condition: next });
      if (pick === latestPick.current) setSaveState("saved");
    } catch {
      if (pick !== latestPick.current) return;
      setSaveState("failed");
      setRollbacks((n) => n + 1);
    }
  };

  return (
    <section aria-labelledby="settings-collection" className="space-y-6 p-6 border border-rule rounded-lg">
      <div>
        <h2 id="settings-collection" className="text-xl font-semibold text-ink">
          Collection
        </h2>
        <p className="text-sm text-ink-3 mt-1">
          New raw cards start in this condition. You can still change any one card, and graded cards keep their grade.
        </p>
      </div>

      <div ref={groupRef} aria-busy={condition === undefined || undefined}>
        {condition === undefined ? (
          <p className="text-sm text-ink-3">Loading your default…</p>
        ) : (
          condition !== null && (
            <ModeRadioGroup
              label="Default card condition"
              value={condition}
              options={CONDITION_OPTIONS}
              onChange={(next) => void choose(next)}
            />
          )
        )}
      </div>

      {/* The same live region as Appearance: a polite status always mounted,
          remounted as an alert on failure; empty, it takes no room. */}
      <p
        key={saveState === "failed" ? "failed" : "ok"}
        role={saveState === "failed" ? "alert" : "status"}
        aria-live={saveState === "failed" ? undefined : "polite"}
        className={"text-sm empty:-mt-6 " + (saveState === "failed" ? "text-neon-pink-text" : "text-ink-3")}
      >
        {saveState === "saving" && "Saving…"}
        {saveState === "saved" && "Saved."}
        {saveState === "failed" && "That didn't save, so your old default is back. Give it another try."}
      </p>
    </section>
  );
}
