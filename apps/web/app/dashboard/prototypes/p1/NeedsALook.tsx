import { ArchiveBoxIcon, ExclamationTriangleIcon, PhotoIcon } from "@heroicons/react/24/outline";
import type { ReactNode } from "react";
import { EmptySleeve } from "@/app/collection/prototypes/_shared/CardFace";
import { MARKETPLACES, type DashboardData, type SaleLine, type SaleProblem } from "../_shared/data";
import { ANCHOR, count, orderAnchor, Thumb } from "./bits";
import { problemText } from "./ShipList";

/**
 * NEO-464 prototype 1 — "Needs a Look": the snags, second on the page.
 * Problem lines on orders (each jumps back to its order), scans waiting on
 * the collector, scans still being identified, and boxed cards not listed
 * yet. Every item is a count plus what it is; nothing here is a value.
 */
export default function NeedsALook({ data }: { data: DashboardData }) {
  const problemOrders = (data.sales?.unshipped ?? []).filter((o) => o.hasProblem);
  const { intake } = data;
  const guesses = intake.preview.filter((s) => s.guess);
  const unidentified = intake.preview.filter((s) => !s.guess);
  const unlisted = data.unlistedBoxes.reduce((n, b) => n + b.unlisted, 0);

  return (
    <section id={ANCHOR.look} aria-labelledby="p1-look-heading" className="scroll-mt-6">
      <h2 id="p1-look-heading" className="text-2xl font-bold text-ink">
        Needs a Look
      </h2>
      <ul className="mt-3 flex flex-col gap-3">
        {problemOrders.map((order) => (
          <Snag key={order.id} tone="danger" icon={<ExclamationTriangleIcon className="size-5" />}>
            <p className="font-semibold text-ink">
              {MARKETPLACES[order.marketplace].name} order #{order.orderNumber}
            </p>
            {order.lines
              .filter((l): l is SaleLine & { problem: SaleProblem } => Boolean(l.problem))
              .map((line, i) => (
                <p key={i} className="text-sm text-ink-2">
                  {problemText(line)}
                </p>
              ))}
            <a
              href={`#${orderAnchor(order.id)}`}
              className="mt-1 inline-flex min-h-9 items-center rounded-md text-sm font-medium text-neon-blue-text hover:underline focus-outline max-sm:min-h-11"
            >
              Jump to order #{order.orderNumber}
            </a>
          </Snag>
        ))}

        {intake.needsYou > 0 && (
          <Snag tone="info" icon={<PhotoIcon className="size-5" />}>
            <p className="font-semibold text-ink">
              {count(intake.needsYou, "scan")} {intake.needsYou === 1 ? "needs" : "need"} your yes
            </p>
            <p className="text-sm text-ink-2">We think we know these. Check the match and they go in a binder.</p>
            <div className="mt-2 flex gap-2">
              {guesses.map((s) => s.guess && <Thumb key={s.id} card={s.guess} className="w-12" />)}
            </div>
          </Snag>
        )}

        {intake.waiting > 0 && (
          <Snag tone="quiet" icon={<PhotoIcon className="size-5" />}>
            <p className="font-semibold text-ink">{count(intake.waiting, "scan")} still being identified</p>
            <ul className="text-sm text-ink-2">
              {intake.uploads.map((u) => (
                <li key={u.id}>
                  {u.name}: {u.done} of {count(u.scans, "scan")} done
                </li>
              ))}
            </ul>
            <div className="mt-2 flex gap-2">
              {unidentified.map((s) => (
                <div key={s.id} className="w-12">
                  <EmptySleeve size="fill" label="Scan waiting to be identified" ghost="?" />
                </div>
              ))}
            </div>
          </Snag>
        )}

        {unlisted > 0 && (
          <Snag tone="quiet" icon={<ArchiveBoxIcon className="size-5" />}>
            <p className="font-semibold text-ink">{count(unlisted, "boxed card")} not listed yet</p>
            <ul className="text-sm text-ink-2">
              {data.unlistedBoxes.map((b) => (
                <li key={b.id}>
                  {b.name}: {b.unlisted}
                </li>
              ))}
            </ul>
          </Snag>
        )}
      </ul>
    </section>
  );
}

const TONE = {
  danger: "border-l-notice-danger-rule text-notice-danger-ink",
  info: "border-l-neon-blue text-neon-blue-text",
  quiet: "border-l-rule-strong text-ink-3",
} as const;

/** One snag: an icon, a coloured left edge for its kind, and what to do. */
function Snag({ tone, icon, children }: { tone: keyof typeof TONE; icon: ReactNode; children: ReactNode }) {
  return (
    <li className={`flex gap-3 rounded-lg border border-l-4 border-rule bg-raised p-3 ${TONE[tone]}`}>
      <span aria-hidden="true" className="mt-0.5 shrink-0">
        {icon}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}
