import { useDemoExtension } from "../data/store";
import type { Copy } from "../data/types";

/**
 * Where a new Have lands, as a notice says it: the demo's target binder
 * ("Main", "Ohtani rainbow"), or the real collection.
 */
export function useHomeName(): string {
  const demo = useDemoExtension();
  if (!demo) return "your collection";
  return demo.state.getBinder(demo.state.targetBinderId)?.name ?? "Main";
}

/** The binder the demo narrows counts to, when one is picked. */
export function useScopedName(): string | null {
  const demo = useDemoExtension();
  if (!demo) return null;
  return demo.state.fileableBinders.find((b) => b.id === demo.state.selectedBinderId)?.name ?? null;
}

/** Copies grouped by card, in the order they came. */
export function copiesByCard(copies: readonly Copy[] | undefined): Map<string, Copy[]> {
  const out = new Map<string, Copy[]>();
  for (const copy of copies ?? []) {
    if (copy.quantity <= 0) continue;
    const list = out.get(copy.cardId);
    if (list) list.push(copy);
    else out.set(copy.cardId, [copy]);
  }
  return out;
}

/** Case- and accent-folded, for matching what a collector types. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9#/\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
