import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router";
import type { DashboardData } from "../fake-data";
import { BlockHeading, count } from "./bits";
import Hopper from "./Hopper";
import Boards, { boardItems } from "./Boards";
import CouldFit from "./CouldFit";
import PocketPage, { PocketTitle, WaitingPage, WaitingTitle } from "./PocketPage";
import { Chase, FreshPulls } from "./Pulls";
import { FillingUp, OddsAndEnds } from "./Rail";
import Shelf from "./Shelf";
import { bindersOf, pageCount, shelfOrder } from "./shelf-model";
import ToDo from "./ToDo";
import "./combined.css";

/**
 * The dashboard, one screen, in the order Jason set (2026-11-08) (NEO-464).
 *
 *   1. Greeting and one summary line (the page's one <h1>).
 *   2. Dealer: to-do first (Out the Door, Needs a Look, In the Hopper beside
 *      them), then On the Bubble. Collector: On the Bubble first, In the
 *      Hopper beside it, then anything left to do.
 *      On the Bubble is the top 5 by fewest cards needed, sets and checklist
 *      smart binders together, compact; only when there is one. The hopper
 *      shows for anyone with scans.
 *   3. Your binders: three shelves of eight (24, "Show all N binders" past
 *      that) on the left, the open pocket page on the right, one height.
 *   4. Could fit your smart binders (placeholder heading).
 *   5. The Chase and Fresh Pulls; a rail of Binders Filling Up and Odds and Ends.
 *
 * View state lives in the URL, set functionally so `?as=` survives:
 * - `binder=<id>`: the open binder. Opening and closing one is going
 *   somewhere, so it PUSHES: Back closes it again.
 * - `pg=<n>`: its page (1-based). A page turn REPLACES.
 * - `open=…`: disclosures (see `useOpen`). They REPLACE.
 */

const BINDER_PARAM = "binder";
const PAGE_PARAM = "pg";
const POCKET_ID = "cb-pocket";

/** Into the open pocket page: its heading takes focus, and the page scrolls to it (no glide when motion is reduced). */
function focusPocket(heading: HTMLHeadingElement | null): void {
  heading?.focus({ preventScroll: true });
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.getElementById(POCKET_ID)?.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
}

/** One line under the greeting: what is waiting, then the closest finish. */
function summary(data: DashboardData, closest: { label: string; need: number } | null): string {
  const parts: string[] = [];
  if (data.sales) {
    const n = data.sales.unshipped.length;
    parts.push(n === 0 ? "Nothing to ship." : `${count(n, "order")} to ship.`);
  } else {
    const fresh = data.additions.filter((b) => b.sinceLastVisit).reduce((n, b) => n + b.cards.length, 0);
    if (fresh > 0) parts.push(`${count(fresh, "new card")} since your last visit.`);
  }
  if (closest) parts.push(`${closest.label} is ${count(closest.need, "card")} from done.`);
  return parts.length > 0 ? parts.join(" ") : "Your binders are right where you left them.";
}

/** Cards of the Want List, by card id, for the highlight. */
function wantIds(data: DashboardData): Set<string> {
  return new Set(data.wantList.map((w) => w.id));
}

/**
 * The dashboard screen. Pure of its source: the caller passes the data (fake
 * today, from `demo/`; the real account's once it exists), and the screen
 * takes the dealer or collector layout from `data.sales`.
 */
export default function DashboardScreen({ data }: { data: DashboardData }) {
  const [params, setParams] = useSearchParams();
  const wanted = useMemo(() => wantIds(data), [data]);
  const binders = useMemo(() => shelfOrder(bindersOf(data)), [data]);
  const boards = useMemo(() => boardItems(data.building, binders), [data.building, binders]);

  const open = binders.find((b) => b.id === params.get(BINDER_PARAM)) ?? null;
  const pages = open ? pageCount(open) : 1;
  const rawPage = Number(params.get(PAGE_PARAM) ?? "1");
  const page = Number.isInteger(rawPage) ? Math.min(Math.max(rawPage, 1), pages) - 1 : 0;

  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** Set by a click that opens or closes a binder, so focus follows it (not on a fresh load). */
  const focusNext = useRef<{ to: "pocket" } | { to: "spine"; id: string } | null>(null);

  /** Mirrors the URL for the guards below, which must not push the URL the page is already on. */
  const openParam = params.get(BINDER_PARAM);
  const pageParam = params.get(PAGE_PARAM);

  const openBinder = useCallback(
    (id: string) => {
      if (openParam === id) {
        // Already open: take the reader to it. A later page goes back to page 1, a page turn (replace).
        if (pageParam !== null) {
          focusNext.current = { to: "pocket" };
          setParams(
            (p) => {
              p.delete(PAGE_PARAM);
              return p;
            },
            { replace: true },
          );
        } else {
          focusPocket(headingRef.current);
        }
        return;
      }
      focusNext.current = { to: "pocket" };
      setParams((p) => {
        p.set(BINDER_PARAM, id);
        p.delete(PAGE_PARAM);
        return p;
      });
    },
    [openParam, pageParam, setParams],
  );

  const closeBinder = useCallback(() => {
    // Nothing open: the URL is already shut, so nothing to push.
    if (!open) return;
    focusNext.current = { to: "spine", id: open.id };
    setParams((p) => {
      p.delete(BINDER_PARAM);
      p.delete(PAGE_PARAM);
      return p;
    });
  }, [open, setParams]);

  const turnPage = useCallback(
    (next: number) => {
      setParams(
        (p) => {
          if (next <= 0) p.delete(PAGE_PARAM);
          else p.set(PAGE_PARAM, String(next + 1));
          return p;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const openId = open?.id ?? null;
  useEffect(() => {
    const want = focusNext.current;
    if (!want) return;
    focusNext.current = null;
    if (want.to === "pocket") {
      focusPocket(headingRef.current);
    } else {
      rootRef.current?.querySelector<HTMLElement>(`[data-cb-spine="${CSS.escape(want.id)}"]`)?.focus();
    }
  }, [openId, page]);

  // Block 2's gate: sales, or any inventory saved. The hopper has its own (any scans).
  const dealer = data.sales !== null;
  const todo = dealer || data.totals.cards > 0;
  const scoreboard =
    boards.length > 0 ? (
      <Boards items={boards} wanted={wanted} justCompleted={data.justCompleted} onOpenBinder={openBinder} />
    ) : null;
  const hopper = data.intake.total > 0 ? <Hopper intake={data.intake} wanted={wanted} /> : null;
  const closest = boards[0] ? { label: boards[0].label, need: boards[0].need } : null;

  return (
    <div ref={rootRef} className="space-y-12">
      <header>
        <h1 className="text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">Welcome back, slugger.</h1>
        <p className="mt-2 max-w-prose text-base text-ink-2">{summary(data, closest)}</p>
      </header>

      {dealer ? (
        <>
          <ToDo data={data} todo={todo} withHopper wanted={wanted} />
          {scoreboard}
        </>
      ) : (
        <>
          {(scoreboard || hopper) && (
            <div
              className={
                scoreboard && hopper ? "grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start" : hopper ? "max-w-2xl" : ""
              }
            >
              {scoreboard}
              {hopper}
            </div>
          )}
          <ToDo data={data} todo={todo} withHopper={false} wanted={wanted} />
        </>
      )}

      {binders.length > 0 && (
        <section aria-labelledby="cb-binders-heading">
          {/* Beside xl, a grid: the heading and the open binder's title share the top row; the shelves and the
              page share the row below and stretch to its height, so the page ends level with the bottom shelf.
              Stacked, the source order reads top to bottom: heading, shelves, title, page. */}
          <div className="grid gap-x-8 gap-y-4 xl:grid-cols-[minmax(0,1fr)_29rem] xl:items-stretch">
            <div className="min-w-0 xl:col-start-1 xl:row-start-1">
              <BlockHeading id="cb-binders-heading">Your binders</BlockHeading>
            </div>
            <div className="dash-shelves min-w-0 xl:col-start-1 xl:row-start-2">
              <Shelf binders={binders} openId={openId} pocketId={POCKET_ID} onOpen={openBinder} onClose={closeBinder} />
            </div>
            <div className="min-w-0 xl:col-start-2 xl:row-start-1">
              {open ? <PocketTitle binder={open} headingRef={headingRef} /> : <WaitingTitle />}
            </div>
            <div id={POCKET_ID} className="flex min-w-0 scroll-mt-24 flex-col xl:col-start-2 xl:row-start-2">
              {open ? <PocketPage key={open.id} binder={open} page={page} onPage={turnPage} /> : <WaitingPage />}
            </div>
          </div>
        </section>
      )}

      <CouldFit binders={binders} wanted={wanted} />

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-8">
        <div className="min-w-0 space-y-10">
          <Chase wants={data.wantList} />
          <FreshPulls batches={data.additions} wanted={wanted} />
        </div>
        <div className="min-w-0 space-y-5">
          <FillingUp binders={binders} wanted={wanted} onOpen={openBinder} />
          <OddsAndEnds boxes={data.unlistedBoxes} trade={data.tradePile} />
        </div>
      </div>
    </div>
  );
}
