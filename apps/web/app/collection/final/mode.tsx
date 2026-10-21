import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams, type LinkProps } from "react-router";
import { MOCK_HANDLE } from "./binders/model";

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
  return <CollectionModeContext.Provider value={value}>{children}</CollectionModeContext.Provider>;
}

export function useCollectionMode(): CollectionModeValue {
  return useContext(CollectionModeContext);
}

/**
 * Where a view link or a view change goes: the next view's search (with the
 * mode's kept params) and, in the demo, the history state one level deeper.
 */
function useViewTarget() {
  const { mode, keepParams } = useCollectionMode();
  const location = useLocation();
  return useCallback(
    (next: ParamsInit) => {
      const params = new URLSearchParams(keepParams);
      new URLSearchParams(next).forEach((value, key) => params.set(key, value));
      const search = `?${params.toString()}`;
      if (mode !== "public") return { search, state: undefined };
      const current = (location.state ?? {}) as DemoHistoryState;
      const state: DemoHistoryState = { ...current, demoDepth: (current.demoDepth ?? 0) + 1 };
      return { search, state };
    },
    [mode, keepParams, location.state],
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
  const setParams = useCallback<SetParams>(
    (next) => {
      const { search, state } = target(next);
      void navigate({ search }, { state });
    },
    [navigate, target],
  );
  return [params, setParams];
}

/** A link to another view of the collection page (`?tab=…`): a router link that pushes. */
export function ParamLink({ search, ...rest }: Omit<LinkProps, "to" | "state"> & { search: ParamsInit }) {
  const target = useViewTarget()(search);
  return <Link to={{ search: target.search }} state={target.state} {...rest} />;
}
