import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import ModeRadioGroup from "@/components/primitives/ModeRadioGroup";
import type { PolicyOption } from "@/lib/marketplace/ebay-setup";

/** What a save answered: the server's own sentence when it refused. */
export type SaveAnswer = { ok: true } | { ok: false; error: string };

type SaveState = "idle" | "saving" | "saved" | "failed";

/**
 * NEO-415 — one eBay policy slot on Profile → eBay: the seller's own
 * policies as choice cards (a radio group: Tab lands on the pick, arrows
 * choose). A pick shows at once and saves; picks can overlap (arrows choose
 * as they move), so only the latest reports. A refused or failed save puts
 * the old pick back, moves focus to it while focus is still in the group,
 * and says why in an alert (the DefaultConditionSection pattern).
 *
 * The saved value comes from `ebayConnect.connectionState`; the local pick
 * holds until the query catches up, so the cards never flick back while the
 * save's action has answered and the query has not.
 */
export default function PolicyPicker({
  label,
  options,
  saved,
  onSave,
  emptyLine,
  children,
}: {
  /** The group's visible label and accessible name. */
  label: string;
  options: PolicyOption[];
  saved: string | null;
  onSave: (id: string) => Promise<SaveAnswer>;
  /** Said instead of the cards when there is nothing to pick. */
  emptyLine: string;
  /** A note under the cards (what the picker leaves out, say). */
  children?: ReactNode;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState("");
  const latestPick = useRef(0);
  const groupRef = useRef<HTMLDivElement>(null);
  const [rollbacks, setRollbacks] = useState(0);

  // The query caught up with the pick: let it speak for the value again.
  if (pending !== null && saved === pending && saveState !== "saving") setPending(null);
  const value = pending ?? saved ?? "";

  useLayoutEffect(() => {
    if (rollbacks === 0) return;
    const group = groupRef.current;
    // Only while focus is still in the group; never pull it back from elsewhere.
    if (!group || !group.contains(document.activeElement)) return;
    const checked = group.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
    (checked ?? group.querySelector<HTMLElement>('[role="radio"]'))?.focus();
  }, [rollbacks]);

  const choose = async (next: string) => {
    if (next === value) return;
    const pick = ++latestPick.current;
    setPending(next);
    setSaveState("saving");
    let answer: SaveAnswer;
    try {
      answer = await onSave(next);
    } catch {
      answer = { ok: false, error: "That didn't save. Give it another try." };
    }
    if (pick !== latestPick.current) return;
    if (answer.ok) {
      setSaveState("saved");
      return;
    }
    setPending(null);
    setError(answer.error);
    setSaveState("failed");
    setRollbacks((n) => n + 1);
  };

  const gone = saved !== null && pending === null && !options.some((o) => o.value === saved);

  return (
    <div className="space-y-2">
      <div ref={groupRef}>
        {options.length === 0 ? (
          <>
            <span className="mb-2 block text-sm font-medium text-ink-2">{label}</span>
            <p className="rounded-md border border-dashed border-rule-strong px-3 py-2 text-sm text-ink-3">{emptyLine}</p>
          </>
        ) : (
          <ModeRadioGroup label={label} value={value} options={options} onChange={(next) => void choose(next)} />
        )}
      </div>
      {gone && (
        <p className="text-sm text-notice-warn-ink">
          The policy you picked here isn&apos;t on your eBay account anymore. Pick another.
        </p>
      )}
      {children}
      {/* One live region, remounted as an alert on failure; empty, it takes no room. */}
      <p
        key={saveState === "failed" ? "failed" : "ok"}
        role={saveState === "failed" ? "alert" : "status"}
        aria-live={saveState === "failed" ? undefined : "polite"}
        className={"text-sm " + (saveState === "failed" ? "text-neon-pink-text" : "text-ink-3")}
      >
        {saveState === "saving" && "Saving…"}
        {saveState === "saved" && "Saved."}
        {saveState === "failed" && `${error}${saved ? " Your old pick is back." : ""}`}
      </p>
    </div>
  );
}
