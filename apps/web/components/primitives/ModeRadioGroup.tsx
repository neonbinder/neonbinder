import React, { useId, useRef } from "react";

/**
 * NEO-356 — a small radio group drawn as a row of choice cards: the Theme
 * picker in Settings (Light / Dark / System) and anything else that is "pick
 * one of a few, each with a line of explanation".
 *
 * Keyboard, per the WAI-ARIA radio group pattern:
 * - Tab lands on the checked option (roving tabindex); the group is one stop.
 * - Arrow keys move to the previous / next option AND choose it, wrapping at
 *   the ends; Home and End jump to the first and last.
 * - Enter and Space choose the focused option.
 *
 * Each option's accessible name is its label; the description is attached as
 * its description, so a screen reader reads "Light, radio button, checked, 1 of
 * 3, Bright as a brand-new Trapper Keeper".
 *
 * Layout: the cards share a row and wrap below ~9rem each, so at 320px they
 * stack one per line instead of overflowing.
 */
export interface ModeRadioOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
}

export interface ModeRadioGroupProps<T extends string = string> {
  /** Visible label for the group, and its accessible name. */
  label: string;
  value: T;
  options: ReadonlyArray<ModeRadioOption<T>>;
  onChange: (value: T) => void;
  className?: string;
}

export function ModeRadioGroup<T extends string = string>({
  label,
  value,
  options,
  onChange,
  className = "",
}: ModeRadioGroupProps<T>) {
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  // An unknown value still leaves one option reachable by Tab.
  const checkedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    refs.current[index]?.focus();
    if (option.value !== value) onChange(option.value);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = options.length - 1;
    let next: number | null = null;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = index === last ? 0 : index + 1;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = index === 0 ? last : index - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      case "Enter":
      case " ":
        next = index;
        break;
      default:
        return;
    }
    event.preventDefault();
    choose(next);
  };

  return (
    <div className={className}>
      <span id={labelId} className="mb-2 block text-sm font-medium text-ink-2">
        {label}
      </span>
      <div role="radiogroup" aria-labelledby={labelId} className="flex flex-wrap gap-2">
        {options.map((option, index) => {
          const checked = index === checkedIndex && option.value === value;
          // Named by the label alone (the description is its description), so
          // the name stays "Light", not "Light Bright as a brand-new…".
          const nameId = `${baseId}-name-${index}`;
          const descriptionId = option.description ? `${baseId}-desc-${index}` : undefined;
          return (
            <button
              key={option.value}
              ref={(el) => {
                refs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-labelledby={nameId}
              aria-describedby={descriptionId}
              tabIndex={index === checkedIndex ? 0 : -1}
              onClick={() => choose(index)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={`flex min-w-0 grow basis-36 items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors focus-outline ${
                checked
                  ? "border-selection bg-raised-deep"
                  : "border-field-rule bg-field hover:bg-hover"
              }`}
            >
              {/* The radio mark: a ring, filled when chosen. Shape, not only
                  colour, says which one is on. */}
              <span
                aria-hidden="true"
                className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2 ${
                  checked ? "border-selection" : "border-control"
                }`}
              >
                {checked && <span className="size-2 rounded-full bg-selection" />}
              </span>
              <span className="min-w-0">
                <span id={nameId} className="block text-sm font-medium text-ink">
                  {option.label}
                </span>
                {option.description && (
                  <span id={descriptionId} className="mt-0.5 block text-xs text-ink-3">
                    {option.description}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default ModeRadioGroup;
