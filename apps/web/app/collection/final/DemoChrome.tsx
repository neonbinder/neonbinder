import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { ArrowUturnLeftIcon, UserPlusIcon } from "@heroicons/react/24/outline";
import { FOCUS } from "../prototypes/p1/ui";
import DemoThemeToggle from "./DemoThemeToggle";
import { PUBLIC_DESTINATIONS, useCollectionMode } from "./mode";
import "./demo-chrome.css";
import NeonButton from "@/components/modules/NeonButton";

/**
 * NEO-350 — the demo chrome around the collection page, so whoever is
 * looking always knows the binders are sample data.
 *
 * - Both modes: a demo bar above the page (the "Demo binder" tag, what that
 *   means, Reset).
 * - The public demo (on `/binder-tracking`) also says how to leave: the bar
 *   carries Sign up and Back to the tour below `lg`, and on a wide screen the
 *   two exits are index tabs on the right edge (`DemoRail`), where the
 *   signed-in shell keeps its own tabs (the pack tray already leaves that
 *   edge free). Only one copy of each exit is ever shown.
 * - Signed in (`/collection`), the collector already has an account and the
 *   shell's own nav, so the bar is just the marker and Reset.
 * - Both modes (NEO-356): a Light / Dark switch for the demo alone, hidden
 *   for a collector who saved a mode in Settings (see DemoThemeToggle).
 */

const SIGN_UP = "Sign up free";
const EXIT = "Back to the tour";

/**
 * The demo bar: a yellow tag (the app's for-sale tag) saying this is a demo,
 * what that means, where its links lead, and Reset. In the public demo it
 * takes focus when the demo opens, so a keyboard or screen reader lands at
 * its start; signed in, `/collection` is an ordinary page of the app and
 * focus stays where the shell puts it.
 */
export function DemoBar({ onReset, onExit }: { onReset: () => void; onExit?: () => void }) {
  const isPublic = useCollectionMode().mode === "public";
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (isPublic) ref.current?.focus({ preventScroll: true });
  }, [isPublic]);

  return (
    <section
      ref={ref}
      tabIndex={isPublic ? -1 : undefined}
      aria-label="About this demo"
      className="flex flex-col gap-3 rounded-xl border border-neon-yellow/50 bg-neon-yellow/[0.06] px-4 py-3 focus:outline-none sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:gap-3">
        <span className="mt-0.5 inline-flex shrink-0 -rotate-2 items-center gap-1.5 rounded-sm bg-neon-yellow px-2 py-0.5 text-sm font-bold text-on-neon-yellow shadow-[0_0_10px_rgb(255_230_0/calc(0.35*var(--glow)))]">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-on-neon-yellow/70" />
          Demo binder
        </span>
        <div className="min-w-0 space-y-1 text-sm">
          {isPublic ? (
            <>
              <p className="text-ink">Fake cards, real buttons. Go nuts: nothing leaves this tab.</p>
              <p className="text-ink-2">
                Inventory and label printing need an account, so those links show you the tour instead.
              </p>
            </>
          ) : (
            <>
              <p className="text-ink">Sample cards, real buttons. Play away: none of it touches your account.</p>
              <p className="text-ink-2">
                Your real collection moves in here soon. Inventory and the Print Shop are the real deal.
              </p>
            </>
          )}
          <DemoThemeToggle className="max-w-80 pt-2" />
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onReset}
          className={`min-h-10 rounded-md px-2 text-sm text-ink-2 underline underline-offset-4 hover:text-ink ${FOCUS}`}
        >
          Reset demo data
        </button>
        {/* `lg:hidden` rides on a `contents` wrapper: Radix's button display
            is unlayered CSS, so a Tailwind `hidden` on the button itself
            would lose to it. */}
        {isPublic && (
          <span className="contents lg:hidden">
            <NeonButton asChild className="min-h-10">
              <Link to={PUBLIC_DESTINATIONS.signUp}>{SIGN_UP}</Link>
            </NeonButton>
          </span>
        )}
        {isPublic && onExit && (
          <span className="contents lg:hidden">
            <NeonButton type="button" variant="secondary" outline onClick={onExit} className="min-h-10">
              {EXIT}
            </NeonButton>
          </span>
        )}
      </div>
    </section>
  );
}

/**
 * The exits as binder index tabs on the right edge, wide screens only: the
 * same staircase the signed-in shell's nav uses, so the demo sits in the
 * frame it will live in after sign-up. Resting tabs sit 10px past the edge
 * and slide out, rather than animating width (see binder-tabs.tsx).
 */
export function DemoRail({ onExit }: { onExit?: () => void }) {
  const tab =
    "binder-tab flex items-center gap-3 rounded-l-xl py-4 pl-4 pr-5 text-left text-sm font-medium leading-tight transition-[transform,background-color,color,box-shadow] duration-200 ease-out motion-reduce:transition-colors focus-outline";
  return (
    <aside aria-label="Leave the demo" className="fixed right-0 top-1/2 z-30 hidden -translate-y-1/2 flex-col gap-2 lg:flex">
      <Link
        to={PUBLIC_DESTINATIONS.signUp}
        className={`${tab} demo-tab-lit tab-hue-green w-[170px]`}
      >
        <UserPlusIcon aria-hidden="true" className="h-6 w-6 shrink-0" />
        {SIGN_UP}
      </Link>
      {onExit && (
        <button
          type="button"
          onClick={onExit}
          style={{ marginRight: "-6px" }}
          className={`${tab} tab-hue-blue w-[170px] translate-x-[10px] text-ink-2 hover:translate-x-[4px] hover:text-ink`}
        >
          <ArrowUturnLeftIcon aria-hidden="true" className="h-6 w-6 shrink-0" />
          {EXIT}
        </button>
      )}
    </aside>
  );
}
