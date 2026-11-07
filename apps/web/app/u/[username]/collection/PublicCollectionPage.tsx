import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import CardFace from "@/app/collection/prototypes/_shared/CardFace";
import { useMediaQuery, useReducedMotion } from "@/app/collection/prototypes/p2/hooks";
import "@/app/collection/prototypes/p2/p2.css";
import { hydrateCatalogCard, hydratePublicOwnCard } from "@/app/collection/final/data/convexStore";
import { cardLabel } from "@/app/collection/final/data/labels";
import { POCKETS_PER_PAGE, type Card, type Copy, type CopyPhotos } from "@/app/collection/final/data/types";
import BinderDesk, { stepCount, stepOfPage, usePageTurnKeys, whereLabel } from "@/app/collection/final/binders/BinderDesk";
import "@/app/collection/final/binders/binders.css";
import { PLAIN_LABEL } from "@/app/collection/final/binders/label";
import { sortedPages, type PageModel, type PocketModel } from "@/app/collection/final/binders/model";
import NeonButton from "@/components/modules/NeonButton";
import { USERNAME_RE } from "@/lib/collection/share-links";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import { useOverflows } from "@/src/hooks/useOverflows";
import PublicCardOverlay, { grade, type PublicCopy } from "./PublicCardOverlay";

/**
 * NEO-360 — the public share pages: a binder, the Want List, Up for Trade and
 * the for-sale stock, read-only, for a visitor who never signs in. A binder is
 * the real one the owner sees (NEO-444, `BinderDesk` in read-only mode); the
 * shelves are grids of cards.
 *
 * Everything comes from `convex/publicCollection.ts`, which answers only what
 * is public (cards, condition, grade) and the same not-found for a private
 * page, a mistyped link and a missing one; this page shows one not-found
 * screen for all of them. Dark in both modes, like the profile page it hangs
 * off (`../page.tsx`). Every page carries `noindex` for now: a link is
 * shared by hand, not found by a search engine.
 */

const PAGE_SIZE = 60;
/** The card popped out of the binder into its top loader, by its opaque key. */
const CARD_PARAM = "card";
/** The binder page the visitor is on, from 1. */
const PAGE_PARAM = "page";

/**
 * A visitor's spread: the owner's breakpoint, except a touch tablet held
 * upright, where a spread's pockets come out small and one page reads better.
 */
const VISITOR_SPREAD = "(min-width: 1024px), (min-width: 768px) and (orientation: landscape), (min-width: 768px) and (hover: hover)";
/** A touch screen, where a swipe turns the page and there are no PageUp keys to name. */
const SWIPES = "(hover: none)";

/** On the history entry a press pushed, so closing steps Back off it instead of leaving a second entry. */
interface CardHistoryState {
  card: true;
}

type PublicBinder = NonNullable<FunctionReturnType<typeof api.publicCollection.binder>>;
type PublicWant = FunctionReturnType<typeof api.publicCollection.wantList>["page"][number];
type Listed = PublicCopy | PublicWant;

/** `<meta name="robots" content="noindex">` while the page is open. */
function useNoIndex() {
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex";
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
}

function useUsername(): string {
  const { username = "" } = useParams<{ username: string }>();
  return USERNAME_RE.test(username) ? username : "";
}

/**
 * The page frame. `title` names the tab: the page's own title and the
 * collector, `null` for the not-found screen, left out while loading.
 */
function Shell({
  username,
  title,
  wide = false,
  children,
}: {
  username: string;
  title?: string | null;
  /** A little more room, so an open binder reaches its full size. */
  wide?: boolean;
  children: ReactNode;
}) {
  useNoIndex();
  const profile = useQuery(
    api.publicProfile.getPublicProfileByUsername,
    username ? { username } : "skip",
  );
  const name = profile?.displayName ?? profile?.username ?? username;
  const column = wide ? "max-w-6xl" : "max-w-5xl";
  useDocumentTitle(
    title === null ? "Nothing to see here · NeonBinder" : title ? `${title} · ${name || "NeonBinder"}` : "NeonBinder",
  );
  return (
    <div data-theme="dark" className="min-h-screen bg-surface text-ink">
      <header className="border-b border-rule bg-surface px-4 py-3">
        <div className={`mx-auto flex ${column} items-center justify-between gap-3`}>
          {username && profile === undefined ? (
            // Holds the slot, so the collector's name doesn't arrive by replacing ours.
            <span aria-hidden="true" data-name-slot className="flex min-h-10 items-center gap-2">
              <span className="h-8 w-8 rounded-full bg-raised" />
              <span className="h-4 w-24 rounded bg-raised" />
            </span>
          ) : profile ? (
            <Link to={`/u/${profile.username}`} className="flex min-h-10 items-center gap-2 font-semibold focus-outline">
              {profile.photoUrl ? (
                <img src={profile.photoUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
              ) : (
                <span
                  aria-hidden="true"
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-raised text-sm font-bold"
                >
                  {name.charAt(0).toUpperCase()}
                </span>
              )}
              {name}
            </Link>
          ) : (
            <Link to="/" className="inline-flex min-h-10 items-center font-semibold focus-outline">
              NeonBinder
            </Link>
          )}
          <Link
            to="/sign-up"
            className="inline-flex min-h-10 items-center rounded-md px-3 text-sm font-semibold text-neon-green-text underline underline-offset-4 focus-outline"
          >
            Sign up for NeonBinder
          </Link>
        </div>
      </header>
      <main className={`mx-auto ${column} px-4 py-6`}>{children}</main>
    </div>
  );
}

/** `progress` is for the eye: announcing every page of a long read would drown a screen reader. */
function Loading({ progress }: { progress?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16">
      <div role="status">
        <span className="sr-only">Loading…</span>
        <div aria-hidden="true" className="h-8 w-8 animate-spin rounded-full border-2 border-ink border-t-transparent" />
      </div>
      {progress && <p className="text-sm tabular-nums text-ink-2">{progress}</p>}
    </div>
  );
}

/** How far the read has got. `lines` is what the reader counts: a line can hold several copies. */
function sleevingLine(done: number, count: { lines: number } | null): string {
  if (done === 0) return "Sleeving the cards…";
  const total = count ? ` of ${Math.max(count.lines, done).toLocaleString("en-US")}` : "";
  return `Sleeving ${done.toLocaleString("en-US")}${total} cards…`;
}

/** The one not-found screen: worded the same whether the page is private, mistyped or missing. */
export function PublicNotFound() {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <h1 className="text-2xl font-bold">Nothing to see here</h1>
      <p className="max-w-sm text-ink-2">
        This page is private, or the link isn't quite right. Ask whoever shared it for a fresh link.
      </p>
      <Link to="/" className="text-neon-blue-text underline underline-offset-4 focus-outline">
        Go to NeonBinder
      </Link>
    </div>
  );
}

/** One card and what the visitor may know about this copy. */
function CardTile({ item, tags = true }: { item: Listed; tags?: boolean }) {
  const copy = "quantity" in item ? item : null;
  // NEO-361: a collector's own card (one NB doesn't have) shows too, marked unlisted.
  const card = item.card
    ? hydrateCatalogCard(item.card)
    : copy?.unlisted
      ? hydratePublicOwnCard(copy.key, copy.unlisted)
      : null;
  const lines = copy ? [grade(copy) ?? copy.condition, copy.quantity > 1 ? `×${copy.quantity}` : null].filter(Boolean) : [];
  // NEO-377: the collector's own photo of this copy, when they took one, in
  // place of the drawn card. Full size opens in a new tab.
  const photo = copy?.photos?.front ?? copy?.photos?.back;
  const label = card ? cardLabel(card) : "this card";
  return (
    <li className="flex flex-col gap-1.5">
      {photo ? (
        <a
          href={photo.imageUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="block rounded-md focus-outline"
          aria-label={`Photo of ${label}, full size (opens a new tab)`}
        >
          <img
            src={photo.thumbUrl}
            alt=""
            loading="lazy"
            decoding="async"
            className="aspect-[5/7] w-full rounded-md border border-rule bg-sheet object-contain"
          />
        </a>
      ) : card ? (
        <CardFace model={card} size="fill" />
      ) : (
        <div className="aspect-[5/7] rounded-md border border-dashed border-rule" aria-hidden="true" />
      )}
      <p className="text-xs leading-snug text-ink-2">
        <span className="block font-medium text-ink">{card ? cardLabel(card) : "No longer in the catalog"}</span>
        {card?.own && <span className="block text-ink-3">Not in the NeonBinder catalog</span>}
        {lines.length > 0 && <span className="block">{lines.join(" · ")}</span>}
        {copy?.photos?.front && copy.photos.back && (
          <a
            href={copy.photos.back.imageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-fit rounded-sm text-neon-blue-text underline focus-outline"
          >
            See the back<span className="sr-only"> of {label} (opens a new tab)</span>
          </a>
        )}
        {/* NEO-367: the catalog card's Notes are NB's facts about the card, public
            by Jason's call. Never the copy's own notes, which this page never gets. */}
        {card?.notes && (
          <span className="mt-0.5 block line-clamp-3 whitespace-pre-line text-ink-3 [overflow-wrap:anywhere]">
            {card.notes}
          </span>
        )}
      </p>
      {copy && tags && (copy.upForTrade || copy.forSale) && (
        <p className="flex flex-wrap gap-1 text-xs font-semibold">
          {copy.upForTrade && <span className="rounded bg-raised px-1.5 py-0.5 text-neon-blue-text">Trade</span>}
          {copy.forSale && <span className="rounded bg-raised px-1.5 py-0.5 text-neon-green-text">Also for sale</span>}
        </p>
      )}
    </li>
  );
}

/** Stays focusable while the next page loads (aria-disabled), so focus is not dropped. */
function MoreButton({ status, loadMore }: { status: string; loadMore: (n: number) => void }) {
  if (status !== "CanLoadMore" && status !== "LoadingMore") return null;
  const loading = status === "LoadingMore";
  return (
    <div className="mt-6 flex flex-col items-center gap-2">
      <NeonButton
        type="button"
        variant="secondary"
        outline
        aria-disabled={loading}
        onClick={() => !loading && loadMore(PAGE_SIZE)}
        className="min-h-10"
      >
        Show more
      </NeonButton>
      <p role="status" className="text-sm text-ink-3">
        {loading ? "Loading more cards…" : ""}
      </p>
    </div>
  );
}

function countLine(count: { copies: number; lines: number } | null, noun: string): string | null {
  if (!count) return null;
  return `${count.copies.toLocaleString("en-US")} ${noun}${count.copies === 1 ? "" : "s"}`;
}

// ───────────────────────────────────────────────────────────────────────────
// A binder
// ───────────────────────────────────────────────────────────────────────────

/** The card a public copy is of. Null by type only: the server leaves out a copy whose card has gone. */
function publicCard(copy: PublicCopy): Card | null {
  return copy.card ? hydrateCatalogCard(copy.card) : copy.unlisted ? hydratePublicOwnCard(copy.key, copy.unlisted) : null;
}

/** A public copy in the shape the binder draws. The rest of a `Copy` is private and never reaches this page. */
function asCopy(item: PublicCopy, card: Card): Copy {
  return {
    id: item.key,
    cardId: card.id,
    quantity: item.quantity,
    slot: item.slot,
    graded: item.grading,
    upForTrade: item.upForTrade === true,
    homeKind: "binder",
  } as Copy;
}

/** A copy's pocket; null when there is no card to draw, and the binder skips it. */
function pocketOf(item: PublicCopy): PocketModel | null {
  const card = publicCard(item);
  if (!card) return null;
  return {
    content: { kind: "have", card, copies: [asCopy(item, card)] },
    ...(item.photos ? { photos: item.photos } : {}),
  };
}

const EMPTY_POCKET: PocketModel = { content: { kind: "empty" } };

/**
 * Pockets as the owner placed them, every page numbered as it is in the
 * binder. Every card in a binder sits in a pocket; one stored before that rule
 * (waiting on the backfill) shows after the last filled pocket, where the
 * backfill will put it. Nothing is ever dropped: a copy whose pocket is already
 * taken goes there too.
 */
function storedPages(results: readonly PublicCopy[]): PageModel[] {
  const bySlot = new Map<number, PocketModel>();
  const unplaced: PocketModel[] = [];
  let next = 0;
  for (const copy of results) {
    const pocket = pocketOf(copy);
    if (!pocket) continue;
    if (copy.slot === undefined || copy.slot < 0 || bySlot.has(copy.slot)) {
      unplaced.push(pocket);
      continue;
    }
    bySlot.set(copy.slot, pocket);
    if (copy.slot + 1 > next) next = copy.slot + 1;
  }
  for (const pocket of unplaced) bySlot.set(next++, pocket);
  const pages: PageModel[] = [];
  for (let p = 0; p * POCKETS_PER_PAGE < next; p++) {
    const pockets: PocketModel[] = [];
    for (let s = 0; s < POCKETS_PER_PAGE; s++) {
      pockets.push(bySlot.get(p * POCKETS_PER_PAGE + s) ?? EMPTY_POCKET);
    }
    pages.push({ section: null, pockets });
  }
  return pages;
}

/**
 * NEO-362 — a binder its owner keeps sorted: drawn in the same order the owner
 * sees (`sortedPages`). With empty slots shared, the cards it still needs sit
 * in their sleeves.
 */
function sortedPublicPages(
  results: readonly PublicCopy[],
  sort: "checklist" | "player" | "team",
  emptySlots: boolean,
  needs: readonly Card[],
): PageModel[] {
  const cards = new Map<string, Card>();
  const copies: Copy[] = [];
  const photos = new Map<string, CopyPhotos>();
  for (const item of results) {
    const card = publicCard(item);
    if (!card) continue;
    cards.set(card.id, card);
    copies.push(asCopy(item, card));
    if (item.photos) photos.set(item.key, item.photos);
  }
  const pages = sortedPages({ copies, cards, sort, emptySlots, needs });
  return pages.map((page) => ({
    ...page,
    pockets: page.pockets.map((pocket) => {
      const shot = pocket.content.kind === "have" ? photos.get(pocket.content.copies[0].id) : undefined;
      return shot ? { ...pocket, photos: shot } : pocket;
    }),
  }));
}

/** The first page a step shows. */
function firstPageOfStep(step: number, wide: boolean): number {
  return wide && step > 0 ? step * 2 - 1 : step;
}

/** The photos a step of the binder shows, front first, as the pocket picks them. */
function thumbsOfStep(pages: readonly PageModel[], step: number, wide: boolean): string[] {
  if (step < 0) return [];
  const first = firstPageOfStep(step, wide);
  const onStep = wide && step > 0 ? pages.slice(first, first + 2) : pages.slice(first, first + 1);
  return onStep.flatMap((page) =>
    page.pockets.flatMap(({ photos }) => {
      const url = (photos?.front ?? photos?.back)?.thumbUrl;
      return url ? [url] : [];
    }),
  );
}

/** Focus without a jump, then just enough scroll to see it. A scroll-behavior from CSS can't make it glide. */
function focusInView(target: HTMLElement) {
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "nearest", behavior: "instant" });
}

/**
 * `/u/:username/binders/:path`: the binder itself, read-only. Its place is in
 * the URL: `page` is the page you're on (replaced as you turn, so Back leaves
 * the binder rather than walking its pages; a refresh or a pasted link opens
 * there). `card` is the card popped out into its top loader (pushed, so Back
 * puts it down rather than leaving the page).
 */
export function PublicBinderPage() {
  const username = useUsername();
  const { path = "" } = useParams<{ path: string }>();
  const header = useQuery(api.publicCollection.binder, username ? { username, path } : "skip");
  if (!username) {
    return (
      <Shell username="" title={null}>
        <PublicNotFound />
      </Shell>
    );
  }
  if (header === undefined) {
    return (
      <Shell username={username}>
        <Loading progress={sleevingLine(0, null)} />
      </Shell>
    );
  }
  if (header === null) {
    return (
      <Shell username={username} title={null}>
        <PublicNotFound />
      </Shell>
    );
  }
  return (
    // Dark everywhere, portals included (`ForceDark` on the route, src/main.tsx):
    // the binder's light-mode rules read `<html data-theme>`.
    <Shell username={username} title={header.name} wide>
      <OpenBinder username={username} path={path} header={header} />
    </Shell>
  );
}

function OpenBinder({ username, path, header }: { username: string; path: string; header: PublicBinder }) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.publicCollection.binderCopies,
    { username, path },
    { initialNumItems: PAGE_SIZE },
  );
  // Real page numbers need every card: keep reading until they are all in.
  useEffect(() => {
    if (status === "CanLoadMore") loadMore(PAGE_SIZE);
  }, [status, loadMore]);
  const layout = header.layout;
  const sort = layout?.sort;
  const sharesSlots = !!sort && !!layout?.emptySlots;
  const needs = useQuery(api.publicCollection.binderNeeds, sharesSlots ? { username, path } : "skip");
  const ready = status === "Exhausted" && (!sharesSlots || needs !== undefined);
  // A live update can move the reader off Exhausted (the owner adds a card, a
  // page splits). The last full read stays on screen until the next one is in,
  // so a page the visitor is on, and a card they have open, never drop to Loading.
  const latest = useMemo(() => (ready ? { copies: results, needs: needs?.needs ?? [] } : null), [ready, results, needs]);
  const [lastRead, setLastRead] = useState(latest);
  if (latest && latest !== lastRead) setLastRead(latest);
  const read = latest ?? lastRead;

  const pages = useMemo(() => {
    if (!read) return [];
    if (!sort) return storedPages(read.copies);
    const needCards = read.needs.map((n) => hydrateCatalogCard(n.card)).filter((c): c is Card => c !== null);
    return sortedPublicPages(read.copies, sort, sharesSlots, needCards);
  }, [read, sort, sharesSlots]);
  // Each copy and the page it sits on, for the card in the URL.
  const copyPlaces = useMemo(() => {
    const places = new Map<string, number>();
    pages.forEach((page, p) => {
      for (const { content } of page.pockets) {
        if (content.kind === "have") places.set(content.copies[0].id, p);
      }
    });
    return places;
  }, [pages]);

  const wide = useMediaQuery(VISITOR_SPREAD);
  const swipes = useMediaQuery(SWIPES);
  const reducedMotion = useReducedMotion();
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const openKey = params.get(CARD_PARAM);
  const opened = useMemo(() => {
    if (!openKey || !copyPlaces.has(openKey)) return null;
    const copy = read?.copies.find((c) => c.key === openKey);
    const card = copy ? publicCard(copy) : null;
    return copy && card ? { copy, card } : null;
  }, [openKey, copyPlaces, read]);

  // The open card's own page, whatever else the link asks for: its pocket has
  // to be there to take focus back. Else the page in the URL, else the first.
  const asked = Number(params.get(PAGE_PARAM));
  const onPage = (openKey ? copyPlaces.get(openKey) : undefined) ?? (Number.isInteger(asked) && asked >= 1 ? asked - 1 : 0);
  const steps = stepCount(pages.length, wide);
  const at = Math.min(stepOfPage(onPage, wide), steps - 1);
  const turnTo = (step: number) => {
    const first = firstPageOfStep(Math.max(0, Math.min(step, steps - 1)), wide);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (first === 0) next.delete(PAGE_PARAM);
        else next.set(PAGE_PARAM, String(first + 1));
        return next;
      },
      { replace: true },
    );
  };
  // The steps either side, so a page turn lands on cards already in hand.
  useEffect(() => {
    for (const url of [...thumbsOfStep(pages, at - 1, wide), ...thumbsOfStep(pages, at + 1, wide)]) new Image().src = url;
  }, [pages, at, wide]);
  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // PageUp / PageDown from a pocket: the new page may have no pocket there, and
  // the button holding focus goes with the old one.
  const turnedFromInside = useRef(false);
  usePageTurnKeys(!!read && !opened, rootRef, (delta) => {
    const to = at + delta;
    turnedFromInside.current = to >= 0 && to < steps && !!rootRef.current?.contains(document.activeElement);
    turnTo(to);
  });
  useEffect(() => {
    if (!turnedFromInside.current) return;
    turnedFromInside.current = false;
    if (document.activeElement && document.activeElement !== document.body) return;
    const root = rootRef.current;
    const target =
      root?.querySelector<HTMLElement>("button.p2-sleeve") ??
      root?.querySelector<HTMLElement>('button[aria-keyshortcuts]:not([aria-disabled="true"])');
    if (target) focusInView(target);
  }, [at]);

  const openCard = (copies: Copy[]) => {
    const next = new URLSearchParams(params);
    next.set(CARD_PARAM, copies[0].id);
    void navigate({ search: next.toString() }, { state: { card: true } satisfies CardHistoryState });
  };
  const pushed = (location.state as CardHistoryState | null)?.card === true;
  const closeCard = () => {
    if (pushed) {
      void navigate(-1);
      return;
    }
    // A shared link or a refresh: nothing to step back to. Stay on the card's page.
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(CARD_PARAM);
        const first = firstPageOfStep(at, wide);
        if (first === 0) next.delete(PAGE_PARAM);
        else next.set(PAGE_PARAM, String(first + 1));
        return next;
      },
      { replace: true },
    );
  };
  // A card that isn't here (a stale link, or the owner just took it out): the
  // URL stops asking for it.
  useEffect(() => {
    if (!latest || !openKey || opened) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(CARD_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [latest, openKey, opened, setParams]);
  // However the card was put down (Escape, Back), focus returns to its pocket.
  // `Overlay` does this when it was opened by a press; a shared link has no
  // opener. With the pocket gone, the first card on the page, else the heading.
  const lastOpen = useRef<string | null>(null);
  useEffect(() => {
    const key = opened?.copy.key ?? null;
    const closed = lastOpen.current;
    lastOpen.current = key;
    if (key || !closed) return;
    const root = rootRef.current;
    const target =
      root?.querySelector<HTMLElement>(`[data-copy-key="${CSS.escape(closed)}"]`) ??
      root?.querySelector<HTMLElement>("button.p2-sleeve") ??
      headingRef.current;
    if (target) focusInView(target);
  }, [opened]);

  const count = countLine(header.count, "card");
  const hasBinder = !!read && pages.length > 0;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold focus:outline-none">
          {header.name}
        </h1>
        {hasBinder && (
          <p aria-live="polite" className="text-sm tabular-nums text-ink-2">
            {whereLabel(pages.length, wide, at)}
          </p>
        )}
      </div>
      {/* On a wide screen the inside cover says these, once it's there; a phone has no cover. */}
      {(!wide || !hasBinder) && (
        <div className="mb-4 space-y-1">
          {header.description && <p className="text-ink-2">{header.description}</p>}
          {/* One line on a short screen: every line here pushes the binder down. */}
          <p className="text-sm text-ink-3">
            {count && <span className="block [@media(max-height:480px)]:mr-3 [@media(max-height:480px)]:inline">{count}</span>}
            {hasBinder && (
              <span className="mt-1 block [@media(max-height:480px)]:mt-0 [@media(max-height:480px)]:inline">
                Tap a card to pop it out.{swipes && " Swipe to turn."}
              </span>
            )}
          </p>
        </div>
      )}
      {!read ? (
        <Loading progress={sleevingLine(results.length, header.count)} />
      ) : !hasBinder ? (
        <p className="mt-6 text-ink-2">This binder is empty for now.</p>
      ) : (
        <div ref={rootRef} className="nb-visitor-desk">
          <BinderDesk
            readOnly
            pages={pages}
            wide={wide}
            at={at}
            onTurn={turnTo}
            vinyl={header.label?.background ?? PLAIN_LABEL.background}
            cover={<PublicCover header={header} count={count} swipes={swipes} />}
            reducedMotion={reducedMotion}
            name={header.name}
            onOpenCopies={openCard}
          />
        </div>
      )}
      {!sort && layout?.emptySlots && <StillNeeds username={username} path={path} />}
      {opened && <PublicCardOverlay key={opened.copy.key} copy={opened.copy} card={opened.card} onClose={closeCard} />}
    </>
  );
}

/** The inside front cover, for a visitor: what the binder is, and how to use it. No owner's controls. */
function PublicCover({ header, count, swipes }: { header: PublicBinder; count: string | null; swipes: boolean }) {
  // No height of its own (`h-0 min-h-full`), so a long description scrolls here
  // instead of stretching the binder past its pages. A tab stop only when it does.
  const [coverRef, scrolls] = useOverflows<HTMLDivElement>();
  return (
    <div
      ref={coverRef}
      role="group"
      aria-label={scrolls ? "About this binder" : undefined}
      tabIndex={scrolls ? 0 : undefined}
      className="flex h-0 min-h-full flex-col gap-3 overflow-y-auto text-sm text-ink-2 focus-outline"
    >
      {/* The page's h1 already says it, for a screen reader. */}
      <p aria-hidden="true" className="neon-header nb-glow-blue !text-[26px] leading-tight text-ink [overflow-wrap:anywhere]">
        {header.name}
      </p>
      {count && <p className="text-ink-3">{count}</p>}
      {header.description && <p className="whitespace-pre-line [overflow-wrap:anywhere]">{header.description}</p>}
      <p className="mt-auto text-xs text-ink-3">
        {swipes ? "Swipe to turn the pages. Tap a card to pop it out." : "PageUp and PageDown turn the pages. Pick a card to pop it out."}
      </p>
    </div>
  );
}

/** NEO-362 — an empty slot the owner shares: a card this binder still needs. */
function NeedTile({ card }: { card: Card }) {
  return (
    <li className="flex flex-col gap-1.5">
      <div className="opacity-40">
        <CardFace model={card} size="fill" state="need" />
      </div>
      <p className="text-xs leading-snug text-ink-2">
        <span className="block font-medium text-ink-3">{cardLabel(card)}</span>
        <span className="block font-semibold text-neon-pink-text">Still needs</span>
      </p>
    </li>
  );
}

/** NEO-362 — an unsorted binder's shared empty slots: listed after its pages. */
function StillNeeds({ username, path }: { username: string; path: string }) {
  const needs = useQuery(api.publicCollection.binderNeeds, { username, path });
  if (!needs || needs.needs.length === 0) return null;
  const cards = needs.needs.map((n) => hydrateCatalogCard(n.card)).filter((c): c is Card => c !== null);
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-lg font-bold">Still needs</h2>
      <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {cards.map((card) => (
          <NeedTile key={card.id} card={card} />
        ))}
      </ul>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// The shelves
// ───────────────────────────────────────────────────────────────────────────

type Shelf = "want" | "trade" | "forSale";

const SHELVES: Record<Shelf, { title: string; empty: string; noun: string }> = {
  want: { title: "Want List", empty: "Nothing on the Want List right now.", noun: "card" },
  trade: { title: "Up for Trade", empty: "Nothing up for trade right now.", noun: "card" },
  forSale: { title: "For sale", empty: "Nothing for sale right now.", noun: "card" },
};

function ShelfList({ shelf, username }: { shelf: Shelf; username: string }) {
  const query =
    shelf === "want"
      ? api.publicCollection.wantList
      : shelf === "trade"
        ? api.publicCollection.trade
        : api.publicCollection.forSale;
  const { results, status, loadMore } = usePaginatedQuery(query, { username }, { initialNumItems: PAGE_SIZE });
  if (status === "LoadingFirstPage") return <Loading />;
  if (results.length === 0) return <p className="mt-6 text-ink-2">{SHELVES[shelf].empty}</p>;
  return (
    <>
      <ul className="mt-6 grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {(results as Listed[]).map((item) => (
          <CardTile key={item.key} item={item} tags={shelf === "trade"} />
        ))}
      </ul>
      <MoreButton status={status} loadMore={loadMore} />
    </>
  );
}

/** `/u/:username/want-list`, `/up-for-trade` and `/for-sale`. */
export function PublicShelfPage({ shelf }: { shelf: Shelf }) {
  const username = useUsername();
  const header = useQuery(api.publicCollection.shelf, username ? { username, shelf } : "skip");
  if (!username || header === null) {
    return (
      <Shell username={username} title={null}>
        <PublicNotFound />
      </Shell>
    );
  }
  if (header === undefined) {
    return (
      <Shell username={username}>
        <Loading />
      </Shell>
    );
  }
  const { title, noun } = SHELVES[shelf];
  const line = countLine(header.count, noun);
  return (
    <Shell username={username} title={title}>
      <h1 className="text-2xl font-bold">{title}</h1>
      {line && <p className="mt-1 text-sm text-ink-3">{line}</p>}
      <ShelfList shelf={shelf} username={username} />
    </Shell>
  );
}

export function PublicWantListPage() {
  return <PublicShelfPage shelf="want" />;
}
export function PublicTradePage() {
  return <PublicShelfPage shelf="trade" />;
}
export function PublicForSalePage() {
  return <PublicShelfPage shelf="forSale" />;
}
