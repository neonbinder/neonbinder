import { useDashboard } from "../_shared/persona";
import { isLate } from "../_shared/data";
import Boards from "./Boards";
import { Chase, FreshPulls } from "./Pulls";
import { FillingUp, Hopper, OddsAndEnds, OUT_THE_DOOR_ID, OutTheDoor } from "./Rail";

/**
 * NEO-464 — dashboard prototype 2, "Scoreboard wall". For set builders: the
 * sets on the board are the hero (LED boards, ranked by fewest cards to go),
 * then the chase, then fresh pulls. Sales, intake and smart binders ride a
 * quiet rail beside them; a dealer gets one line up top that jumps to the
 * ship list, so the wall stays first without hiding what is late.
 *
 * Renders the page's one <h1>. Disclosures keep their state in `?open=`
 * (see `useOpen`), replacing the entry.
 */
export default function Dashboard() {
  const dash = useDashboard();
  const leader = dash.building[0];
  const unshipped = dash.sales?.unshipped ?? [];
  const late = unshipped.filter(isLate).length;

  return (
    <div className="space-y-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">Welcome back, slugger.</h1>
        <p className="max-w-prose text-base text-ink-2">
          {leader
            ? `${dash.building.length === 1 ? "1 set" : `${dash.building.length} sets`} on the board. ${leader.setLabel} is ${
                leader.need === 1 ? "1 card" : `${leader.need} cards`
              } from done.`
            : "Nothing on the board yet. Pick a set and light it up."}
        </p>
        {unshipped.length > 0 && (
          <p className="text-sm text-ink-2">
            <a
              href={`#${OUT_THE_DOOR_ID}`}
              className="font-semibold text-neon-blue-text underline underline-offset-4 hover:text-ink focus-outline"
            >
              {unshipped.length === 1 ? "1 order to ship" : `${unshipped.length} orders to ship`}
            </a>
            {late > 0 && (
              <span className="text-notice-warn-ink">
                {late === 1 ? ", 1 sold 2 or more days ago" : `, ${late} sold 2 or more days ago`}
              </span>
            )}
            .
          </p>
        )}
      </header>

      <Boards building={dash.building} wantList={dash.wantList} justCompleted={dash.justCompleted} />

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-8">
        <div className="min-w-0 space-y-10">
          <Chase wants={dash.wantList} />
          <FreshPulls batches={dash.additions} />
        </div>
        <div className="min-w-0 space-y-5">
          {dash.sales && <OutTheDoor sales={dash.sales} />}
          <Hopper intake={dash.intake} />
          <FillingUp binders={dash.smartBinders} />
          <OddsAndEnds boxes={dash.unlistedBoxes} trade={dash.tradePile} />
        </div>
      </div>
    </div>
  );
}
