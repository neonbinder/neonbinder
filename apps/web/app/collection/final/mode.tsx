import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type MutableRefObject,
  type Ref,
  type ReactNode,
} from "react";
import { Link, useLocation, useNavigate, useSearchParams, type LinkProps, type To } from "react-router";
import { ScopeProvider, useScope } from "./data/store";
import { isHome, type Container, type Scope, type Side } from "./data/types";

/**
 * NEO-350 / NEO-358 — where the collection page is running, and what that
 * changes. Which STORE it runs on is a separate question (`./data/store`):
 * signed-in `/collection` is the real collection on the Convex store, the
 * public demo is fixture data on the demo store.
 *
 * - `"app"`: `/collection`, inside the signed-in binder shell. Links go to
 *   the real tools; "Print label" opens the Print Shop in a new tab, so the
 *   label being edited here survives.
 * - `"public"`: the no-login demo on the `/binder-tracking` marketing page.
 *   Nothing it does may need an account: a link to a signed-in tool goes to
 *   the public tour page for it instead (`PUBLIC_DESTINATIONS`), and the
 *   demo bar adds Sign up and Back to the tour.
 *
 * In both, where you are rides on the page URL, so Back steps back through
 * the views, a refresh stays put and a deep link opens straight there. The
 * params, all ids and never display names:
 *
 * - The side (NEO-364, `useCollectionSide`): `/collection` is the
 *   collection (binders), `/inventory` the inventory (boxes). The public demo
 *   runs both on one page and says which with `side=inventory`, written only
 *   for the inventory, so the demo's entry URL stays exactly `?demo=on`.
 *   Switching sides is a view change like any other (`SideLink`), so Back
 *   steps back across it and the demo counts it in `demoDepth`.
 * - `tab`: on the collection `cards`, `binders` or `checklists`; on the
 *   inventory `cards` (the Inventory list), `boxes` (My Boxes) or
 *   `checklists`. A tab, or an open container, of the other side redirects
 *   there in place of the entry (`useGoToSide` with `replace`).
 * - My Cards: `set` (a set wall), or `view=needs` with an optional `for`.
 * - My Binders: `b` (an open binder), `set` (a set to browse) or `all=1`.
 * - My Boxes: `b` (an open box, Unsorted, or the Up for Trade pile drawn as
 *   a box).
 * - Checklists: the drill (`checklistParams.ts`): above a set, `sport`,
 *   `year` and `brand`; from a set down, `set` (the rest follows from it),
 *   `type` (Base, Inserts or Parallels) and `variant` (an insert or parallel
 *   name). Also `q`, the search box, and `card`, a row a search jumped to.
 *
 * Every view change pushes a history entry (`useCollectionParams`,
 * `ParamLink`), each Checklists drill step included. In-view tweaks replace
 * the current entry instead (`useReplaceParams`): the search box's `q` as
 * you type, a jump that only rings another row of the checklist on screen,
 * the binder-scope picker. Page turns and filters stay in local state and
 * touch no URL. The card drawer opens ON a view: `detail=<cardId>` (and
 * `mode=add`), pushed (`usePushParams`) so Back closes it, its ↑ ↓ replacing
 * the card in place (`./drawerParams`). Public mode also keeps its own params on
 * every view URL (`keepParams`, the marketing page's `demo=on`) and counts
 * how deep into the demo each entry is (`DemoHistoryState`), so "Back to the
 * tour" can return to the entry the visitor came from in one step.
 *
 * The Binder picker's scope rides there too, as `scope=<containerId>` (left
 * off for All), and the URL is its one source: the page reads it
 * (`scopeFromParams`, against `useContainers()`) and hands it down in
 * `ViewScopeProvider`, where both stores read it (`useScope`). Picking a
 * scope replaces the current entry (`useSetScope`); every view change carries
 * the scope of the moment on, so Back restores the scope each view had. An
 * unknown or deleted id, or one that is not a binder that holds copies (the
 * Want List, the Up for Trade pile, a smart binder, or a box, which is
 * Inventory's), reads as All, and an unknown id anywhere else
 * falls back the same quiet way: to the deepest level that still makes sense.
 *
 * Public mode is always the demo store and never reaches Convex or Clerk.
 * On the inventory side the page never narrows: the scope is always All.
 */

export type CollectionMode = "app" | "public";

/** The demo's side param: `side=inventory`, absent on the collection side. */
export const SIDE_PARAM = "side";
/** Where each side lives in the signed-in app. */
export const SIDE_PATHS: Record<Side, string> = {
  collection: "/collection",
  inventory: "/inventory",
};

type ParamsInit = URLSearchParams | Record<string, string>;
type SetParams = (next: ParamsInit) => void;

/**
 * The history state on a public-demo entry. The marketing page sets
 * `demoFrom: "tour"` on the entry that opens the demo; every view the demo
 * pushes after it carries that on and counts one deeper.
 */
export interface DemoHistoryState {
  demoFrom?: string;
  /** Views pushed since the demo opened: 0 on the entry that opened it. */
  demoDepth?: number;
}

/** Where a signed-in destination goes from the public demo, and why. */
export const PUBLIC_DESTINATIONS = {
  /**
   * The Inventory long box, for a store with no inventory side: `/inventory`
   * needs an account. (The demo has its own inventory side, NEO-364.)
   */
  inventory: "/managing-inventory",
  /** "Print label" / "Print this label": `/print/spine-label` needs an account. */
  printShop: "/print-shop",
  /** The demo's sign-up call to action. */
  signUp: "/sign-up",
} as const;

interface CollectionModeValue {
  mode: CollectionMode;
  /** Where the Inventory long box leads when the store has no Inventory tab. */
  inventoryHref: string;
  /** Where a "Print label" link leads, given the Print Shop link the app uses. */
  printLabelHref: (appHref: string) => string;
  /**
   * The app's "Print label" opens the Print Shop in a new tab, so a label
   * mid-edit here is still here. The public tour page opens in place.
   */
  printLabelInNewTab: boolean;
  /**
   * Params every view URL keeps: public mode's `demo=on`, plus `side=inventory`
   * on the demo's inventory side. Empty in the app.
   */
  keepParams: Record<string, string>;
  /** The page's own kept params, without the side: what a side switch starts from. */
  baseParams: Record<string, string>;
  /** The app page's side (`FinalCollectionPage`'s `surface`); unset: by route. */
  surface?: Side;
}

const APP_MODE: CollectionModeValue = {
  mode: "app",
  inventoryHref: SIDE_PATHS.inventory,
  printLabelHref: (appHref) => appHref,
  printLabelInNewTab: true,
  keepParams: {},
  baseParams: {},
};

const CollectionModeContext = createContext<CollectionModeValue>(APP_MODE);

export function CollectionModeProvider({
  mode,
  keepParams,
  surface,
  children,
}: {
  mode: CollectionMode;
  /** Public mode: params every view URL keeps (the marketing page's `demo=on`). */
  keepParams?: Record<string, string>;
  /** App mode: the page's side (`/inventory` passes `"inventory"`). Unset: by route. */
  surface?: Side;
  children: ReactNode;
}) {
  // The URL the page is headed to. The router commits a navigation inside a
  // transition, so for a moment after a push the rendered params are the old
  // ones; a scope pick or a second push in that moment builds on this.
  const location = useLocation();
  const base = new URLSearchParams(keepParams);
  base.delete(SIDE_PARAM);
  const baseKey = base.toString();
  // The demo's inventory side rides on every view URL as `side=inventory`.
  const demoInventory =
    mode === "public" && new URLSearchParams(location.search).get(SIDE_PARAM) === "inventory";
  const value = useMemo<CollectionModeValue>(() => {
    if (mode === "app") return surface ? { ...APP_MODE, surface } : APP_MODE;
    const baseParams = Object.fromEntries(new URLSearchParams(baseKey));
    return {
      mode,
      inventoryHref: PUBLIC_DESTINATIONS.inventory,
      printLabelHref: () => PUBLIC_DESTINATIONS.printShop,
      printLabelInNewTab: false,
      keepParams: demoInventory ? { ...baseParams, [SIDE_PARAM]: "inventory" } : baseParams,
      baseParams,
    };
  }, [mode, baseKey, demoInventory, surface]);
  const latestRef = useRef<LatestEntry>({ search: location.search, state: location.state });
  useLayoutEffect(() => {
    latestRef.current = { search: location.search, state: location.state };
  }, [location]);
  return (
    <CollectionModeContext.Provider value={value}>
      <LatestEntryContext.Provider value={latestRef}>{children}</LatestEntryContext.Provider>
    </CollectionModeContext.Provider>
  );
}

/** The newest history entry the page has asked for, committed or not. */
interface LatestEntry {
  search: string;
  state: unknown;
  /** The scope to carry on: set while a navigation of ours is still pending. */
  scope?: Scope;
}
const LatestEntryContext = createContext<MutableRefObject<LatestEntry> | null>(null);

function useLatestEntry(): MutableRefObject<LatestEntry> {
  const ref = useContext(LatestEntryContext);
  if (!ref) throw new Error("useLatestEntry: outside CollectionModeProvider");
  return ref;
}

export function useCollectionMode(): CollectionModeValue {
  return useContext(CollectionModeContext);
}

/**
 * The side a URL stands for (NEO-364). The app: the page's `surface`, else
 * the route (`/inventory` is the inventory, anything else the collection).
 * The public demo: `side=inventory`, else the collection.
 */
export function sideOf(
  mode: CollectionMode,
  location: { pathname: string; search: string },
  surface?: Side,
): Side {
  if (mode === "public") {
    return new URLSearchParams(location.search).get(SIDE_PARAM) === "inventory" ? "inventory" : "collection";
  }
  if (surface) return surface;
  return location.pathname === SIDE_PATHS.inventory || location.pathname.startsWith(`${SIDE_PATHS.inventory}/`)
    ? "inventory"
    : "collection";
}

/** The page's side, as its URL has it (see `sideOf`). The page puts it in `SideProvider`. */
export function useCollectionSide(): Side {
  const { mode, surface } = useCollectionMode();
  const location = useLocation();
  return sideOf(mode, location, surface);
}

/** The scope param: a binder or box id, or absent for All. */
export const SCOPE_PARAM = "scope";

/**
 * A container the picker can scope to: a binder that is a home. A box is
 * Inventory's, so the collection never narrows to one (NEO-359).
 */
function scopable(containers: readonly Container[], id: string): boolean {
  const c = containers.find((x) => x.id === id);
  return isHome(c) && c?.kind !== "box";
}

/**
 * The scope a URL stands for. `scope=` names it; an unknown, deleted or
 * non-home id is All. With no `scope` on the URL, an open binder or box
 * (`tab=binders&b=…`, as a shared link has it) scopes the page the way
 * opening it does: a home scopes to itself, anything else to All. While the
 * shelf is still loading (`containers` undefined) the scope reads as All.
 */
export function scopeFromParams(params: URLSearchParams, containers: readonly Container[] | undefined): Scope {
  if (!containers) return "all";
  const id = params.get(SCOPE_PARAM);
  if (id !== null) return scopable(containers, id) ? id : "all";
  const open = params.get("tab") === "binders" ? params.get("b") : null;
  return open && scopable(containers, open) ? open : "all";
}

/**
 * The page's scope as its URL has it: view links carry it on, and both
 * stores read it (`useScope` in `./data/store`). The page wraps its views in
 * this with `value={scopeFromParams(params, containers)}`.
 */
export const ViewScopeProvider = ScopeProvider;

/** Writes a scope into a view's params: the id, or nothing for All. */
function putScope(params: URLSearchParams, scope: Scope) {
  if (scope === "all") params.delete(SCOPE_PARAM);
  else params.set(SCOPE_PARAM, scope);
}

/**
 * Where a view link or a view change goes: the next view's search (with the
 * mode's kept params and the scope of the moment, unless `next` sets its
 * own: `"all"` for All) and, in the demo, the history state one level deeper.
 */
function useViewTarget() {
  const { mode, keepParams } = useCollectionMode();
  const scope = useScope();
  const latestRef = useLatestEntry();
  return useCallback(
    (next: ParamsInit) => {
      const params = new URLSearchParams(keepParams);
      const view = new URLSearchParams(next);
      view.forEach((value, key) => params.set(key, value));
      const carried = view.get(SCOPE_PARAM) ?? latestRef.current.scope ?? scope;
      putScope(params, carried);
      const search = `?${params.toString()}`;
      if (mode !== "public") return { search, state: undefined, scope: carried };
      const current = (latestRef.current.state ?? {}) as DemoHistoryState;
      const state: DemoHistoryState = { ...current, demoDepth: (current.demoDepth ?? 0) + 1 };
      return { search, state, scope: carried };
    },
    [mode, keepParams, scope, latestRef],
  );
}

/**
 * Changes the current entry's params in place: `update` edits a copy of the
 * newest URL the page has asked for, and the result REPLACES the current
 * entry (keeping its history state), so the change is never a Back step of
 * its own. Nothing happens when `update` leaves the params as they were.
 */
export function useReplaceParams(): (update: (params: URLSearchParams) => void) => void {
  const navigate = useNavigate();
  const latestRef = useLatestEntry();
  return useCallback(
    (update) => {
      const next = new URLSearchParams(latestRef.current.search);
      const before = next.toString();
      update(next);
      if (next.toString() === before) return;
      const search = `?${next.toString()}`;
      latestRef.current = { ...latestRef.current, search };
      void navigate({ search }, { replace: true, state: latestRef.current.state });
    },
    [navigate, latestRef],
  );
}

/**
 * Opens something ON the current view (the card drawer): `update` edits a
 * copy of the newest URL the page has asked for, and the result is PUSHED, so
 * Back steps out of it to the view underneath. The mode's kept params and the
 * scope carry on as for any view change; `state` rides on the new entry next
 * to the demo's depth count.
 */
export function usePushParams(): (update: (params: URLSearchParams) => void, state?: Record<string, unknown>) => void {
  const navigate = useNavigate();
  const target = useViewTarget();
  const latestRef = useLatestEntry();
  return useCallback(
    (update, extra) => {
      const next = new URLSearchParams(latestRef.current.search);
      update(next);
      const t = target(next);
      const state = extra ? { ...((t.state ?? {}) as object), ...extra } : t.state;
      latestRef.current = { search: t.search, state, scope: t.scope };
      void navigate({ search: t.search }, { state });
    },
    [navigate, target, latestRef],
  );
}

/**
 * The Binder picker's setter: the same view at another scope, replacing the
 * current entry (`useReplaceParams`), so a scope change is never a Back step.
 */
export function useSetScope(): (scope: Scope) => void {
  const replace = useReplaceParams();
  const latestRef = useLatestEntry();
  return useCallback(
    (scope) => {
      latestRef.current = { ...latestRef.current, scope };
      replace((params) => putScope(params, scope));
    },
    [replace, latestRef],
  );
}

/**
 * The page's search params, read from the router in both modes. The setter
 * opens another view: it replaces the view params whole (keeping the mode's
 * own) and pushes a history entry, so Back returns to the view before.
 */
export function useCollectionParams(): [URLSearchParams, SetParams] {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const target = useViewTarget();
  const latestRef = useLatestEntry();
  const setParams = useCallback<SetParams>(
    (next) => {
      const { search, state, scope } = target(next);
      latestRef.current = { search, state, scope };
      void navigate({ search }, { state });
    },
    [navigate, target, latestRef],
  );
  return [params, setParams];
}

/** A link to another view of the collection page (`?tab=…`): a router link that pushes. */
export function ParamLink({
  search,
  onClick,
  ...rest
}: Omit<LinkProps, "to" | "state"> & { search: ParamsInit; ref?: Ref<HTMLAnchorElement> }) {
  const target = useViewTarget()(search);
  const latestRef = useLatestEntry();
  return (
    <Link
      to={{ search: target.search }}
      state={target.state}
      onClick={(e) => {
        onClick?.(e);
        // A plain click navigates here; record it as where the page is headed.
        if (!e.defaultPrevented && e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) {
          latestRef.current = target;
        }
      }}
      {...rest}
    />
  );
}

/**
 * Where a view on a side goes (NEO-364): the app's other route
 * (`/collection` or `/inventory`) with the view's params, or, in the demo,
 * the same page with the kept params, `side=inventory` for the inventory
 * (never written for the collection), and the view's. A push counts one
 * deeper in the demo; a replace keeps the entry's history state. The scope
 * is never carried across: each side starts at All.
 */
function useSideTarget() {
  const { mode, baseParams } = useCollectionMode();
  const latestRef = useLatestEntry();
  return useCallback(
    (side: Side, next: ParamsInit, how: "push" | "replace"): { to: To; search: string; state: unknown } => {
      const view = new URLSearchParams(next);
      view.delete(SIDE_PARAM);
      if (mode !== "public") {
        const q = view.toString();
        const search = q ? `?${q}` : "";
        return { to: { pathname: SIDE_PATHS[side], search }, search, state: undefined };
      }
      const params = new URLSearchParams(baseParams);
      if (side === "inventory") params.set(SIDE_PARAM, "inventory");
      view.forEach((value, key) => params.set(key, value));
      const search = `?${params.toString()}`;
      const current = (latestRef.current.state ?? {}) as DemoHistoryState;
      const state =
        how === "replace" ? latestRef.current.state : ({ ...current, demoDepth: (current.demoDepth ?? 0) + 1 } satisfies DemoHistoryState);
      return { to: { search }, search, state };
    },
    [mode, baseParams, latestRef],
  );
}

/**
 * Opens a view on a side (NEO-364): pushed (a Back step), or with
 * `replace` in place of the current entry (a redirect of a link to the
 * other side's tab or container, so Back skips it).
 */
export function useGoToSide(): (side: Side, next: ParamsInit, options?: { replace?: boolean }) => void {
  const navigate = useNavigate();
  const target = useSideTarget();
  const latestRef = useLatestEntry();
  const { mode } = useCollectionMode();
  return useCallback(
    (side, next, options) => {
      const replace = options?.replace === true;
      const t = target(side, next, replace ? "replace" : "push");
      // Same page in the demo: record where it is headed. The app's other
      // route mounts a page of its own.
      if (mode === "public") latestRef.current = { search: t.search, state: t.state };
      void navigate(t.to, { replace, state: t.state });
    },
    [navigate, target, latestRef, mode],
  );
}

/** A link to a view on a side (`useSideTarget`): the demo's side switch, the long box's door to the Inventory list. */
export function SideLink({
  side,
  search,
  onClick,
  ...rest
}: Omit<LinkProps, "to" | "state"> & { side: Side; search?: ParamsInit; ref?: Ref<HTMLAnchorElement> }) {
  const t = useSideTarget()(side, search ?? {}, "push");
  const latestRef = useLatestEntry();
  const { mode } = useCollectionMode();
  return (
    <Link
      to={t.to}
      state={t.state}
      onClick={(e) => {
        onClick?.(e);
        if (
          mode === "public" &&
          !e.defaultPrevented &&
          e.button === 0 &&
          !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        ) {
          latestRef.current = { search: t.search, state: t.state };
        }
      }}
      {...rest}
    />
  );
}
