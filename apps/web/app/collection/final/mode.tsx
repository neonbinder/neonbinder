import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { Link, useLocation, useNavigate, useSearchParams, type LinkProps } from "react-router";
import { MOCK_HANDLE } from "./binders/model";
import type { BinderSelection, CollectionBinder } from "./store";

/**
 * NEO-350 — where the collection demo is running, and what that changes.
 *
 * The same page ships twice:
 *
 * - `"app"`: `/collection`, inside the signed-in binder shell. Links go to
 *   the real tools.
 * - `"public"`: the no-login demo on the `/binder-tracking` marketing page.
 *   Nothing it does may need an account:
 *   - a link to a signed-in tool goes to the public tour page for it instead
 *     (`PUBLIC_DESTINATIONS`);
 *   - share links use a neutral `@you` handle and say they are examples.
 *
 * In both, where you are (tab, set wall, need list, open binder) rides on the
 * page URL with the same params (`?tab=…&set=…&view=…&for=…&b=…`), so Back
 * steps back through the views, a refresh stays put and a deep link opens
 * straight there. Every view change pushes a history entry; in-view tweaks
 * (page turns, filters, the binder-scope picker, the card drawer) stay in
 * local state and push nothing. Public mode also keeps its own params on
 * every view URL (`keepParams`, the marketing page's `demo=on`) and counts
 * how deep into the demo each entry is (`DemoHistoryState`), so "Back to the
 * tour" can return to the entry the visitor came from in one step.
 *
 * The Binder picker's scope rides there too, as `scope=<binderId>` (left off
 * for All), and the URL is its one source: the page reads it
 * (`scopeFromParams`) and the store's `selectedBinderId` follows. Picking a
 * scope replaces the current entry (`useSetScope`); every view change carries
 * the scope of the moment on, so Back restores the scope each view had. An
 * unknown or deleted binder id reads as All.
 *
 * Both modes are hard-coded data and never reach Convex or Clerk.
 */

export type CollectionMode = "app" | "public";

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
  /** The Inventory long box: `/inventory` needs an account. */
  inventory: "/managing-inventory",
  /** "Print label" / "Print this label": `/print/spine-label` needs an account. */
  printShop: "/print-shop",
  /** The demo's sign-up call to action. */
  signUp: "/sign-up",
} as const;

/** The demo's share-link handle: anyone's, so it reads as an example. */
export const PUBLIC_SHARE_HANDLE = "you";

interface CollectionModeValue {
  mode: CollectionMode;
  /** Where the Inventory long box leads. */
  inventoryHref: string;
  /** Where a "Print label" link leads, given the Print Shop link the app uses. */
  printLabelHref: (appHref: string) => string;
  /** The handle in a binder's share link. */
  shareHandle: string;
  /** Params every view URL keeps (public mode's `demo=on`). Empty in the app. */
  keepParams: Record<string, string>;
}

const APP_MODE: CollectionModeValue = {
  mode: "app",
  inventoryHref: "/inventory",
  printLabelHref: (appHref) => appHref,
  shareHandle: MOCK_HANDLE,
  keepParams: {},
};

const CollectionModeContext = createContext<CollectionModeValue>(APP_MODE);

export function CollectionModeProvider({
  mode,
  keepParams,
  children,
}: {
  mode: CollectionMode;
  /** Public mode: params every view URL keeps (the marketing page's `demo=on`). */
  keepParams?: Record<string, string>;
  children: ReactNode;
}) {
  const keepKey = new URLSearchParams(keepParams).toString();
  const value = useMemo<CollectionModeValue>(
    () =>
      mode === "app"
        ? APP_MODE
        : {
            mode,
            inventoryHref: PUBLIC_DESTINATIONS.inventory,
            printLabelHref: () => PUBLIC_DESTINATIONS.printShop,
            shareHandle: PUBLIC_SHARE_HANDLE,
            keepParams: Object.fromEntries(new URLSearchParams(keepKey)),
          },
    [mode, keepKey],
  );
  // The URL the page is headed to. The router commits a navigation inside a
  // transition, so for a moment after a push the rendered params are the old
  // ones; a scope pick or a second push in that moment builds on this.
  const location = useLocation();
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
  scope?: BinderSelection;
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

/** The scope param: a binder id, or absent for All. */
export const SCOPE_PARAM = "scope";

/** A binder the picker can scope to (the store refuses anything else). */
function scopable(binders: CollectionBinder[], id: string): boolean {
  return binders.some((b) => b.id === id && b.kind === "manual");
}

/**
 * The scope a URL stands for. `scope=` names it; an unknown or deleted id is
 * All. With no `scope` on the URL, an open binder (`tab=binders&b=…`, as a
 * shared link has it) scopes the page the way opening it does: a binder that
 * holds copies scopes to itself, a smart binder to All.
 */
export function scopeFromParams(params: URLSearchParams, binders: CollectionBinder[]): BinderSelection {
  const id = params.get(SCOPE_PARAM);
  if (id !== null) return scopable(binders, id) ? id : "all";
  const open = params.get("tab") === "binders" ? params.get("b") : null;
  return open && scopable(binders, open) ? open : "all";
}

/** The page's scope as its URL has it, for view links to carry on. */
const ViewScopeContext = createContext<BinderSelection>("all");
export const ViewScopeProvider = ViewScopeContext.Provider;

/** Writes a scope into a view's params: the id, or nothing for All. */
function putScope(params: URLSearchParams, scope: BinderSelection) {
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
  const scope = useContext(ViewScopeContext);
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
 * The Binder picker's setter: the same view at another scope. It REPLACES
 * the current entry (keeping its history state), so a scope change is never
 * a Back step of its own.
 */
export function useSetScope(): (scope: BinderSelection) => void {
  const navigate = useNavigate();
  const latestRef = useLatestEntry();
  return useCallback(
    (scope) => {
      const next = new URLSearchParams(latestRef.current.search);
      putScope(next, scope);
      const search = `?${next.toString()}`;
      latestRef.current = { ...latestRef.current, search, scope };
      void navigate({ search }, { replace: true, state: latestRef.current.state });
    },
    [navigate, latestRef],
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
}: Omit<LinkProps, "to" | "state"> & { search: ParamsInit }) {
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
