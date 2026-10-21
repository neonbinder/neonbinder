/**
 * NEO-350 prototype 3 — small hooks: a geometric roving tabindex (one Tab
 * stop per grid, arrows move by what the eye sees) and a media query.
 */

import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type RefObject,
} from "react";

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** The element's content width, kept live. */
export function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/**
 * Roving tabindex over `[data-rove]` items inside `container`.
 *
 * Left/Right walk DOM order; Up/Down jump to the nearest item in the next
 * visual row (so a wall with gaps and a wrapped image grid both behave);
 * Home/End go to the first/last item. The caller marks each item with
 * `data-rove={key}` and `tabIndex={tabIndexFor(key)}`.
 */
export function useRoving(container: RefObject<HTMLElement | null>, keys: string[]) {
  const [active, setActive] = useState<string | null>(null);
  const current = active !== null && keys.includes(active) ? active : (keys[0] ?? null);

  const tabIndexFor = useCallback((key: string) => (key === current ? 0 : -1), [current]);

  const focusKey = useCallback(
    (key: string) => {
      setActive(key);
      const el = container.current?.querySelector<HTMLElement>(
        `[data-rove="${CSS.escape(key)}"]`,
      );
      el?.focus();
    },
    [container],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const root = container.current;
      if (!root) return;
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-rove]");
      if (!target || !root.contains(target)) return;
      const items = [...root.querySelectorAll<HTMLElement>("[data-rove]")];
      const i = items.indexOf(target);
      let next: HTMLElement | undefined;
      switch (e.key) {
        case "ArrowRight":
          next = items[i + 1];
          break;
        case "ArrowLeft":
          next = items[i - 1];
          break;
        case "Home":
          next = items[0];
          break;
        case "End":
          next = items[items.length - 1];
          break;
        case "ArrowDown":
        case "ArrowUp":
          next = verticalNeighbour(items, target, e.key === "ArrowDown");
          break;
        default:
          return;
      }
      e.preventDefault();
      if (next) {
        const key = next.dataset.rove!;
        setActive(key);
        next.focus();
      }
    },
    [container],
  );

  const onFocus = useCallback((e: React.FocusEvent<HTMLElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-rove]");
    if (el?.dataset.rove) setActive(el.dataset.rove);
  }, []);

  return { tabIndexFor, onKeyDown, onFocus, focusKey, activeKey: current };
}

function verticalNeighbour(
  items: HTMLElement[],
  from: HTMLElement,
  down: boolean,
): HTMLElement | undefined {
  const r = from.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const candidates = items
    .filter((el) => el !== from)
    .map((el) => ({ el, rect: el.getBoundingClientRect() }))
    .filter(({ rect }) => (down ? rect.top >= r.bottom - 2 : rect.bottom <= r.top + 2));
  if (candidates.length === 0) return undefined;
  const rowTop = down
    ? Math.min(...candidates.map((c) => c.rect.top))
    : Math.max(...candidates.map((c) => c.rect.top));
  const band = candidates.filter((c) => Math.abs(c.rect.top - rowTop) < 6);
  band.sort(
    (a, b) =>
      Math.abs(a.rect.left + a.rect.width / 2 - cx) -
      Math.abs(b.rect.left + b.rect.width / 2 - cx),
  );
  return band[0]?.el;
}
