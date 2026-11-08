import { Link, useSearchParams } from "react-router";
import { ModeRadioGroup } from "@/components/primitives/ModeRadioGroup";
import DemoThemeToggle from "@/app/collection/final/DemoThemeToggle";
import { PERSONAS } from "./data";
import { DASHBOARDS, type DashboardNumber } from "./names";
import { PERSONA_PARAM, usePersona } from "./persona";

/**
 * NEO-464 — the slim bar above every dashboard prototype: says it is a
 * prototype on fake data, jumps between the five, and holds the two dev
 * switches Jason judges them with: who is looking (Collector, no sales /
 * Dealer, sales; `?as=`) and Light / Dark.
 *
 * Jumping to another prototype is going somewhere: a pushed entry, so Back
 * returns. The persona carries across the jump; the prototype's own view
 * params do not. The two switches replace the entry (see `./persona`).
 */
export default function PrototypeBanner({ current }: { current: DashboardNumber }) {
  const [params] = useSearchParams();
  const [persona, setPersona] = usePersona();
  const as = params.get(PERSONA_PARAM);
  const search = as ? `?${new URLSearchParams({ [PERSONA_PARAM]: as })}` : "";

  return (
    <section
      aria-label="About these prototypes"
      className="flex flex-col gap-4 rounded-xl border border-rule bg-raised px-4 py-3"
    >
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <p className="flex items-center gap-2 text-sm font-medium text-ink-2">
          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-neon-blue" />
          UI prototype · fake data
        </p>
        <nav aria-label="Dashboard prototypes">
          <ul className="flex flex-wrap gap-1.5">
            {DASHBOARDS.map((d) => {
              const active = d.n === current;
              return (
                <li key={d.n}>
                  <Link
                    to={{ pathname: d.path, search }}
                    aria-current={active ? "page" : undefined}
                    className={`flex min-h-9 items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm font-medium transition-colors focus-outline ${
                      active
                        ? "border-selection bg-raised-deep text-ink"
                        : "border-field-rule bg-field text-ink-2 hover:bg-hover hover:text-ink"
                    }`}
                  >
                    <span className="font-bold tabular-nums">{d.n}</span>
                    {d.name}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        <ModeRadioGroup label="Viewing as" value={persona} options={PERSONAS} onChange={setPersona} className="sm:flex-1" />
        <DemoThemeToggle className="sm:flex-1" />
      </div>
    </section>
  );
}
