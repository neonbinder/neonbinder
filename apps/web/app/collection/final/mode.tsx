import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Link, useSearchParams } from "react-router";
import { MOCK_HANDLE } from "./binders/model";

/**
 * NEO-350 — where the collection demo is running, and what that changes.
 *
 * The same page ships twice:
 *
 * - `"app"`: `/collection`, inside the signed-in binder shell. Where you are
 *   (tab, open binder, set wall) rides on the URL (`?tab=…&b=…`), so Back and
 *   a shared link work, and links go to the real tools.
 * - `"public"`: the no-login demo on the `/binder-tracking` marketing page.
 *   Nothing it does may need an account or touch the marketing page's URL:
 *   - where you are lives in local state, not the URL (the marketing URL stays
 *     a clean share link, and Back means "leave the demo", not "the tab I
 *     clicked before");
 *   - a link to a signed-in tool goes to the public tour page for it instead
 *     (`PUBLIC_DESTINATIONS`);
 *   - share links use a neutral `@you` handle and say they are examples.
 *
 * Both modes are hard-coded data and never reach Convex or Clerk.
 */

export type CollectionMode = "app" | "public";

type ParamsInit = URLSearchParams | Record<string, string>;
type SetParams = (next: ParamsInit) => void;

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
  /** Public mode: the demo's own "URL" (local state). Null in the app. */
  local: { params: URLSearchParams; setParams: SetParams } | null;
  /** Public mode: the href a demo-internal link carries (middle-click, copy). */
  entryHref: string;
}

const APP_MODE: CollectionModeValue = {
  mode: "app",
  inventoryHref: "/inventory",
  printLabelHref: (appHref) => appHref,
  shareHandle: MOCK_HANDLE,
  local: null,
  entryHref: "",
};

const CollectionModeContext = createContext<CollectionModeValue>(APP_MODE);

export function CollectionModeProvider({
  mode,
  entryHref = "#",
  children,
}: {
  mode: CollectionMode;
  /** Public mode: where a demo-internal link points if opened on its own. */
  entryHref?: string;
  children: ReactNode;
}) {
  const [params, setLocal] = useState(() => new URLSearchParams());
  const setParams = useCallback<SetParams>((next) => setLocal(new URLSearchParams(next)), []);
  const value = useMemo<CollectionModeValue>(
    () =>
      mode === "app"
        ? APP_MODE
        : {
            mode,
            inventoryHref: PUBLIC_DESTINATIONS.inventory,
            printLabelHref: () => PUBLIC_DESTINATIONS.printShop,
            shareHandle: PUBLIC_SHARE_HANDLE,
            local: { params, setParams },
            entryHref,
          },
    [mode, params, setParams, entryHref],
  );
  return <CollectionModeContext.Provider value={value}>{children}</CollectionModeContext.Provider>;
}

export function useCollectionMode(): CollectionModeValue {
  return useContext(CollectionModeContext);
}

/**
 * The page's search params: the router's in the app, the demo's own in
 * public mode. A drop-in for `useSearchParams()` (read, and replace whole).
 */
export function useCollectionParams(): [URLSearchParams, SetParams] {
  const { local } = useCollectionMode();
  const [routerParams, setRouterParams] = useSearchParams();
  const setRouter = useCallback<SetParams>((next) => setRouterParams(next), [setRouterParams]);
  return local ? [local.params, local.setParams] : [routerParams, setRouter];
}

/**
 * A link to another view of the collection page (`?tab=…`). In the app it is
 * a router link; in the demo it swaps the demo's own params and leaves the
 * page URL alone.
 */
export function ParamLink({
  search,
  onClick,
  children,
  ...rest
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { search: ParamsInit }) {
  const { local, entryHref } = useCollectionMode();
  const query = new URLSearchParams(search).toString();
  if (!local) {
    return (
      <Link to={{ search: `?${query}` }} onClick={onClick} {...rest}>
        {children}
      </Link>
    );
  }
  return (
    <a
      href={entryHref}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        local.setParams(search);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
