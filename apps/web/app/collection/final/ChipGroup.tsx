import { useRef, type KeyboardEvent, type ReactNode } from "react";

/**
 * NEO-358 — a row of chips where exactly one is on: a radio group drawn as
 * pills. One Tab stop (the checked chip); the arrow keys move AND pick, Home
 * and End jump to the ends, Space or a click picks the chip under focus. A
 * screen reader hears "Needs, radio button, 2 of 4, not checked", the state
 * in `aria-checked` and never in the name.
 *
 * Chips that switch on and off independently are not this: they stay
 * `aria-pressed` toggles (`../prototypes/p3/Chip`).
 */
export interface ChipOption<T extends string> {
  value: T;
  label: ReactNode;
}

/** The pill look, on and off (prototype 3's Chip). */
export function defaultChipClass(checked: boolean): string {
  return `min-h-11 rounded-full border px-3 text-sm font-medium focus-outline sm:min-h-8 ${
    checked ? "border-selection bg-neon-blue text-on-neon-blue" : "border-control text-ink-2 hover:border-ink-3 hover:text-ink"
  }`;
}

export default function ChipGroup<T extends string>({
  label,
  value,
  options,
  onChange,
  className = "flex flex-wrap gap-1.5",
  chipClass = defaultChipClass,
  lead,
}: {
  /** The group's accessible name ("Show on the wall"). */
  label: string;
  value: T;
  options: readonly ChipOption<T>[];
  onChange: (value: T) => void;
  className?: string;
  chipClass?: (checked: boolean) => string;
  /** Visible words before the chips, hidden from a reader (the group's name says it). */
  lead?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const current = options.some((o) => o.value === value) ? value : options[0]?.value;

  const pick = (i: number) => {
    const next = options[(i + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    root.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[(i + options.length) % options.length]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        pick(i + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        pick(i - 1);
        break;
      case "Home":
        pick(0);
        break;
      case "End":
        pick(options.length - 1);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <div ref={root} role="radiogroup" aria-label={label} className={className}>
      {lead && <span aria-hidden="true">{lead}</span>}
      {options.map((o, i) => {
        const checked = o.value === current;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={chipClass(checked)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
