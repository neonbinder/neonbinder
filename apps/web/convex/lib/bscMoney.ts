/**
 * NEO-370 — BuySportsCards money: BSC sends dollars, as strings ("0.25",
 * "1.3299439999999998") or numbers (0.25); NB keeps integer cents. Pure.
 *
 * BSC's price window for a listing (confirmed 2026-10-27, and the old
 * platform's guard): at least 25¢, at most $999.
 */

export const BSC_MIN_PRICE_CENTS = 25;
export const BSC_MAX_PRICE_CENTS = 99_900;

/**
 * Dollars (string or number) → integer cents, rounded half away from zero at
 * the cent. Null for anything that is not a finite number ("", "abc", null,
 * NaN), so a caller can tell "absent" from "zero".
 */
export function bscDollarsToCents(value: unknown): number | null {
  let n: number;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && value.trim() !== "" && /^\s*-?\d*\.?\d+(e-?\d+)?\s*$/i.test(value)) {
    n = Number(value);
  } else return null;
  if (!Number.isFinite(n)) return null;
  // Round at the cent via a fixed string, so 0.285 → 29 rather than the 28 a
  // plain Math.round(0.285 * 100) gives on binary floats.
  const cents = Math.round(Number(`${Math.abs(n).toFixed(6)}e2`));
  return n < 0 ? -cents : cents;
}

/** Integer cents → the dollars number BSC's PUT takes (25 → 0.25). */
export function centsToBscDollars(cents: number): number {
  return Math.round(cents) / 100;
}

export type BscPriceCheck =
  | { ok: true; priceCents: number; raisedToMinimum: boolean }
  | { ok: false; reason: "no_price" | "price_too_high" };

/**
 * A listing row's price from NB's floor: none → "no_price"; above $999 →
 * "price_too_high" (refused, never clamped down); below 25¢ → raised to 25¢.
 */
export function checkBscPrice(floorCents: number | null | undefined): BscPriceCheck {
  if (floorCents === null || floorCents === undefined || !Number.isFinite(floorCents)) {
    return { ok: false, reason: "no_price" };
  }
  const cents = Math.round(floorCents);
  if (cents > BSC_MAX_PRICE_CENTS) return { ok: false, reason: "price_too_high" };
  if (cents < BSC_MIN_PRICE_CENTS) return { ok: true, priceCents: BSC_MIN_PRICE_CENTS, raisedToMinimum: true };
  return { ok: true, priceCents: cents, raisedToMinimum: false };
}
