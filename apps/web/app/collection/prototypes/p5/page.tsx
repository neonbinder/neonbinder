import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Link, useSearchParams } from "react-router";
import { XMarkIcon } from "@heroicons/react/24/solid";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import { inertBackground } from "@/lib/dom/inert-background";
import PrototypeBanner, { prototypeName } from "../_shared/PrototypeBanner";
import { cardLabel, getCard, type CardId } from "../_shared/data";
import { usePrototypeStore } from "../_shared/usePrototypeStore";
import { P5Context, type P5, type View } from "./context";
import BindersView from "./BindersView";
import CardDrawer from "./CardDrawer";
import ChecklistsView from "./ChecklistsView";
import PcLanding from "./PcLanding";
import PcPage from "./PcPage";
import RainbowsView from "./RainbowsView";
import {
  parsePcKey,
  pcKey,
  pcTitle,
  uniqueCard,
  type PcRef,
  type TeamMode,
} from "./model";
import "./p5.css";

/**
 * NEO-350 — collection prototype 5, "Player PC".
 *
 * The way in is a PLAYER, a TEAM or a SCHOOL, not a set: My PCs → a player's
 * career, year by year, have and need → a card's rainbow, copies and details.
 * Rainbows and Binders hang off the same idea; Checklists is a mock of the
 * separate read-only catalog tab. Fake data, no Convex.
 */

const SEED_FOLLOWED: PcRef[] = [
  { kind: "player", id: "reggie-white" },
  { kind: "player", id: "shohei-ohtani" },
  { kind: "team", id: "red-wings" },
  { kind: "team", id: "wisconsin" },
];

const CHROME = "2024-topps-chrome-baseball";
const SEED_CHASED: CardId[] = [
  uniqueCard(CHROME, null, "1"),
  uniqueCard(CHROME, null, "25"),
  // The regular #13, by id: the Sliding variation shares its number.
  uniqueCard(CHROME, null, "13"),
];

const VIEWS: { view: View; label: string }[] = [
  { view: "pcs", label: "My PCs" },
  { view: "rainbows", label: "Rainbows" },
  { view: "binders", label: "Binders" },
];

const LOCAL_KEY = "nb-collection-prototype:p5-local";

function loadLocal(): { followed: PcRef[]; chased: CardId[] } {
  try {
    const raw = window.sessionStorage.getItem(LOCAL_KEY);
    if (raw) return JSON.parse(raw) as { followed: PcRef[]; chased: CardId[] };
  } catch {
    // Blocked or corrupt storage: start from the seed.
  }
  return { followed: SEED_FOLLOWED, chased: SEED_CHASED };
}

interface Toast {
  id: number;
  message: string;
  undo?: () => void;
}

export default function CollectionPrototype5() {
  useDocumentTitle(`${prototypeName(5)} · Collection prototype`);
  const store = usePrototypeStore("p5");
  const [params, setParams] = useSearchParams();

  const pcRef = parsePcKey(params.get("pc"));
  const rawView = params.get("view");
  const view: View =
    rawView === "rainbows" || rawView === "binders" || rawView === "checklists"
      ? rawView
      : "pcs";
  const modeParam = params.get("mode");
  const initialMode: TeamMode | undefined =
    modeParam === "onCard" || modeParam === "playedFor" ? modeParam : undefined;

  const [local, setLocal] = useState(loadLocal);
  useEffect(() => {
    try {
      window.sessionStorage.setItem(LOCAL_KEY, JSON.stringify(local));
    } catch {
      // Storage full or blocked: keep going in memory.
    }
  }, [local]);

  // --- Toast + live region ------------------------------------------------
  const [toast, setToast] = useState<Toast | null>(null);
  const toastRef = useRef<HTMLDivElement>(null);
  const announce = (message: string, undo?: () => void) => {
    setToast((t) => ({ id: (t?.id ?? 0) + 1, message, undo }));
  };
  useEffect(() => {
    if (!toast) return;
    const timer = window.setInterval(() => {
      // Never pull the toast out from under a keyboard user on it.
      if (toastRef.current?.contains(document.activeElement)) return;
      setToast((t) => (t?.id === toast.id ? null : t));
    }, 8000);
    return () => window.clearInterval(timer);
  }, [toast]);

  // --- Drawer ---------------------------------------------------------------
  const [drawerCard, setDrawerCard] = useState<CardId | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const openCard = (cardId: CardId) => {
    if (drawerCard === null) {
      openerRef.current = document.activeElement as HTMLElement | null;
    }
    setDrawerCard(cardId);
  };
  const closeDrawer = () => setDrawerCard(null);
  const drawerOpen = drawerCard !== null;

  useEffect(() => {
    if (!drawerOpen || !layerRef.current) return;
    const opener = openerRef.current;
    const release = inertBackground(layerRef.current);
    document.getElementById("p5-drawer-title")?.focus();
    return () => {
      release();
      if (opener && opener.isConnected) opener.focus();
      else document.getElementById("p5-heading")?.focus();
    };
  }, [drawerOpen]);

  function trapTab(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab" || !drawerOpen || !layerRef.current) return;
    const focusables = Array.from(
      layerRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (
      e.shiftKey &&
      (active === first || !layerRef.current.contains(active))
    ) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // --- Focus the new heading when the view changes (not on first load) -----
  const locationKey = pcRef ? pcKey(pcRef) : view;
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [locationKey]);

  // --- The context every view reads ------------------------------------------
  const owned = new Set(
    store.state.copies.filter((c) => c.quantity > 0).map((c) => c.cardId),
  );

  const isFollowed = (ref: PcRef) =>
    local.followed.some((f) => pcKey(f) === pcKey(ref));
  const p5: P5 = {
    store,
    owned,
    openCard,
    announce,
    quickAdd: (cardId) => {
      const copy = store.addCopy(cardId);
      announce(`Added ${cardLabel(getCard(cardId))}.`, () =>
        store.removeCopy(copy.id),
      );
    },
    goView: (v) => setParams({ view: v }),
    goPc: (ref) => setParams({ pc: pcKey(ref) }),
    followed: local.followed,
    isFollowed,
    follow: (ref) => {
      if (isFollowed(ref)) return;
      setLocal((l) => ({ ...l, followed: [...l.followed, ref] }));
      announce(`Following ${pcTitle(ref)}. New PC added.`, () =>
        setLocal((l) => ({
          ...l,
          followed: l.followed.filter((f) => pcKey(f) !== pcKey(ref)),
        })),
      );
    },
    unfollow: (ref) => {
      const index = local.followed.findIndex((f) => pcKey(f) === pcKey(ref));
      if (index === -1) return;
      setLocal((l) => ({
        ...l,
        followed: l.followed.filter((f) => pcKey(f) !== pcKey(ref)),
      }));
      announce(`Unfollowed ${pcTitle(ref)}. Your cards stay put.`, () =>
        setLocal((l) => {
          const followed = [...l.followed];
          followed.splice(index, 0, ref);
          return { ...l, followed };
        }),
      );
    },
    chased: local.chased,
    toggleChase: (rootId) =>
      setLocal((l) => ({
        ...l,
        chased: l.chased.includes(rootId)
          ? l.chased.filter((id) => id !== rootId)
          : [...l.chased, rootId],
      })),
  };

  const title =
    view === "rainbows"
      ? "Rainbows"
      : view === "binders"
        ? "Binders"
        : view === "checklists"
          ? "Checklists"
          : "My PCs";

  return (
    <P5Context.Provider value={p5}>
      <div>
        <PrototypeBanner current={5} />

        <nav aria-label="Player PC">
          <ul className="flex flex-wrap items-stretch gap-1 border-b border-slate-800">
            {VIEWS.map(({ view: v, label }) => {
              const active = !pcRef && view === v;
              const inside = pcRef && v === "pcs";
              return (
                <li key={v}>
                  <Link
                    to={`?view=${v}`}
                    aria-current={active ? "page" : undefined}
                    className={`-mb-px flex min-h-11 items-center border-b-2 px-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] ${
                      active || inside
                        ? "border-neon-blue text-white"
                        : "border-transparent text-slate-300 hover:text-white"
                    }`}
                  >
                    {label}
                  </Link>
                </li>
              );
            })}
            <li aria-hidden="true" className="mx-2 my-2 w-px bg-slate-700" />
            <li>
              <Link
                to="?view=checklists"
                aria-current={
                  !pcRef && view === "checklists" ? "page" : undefined
                }
                className={`-mb-px flex min-h-11 items-center gap-2 border-b-2 px-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] ${
                  !pcRef && view === "checklists"
                    ? "border-neon-purple text-white"
                    : "border-transparent text-slate-300 hover:text-white"
                }`}
              >
                Checklists
                <span className="rounded border border-dashed border-neon-purple/70 px-1.5 text-xs font-medium text-neon-purple-text">
                  own tab
                </span>
              </Link>
            </li>
          </ul>
        </nav>

        <div className="mt-6">
          {pcRef ? (
            <PcPage
              key={`${pcKey(pcRef)}:${initialMode ?? ""}`}
              pcRef={pcRef}
              initialMode={initialMode}
              headingRef={headingRef}
            />
          ) : (
            <>
              <h1
                id="p5-heading"
                ref={headingRef}
                tabIndex={-1}
                className="mb-3 text-4xl text-white focus:outline-none sm:text-5xl"
                style={{
                  fontFamily: "'Neon', 'Lexend', sans-serif",
                  textShadow: "0 0 18px rgba(0,194,255,0.45)",
                }}
              >
                {title}
              </h1>
              {view === "rainbows" ? (
                <RainbowsView />
              ) : view === "binders" ? (
                <BindersView />
              ) : view === "checklists" ? (
                <ChecklistsView />
              ) : (
                <PcLanding />
              )}
            </>
          )}
        </div>

        <div className="mt-12 border-t border-slate-800 pt-4">
          <button
            type="button"
            onClick={() => {
              store.reset();
              setLocal({ followed: SEED_FOLLOWED, chased: SEED_CHASED });
              announce("Fake data is back to the start.");
            }}
            className="min-h-11 rounded-md px-2 text-sm text-slate-400 underline underline-offset-4 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] sm:min-h-8"
          >
            Reset the fake data
          </button>
        </div>
      </div>

      {createPortal(
        <div ref={layerRef} onKeyDown={trapTab}>
          {drawerCard && (
            <>
              <div
                aria-hidden="true"
                onClick={closeDrawer}
                className="fixed inset-0 z-40 bg-black/70"
              />
              <CardDrawer cardId={drawerCard} onClose={closeDrawer} />
            </>
          )}
          {/* The live region is one stable node: a region mounted with its
              text already in it is often never read out. */}
          <p role="status" className="sr-only">
            {toast?.message ?? ""}
          </p>
          {toast && (
            <div
              ref={toastRef}
              key={toast.id}
              className="p5-anim fixed bottom-4 left-4 right-4 z-[60] flex items-center gap-3 rounded-lg border border-slate-600 border-l-4 border-l-neon-blue bg-slate-900 px-4 py-3 shadow-2xl shadow-black motion-safe:animate-[p5-toast-in_180ms_ease-out] sm:left-6 sm:right-auto sm:w-[26rem]"
            >
              <p
                aria-hidden="true"
                className="min-w-0 flex-1 text-sm text-white"
              >
                {toast.message}
              </p>
              {toast.undo && (
                <button
                  type="button"
                  onClick={() => {
                    toast.undo?.();
                    announce("Undone. Like it never happened.");
                  }}
                  className="min-h-11 shrink-0 rounded-md px-2 text-sm font-bold text-neon-green hover:bg-neon-green hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] sm:min-h-8"
                >
                  Undo
                </button>
              )}
              <button
                type="button"
                onClick={() => setToast(null)}
                aria-label="Dismiss message"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-slate-300 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] sm:h-8 sm:w-8"
              >
                <XMarkIcon aria-hidden="true" className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>,
        document.body,
      )}
    </P5Context.Provider>
  );
}
