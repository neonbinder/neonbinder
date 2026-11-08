import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router";
import { useDashboard } from "../_shared/persona";
import PocketPage, { pageCount } from "./PocketPage";
import {
  AlmostThere,
  Celebration,
  Chase,
  FreshPulls,
  Intake,
  OutTheDoor,
  SmartNews,
  TradePileCard,
  UnlistedBoxes,
} from "./Sections";
import Shelf from "./Shelf";
import { shelfOf } from "./shelf-model";
import "./binder-shelf.css";

/**
 * NEO-464 — dashboard prototype 4, "Binder shelf". For player and team
 * collectors: the binders are the page. Spines stand on a shelf, each with
 * its "N new" sticker; pull one and it opens to a nine-pocket page right
 * under the shelf. Then what filed itself into the smart binders, the ship
 * list (dealer only), fresh pulls, sets on the bubble, the chase, intake.
 *
 * View state lives in the URL, set functionally so `?as=` survives:
 * - `binder=<id>`: the open binder. Opening and closing one is going
 *   somewhere, so it PUSHES: Back closes it again.
 * - `pg=<n>`: its page (1-based). A page turn is an in-view tweak: it
 *   REPLACES, so Back never steps through pages.
 */

const BINDER_PARAM = "binder";
const PAGE_PARAM = "pg";
const POCKET_ID = "p4-pocket";

export default function Dashboard() {
  const data = useDashboard();
  const [params, setParams] = useSearchParams();
  const { mine, smart } = useMemo(() => shelfOf(data), [data]);
  const all = useMemo(() => [...mine, ...smart], [mine, smart]);

  const open = all.find((b) => b.id === params.get(BINDER_PARAM)) ?? null;
  const pages = open ? pageCount(open) : 1;
  const rawPage = Number(params.get(PAGE_PARAM) ?? "1");
  const page = Number.isInteger(rawPage) ? Math.min(Math.max(rawPage, 1), pages) - 1 : 0;

  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** Set by a click that opens or closes a binder, so focus follows it (not on a fresh load). */
  const focusNext = useRef<{ to: "pocket" } | { to: "spine"; id: string } | null>(null);

  const openBinder = useCallback(
    (id: string) => {
      focusNext.current = { to: "pocket" };
      setParams((p) => {
        p.set(BINDER_PARAM, id);
        p.delete(PAGE_PARAM);
        return p;
      });
    },
    [setParams],
  );

  const closeBinder = useCallback(() => {
    if (open) focusNext.current = { to: "spine", id: open.id };
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
      headingRef.current?.focus({ preventScroll: true });
      document.getElementById(POCKET_ID)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else {
      rootRef.current?.querySelector<HTMLElement>(`[data-p4-spine="${CSS.escape(want.id)}"]`)?.focus();
    }
  }, [openId]);

  const sinceLastVisit = data.additions.filter((b) => b.sinceLastVisit).reduce((n, b) => n + b.cards.length, 0);
  const bindersWithNews = all.filter((b) => b.newCards.length > 0).length;

  return (
    <div ref={rootRef} className="space-y-10">
      <header className="space-y-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">Welcome back, slugger.</h1>
          <p className="mt-2 max-w-2xl text-ink-2">
            {sinceLastVisit} cards came in since your last visit, across {bindersWithNews} binders. The green stickers say
            where. Pull one off the shelf to flip through it.
          </p>
        </div>
        {data.justCompleted && <Celebration done={data.justCompleted} />}
      </header>

      <div className="space-y-6">
        <Shelf mine={mine} smart={smart} openId={openId} pocketId={POCKET_ID} onOpen={openBinder} />
        <div id={POCKET_ID} className="scroll-mt-24">
          {open ? (
            <PocketPage key={open.id} binder={open} page={page} onPage={turnPage} onClose={closeBinder} headingRef={headingRef} />
          ) : (
            <p className="text-sm text-ink-3">No binder open. Pick a spine and it opens right here.</p>
          )}
        </div>
      </div>

      <SmartNews binders={smart} onOpen={openBinder} />

      {data.sales && <OutTheDoor sales={data.sales} />}

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <FreshPulls batches={data.additions} />
        <div className="space-y-10">
          <AlmostThere sets={data.building} />
          <Chase wants={data.wantList} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Intake intake={data.intake} />
        <TradePileCard pile={data.tradePile} />
        {data.unlistedBoxes.length > 0 && <UnlistedBoxes boxes={data.unlistedBoxes} />}
      </div>
    </div>
  );
}
