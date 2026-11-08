import { useDashboard } from "../_shared/persona";
import type { DashboardData } from "../_shared/data";
import { ANCHOR } from "./bits";
import FunStuff from "./FunStuff";
import NeedsALook from "./NeedsALook";
import ShipList from "./ShipList";
import "./p1.css";

/**
 * NEO-464 — dashboard prototype 1, "To-do first": a dealer's morning.
 *
 * The page reads top to bottom in the order the work gets done: the run
 * sheet (today's list, each line jumps to its section), then Out the Door
 * (every unshipped order, oldest first), then Needs a Look (problem lines,
 * scans, unlisted boxed cards), then the fun stuff. A collector with no
 * marketplace gets no ship list at all, not an empty one.
 *
 * Jump links are plain `#hash` anchors: each pushes an entry, so Back
 * returns to the run sheet, and `?as=` rides along untouched.
 */
export default function Dashboard() {
  const data = useDashboard();
  const dealer = data.sales !== null;

  return (
    <div className="flex flex-col gap-8 sm:gap-10">
      <header>
        <h1 className="text-3xl font-bold text-ink sm:text-4xl">Welcome back, slugger.</h1>
        <p className="mt-1 text-base text-ink-2">
          {dealer ? "Ship first, sort the snags, then the fun stuff." : "Sort the snags, then the fun stuff."}
        </p>
        <RunSheet data={data} />
      </header>

      {data.sales && <ShipList sales={data.sales} />}
      <NeedsALook data={data} />

      <p className="flex items-center gap-3 text-sm font-semibold text-ink-3" aria-hidden="true">
        <span className="h-0.5 flex-1 rounded bg-rule" />
        That&apos;s the work. Now the good part.
        <span className="h-0.5 flex-1 rounded bg-rule" />
      </p>

      <FunStuff data={data} />
    </div>
  );
}

interface RunItem {
  key: string;
  n: number;
  text: string;
  href: string;
  tone: string;
}

/** Today's list, in the order the page answers it. Lines with nothing to do are left off. */
function runItems(data: DashboardData): RunItem[] {
  const orders = data.sales?.unshipped ?? [];
  const problems = orders.reduce((n, o) => n + o.lines.filter((l) => l.problem).length, 0);
  const unlisted = data.unlistedBoxes.reduce((n, b) => n + b.unlisted, 0);
  const fresh = data.additions.filter((b) => b.sinceLastVisit).reduce((n, b) => n + b.cards.length, 0);
  const items: RunItem[] = [
    { key: "ship", n: orders.length, text: orders.length === 1 ? "order to ship" : "orders to ship", href: ANCHOR.ship, tone: "text-neon-green-text" },
    { key: "problems", n: problems, text: problems === 1 ? "problem line" : "problem lines", href: ANCHOR.look, tone: "text-notice-danger-ink" },
    { key: "scans", n: data.intake.needsYou, text: data.intake.needsYou === 1 ? "scan to confirm" : "scans to confirm", href: ANCHOR.look, tone: "text-neon-blue-text" },
    { key: "list", n: unlisted, text: unlisted === 1 ? "boxed card to list" : "boxed cards to list", href: ANCHOR.look, tone: "text-neon-purple-text" },
    { key: "fresh", n: fresh, text: "fresh pulls", href: ANCHOR.pulls, tone: "text-ink" },
  ];
  return items.filter((i) => i.n > 0);
}

function RunSheet({ data }: { data: DashboardData }) {
  const items = runItems(data);
  if (items.length === 0) return null;
  return (
    <nav aria-label="Today's list" className="mt-5">
      <ol className="flex flex-wrap gap-2">
        {items.map((item) => (
          <li key={item.key}>
            <a
              href={`#${item.href}`}
              aria-label={`${item.n} ${item.text}`}
              className="flex min-h-11 items-center gap-2 rounded-lg border-2 border-rule bg-raised px-3 py-1.5 hover:border-selection focus-outline"
            >
              <span aria-hidden="true" className={`p1-numeral p1-glow text-3xl ${item.tone}`}>
                {item.n}
              </span>
              <span aria-hidden="true" className="text-sm font-medium leading-tight text-ink-2">
                {item.text}
              </span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
