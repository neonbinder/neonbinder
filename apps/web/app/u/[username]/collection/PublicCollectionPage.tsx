import { useEffect, type ReactNode } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { Link, useParams } from "react-router";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import CardFace from "@/app/collection/prototypes/_shared/CardFace";
import { hydrateCatalogCard } from "@/app/collection/final/data/convexStore";
import { cardLabel } from "@/app/collection/final/data/labels";
import NeonButton from "@/components/modules/NeonButton";
import { USERNAME_RE } from "@/lib/collection/share-links";

/**
 * NEO-360 — the public share pages: a binder, the Want List, Up for Trade and
 * the for-sale stock, read-only, for a visitor who never signs in.
 *
 * Everything comes from `convex/publicCollection.ts`, which answers only what
 * is public (cards, condition, grade) and the same not-found for a private
 * page, a mistyped link and a missing one; this page shows one not-found
 * screen for all of them. Dark in both modes, like the profile page it hangs
 * off (`../page.tsx`). Every page carries `noindex` for now: a link is
 * shared by hand, not found by a search engine.
 */

const PAGE_SIZE = 60;
const POCKETS = 9;

type PublicCopy = FunctionReturnType<typeof api.publicCollection.binderCopies>["page"][number];
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

function Shell({ username, children }: { username: string; children: ReactNode }) {
  useNoIndex();
  const profile = useQuery(
    api.publicProfile.getPublicProfileByUsername,
    username ? { username } : "skip",
  );
  const name = profile?.displayName ?? profile?.username ?? username;
  return (
    <div data-theme="dark" className="min-h-screen bg-surface text-ink">
      <header className="border-b border-rule bg-surface px-4 py-3">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
          {profile ? (
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
            <Link to="/" className="min-h-10 font-semibold focus-outline">
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
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
    </div>
  );
}

function Loading() {
  return (
    <div role="status" className="flex justify-center py-16">
      <span className="sr-only">Loading…</span>
      <div aria-hidden="true" className="h-8 w-8 animate-spin rounded-full border-2 border-ink border-t-transparent" />
    </div>
  );
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

function grade(copy: PublicCopy): string | null {
  return copy.grading ? `${copy.grading.grader} ${copy.grading.grade}` : null;
}

/** One card and what the visitor may know about this copy. */
function CardTile({ item, tags = true }: { item: Listed; tags?: boolean }) {
  const card = hydrateCatalogCard(item.card);
  const copy = "quantity" in item ? item : null;
  const lines = copy ? [grade(copy) ?? copy.condition, copy.quantity > 1 ? `×${copy.quantity}` : null].filter(Boolean) : [];
  return (
    <li className="flex flex-col gap-1.5">
      {card ? (
        <CardFace model={card} size="fill" />
      ) : (
        <div className="aspect-[5/7] rounded-md border border-dashed border-rule" aria-label="A card no longer in the catalog" />
      )}
      <p className="text-xs leading-snug text-ink-2">
        <span className="block font-medium text-ink">{card ? cardLabel(card) : "No longer in the catalog"}</span>
        {lines.length > 0 && <span className="block">{lines.join(" · ")}</span>}
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

function MoreButton({ status, loadMore }: { status: string; loadMore: (n: number) => void }) {
  if (status !== "CanLoadMore" && status !== "LoadingMore") return null;
  return (
    <div className="mt-6 flex justify-center">
      <NeonButton
        type="button"
        variant="secondary"
        outline
        disabled={status === "LoadingMore"}
        onClick={() => loadMore(PAGE_SIZE)}
        className="min-h-10"
      >
        {status === "LoadingMore" ? "Loading…" : "Show more"}
      </NeonButton>
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

/**
 * `/u/:username/binders/:path`: nine pockets a page. Every card in a binder
 * sits in a pocket; one stored before that rule (waiting on the backfill)
 * shows after the last filled pocket, where the backfill will put it.
 */
export function PublicBinderPage() {
  const username = useUsername();
  const { path = "" } = useParams<{ path: string }>();
  const args = username ? { username, path } : "skip";
  const header = useQuery(api.publicCollection.binder, args);
  const { results, status, loadMore } = usePaginatedQuery(api.publicCollection.binderCopies, args, {
    initialNumItems: PAGE_SIZE,
  });
  if (!username) {
    return (
      <Shell username="">
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
  if (header === null) {
    return (
      <Shell username={username}>
        <PublicNotFound />
      </Shell>
    );
  }
  const pages = new Map<number, Array<PublicCopy | null>>();
  const put = (copy: PublicCopy, slot: number) => {
    const page = Math.floor(slot / POCKETS);
    const pockets = pages.get(page) ?? Array.from({ length: POCKETS }, () => null);
    pockets[slot % POCKETS] = copy;
    pages.set(page, pockets);
  };
  const taken = new Set<number>();
  for (const copy of results) {
    if (copy.slot === undefined) continue;
    put(copy, copy.slot);
    taken.add(copy.slot);
  }
  // After the last filled pocket, where the backfill will put it.
  let next = Math.max(-1, ...taken) + 1;
  for (const copy of results) {
    if (copy.slot === undefined) put(copy, next++);
  }
  const pageNumbers = [...pages.keys()].sort((a, b) => a - b);
  const spine = header.label;
  return (
    <Shell username={username}>
      <div
        className="rounded-xl border-l-8 bg-raised px-4 py-3"
        style={{ borderLeftColor: spine?.background ?? "var(--color-neon-green)" }}
      >
        <h1 className="text-2xl font-bold">{header.name}</h1>
        {header.description && <p className="mt-1 text-ink-2">{header.description}</p>}
        {countLine(header.count, "card") && <p className="mt-1 text-sm text-ink-3">{countLine(header.count, "card")}</p>}
      </div>
      {status === "LoadingFirstPage" ? (
        <Loading />
      ) : results.length === 0 ? (
        <p className="mt-6 text-ink-2">This binder is empty for now.</p>
      ) : (
        <>
          {pageNumbers.map((page) => (
            <section key={page} aria-label={`Page ${page + 1}`} className="mt-6">
              <h2 className="mb-2 text-sm font-semibold text-ink-3">Page {page + 1}</h2>
              <ol className="grid max-w-xl grid-cols-3 gap-3 rounded-xl border border-rule p-3">
                {pages.get(page)!.map((copy, i) =>
                  copy ? (
                    <CardTile key={copy.key} item={copy} />
                  ) : (
                    <li
                      key={`empty-${i}`}
                      aria-label="Empty pocket"
                      className="aspect-[5/7] rounded-md border border-dashed border-rule"
                    />
                  ),
                )}
              </ol>
            </section>
          ))}
          <MoreButton status={status} loadMore={loadMore} />
        </>
      )}
    </Shell>
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
      <Shell username={username}>
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
    <Shell username={username}>
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
