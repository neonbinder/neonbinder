import { EmptySleeve } from "@/app/collection/prototypes/_shared/CardFace";
import type { IntakeInProgress } from "../_shared/data";
import { CardLine, count, RAIL_PANEL, RailHeading } from "./bits";

/**
 * NEO-464 combined dashboard — In the Hopper: scans still in intake. Shown to
 * everyone who has scans (collector or dealer, sales or none), at the top of
 * the page beside the to-do, because nothing gets filed until these clear
 * (Jason, review item 1). First the scans waiting on a yes, each named by its
 * best guess's full title; then the ones still being identified.
 */
export default function Hopper({ intake, wanted }: { intake: IntakeInProgress; wanted: Set<string> }) {
  if (intake.total === 0) return null;
  const guesses = intake.preview.flatMap((s) => (s.guess ? [{ id: s.id, card: s.guess }] : []));
  const unidentified = intake.preview.filter((s) => !s.guess);

  return (
    <section aria-labelledby="cb-hopper-heading" className={RAIL_PANEL}>
      <RailHeading id="cb-hopper-heading" note={`${count(intake.total, "scan")} in intake`}>
        In the Hopper
      </RailHeading>

      {intake.needsYou > 0 && (
        <div>
          <h3 className="text-sm font-bold text-ink">
            {count(intake.needsYou, "scan")} {intake.needsYou === 1 ? "needs" : "need"} your yes
          </h3>
          <p className="text-xs text-ink-2">We think we know these. Check the match and they go in a binder.</p>
          <ul aria-label="Best guesses waiting on your yes" className="mt-2.5 flex flex-col gap-2.5">
            {guesses.map((g) => (
              <li key={g.id}>
                <CardLine card={g.card} wanted={wanted.has(g.card.id)} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {intake.waiting > 0 && (
        <div className={intake.needsYou > 0 ? "mt-4 border-t border-rule pt-3" : undefined}>
          <h3 className="text-sm font-bold text-ink">{count(intake.waiting, "scan")} still being identified</h3>
          {/* One name for the strip, not one identical name per sleeve. */}
          {unidentified.length > 0 && (
            <div
              role="img"
              aria-label={`${count(unidentified.length, "scan")} waiting to be identified`}
              className="mt-2 flex gap-2"
            >
              {unidentified.map((s) => (
                <div key={s.id} aria-hidden="true" className="w-10">
                  <EmptySleeve size="fill" label="Scan waiting to be identified" ghost="?" />
                </div>
              ))}
            </div>
          )}
          <ul className="mt-3 space-y-2">
            {intake.uploads.map((u) => (
              <li key={u.id} className="text-xs">
                <p className="flex justify-between gap-2">
                  <span className="truncate text-ink-2">{u.name}</span>
                  <span className="shrink-0 tabular-nums text-ink-3">
                    {u.done} of {count(u.scans, "scan")} done
                  </span>
                </p>
                <span aria-hidden="true" className="mt-1 block h-1 overflow-hidden rounded-full bg-chip">
                  <span className="block h-full rounded-full bg-neon-blue" style={{ width: `${(u.done / u.scans) * 100}%` }} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
