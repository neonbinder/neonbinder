import { useId, type FormEvent, type KeyboardEvent } from "react";
import NeonButton from "@/components/modules/NeonButton";
import { Input } from "@/components/primitives/Input";
import { Textarea } from "@/components/primitives/Textarea";
import type { Card as ModelCard } from "../../final/data/types";
import { cardLabel as modelLabel } from "../../final/data/labels";
import {
  cardLabel,
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
 *
 * NEO-358: the real collection passes a view-model card, no binders (a copy
 * has one home, Main, until binders ship) and `hideSaleFields` (price belongs
 * to a listing, not the copy).
 *
 * NEO-359: the collection page files a copy in ONE home. It passes `homes`
 * (with `homeId` / `onHomeChange`) for a "Where it lives" pick, and
 * `upForTrade` (with `onUpForTradeChange`) for the Up for trade switch; it
 * hides the prototypes' binder ticks (`hideBinders`). Every one of these is
 * optional: a prototype that passes none renders exactly as before.
 */

/** A home "Where it lives" offers: a binder, or a box (cards in a box are for sale). */
export interface FormHome {
  id: string;
  name: string;
  kind: "binder" | "box";
}

export interface CopyDetailsFormProps {
  /** A prototype fixture card, or (NEO-358) a collection view-model card. */
  card: Card | ModelCard;
  value: CopyDetails;
  onChange: (next: CopyDetails) => void;
  onSave: (value: CopyDetails) => void;
  onCancel: () => void;
  /** Every binder; smart ones are filtered out here. None: no binder choice. */
  binders?: Binder[];
  /** Leave out For sale and Ask price (the real collection keeps no price on a copy). */
  hideSaleFields?: boolean;
  /** Primary button text. Default "Save copy". */
  saveLabel?: string;
  /** Heading above the fields; default "Copy details". `null` hides it. */
  heading?: string | null;
  className?: string;
  /** NEO-359: the homes "Where it lives" offers. Shown only with `onHomeChange`. */
  homes?: readonly FormHome[];
  /** NEO-359: the picked home's id. */
  homeId?: string;
  onHomeChange?: (homeId: string) => void;
  /** NEO-359: the Up for trade switch's state. Shown only with `onUpForTradeChange`. */
  upForTrade?: boolean;
  onUpForTradeChange?: (on: boolean) => void;
  /** NEO-359: leave out the binder ticks even when `binders` are passed. */
  hideBinders?: boolean;
  /**
   * NEO-378: show the Minimum price field (a copy for sale). `commonPrice` is
   * the variant's common price in dollars, what a blank field means (`null`:
   * none set; `undefined`: still loading).
   */
  minPrice?: { commonPrice: number | null | undefined };
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
  binders = [],
  hideSaleFields = false,
  saveLabel = "Save copy",
  heading = "Copy details",
  className = "",
  homes,
  homeId,
  onHomeChange,
  upForTrade,
  onUpForTradeChange,
  hideBinders = false,
  minPrice,
}: CopyDetailsFormProps) {
  const headingId = useId();
  const minPriceHelpId = useId();
  const quantityHelpId = useId();
  const homeHelpId = useId();
  const set = (patch: Partial<CopyDetails>) => onChange({ ...value, ...patch });

  const run = card.printRun === null ? null : card.printRun === 1 ? "1/1" : `/${card.printRun}`;
  const label = "setId" in card ? cardLabel(card) : modelLabel(card);
  const graded = value.graded !== undefined;
  const manualBinders = hideBinders ? [] : binders.filter((b) => b.kind === "manual");
  const showHomes = !!homes && homes.length > 0 && !!onHomeChange;
  const pickedHome = showHomes ? homes.find((h) => h.id === homeId) : undefined;
  const showTrade = upForTrade !== undefined && !!onUpForTradeChange;
  // Said only where the list has a box: a box is the sale table.
  const homeHelp = !showHomes
    ? null
    : pickedHome?.kind === "box"
      ? "It's in a box, so it's for sale."
      : homes?.some((h) => h.kind === "box")
        ? "A binder keeps it. A box puts it up for sale."
        : null;
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
      aria-label={heading ? undefined : `Details for ${label}`}
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

        {minPrice && (
          <div>
            <Input
              label="Minimum price"
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              placeholder={typeof minPrice.commonPrice === "number" ? minPrice.commonPrice.toFixed(2) : "0.00"}
              value={value.minPrice ?? ""}
              onChange={(e) => set({ minPrice: parseMoney(e.target.value) })}
              aria-describedby={minPriceHelpId}
            />
            <p id={minPriceHelpId} className="mt-1 text-xs text-ink-3">
              {typeof minPrice.commonPrice === "number"
                ? `Blank sells at your common price, $${minPrice.commonPrice.toFixed(2)}.`
                : minPrice.commonPrice === null
                  ? "The lowest it sells for. No common price set for this variant yet."
                  : "The lowest it sells for."}
            </p>
          </div>
        )}

        <Input
          label="Acquired"
          type="date"
          value={value.acquiredAt}
          onChange={(e) => set({ acquiredAt: e.target.value })}
        />

        <Input
          label="Location"
          placeholder="Shelf 2, top drawer"
          value={value.location ?? ""}
          onChange={(e) => set({ location: e.target.value || undefined })}
        />

        {showHomes && (
          <div>
            <label className="block">
              <span className={LABEL}>Where it lives</span>
              <select
                className={SELECT}
                value={homeId ?? ""}
                aria-describedby={homeHelp ? homeHelpId : undefined}
                onChange={(e) => onHomeChange?.(e.target.value)}
              >
                {homeId === undefined && (
                  <option value="">{homes.some((h) => h.kind === "box") ? "Pick a binder or box" : "Pick a binder"}</option>
                )}
                {homes.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.kind === "box" ? `${h.name} (box, for sale)` : h.name}
                  </option>
                ))}
              </select>
            </label>
            {homeHelp && (
              <p id={homeHelpId} className="mt-1 text-xs text-ink-3">
                {homeHelp}
              </p>
            )}
          </div>
        )}

        {showTrade && (
          <div className="flex items-start sm:pt-6">
            <label className={CHOICE}>
              <input
                type="checkbox"
                role="switch"
                className={CHECK}
                checked={upForTrade}
                onChange={(e) => onUpForTradeChange?.(e.target.checked)}
              />
              Up for trade
            </label>
          </div>
        )}

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

        {!hideSaleFields && (
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
        )}
      </div>

      <div className="mt-5 flex flex-wrap justify-end gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-control px-4 py-2 text-sm font-medium text-ink-2 hover:border-ink-3 hover:text-ink focus-outline"
        >
          Cancel
        </button>
        <NeonButton
          type="submit"
          variant="primary"
          disabled={!quantityValid}
          className="focus-outline"
        >
          {saveLabel}
        </NeonButton>
      </div>
    </form>
  );
}
