/**
 * Maestro `{ id: X, text: Y }` — one element that has accessible name X AND
 * shows text Y. Role/name + text only.
 */
import type { Locator } from "@playwright/test";
import type { Maestro } from "../maestro";

export function idWithText(m: Maestro, id: string, text: string): Locator {
  let re: RegExp;
  try {
    re = new RegExp(text, "is");
  } catch {
    re = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "is");
  }
  return m.id(id).filter({ hasText: re });
}
