/**
 * NEO-224 — the set builder's drill lives in the URL.
 *
 * `?sport=<id>&year=<id>&brand=<id|all>&set=<id>&type=<id>&insert=<id>
 * &parallel=<id>`, NB `selectorOptions` ids only, canonical order, absent
 * levels omitted. A reload, a shared link and the browser's Back button all
 * land on the same spot, because the address bar IS the selection: this hook
 * reads it, and every selection the cascade makes is a write to it. No
 * marketplace id ever appears here, and nothing is derived from a name.
 *
 * ## The trusted-id gate
 *
 * The column queries take `v.id("selectorOptions")` arguments, and a string
 * that does not parse fails ARGUMENT VALIDATION — thrown into render by
 * `useQuery` and caught by the app-level error boundary. So a raw URL value
 * never reaches them. An id is TRUSTED once it came from a rendered row (an
 * operator's pick), from a server answer the cascade was handed (a drill, a
 * move, a reshape), or from `resolveDrillPath`. Trust is recorded per
 * position AND parent (`depth:parent:id`), so a path is trusted only as the
 * chain it was trusted in.
 *
 * Anything else — a reload, a pasted link — goes to `resolveDrillPath`, which
 * answers with the deepest valid prefix. While it answers the cascade shows
 * its loading placeholder (`resolving`), never a flash of Sports followed by
 * a jump. When the answer is shorter than the URL, the URL is rewritten to it
 * with `replace` and `truncatedOnLoad` says so, once, until the next pick.
 *
 * ## Push vs replace
 *
 * An operator's pick is a `push`, so Back undoes the last pick. A
 * correction the operator did not ask for as navigation — the resolver's
 * truncation, a delete, a move, a reshape — is a `replace`. Every handler
 * makes exactly ONE `setSearchParams` call: a level and everything it clears
 * are one write, never two in a tick.
 *
 * ## Why the handlers read a ref
 *
 * React Router's `setSearchParams` changes identity whenever the params do,
 * and its functional form closes over the params of the render it was made
 * in. The handlers are fed to memoized columns (NEO-85), so they have to be
 * stable, and they have to act on the path the operator is LOOKING at. Both
 * come from the latest-value ref below, refreshed after every commit.
 */
import type { GenericId } from "convex/values";
import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery } from "convex/react";
import { useSearchParams } from "react-router";
import { api } from "../../convex/_generated/api";
import { ALL_BRANDS_VIEW, type ManufacturerSelection } from "./all-brands-view";
import type { SelectorLevel } from "./selector-sync-feedback";

/**
 * The cascade's levels, root first. Keep in step with `DRILL_LEVELS` in
 * `convex/drillPath.ts`: the resolver checks position n against level n, so
 * the two lists must agree.
 */
export const DRILL_LEVELS: readonly SelectorLevel[] = [
  "sport",
  "year",
  "manufacturer",
  "setName",
  "variantType",
  "insert",
  "parallel",
];

/** The query-string key for each level. Short, because people read URLs. */
export const DRILL_PARAMS: Readonly<Record<SelectorLevel, string>> = {
  sport: "sport",
  year: "year",
  manufacturer: "brand",
  setName: "set",
  variantType: "type",
  insert: "insert",
  parallel: "parallel",
};

/**
 * `brand=all` — the NEO-237 All Brands VIEW. Not an id, never sent to the
 * server, and only valid with nothing below it: a set picked in the view
 * back-fills the brand from the set's own parent, so a URL that pairs the
 * view with a set was not written by the cascade.
 */
export const ALL_BRANDS_PARAM = "all";

/** Index of the manufacturer level in a path (the only place `all` may sit). */
const BRAND_INDEX = DRILL_LEVELS.indexOf("manufacturer");

/** Longer than any Convex id by a wide margin; the server uses the same cap. */
const MAX_PARAM_LENGTH = 128;

/** The 1-based depth of a level, as `clearFrom` and the handlers count it. */
export const levelDepth = (level: SelectorLevel): number =>
  DRILL_LEVELS.indexOf(level) + 1;

/**
 * One raw URL value per level, root first; `null` where the param is absent
 * or empty. Pure: reads nothing but the params it is handed.
 */
export function parseDrillParams(params: URLSearchParams): Array<string | null> {
  return DRILL_LEVELS.map((level) => {
    const value = params.get(DRILL_PARAMS[level])?.trim();
    return value ? value : null;
  });
}

/**
 * The longest prefix of `raw` the cascade could have written: contiguous
 * from the root (a `set` with no `brand` hangs off nothing), no value past
 * the length cap, `all` only at the brand position and nothing after it.
 *
 * `dropped` is true when the URL carried a value the prefix leaves out, so
 * the caller knows a rewrite is a truncation and not a reordering.
 */
export function canonicalPrefix(raw: ReadonlyArray<string | null>): {
  path: string[];
  dropped: boolean;
} {
  const path: string[] = [];
  for (let i = 0; i < DRILL_LEVELS.length && i < raw.length; i++) {
    const value = raw[i];
    if (value === null || value === undefined) break;
    if (value.length > MAX_PARAM_LENGTH) break;
    const isView = value === ALL_BRANDS_PARAM;
    if (isView && i !== BRAND_INDEX) break;
    path.push(value);
    if (isView) break;
  }
  const present = raw.filter((value) => value !== null && value !== undefined);
  return { path, dropped: present.length > path.length };
}

/**
 * The params for `path`, in canonical order. Params that are not the drill's
 * (anything else a link carries) are kept as they were; the drill's own keys
 * are rewritten from scratch, so a stale deeper level can never survive.
 */
export function serializeDrillPath(
  path: readonly string[],
  base?: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(base);
  for (const level of DRILL_LEVELS) next.delete(DRILL_PARAMS[level]);
  path.forEach((value, i) => {
    if (i < DRILL_LEVELS.length) next.append(DRILL_PARAMS[DRILL_LEVELS[i]], value);
  });
  return next;
}

/** The trust key for position `i` of `path`: depth, parent, id. */
const trustKey = (path: readonly string[], i: number): string =>
  `${i}:${i === 0 ? "" : path[i - 1]}:${path[i]}`;

/** True when every id in `path` has been trusted as part of this chain. */
function isTrustedPath(
  path: readonly string[],
  trusted: ReadonlySet<string>,
): boolean {
  return path.every(
    (value, i) =>
      (i === BRAND_INDEX && value === ALL_BRANDS_PARAM) ||
      trusted.has(trustKey(path, i)),
  );
}

/** `prev` plus every link of `path`; `prev` itself when nothing is new. */
function withTrust(
  prev: ReadonlySet<string>,
  path: readonly string[],
): ReadonlySet<string> {
  let next: Set<string> | null = null;
  path.forEach((value, i) => {
    if (i === BRAND_INDEX && value === ALL_BRANDS_PARAM) return;
    const key = trustKey(path, i);
    if (prev.has(key)) return;
    next ??= new Set(prev);
    next.add(key);
  });
  return next ?? prev;
}

/** The cascade's selection, one slot per level. */
export type DrillSelection = {
  sportId: GenericId<"selectorOptions"> | null;
  yearId: GenericId<"selectorOptions"> | null;
  /** A row, or the All Brands VIEW sentinel (`ALL_BRANDS_VIEW`). */
  manufacturer: ManufacturerSelection | null;
  setId: GenericId<"selectorOptions"> | null;
  variantTypeId: GenericId<"selectorOptions"> | null;
  insertId: GenericId<"selectorOptions"> | null;
  parallelId: GenericId<"selectorOptions"> | null;
};

const asId = (value: string | undefined) =>
  (value ?? null) as GenericId<"selectorOptions"> | null;

/** The selection a (trusted) path stands for. */
export function selectionFromPath(path: readonly string[]): DrillSelection {
  const brand = path[BRAND_INDEX];
  return {
    sportId: asId(path[0]),
    yearId: asId(path[1]),
    manufacturer:
      brand === undefined
        ? null
        : brand === ALL_BRANDS_PARAM
          ? ALL_BRANDS_VIEW
          : (brand as GenericId<"selectorOptions">),
    setId: asId(path[3]),
    variantTypeId: asId(path[4]),
    insertId: asId(path[5]),
    parallelId: asId(path[6]),
  };
}

/** The URL token for a value a column hands back. */
const tokenOf = (value: string): string =>
  value === ALL_BRANDS_VIEW ? ALL_BRANDS_PARAM : value;

/**
 * The resolver's answer as a path. The view is not an id, so it was never
 * sent; it is put back when everything above it checked out.
 */
function pathFromResolution(
  urlPath: readonly string[],
  resolved: ReadonlyArray<{ _id: string }>,
): string[] {
  const ids = resolved.map((step) => step._id as string);
  if (urlPath[BRAND_INDEX] === ALL_BRANDS_PARAM && ids.length === BRAND_INDEX) {
    ids.push(ALL_BRANDS_PARAM);
  }
  return ids;
}

/**
 * The ids the resolver is asked about: the path minus the view sentinel,
 * which can only sit last.
 */
const idsToResolve = (path: readonly string[]): string[] =>
  path.filter((value) => value !== ALL_BRANDS_PARAM);

/** One step of a server-supplied path, root first. */
export type DrillStep = { _id: string; level: SelectorLevel };

const EMPTY_TRUST: ReadonlySet<string> = new Set();
const EMPTY_PATH: readonly string[] = [];

export type DrillUrlState = {
  /** All null while `resolving`. */
  selection: DrillSelection;
  /**
   * An untrusted URL is being checked. The cascade shows its loading
   * placeholder instead of the columns.
   */
  resolving: boolean;
  /**
   * The URL this page was opened with named rows that are not there (or not
   * where it said), and was cut back to the part that is. Cleared by the next
   * write.
   */
  truncatedOnLoad: boolean;
  /**
   * An operator's pick at `level`: that level set, everything deeper cleared.
   * Push. Re-picking the selected row is a no-op.
   */
  select: (level: SelectorLevel, value: string) => void;
  /**
   * A set picked in the All Brands view: the brand back-filled from the set's
   * own parent, in the same write. Push.
   */
  selectSetUnder: (brandId: string, setId: string) => void;
  /**
   * Replay a server-supplied path, root first, the way the level handlers
   * would one after another: each step sets its level and clears below it.
   */
  drillTo: (steps: readonly DrillStep[], mode: "push" | "replace") => void;
  /** Clear `level` and everything deeper. Replace (a delete is not navigation). */
  clearFrom: (level: SelectorLevel) => void;
  /** The selected set now lives under `brandId`; keep the set and below. Replace. */
  moveSet: (brandId: string) => void;
};

export function useDrillUrlState(): DrillUrlState {
  const [searchParams, setSearchParams] = useSearchParams();
  const { urlPath, urlDropped } = useMemo(() => {
    const { path, dropped } = canonicalPrefix(parseDrillParams(searchParams));
    return { urlPath: path, urlDropped: dropped };
  }, [searchParams]);

  const [trusted, setTrusted] = useState<ReadonlySet<string>>(EMPTY_TRUST);
  const [truncatedOnLoad, setTruncatedOnLoad] = useState(false);

  const urlTrusted = isTrustedPath(urlPath, trusted);
  const resolved = useQuery(
    api.drillPath.resolveDrillPath,
    urlTrusted ? "skip" : { ids: idsToResolve(urlPath) },
  );

  // The path the cascade shows: the URL's when it is trusted, else the
  // resolver's answer, else nothing yet. `urlPath` is memoized on the params
  // and Convex hands back the same result object until it changes, so this
  // keeps its identity across unrelated renders.
  const effectivePath = useMemo<readonly string[] | null>(() => {
    if (urlTrusted) return urlPath;
    if (resolved === undefined) return null;
    return pathFromResolution(urlPath, resolved);
  }, [urlTrusted, urlPath, resolved]);

  // Settle the URL onto the effective path: trust what the server vouched
  // for, and rewrite a URL that is longer than its valid part, or merely not
  // in canonical order. The trust update is an ordinary state update and the
  // URL write is a router transition, so the trust always commits first: the
  // shortened URL is already trusted when it lands, and the cascade goes
  // straight from the placeholder to the restored columns.
  //
  // Idempotent by construction — `withTrust` hands back the same set when
  // nothing is new, and a URL already in canonical form is left alone — so a
  // re-run while the router's transition is still pending repeats nothing
  // that matters.
  useEffect(() => {
    if (effectivePath === null) return;
    setTrusted((prev) => withTrust(prev, effectivePath));
    const next = serializeDrillPath(effectivePath, searchParams);
    if (next.toString() === searchParams.toString()) return;
    if (urlDropped || effectivePath.length < urlPath.length) {
      setTruncatedOnLoad(true);
    }
    setSearchParams(next, { replace: true });
  }, [effectivePath, searchParams, setSearchParams, urlDropped, urlPath]);

  const latest = useRef({
    path: effectivePath ?? EMPTY_PATH,
    searchParams,
    setSearchParams,
  });
  useLayoutEffect(() => {
    latest.current = {
      path: effectivePath ?? EMPTY_PATH,
      searchParams,
      setSearchParams,
    };
  });

  /** The one write every handler goes through. */
  const write = useCallback(
    (nextRaw: ReadonlyArray<string | null>, mode: "push" | "replace") => {
      const { path: next } = canonicalPrefix(nextRaw);
      const { searchParams: params, setSearchParams: setParams } =
        latest.current;
      const serialized = serializeDrillPath(next, params);
      // One transition for all of it. The router commits a navigation inside
      // `startTransition`, so trust and the notice flag set outside it would
      // render a frame of their own first — the new trust against the OLD
      // URL, one extra pass of every query under the previous selection.
      // Inside the same transition they land in the navigation's commit.
      startTransition(() => {
        setTrusted((prev) => withTrust(prev, next));
        setTruncatedOnLoad(false);
        if (serialized.toString() === params.toString()) return;
        setParams(serialized, { replace: mode === "replace" });
      });
    },
    [],
  );

  const select = useCallback(
    (level: SelectorLevel, value: string) => {
      const depth = levelDepth(level);
      const current = latest.current.path;
      if (current.length < depth - 1) return;
      // Re-picking the row that is already selected (Enter or a click on
      // it) only closes the list, which the column does itself. It is not a
      // new pick: no push, and the drill below it stays exactly as it was.
      if (current[depth - 1] === tokenOf(value)) return;
      write([...current.slice(0, depth - 1), tokenOf(value)], "push");
    },
    [write],
  );

  const selectSetUnder = useCallback(
    (brandId: string, setId: string) => {
      const current = latest.current.path;
      if (current.length < BRAND_INDEX) return;
      if (current[BRAND_INDEX + 1] === setId) return;
      write([...current.slice(0, BRAND_INDEX), brandId, setId], "push");
    },
    [write],
  );

  const drillTo = useCallback(
    (steps: readonly DrillStep[], mode: "push" | "replace") => {
      const next = [...latest.current.path];
      for (const step of steps) {
        const depth = levelDepth(step.level);
        next.length = Math.min(next.length, depth - 1);
        // A step whose parent level is not set has nothing to hang off;
        // the level handlers it replaces would have left a hole there.
        if (next.length !== depth - 1) break;
        next.push(tokenOf(step._id));
      }
      write(next, mode);
    },
    [write],
  );

  const clearFrom = useCallback(
    (level: SelectorLevel) => {
      write(latest.current.path.slice(0, levelDepth(level) - 1), "replace");
    },
    [write],
  );

  const moveSet = useCallback(
    (brandId: string) => {
      const current = latest.current.path;
      if (current.length <= BRAND_INDEX) return;
      const next = [...current];
      next[BRAND_INDEX] = brandId;
      write(next, "replace");
    },
    [write],
  );

  const selection = useMemo(
    () => selectionFromPath(effectivePath ?? EMPTY_PATH),
    [effectivePath],
  );

  return {
    selection,
    resolving: effectivePath === null,
    truncatedOnLoad,
    select,
    selectSetUnder,
    drillTo,
    clearFrom,
    moveSet,
  };
}
