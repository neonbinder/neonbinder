/**
 * NEO-358 — what a view shows while its reads are in flight: grey bars in the
 * shape of what is coming, and one short line for a screen reader. The bars
 * hold no text, so the pulse never fades anything a reader has to read, and
 * it stops for anyone who asks for less motion.
 */

export function SkeletonBars({ rows = 3, className = "" }: { rows?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={`flex flex-col gap-2 ${className}`}>
      {Array.from({ length: rows }, (_, i) => (
        <span
          key={i}
          className="block h-4 rounded bg-rule motion-safe:animate-pulse"
          style={{ width: `${92 - ((i * 23) % 40)}%` }}
        />
      ))}
    </div>
  );
}

/** A row of sleeves still being dealt: the shape of a checklist's pips or tiles. */
export function SkeletonPips({ count = 18, size = "pip" }: { count?: number; size?: "pip" | "tile" }) {
  const cls = size === "pip" ? "h-3.5 w-2.5 rounded-[2px]" : "size-10 rounded-md";
  return (
    <span aria-hidden="true" className="flex flex-wrap gap-1">
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className={`${cls} bg-rule motion-safe:animate-pulse`} />
      ))}
    </span>
  );
}

/**
 * The screen reader's half of a skeleton. Polite, and said once. `silent`
 * where the view already has a status line of its own saying the same thing:
 * the words stay for a reader browsing past, but nothing is announced, so a
 * view never talks over itself (one live status per view).
 */
export function LoadingNote({ children, silent = false }: { children: string; silent?: boolean }) {
  return (
    <p role={silent ? undefined : "status"} className="sr-only">
      {children}
    </p>
  );
}
