import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { ArrowUturnLeftIcon, UserPlusIcon } from "@heroicons/react/24/outline";
import { FOCUS } from "../prototypes/p1/ui";
import { PUBLIC_DESTINATIONS } from "./mode";

/**
 * NEO-350 — what the public demo (on `/binder-tracking`) adds around the
 * collection page, so a visitor always knows it is a demo and how to leave
 * it: a demo bar above the page, and on a wide screen the two exits as index
 * tabs on the right edge, where the signed-in shell keeps its own tabs (the
 * pack tray already leaves that edge free).
 *
 * Below `lg` the exits sit in the bar instead; only one copy is ever shown.
 */

const SIGN_UP = "Sign up free";
const EXIT = "Back to the tour";

/**
 * The demo bar: a yellow tag (the app's for-sale tag) saying this is a demo,
 * what that means, why some links lead to the tour, and Reset. Takes focus
 * when the demo opens, so a keyboard or screen reader lands at its start.
 */
export function DemoBar({ onReset, onExit }: { onReset: () => void; onExit?: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-label="About this demo"
      className="flex flex-col gap-3 rounded-xl border border-neon-yellow/50 bg-neon-yellow/[0.06] px-4 py-3 focus:outline-none sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:gap-3">
        <span className="mt-0.5 inline-flex shrink-0 -rotate-2 items-center gap-1.5 rounded-sm bg-neon-yellow px-2 py-0.5 text-sm font-bold text-black shadow-[0_0_10px_rgba(255,230,0,0.35)]">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-black/70" />
          Demo binder
        </span>
        <div className="min-w-0 space-y-1 text-sm">
          <p className="text-slate-100">Fake cards, real buttons. Go nuts: nothing leaves this tab.</p>
          <p className="text-slate-300">
            Inventory and label printing need an account, so those links show you the tour instead.
          </p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onReset}
          className={`min-h-10 rounded-md px-2 text-sm text-slate-200 underline underline-offset-4 hover:text-white ${FOCUS}`}
        >
          Reset demo data
        </button>
        <Link
          to={PUBLIC_DESTINATIONS.signUp}
          className="inline-flex min-h-10 items-center rounded-md bg-neon-green px-4 text-sm font-bold text-black hover:bg-[#33e07c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] focus-visible:ring-offset-2 focus-visible:ring-offset-black lg:hidden"
        >
          {SIGN_UP}
        </Link>
        {onExit && (
          <button
            type="button"
            onClick={onExit}
            className={`min-h-10 rounded-md border border-slate-600 px-3 text-sm text-slate-100 hover:border-neon-blue lg:hidden ${FOCUS}`}
          >
            {EXIT}
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * The exits as binder index tabs on the right edge, wide screens only: the
 * same staircase the signed-in shell's nav uses, so the demo sits in the
 * frame it will live in after sign-up.
 */
export function DemoRail({ onExit }: { onExit?: () => void }) {
  const tab =
    "binder-tab flex items-center gap-3 rounded-l-xl py-4 pl-4 pr-5 text-left text-sm font-medium leading-tight transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF]";
  return (
    <aside aria-label="Leave the demo" className="fixed right-0 top-1/2 z-30 hidden -translate-y-1/2 flex-col gap-2 lg:flex">
      <Link
        to={PUBLIC_DESTINATIONS.signUp}
        className={`${tab} binder-tab-glow-green w-[170px] bg-gray-900 text-neon-green`}
      >
        <UserPlusIcon aria-hidden="true" className="h-6 w-6 shrink-0" />
        {SIGN_UP}
      </Link>
      {onExit && (
        <button
          type="button"
          onClick={onExit}
          style={{ marginRight: "-6px" }}
          className={`${tab} w-[160px] bg-gray-800/80 text-gray-300 hover:w-[166px] hover:bg-gray-800 hover:text-white`}
        >
          <ArrowUturnLeftIcon aria-hidden="true" className="h-6 w-6 shrink-0" />
          {EXIT}
        </button>
      )}
    </aside>
  );
}
