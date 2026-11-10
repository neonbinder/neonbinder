import { Link, useLocation } from "react-router";
import CardFace from "@/app/collection/prototypes/_shared/CardFace";
import type { NewSet } from "../fake-data";
import { BlockHeading, count, sideHref } from "./bits";

/**
 * NEO-464 combined dashboard — New on NeonBinder: the newest checklists in
 * the catalog, newest first, each drawn with its first Base card and opening
 * its checklist. Catalog news, the same for every collector, so it shows on
 * every account; on one with little else it leads the page.
 */

/** "Baseball, 330 cards": what is known of it, in words. */
export function newSetLine(set: Pick<NewSet, "sport" | "cardCount">): string {
  const parts: string[] = [];
  if (set.sport) parts.push(set.sport);
  if (set.cardCount !== null && set.cardCount > 0) parts.push(count(set.cardCount, "card"));
  return parts.join(", ");
}

export default function NewOnNeonBinder({ sets }: { sets: NewSet[] }) {
  const { pathname } = useLocation();
  if (sets.length === 0) return null;
  return (
    <section aria-labelledby="cb-new-sets-heading" className="space-y-4">
      <BlockHeading id="cb-new-sets-heading" note="Fresh checklists, newest first.">
        New on NeonBinder
      </BlockHeading>
      <ul className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-6">
        {sets.map((set) => {
          const line = newSetLine(set);
          return (
            <li key={set.id} className="min-w-0">
              <Link
                to={sideHref(pathname, "collection", { tab: "checklists", set: set.id })}
                className="group block rounded-md focus-outline"
              >
                <div aria-hidden="true" className="transition-transform group-hover:-translate-y-1 motion-reduce:transition-none">
                  {set.cover ? <CardFace model={set.cover.card} size="fill" /> : <span className="cb-newset-blank" />}
                </div>
                <span className="mt-1.5 block text-xs leading-snug">
                  <span className="line-clamp-2 break-words font-semibold text-ink group-hover:text-neon-blue-text">
                    {set.label}
                  </span>
                  {line && <span className="block truncate text-ink-3">{line}</span>}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
