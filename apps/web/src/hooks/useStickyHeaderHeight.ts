import { useLayoutEffect, type RefObject } from "react";

/**
 * The CSS custom property on `<html>` holding the page header's height in px
 * while it sticks to the top, and `0px` while it scrolls away (below `sm` the
 * shells' headers are not sticky). Anything that sticks under the header sets
 * its `top` from it (`top-[var(--nb-header-h,0px)]`), so it sits flush under
 * the header at every width, with no hard-coded height to drift out of step.
 */
export const HEADER_HEIGHT_VAR = "--nb-header-h";

/** Fired on `window` after the value changes, for code that measures against it. */
export const HEADER_HEIGHT_EVENT = "nb:header-height";

/**
 * Publishes `header`'s real height as {@link HEADER_HEIGHT_VAR}. Re-measures
 * when the header resizes, when the window does (sticky turns on and off at
 * a breakpoint without the header changing size), and when its class changes
 * (the demo's header sticks only from `sm` up while the demo is open).
 */
export function useStickyHeaderHeight(header: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = header.current;
    if (!el) return;
    const root = document.documentElement;
    let last: string | null = null;
    const publish = (px: string | null) => {
      if (px === last) return;
      last = px;
      if (px === null) root.style.removeProperty(HEADER_HEIGHT_VAR);
      else root.style.setProperty(HEADER_HEIGHT_VAR, px);
      window.dispatchEvent(new Event(HEADER_HEIGHT_EVENT));
    };
    const measure = () => {
      const stuck = getComputedStyle(el).position === "sticky";
      publish(`${stuck ? Math.ceil(el.getBoundingClientRect().height) : 0}px`);
    };
    measure();
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resized?.observe(el);
    const restyled = typeof MutationObserver === "undefined" ? null : new MutationObserver(measure);
    restyled?.observe(el, { attributes: true, attributeFilter: ["class"] });
    window.addEventListener("resize", measure);
    return () => {
      resized?.disconnect();
      restyled?.disconnect();
      window.removeEventListener("resize", measure);
      publish(null);
    };
  }, [header]);
}
