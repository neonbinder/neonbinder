import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import ModeRadioGroup from "@/components/primitives/ModeRadioGroup";
import type { PolicyOption } from "@/lib/marketplace/ebay-setup";

/** What a save answered: the server's own sentence when it refused. */
export type SaveAnswer = { ok: true } | { ok: false; error: string };

type SaveState = "idle" | "saving" | "saved" | "failed";

const GONE_LINE = "The policy you picked here isn't on your eBay account anymore. Pick another.";

/**
 * NEO-415 — one eBay policy slot on Profile → Credentials → eBay: the seller's own
 * policies as choice cards (a radio group: Tab lands on the pick, arrows
 * choose). A pick shows at once and saves; picks can overlap (arrows choose
 * as they move), so only the latest reports. A refused or failed save puts
 * the old pick back, moves focus to it while focus is still in the group,
 * and says why in an alert (the DefaultConditionSection pattern).
 *
 * One live line says it all: saving, saved, a refusal, or that the saved
 * policy is no longer on the account. It holds one line's room even while
 * empty, so "Saving…" never shoves the next picker down as arrows choose. While it holds a refusal or that
 * warning, the radiogroup is described by it, so focus on the group reads
 * it too.
 *
 * A `hint` says what fits the slot under the cards, and describes the group
 * after any refusal or warning (the Packing weight's pattern).
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
  hint,
  children,
}: {
  /** The group's visible label and accessible name. */
  label: string;
  options: PolicyOption[];
  saved: string | null;
  onSave: (id: string) => Promise<SaveAnswer>;
  /** Said instead of the cards when there is nothing to pick. */
  emptyLine: string;
  /** What fits this slot, under the cards; it describes the group. */
  hint?: string;
  /** A note under the cards (what the picker leaves out, or where to make one). */
  children?: ReactNode;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState("");
  const latestPick = useRef(0);
  const groupRef = useRef<HTMLDivElement>(null);
  const [rollbacks, setRollbacks] = useState(0);
  const lineId = useId();
  const hintId = useId();

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
  const failed = saveState === "failed";
  const warnGone = gone && !failed && saveState !== "saving";
  let text = "";
  if (saveState === "saving") text = "Saving…";
  else if (failed) text = `${error}${gone ? ` ${GONE_LINE}` : saved ? " Your old pick is back." : ""}`;
  else if (warnGone) text = GONE_LINE;
  else if (saveState === "saved") text = "Saved.";
  // The group is described by the line only while it says something about the pick.
  const describes = failed || warnGone;
  const describedBy = [describes ? lineId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className="flex flex-col gap-2">
      <div ref={groupRef}>
        {options.length === 0 ? (
          <>
            <span className="mb-2 block text-sm font-medium text-ink-2">{label}</span>
            <p className="rounded-md border border-dashed border-rule-strong px-3 py-2 text-sm text-ink-3">{emptyLine}</p>
          </>
        ) : (
          <ModeRadioGroup
            label={label}
            value={value}
            options={options}
            onChange={(next) => void choose(next)}
            describedBy={describedBy}
          />
        )}
      </div>
      {hint && (
        <p id={hintId} className="text-sm text-ink-3">
          {hint}
        </p>
      )}
      {children}
      {/* One live region, remounted as an alert on failure. */}
      <p
        id={lineId}
        key={failed ? "failed" : "ok"}
        role={failed ? "alert" : "status"}
        aria-live={failed ? undefined : "polite"}
        className={
          "min-h-5 text-sm " +
          (failed ? "text-neon-pink-text" : warnGone ? "text-notice-warn-ink" : "text-ink-3")
        }
      >
        {text}
      </p>
    </div>
  );
}
