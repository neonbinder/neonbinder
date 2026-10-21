/**
 * NEO-350 — a spine label as readable query params, so another page can open
 * the Print Shop's designer (`/print/spine-label`) with a label filled in:
 *
 *   /print/spine-label?name=All+Reggie+White&bg=203731&fg=FFB612&font=anton
 *
 * `bg` and `fg` are hex without the `#` (a `#` is accepted too, url-encoded,
 * as are three-digit forms). `font` is a spine font id. Every param is
 * optional and checked on its own: one that is not valid is dropped without a
 * word, and the designer keeps its usual default for that field. Nothing here
 * adds a label to the sheet; it only seeds the form.
 */

import { normalizeHexColor } from "./contrast";
import { SPINE_FONTS } from "./spine-fonts";

/** The designer's own route. */
export const SPINE_LABEL_PATH = "/print/spine-label";

/**
 * Longest name the link carries. Far past anything a spine can letter (the
 * fitter shrinks long names to nothing); this only stops a pasted essay.
 */
export const MAX_PREFILL_NAME_LENGTH = 80;

export interface SpineLabelPrefill {
  name?: string;
  /** `#rrggbb`, lower case. */
  background?: string;
  /** `#rrggbb`, lower case. */
  text?: string;
  /** A known spine font id. */
  fontId?: string;
}

/**
 * Hex only: 3 or 6 hex digits, `#` optional. A colour name, `rgb()` or
 * anything carrying CSS is dropped.
 */
function hexParam(value: string | null): string | undefined {
  if (value === null) return undefined;
  return normalizeHexColor(value) ?? undefined;
}

function nameParam(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_PREFILL_NAME_LENGTH) return undefined;
  return trimmed;
}

function fontParam(value: string | null): string | undefined {
  if (value === null) return undefined;
  return SPINE_FONTS.some((f) => f.id === value) ? value : undefined;
}

/** Read a prefill from a query string (`?a=b`, `a=b`) or parsed params. */
export function parseSpineLabelParams(search: string | URLSearchParams): SpineLabelPrefill {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const out: SpineLabelPrefill = {};
  const name = nameParam(params.get("name"));
  const background = hexParam(params.get("bg"));
  const text = hexParam(params.get("fg"));
  const fontId = fontParam(params.get("font"));
  if (name !== undefined) out.name = name;
  if (background !== undefined) out.background = background;
  if (text !== undefined) out.text = text;
  if (fontId !== undefined) out.fontId = fontId;
  return out;
}

/**
 * The designer's URL with this label filled in. Fields that are missing or
 * not valid are left out, so the link never carries something the designer
 * would throw away.
 */
export function spineLabelPrintHref(label: {
  name?: string;
  background?: string;
  text?: string;
  fontId?: string;
}): string {
  const params = new URLSearchParams();
  const name = nameParam(label.name ?? null);
  const background = hexParam(label.background ?? null);
  const text = hexParam(label.text ?? null);
  const fontId = fontParam(label.fontId ?? null);
  if (name) params.set("name", name);
  if (background) params.set("bg", background.slice(1));
  if (text) params.set("fg", text.slice(1));
  if (fontId) params.set("font", fontId);
  const query = params.toString();
  return query ? `${SPINE_LABEL_PATH}?${query}` : SPINE_LABEL_PATH;
}
