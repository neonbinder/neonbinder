import { useId, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "@/components/primitives/Button";
import { Input } from "@/components/primitives/Input";
import { Textarea } from "@/components/primitives/Textarea";
import {
  cardLabel,
  printRunLabel,
  type Binder,
  type Card,
  type Condition,
  type CopyDetails,
  type Grader,
} from "./data";

/**
 * NEO-350 — the "details" editor every collection prototype can drop in.
 *
 * Controlled: the parent owns `value` and gets every edit through `onChange`.
 * Only quantity is required; everything else is optional, and the form says
 * so rather than marking fields. Enter in a single-line field saves, Escape
 * anywhere in the form cancels.
 *
 * Grader, grade and cert appear only for a graded copy; condition only for a
 * raw one. Serial number appears only when the card is numbered. The binder
 * list offers manual binders only: a smart binder fills itself from its rule.
 */

export interface CopyDetailsFormProps {
  card: Card;
  value: CopyDetails;
  onChange: (next: CopyDetails) => void;
  onSave: (value: CopyDetails) => void;
  onCancel: () => void;
  /** Every binder; smart ones are filtered out here. */
  binders: Binder[];
  /** Primary button text. Default "Save copy". */
  saveLabel?: string;
  /** Heading above the fields; default "Copy details". `null` hides it. */
  heading?: string | null;
  className?: string;
}

const CONDITIONS: Condition[] = [
  "Mint",
  "Near Mint",
  "Excellent",
  "Very Good",
  "Good",
  "Poor",
];
const GRADERS: Grader[] = ["PSA", "BGS", "SGC", "CGC", "TAG"];

const LABEL = "block text-sm font-medium text-ink-2 mb-1";
const SELECT =
  "w-full rounded-md border border-field-rule bg-field px-3 py-2 text-base text-ink focus-outline";
const CHOICE =
  "flex cursor-pointer items-center gap-2 rounded-md border border-field-rule bg-field px-3 py-2 text-sm text-ink-2 has-[:checked]:border-selection has-[:checked]:text-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus";
const CHECK = "h-4 w-4 accent-selection";

/** Number fields hold `undefined` when blank, never NaN. */
function parseMoney(text: string): number | undefined {
  if (text.trim() === "") return undefined;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export default function CopyDetailsForm({
  card,
  value,
  onChange,
  onSave,
  onCancel,
  binders,
  saveLabel = "Save copy",
  heading = "Copy details",
  className = "",
}: CopyDetailsFormProps) {
  const headingId = useId();
  const quantityHelpId = useId();
  const set = (patch: Partial<CopyDetails>) => onChange({ ...value, ...patch });

  const run = printRunLabel(card);
  const graded = value.graded !== undefined;
  const manualBinders = binders.filter((b) => b.kind === "manual");
  const quantityValid = Number.isInteger(value.quantity) && value.quantity >= 1;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!quantityValid) return;
    onSave(value);
  }

  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  }

  function setGraded(next: boolean) {
    if (next === graded) return;
    set(
      next
        ? { graded: { grader: "PSA", grade: "" }, condition: undefined }
        : { graded: undefined },
    );
  }

  return (
    <form
      onSubmit={submit}
      onKeyDown={onKeyDown}
      aria-labelledby={heading ? headingId : undefined}
      aria-label={heading ? undefined : `Details for ${cardLabel(card)}`}
      className={`rounded-lg border border-rule bg-sheet p-4 text-ink shadow-offset sm:p-5 ${className}`}
    >
      {heading && (
        <h2 id={headingId} className="text-lg font-bold text-ink">
          {heading}
        </h2>
      )}
      <p className="mt-1 text-sm text-ink-3">
        Only the quantity is needed. Fill in the rest whenever you like.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <Input
            label="Quantity"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            required
            value={Number.isFinite(value.quantity) ? value.quantity : ""}
            onChange={(e) =>
              // Blank is NaN (invalid, shown as empty), never a silent 0.
              set({
                quantity:
                  e.target.value === "" ? Number.NaN : Math.floor(Number(e.target.value)),
              })
            }
            error={quantityValid ? undefined : "Enter 1 or more."}
            aria-describedby={quantityHelpId}
          />
          <span id={quantityHelpId} className="sr-only">
            Identical raw copies can share one entry.
          </span>
        </div>

        <fieldset>
          <legend className={LABEL}>Raw or graded</legend>
          <div className="grid grid-cols-2 gap-2">
            <label className={CHOICE}>
              <input
                type="radio"
                name={`${headingId}-graded`}
                className={CHECK}
                checked={!graded}
                onChange={() => setGraded(false)}
              />
              Raw
            </label>
            <label className={CHOICE}>
              <input
                type="radio"
                name={`${headingId}-graded`}
                className={CHECK}
                checked={graded}
                onChange={() => setGraded(true)}
              />
              Graded
            </label>
          </div>
        </fieldset>

        {graded && value.graded ? (
          <div className="grid grid-cols-3 gap-3 sm:col-span-2">
            <label className="block">
              <span className={LABEL}>Grader</span>
              <select
                className={SELECT}
                value={value.graded.grader}
                onChange={(e) =>
                  set({ graded: { ...value.graded!, grader: e.target.value as Grader } })
                }
              >
                {GRADERS.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </label>
            <Input
              label="Grade"
              placeholder="9.5"
              value={value.graded.grade}
              onChange={(e) => set({ graded: { ...value.graded!, grade: e.target.value } })}
            />
            <Input
              label="Cert number"
              inputMode="numeric"
              value={value.graded.cert ?? ""}
              onChange={(e) =>
                set({ graded: { ...value.graded!, cert: e.target.value || undefined } })
              }
            />
          </div>
        ) : (
          <label className="block">
            <span className={LABEL}>Condition</span>
            <select
              className={SELECT}
              value={value.condition ?? ""}
              onChange={(e) =>
                set({ condition: (e.target.value || undefined) as Condition | undefined })
              }
            >
              <option value="">Not set</option>
              {CONDITIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        )}

        {run && (
          <Input
            label={`Serial number (${run === "1/1" ? "1 of 1" : `out of ${run.slice(1)}`})`}
            placeholder={run === "1/1" ? "1/1" : `23${run}`}
            value={value.serialNumber ?? ""}
            onChange={(e) => set({ serialNumber: e.target.value || undefined })}
          />
        )}

        <Input
          label="Cost"
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          placeholder="0.00"
          value={value.costBasis ?? ""}
          onChange={(e) => set({ costBasis: parseMoney(e.target.value) })}
        />

        <Input
          label="Acquired"
          type="date"
          value={value.acquiredAt}
          onChange={(e) => set({ acquiredAt: e.target.value })}
        />

        <Input
          label="Location"
          placeholder="Box 3"
          value={value.location ?? ""}
          onChange={(e) => set({ location: e.target.value || undefined })}
        />

        {manualBinders.length > 0 && (
          <fieldset className="sm:col-span-2">
            <legend className={LABEL}>Binders</legend>
            <div className="flex flex-wrap gap-2">
              {manualBinders.map((b) => {
                const checked = value.binderIds.includes(b.id);
                return (
                  <label key={b.id} className={CHOICE}>
                    <input
                      type="checkbox"
                      className={CHECK}
                      checked={checked}
                      onChange={() =>
                        set({
                          binderIds: checked
                            ? value.binderIds.filter((id) => id !== b.id)
                            : [...value.binderIds, b.id],
                        })
                      }
                    />
                    {b.name}
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}

        <div className="sm:col-span-2">
          <Textarea
            label="Notes"
            placeholder="Pulled at the '97 show, corner ding top left…"
            value={value.notes}
            onChange={(e) => set({ notes: e.target.value })}
          />
        </div>

        <div className="flex flex-wrap items-end gap-4 sm:col-span-2">
          <label className={CHOICE}>
            <input
              type="checkbox"
              role="switch"
              className={CHECK}
              checked={value.forSale}
              onChange={(e) =>
                set({
                  forSale: e.target.checked,
                  askPrice: e.target.checked ? value.askPrice : undefined,
                })
              }
            />
            For sale
          </label>
          {value.forSale && (
            <div className="w-40">
              <Input
                label="Ask price"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                placeholder="0.00"
                value={value.askPrice ?? ""}
                onChange={(e) => set({ askPrice: parseMoney(e.target.value) })}
              />
            </div>
          )}
        </div>
      </div>

      <div className="mt-5 flex flex-wrap justify-end gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-control px-4 py-2 text-sm font-medium text-ink-2 hover:border-ink-3 hover:text-ink focus-outline"
        >
          Cancel
        </button>
        <Button
          type="submit"
          variant="primary"
          disabled={!quantityValid}
          className="focus-outline"
        >
          {saveLabel}
        </Button>
      </div>
    </form>
  );
}
