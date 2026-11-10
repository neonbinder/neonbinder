import { useCallback } from "react";
import { useSearchParams } from "react-router";

/**
 * NEO-464 combined dashboard — which disclosures are open (a board's full
 * need list, a batch's every card, the whole shelf), kept in the URL as
 * `?open=a,b` so a refresh or a shared link shows the same page. Opening one
 * is an in-view tweak: it REPLACES the entry, so Back never steps through
 * show / hide. Updated functionally, so the screen's other params survive.
 */

const OPEN_PARAM = "open";

export function useOpen(id: string): [boolean, () => void] {
  const [params, setParams] = useSearchParams();
  const open = (params.get(OPEN_PARAM) ?? "").split(",").includes(id);
  const toggle = useCallback(() => {
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        const ids = new Set((out.get(OPEN_PARAM) ?? "").split(",").filter(Boolean));
        if (ids.has(id)) ids.delete(id);
        else ids.add(id);
        if (ids.size === 0) out.delete(OPEN_PARAM);
        else out.set(OPEN_PARAM, [...ids].join(","));
        return out;
      },
      { replace: true },
    );
  }, [id, setParams]);
  return [open, toggle];
}
