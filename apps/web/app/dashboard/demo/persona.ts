import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import { getDashboard, parsePersona, type DashboardData, type Persona } from "../fake-data";

/**
 * NEO-464 — who the dashboard prototypes are drawn for, kept in the URL as
 * `?as=collector|dealer` (default dealer) so a refresh or a shared link shows
 * the same page. Changing it is a dev toggle, an in-view tweak: it REPLACES
 * the history entry, so Back never steps through persona flips.
 *
 * A prototype that keeps its own view in the URL (an opened binder, a tab)
 * must leave `as` alone: update params functionally,
 * `setParams((p) => { p.set("binder", id); return p; })`, never `setParams({ binder: id })`.
 */

export const PERSONA_PARAM = "as";

/** The persona in the URL, and a setter that replaces the entry. */
export function usePersona(): [Persona, (next: Persona) => void] {
  const [params, setParams] = useSearchParams();
  const persona = parsePersona(params.get(PERSONA_PARAM));
  const setPersona = useCallback(
    (next: Persona) => {
      setParams(
        (prev) => {
          const out = new URLSearchParams(prev);
          out.set(PERSONA_PARAM, next);
          return out;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  return [persona, setPersona];
}

/** The dashboard fixture for the persona in the URL. */
export function useDashboard(): DashboardData {
  const [persona] = usePersona();
  return useMemo(() => getDashboard(persona), [persona]);
}
