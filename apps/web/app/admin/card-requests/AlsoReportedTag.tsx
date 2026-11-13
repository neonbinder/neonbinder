import { ALSO_REPORTED_INK, alsoReportedLine, alsoReportedSpoken } from "./syncReportCopy";

/**
 * NEO-536 — "+3 reported", one look wherever a sync report shows how many
 * other collectors reported the same set: the dashboard's "From collectors"
 * rows and the Sync reports list on Card Requests. A blue pill (the crew's
 * colour, not the warning amber). The pill is seen; a reader hears
 * "also reported by 3 other collectors" in its place. Nothing for none.
 */
export default function AlsoReportedTag({ n }: { n: number }) {
  const line = alsoReportedLine(n);
  if (!line) return null;
  return (
    <>
      <span
        aria-hidden="true"
        className={`inline-flex shrink-0 items-center rounded-full border border-neon-blue/60 px-2 py-0.5 text-xs font-bold tabular-nums ${ALSO_REPORTED_INK}`}
      >
        {line}
      </span>
      <span className="sr-only">, {alsoReportedSpoken(n)}</span>
    </>
  );
}
