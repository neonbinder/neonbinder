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
      className={`min-h-11 rounded-full border px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] focus-visible:ring-offset-2 focus-visible:ring-offset-black sm:min-h-8 ${
        pressed
          ? "border-neon-blue bg-neon-blue text-black"
          : "border-slate-600 text-slate-200 hover:border-slate-400 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}
