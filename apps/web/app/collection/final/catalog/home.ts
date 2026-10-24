import { systemContainer, useContainers, useScope } from "../data/store";
import { isHome, type Copy } from "../data/types";

/**
 * Where a new Have lands, as a notice says it: the scoped binder or box
 * ("Ohtani rainbow", "Show box"), else Main.
 */
export function useHomeName(): string {
  const containers = useContainers();
  const scope = useScope();
  const scoped = scope === "all" ? undefined : containers?.find((c) => c.id === scope);
  if (scoped && isHome(scoped)) return scoped.name;
  return systemContainer(containers, "main")?.name ?? "Main";
}

/** The binder or box the page narrows counts to, when one is picked. */
export function useScopedName(): string | null {
  const containers = useContainers();
  const scope = useScope();
  if (scope === "all") return null;
  const scoped = containers?.find((c) => c.id === scope);
  return scoped && isHome(scoped) ? scoped.name : null;
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
