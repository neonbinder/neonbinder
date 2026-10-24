/**
 * NEO-358 — the card drawer rides on the page URL, so Back closes it and a
 * refresh or a shared link reopens it: `detail=<cardId>`, plus `mode=add`
 * when it opened on its Add a copy form. Not `card`: Checklists already uses
 * that for the row a search jumped to (`./checklistParams`).
 */
export const DRAWER_PARAM = "detail";
export const DRAWER_MODE_PARAM = "mode";

/** A URL's view, leaving out the card drawer open on it. */
export function viewOf(search: string): string {
  const p = new URLSearchParams(search);
  p.delete(DRAWER_PARAM);
  p.delete(DRAWER_MODE_PARAM);
  return p.toString();
}
