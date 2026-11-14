import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router";
import type { DashboardData } from "../fake-data";
import { BlockHeading, count } from "./bits";
import Hopper from "./Hopper";
import Boards, { boardItems } from "./Boards";
import CouldFit from "./CouldFit";
import { ClosedCover, EmptyCover } from "./Cover";
import NewListings from "./NewListings";
import NewOnNeonBinder from "./NewOnNeonBinder";
import { DashboardCardPanel } from "./panelLink";
import PocketPage, { PocketTitle, WaitingTitle } from "./PocketPage";
import { Chase, FreshPulls } from "./Pulls";
import { FillingUp, OddsAndEnds } from "./Rail";
import Shelf from "./Shelf";
import CrewDesk from "./CrewDesk";
import { CollectionStarter, InventoryStarter } from "./Starters";
import SyncStatus from "./SyncStatus";
import { pageCount, shelfOrder, type ShelfBinder } from "./shelf-model";
import { NeedsALook, needsALook, OutTheDoor } from "./ToDo";
import "./combined.css";

/**
 * The dashboard: ONE screen for everyone (Jason, 2026-11-10: "We should not
 * build two different dashboards. We should just build one that shows every
 * piece that is relevant to that user's data."). Every section draws only
 * when the account's data has something for it; nothing at all draws nothing.
 *
 *   1. Greeting and one summary line (the page's one <h1>), then the sync
 *      status: cards waiting for the next sync, and sets whose latest sync
 *      failed or held cards back (none of either: not drawn).
 *      Under it, what is open with the crew (`CrewDesk`, NEO-536): the
 *      collector's open requests and reports, and for an admin every
 *      collector's. The signed-in page only (the demo has no crew).
 *   2. The top band: a lead section with a side column beside it.
 *      - Side: In the Hopper (any scans in intake), then Needs a Look (a
 *        problem order, or a box with cards not listed).
 *      - Lead, by one rule: an order waiting to ship puts Out the Door first
 *        (the boards follow the band); otherwise On the Bubble, the set
 *        boards, leads (Out the Door's "all shipped" line follows it).
 *        Out the Door shows only for an account that sells; the boards only
 *        when a set is being built.
 *   3. Your binders (and boxes): three shelves of eight on the left, the
 *      open pocket page on the right, one height. With a box in use, the
 *      third shelf holds the boxes and the binders two (16; "Show all N
 *      binders" past the cap). An empty second shelf carries the way into
 *      Collection's Add cards; the third, until there is a box, carries
 *      Inventory's, after any binders on it while there is room
 *      (`Starters`). With no binder open, the first stands shut beside them
 *      (`Cover`); an open one with nothing in it stays shut.
 *   4. Could fit your smart binders.
 *   5. The Chase, Fresh Pulls and New Listings; a rail of Binders Filling Up
 *      and Odds and Ends.
 *   6. New on NeonBinder, the catalog's newest sets. Shown to everyone: it
 *      leads instead (right under the greeting) when nothing else is up top.
 *
 * View state lives in the URL, set functionally so other params survive:
 * - `binder=<id>`: the open binder. Opening and closing one is going
 *   somewhere, so it PUSHES: Back closes it again.
 * - `pg=<n>`: its page (1-based). A page turn REPLACES.
 * - `open=…`: disclosures (see `useOpen`). They REPLACE.
 * - `detail=<card>` (and `side=inventory`): a card's panel, open over the
 *   screen (`./panelLink`). Opening one PUSHES: Back closes it.
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

/**
 * One line under the greeting: orders to ship (only for an account that
 * sells), the cards filed into a binder since the last visit (an add or a
 * move; never a sale, an edit or a pocket shuffle), then the closest finish.
 */
export function summary(
  data: Pick<DashboardData, "sales">,
  binders: readonly Pick<ShelfBinder, "newCards">[],
  closest: { label: string; need: number } | null,
): string {
  const parts: string[] = [];
  if (data.sales) {
    const n = data.sales.unshipped.length;
    parts.push(n === 0 ? "Nothing to ship." : `${count(n, "order")} to ship.`);
  }
  const filed = binders.reduce((n, b) => n + b.newCards.length, 0);
  if (filed > 0) parts.push(`${count(filed, "card")} filed since your last visit.`);
  if (closest) parts.push(`${closest.label} is ${count(closest.need, "card")} from done.`);
  return parts.length > 0 ? parts.join(" ") : "Your binders are right where you left them.";
}

/** Cards of the Want List, by card id, for the highlight. */
function wantIds(data: DashboardData): Set<string> {
  return new Set(data.wantList.map((w) => w.id));
}

/**
 * The dashboard screen. Pure of its source: the caller passes the data (fake,
 * from `demo/`; or the signed-in account's, from `real/`), and the screen
 * draws the sections that data fills. The shelf is `data.binders`, laid
 * out by the caller (the demo's by `bindersOf` in `../fake-data`, so this
 * screen, which the signed-in page loads, never loads the demo's data).
 */
export default function DashboardScreen({ data }: { data: DashboardData }) {
  const [params, setParams] = useSearchParams();
  const wanted = useMemo(() => wantIds(data), [data]);
  const binders = useMemo(() => shelfOrder(data.binders ?? []), [data]);
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

  // Each section only when the data fills it.
  const scoreboard =
    boards.length > 0 ? (
      <Boards items={boards} wanted={wanted} justCompleted={data.justCompleted} onOpenBinder={openBinder} />
    ) : null;
  const ship = data.sales ? <OutTheDoor sales={data.sales} /> : null;
  const hopper = data.intake.total > 0 ? <Hopper intake={data.intake} wanted={wanted} /> : null;
  const look = needsALook(data) ? <NeedsALook data={data} /> : null;
  const closest = boards[0] ? { label: boards[0].label, need: boards[0].need } : null;

  // The one ordering rule: an order waiting to ship leads; else the boards do.
  const shipLeads = (data.sales?.unshipped.length ?? 0) > 0 || !scoreboard;
  const lead = shipLeads ? ship : scoreboard;
  const after = shipLeads ? scoreboard : ship;
  const side =
    hopper || look ? (
      <div className="flex min-w-0 flex-col gap-8">
        {hopper}
        {look}
      </div>
    ) : null;
  const sync = data.syncStatus ? <SyncStatus status={data.syncStatus} /> : null;
  // The catalog's news shows for everyone; with nothing else up top, it leads.
  const news = <NewOnNeonBinder sets={data.newSets} />;
  const newsLeads = !lead && !side && !sync;

  // The third shelf is the boxes' once one is in use. An empty shelf carries a way in: shelf 2 to
  // Collection's Add cards while it holds no binder, shelf 3 to Inventory's until there is a box.
  const boxes = data.shelfBoxes ?? [];
  const hasBoxes = boxes.length > 0 || (data.shelfBoxes === undefined && (data.totals.boxes ?? 0) > 0);
  const starter = (row: number) => {
    if (row === 1) return <CollectionStarter />;
    if (row === 2 && !hasBoxes) return <InventoryStarter />;
    return null;
  };
  // An open binder with nothing in it stays shut: no pages to turn.
  const openEmpty = open !== null && open.cardCount === 0 && !open.checklist;

  const band = lead && side ? (shipLeads ? "lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]" : "lg:grid-cols-[minmax(0,1fr)_22rem]") : "";

  return (
    <div ref={rootRef} className="space-y-12">
      <header>
        <h1 className="text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">Welcome back, slugger.</h1>
        <p className="mt-2 max-w-prose text-base text-ink-2">{summary(data, binders, closest)}</p>
      </header>

      {sync}
      {/* What is open with the crew (NEO-536): the signed-in page's only; it never decides what leads. */}
      <CrewDesk />
      {newsLeads && news}

      {(lead || side) && (
        <div className={lead ? `grid gap-8 lg:items-start ${band}` : "max-w-2xl"}>
          {lead}
          {side}
        </div>
      )}
      {after}

      {binders.length > 0 && (
        <section aria-labelledby="cb-binders-heading">
          {/* Beside xl, a grid: the heading and the open binder's title share the top row; the shelves and the
              page share the row below and stretch to its height, so the page ends level with the bottom shelf.
              Stacked, the source order reads top to bottom: heading, shelves, title, page. */}
          <div className="grid gap-x-8 gap-y-4 xl:grid-cols-[minmax(0,1fr)_29rem] xl:items-stretch">
            <div className="min-w-0 xl:col-start-1 xl:row-start-1">
              <BlockHeading id="cb-binders-heading">
                {boxes.length > 0 ? "Your binders and boxes" : "Your binders"}
              </BlockHeading>
            </div>
            <div className="dash-shelves min-w-0 xl:col-start-1 xl:row-start-2">
              <Shelf
                binders={binders}
                openId={openId}
                pocketId={POCKET_ID}
                onOpen={openBinder}
                onClose={closeBinder}
                starter={starter}
                boxes={boxes}
              />
            </div>
            <div className="min-w-0 xl:col-start-2 xl:row-start-1">
              {open ? <PocketTitle binder={open} headingRef={headingRef} /> : <WaitingTitle />}
            </div>
            <div id={POCKET_ID} className="flex min-w-0 scroll-mt-24 flex-col xl:col-start-2 xl:row-start-2">
              {!open ? (
                <ClosedCover binder={binders[0]} onOpen={openBinder} />
              ) : openEmpty ? (
                <EmptyCover key={open.id} binder={open} />
              ) : (
                <PocketPage key={open.id} binder={open} page={page} onPage={turnPage} />
              )}
            </div>
          </div>
        </section>
      )}

      <CouldFit binders={binders} wanted={wanted} />

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-8">
        <div className="min-w-0 space-y-10">
          <Chase wants={data.wantList} />
          <FreshPulls batches={data.additions} wanted={wanted} />
          <NewListings listings={data.newListings} />
        </div>
        <div className="min-w-0 space-y-5">
          <FillingUp binders={binders} wanted={wanted} onOpen={openBinder} />
          <OddsAndEnds boxes={data.unlistedBoxes} trade={data.tradePile} />
        </div>
      </div>

      {!newsLeads && news}

      <DashboardCardPanel />
    </div>
  );
}
