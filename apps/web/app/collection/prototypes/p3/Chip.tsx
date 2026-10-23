import type { ReactNode } from "react";

/** NEO-350 prototype 3 — an aria-pressed pill, for filters and mode switches. */
export default function Chip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`min-h-11 rounded-full border px-3 text-sm font-medium focus-outline sm:min-h-8 ${
        pressed
          ? "border-selection bg-neon-blue text-on-neon-blue"
          : "border-control text-ink-2 hover:border-ink-3 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}
