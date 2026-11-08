import { useDashboard } from "../_shared/persona";
import { BinderSide } from "./BinderSide";
import { BoxSide } from "./BoxSide";
import "./split-desk.css";

/**
 * NEO-464 — dashboard prototype 5, "Split desk". For the collector who wears
 * two hats: the binder (cards kept) on the left, the box (cards for sale) on
 * the right, and between them the one loud thing on the page, a seam that is
 * a punched binder edge on one side and a cut box edge on the other.
 *
 * A collector who never sells has no box side at all (`sales` is null): the
 * binder takes the whole desk and there is no line to draw.
 *
 * On a phone the sides stack, box first: a seller opening the app on the go
 * wants the orders to ship before anything else. The DOM follows that order,
 * so reading and Tab order match the phone; on a wide screen the grid sets the
 * box in the right-hand column.
 */
export default function Dashboard() {
  const data = useDashboard();
  const selling = data.sales !== null;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-bold leading-tight text-ink sm:text-4xl">Welcome back, slugger.</h1>
        <p className="mt-1 text-ink-2">
          {selling ? "Binder and box, one desk. Here's what moved." : "Here's what landed in your binders."}
        </p>
      </header>

      {selling && data.sales ? (
        <div className="flex flex-col lg:grid lg:grid-cols-[minmax(0,3fr)_3rem_minmax(0,2fr)] lg:gap-x-6">
          <div className="min-w-0 lg:col-start-3 lg:row-start-1">
            <BoxSide sales={data.sales} boxes={data.unlistedBoxes} intake={data.intake} />
          </div>
          <div aria-hidden="true" className="p5-divide p5-divide-h my-8 lg:hidden" />
          <div aria-hidden="true" className="p5-divide p5-divide-v hidden lg:col-start-2 lg:row-start-1 lg:block" />
          <div className="min-w-0 lg:col-start-1 lg:row-start-1">
            <BinderSide data={data} withTray={false} />
          </div>
        </div>
      ) : (
        <BinderSide data={data} withTray />
      )}
    </div>
  );
}
