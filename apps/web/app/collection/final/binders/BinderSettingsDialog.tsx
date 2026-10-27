import { useId, useState } from "react";
import NeonButton from "@/components/modules/NeonButton";
import { ruleProblem } from "@/lib/collection/binder-rule";
import Modal from "../../prototypes/p2/Modal";
import { useCapabilities } from "../data/store";
import type { BinderSettingsPatch, BinderSort, Container, SmartRule } from "../data/types";
import type { BinderLayout } from "./model";
import RuleBuilder, { blankRule, describeSmartRule } from "./RuleBuilder";

/**
 * NEO-362 — one binder's settings, in place of the old "Lay out like my real
 * binder / Just a stack" toggle. Every binder has them, Main included:
 *
 * - **Order.** Unsorted (the default: each card stays in the pocket it was
 *   put in, drag it anywhere), or kept sorted by checklist, player or team.
 *   An unsorted binder can also be sorted ONCE ("Sort now") and stays
 *   unsorted after, so the collector can still move cards by hand.
 * - **Empty slots.** The cards it still needs, each in the pocket it would
 *   fill; on by default for a binder that follows a checklist.
 * - **The public page** shows the empty slots too, only when asked.
 * - **A smart rule** (not on Main): what cards belong, and "Find cards" to
 *   pull in the ones the collector already has.
 *
 * Each choice saves as it is made (with Undo on the status line); the rule
 * saves on its own Save, once it is whole.
 */

const CHOICE =
  "flex cursor-pointer items-start gap-2 rounded-md border border-field-rule bg-field px-3 py-2 text-sm text-ink-2 has-[:checked]:border-selection has-[:checked]:text-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60";
const SECTION = "border-t border-rule-strong pt-4";
const HEADING = "text-base font-bold text-ink";
const SELECT = "rounded-md border border-field-rule bg-field px-3 py-2 text-base text-ink focus-outline";

const ORDERS: { value: BinderSort | null; title: string; line: string }[] = [
  { value: null, title: "Where I put them", line: "Each card stays in its pocket. Drag cards anywhere." },
  { value: "checklist", title: "Keep sorted by checklist", line: "Year, set, then card number." },
  { value: "player", title: "Keep sorted by player", line: "By last name. A card with two players files under the first." },
  { value: "team", title: "Keep sorted by team", line: "A card with two teams files under the first." },
];

const SORT_WORDS: Record<BinderSort, string> = { checklist: "checklist", player: "player", team: "team" };

export default function BinderSettingsDialog({
  container,
  layout,
  follows,
  tooBigToSort,
  onSettings,
  onSortNow,
  onRule,
  onFindCards,
  onClose,
}: {
  container: Container;
  /** The binder's layout, its defaults resolved. */
  layout: BinderLayout;
  /** It follows a checklist (empty slots default on). */
  follows: boolean;
  /** Too many cards to keep sorted, or to sort at once: why, else null. */
  tooBigToSort: string | null;
  onSettings: (patch: BinderSettingsPatch) => void;
  onSortNow: (sort: BinderSort) => void;
  /** Resolves with null once saved, or why it was refused. */
  onRule: (rule: SmartRule | null) => Promise<string | null>;
  onFindCards: () => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const id = useId();
  const { binderRules } = useCapabilities();
  const [once, setOnce] = useState<BinderSort>("checklist");
  const [draft, setDraft] = useState<{ rule: SmartRule; names: Record<string, string> } | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rules = binderRules && container.system !== "main";
  const rule = container.smartRule;

  const saveRule = async () => {
    if (!draft || busy) return;
    setTried(true);
    if (ruleProblem(draft.rule)) return;
    setBusy(true);
    setError(null);
    const refused = await onRule(draft.rule);
    setBusy(false);
    if (refused) setError(refused);
    else {
      setDraft(null);
      setTried(false);
    }
  };

  return (
    <Modal labelledBy={titleId} onClose={onClose} className="max-w-lg">
      <div className="space-y-4 p-5">
        <div>
          <h2 id={titleId} className="text-xl font-bold text-ink">
            {container.name} settings
          </h2>
          <p className="mt-1 text-sm text-ink-2">Each change saves right away. Undo is on the status line.</p>
        </div>

        <fieldset className={SECTION}>
          <legend className={HEADING}>Order</legend>
          <div className="mt-2 grid gap-2">
            {ORDERS.map((o) => {
              const disabled = o.value !== null && layout.sort === null && !!tooBigToSort;
              return (
                <label key={o.value ?? "none"} className={CHOICE}>
                  <input
                    type="radio"
                    name={`${id}-order`}
                    className="mt-0.5 h-4 w-4 accent-selection"
                    checked={layout.sort === o.value}
                    disabled={disabled}
                    onChange={() => onSettings({ sort: o.value })}
                  />
                  <span>
                    <span className="block font-medium">{o.title}</span>
                    <span className="block text-ink-3">{o.line}</span>
                  </span>
                </label>
              );
            })}
          </div>
          <p className="mt-2 text-sm text-ink-3">
            {layout.sort
              ? "While it keeps itself sorted, cards can't be dragged between pockets. Turn sorting off and every card stays where it is now."
              : "New cards go in the first open pocket."}
          </p>
          {tooBigToSort && <p className="mt-2 text-sm text-notice-warn-ink">{tooBigToSort}</p>}
          {!layout.sort && !tooBigToSort && (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-ink-2">Sort it once, by</span>
                <select className={SELECT} value={once} onChange={(e) => setOnce(e.target.value as BinderSort)}>
                  {(Object.keys(SORT_WORDS) as BinderSort[]).map((s) => (
                    <option key={s} value={s}>
                      {SORT_WORDS[s]}
                    </option>
                  ))}
                </select>
              </label>
              <NeonButton type="button" variant="secondary" onClick={() => onSortNow(once)} className="min-h-10">
                Sort now
              </NeonButton>
              <p className="w-full text-sm text-ink-3">
                Re-pockets every card once. After that you can still drag them around.
              </p>
            </div>
          )}
        </fieldset>

        <fieldset className={SECTION}>
          <legend className={HEADING}>Empty slots</legend>
          <div className="mt-2 grid gap-2">
            <label className={CHOICE}>
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-selection"
                checked={layout.emptySlots}
                onChange={(e) => onSettings({ emptySlots: e.target.checked })}
              />
              <span>
                <span className="block font-medium">Include empty slots</span>
                <span className="block text-ink-3">
                  {layout.sort
                    ? "A card this binder still needs gets an empty sleeve where it would go, and each checklist, player or team starts a fresh page."
                    : follows
                      ? "The checklist's missing cards show as empty sleeves in their own pockets."
                      : "Shown once the binder keeps itself sorted, or follows a checklist pocket by pocket."}
                  {follows ? " On by default here: this binder follows a checklist." : ""}
                </span>
              </span>
            </label>
            <label className={CHOICE}>
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-selection"
                checked={!!container.settings?.publicEmptySlots}
                disabled={container.system === "main"}
                onChange={(e) => onSettings({ publicEmptySlots: e.target.checked ? true : null })}
              />
              <span>
                <span className="block font-medium">Show empty slots on my public page</span>
                <span className="block text-ink-3">
                  {container.system === "main"
                    ? "Main is never public."
                    : "Lets visitors see what you still need. Leave it off to just show off what you have."}
                </span>
              </span>
            </label>
          </div>
        </fieldset>

        {rules && (
          <section className={SECTION} aria-labelledby={`${id}-rule`}>
            <h3 id={`${id}-rule`} className={HEADING}>
              Smart rule
            </h3>
            {!draft ? (
              <>
                <p className="mt-1 text-sm text-ink-2">
                  {rule
                    ? `Takes ${describeSmartRule(rule, container.ruleNames)}.`
                    : "Say which cards belong here, and Find cards pulls in the ones you already have. Nothing moves until you say so."}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {rule && (
                    <NeonButton type="button" onClick={onFindCards} className="min-h-10">
                      Find cards
                    </NeonButton>
                  )}
                  <NeonButton
                    type="button"
                    variant="secondary"
                    outline
                    onClick={() => setDraft({ rule: rule ?? blankRule(), names: { ...(container.ruleNames ?? {}) } })}
                    className="min-h-10"
                  >
                    {rule ? "Edit the rule" : "Add a rule"}
                  </NeonButton>
                  {rule && (
                    <NeonButton
                      type="button"
                      variant="negative"
                      outline
                      onClick={() => void onRule(null).then((r) => setError(r))}
                      className="min-h-10"
                    >
                      Remove the rule
                    </NeonButton>
                  )}
                </div>
              </>
            ) : (
              <div className="mt-2 space-y-3">
                <RuleBuilder
                  rule={draft.rule}
                  names={draft.names}
                  onChange={(next, names) => setDraft({ rule: next, names })}
                  showProblems={tried}
                />
                {rule && (
                  <p className="text-sm text-ink-3">
                    Cards already here that the new rule leaves out stay put, marked &ldquo;outside the rule&rdquo;.
                  </p>
                )}
                <div className="flex flex-wrap justify-end gap-2">
                  <NeonButton
                    type="button"
                    variant="negative"
                    outline
                    onClick={() => {
                      setDraft(null);
                      setTried(false);
                      setError(null);
                    }}
                    className="min-h-10"
                  >
                    Cancel
                  </NeonButton>
                  <NeonButton
                    type="button"
                    onClick={() => void saveRule()}
                    aria-disabled={busy ? true : undefined}
                    aria-busy={busy ? true : undefined}
                    className="min-h-10"
                  >
                    Save the rule
                  </NeonButton>
                </div>
              </div>
            )}
            <p role="alert" className="mt-2 text-sm text-neon-pink-text empty:hidden">
              {error ?? ""}
            </p>
          </section>
        )}

        <div className="flex justify-end border-t border-rule-strong pt-4">
          <NeonButton type="button" variant="secondary" outline onClick={onClose} className="min-h-10">
            Done
          </NeonButton>
        </div>
      </div>
    </Modal>
  );
}
