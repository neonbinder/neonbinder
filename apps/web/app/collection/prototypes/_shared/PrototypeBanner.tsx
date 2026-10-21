import { Link } from "react-router";

/**
 * NEO-350 — the slim bar at the top of every collection prototype: says it is
 * a prototype on fake data, and jumps between the five.
 */

export type PrototypeNumber = 1 | 2 | 3 | 4 | 5;

export const PROTOTYPES: { n: PrototypeNumber; name: string; path: string }[] = [
  { n: 1, name: "Set Builder Collector Edition", path: "/collection/1" },
  { n: 2, name: "Nine-Pocket", path: "/collection/2" },
  { n: 3, name: "Checklist Wall", path: "/collection/3" },
  { n: 4, name: "Dealer's Counter", path: "/collection/4" },
  { n: 5, name: "Player PC", path: "/collection/5" },
];

export function prototypeName(n: PrototypeNumber): string {
  return PROTOTYPES.find((p) => p.n === n)!.name;
}

export default function PrototypeBanner({ current }: { current: PrototypeNumber }) {
  return (
    <div className="mb-6 flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
      <p className="flex items-center gap-2 text-sm text-slate-300">
        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-neon-blue" />
        UI prototype · fake data
      </p>
      <nav aria-label="Collection prototypes">
        <ul className="flex flex-wrap gap-1.5">
          {PROTOTYPES.map((p) => {
            const active = p.n === current;
            return (
              <li key={p.n}>
                <Link
                  to={p.path}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] ${
                    active
                      ? "border-neon-blue bg-neon-blue text-black"
                      : "border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white"
                  }`}
                >
                  <span className="tabular-nums font-bold">{p.n}</span>
                  {p.name}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
