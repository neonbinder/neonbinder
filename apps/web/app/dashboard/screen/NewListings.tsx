import { ChevronDownIcon } from "@heroicons/react/24/outline";
import CardFace from "@/app/collection/prototypes/_shared/CardFace";
import type { NewListing } from "../fake-data";
import { BlockHeading, CardTitle } from "./bits";
import { PanelLink } from "./panelLink";
import { useOpen } from "./useOpen";

/**
 * NEO-464 review round 4 — New Listings, under Fresh Pulls: the cards that
 * landed in a box (Inventory) in the last two weeks, newest first, each with
 * how many and NB's price. Listings come from NB's own inventory (Jason,
 * 2026-11-10: "don't worry about if it has sync'd yet or not"), so nothing
 * here reads a marketplace. Each tile opens the card's panel over the
 * dashboard (`./panelLink`), as stock for sale, where its price is set.
 * Nothing new in a box: no section.
 */

/** How many tiles show before "Show all". */
const PREVIEW = 6;

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** "$45.00", "$0.75 each", or "No price yet". */
export function priceWords(priceCents: number | null, quantity: number): string {
  if (priceCents === null) return "No price yet";
  const price = USD.format(priceCents / 100);
  return quantity > 1 ? `${price} each` : price;
}

export default function NewListings({ listings }: { listings: NewListing[] }) {
  const [all, toggle] = useOpen("listings");
  if (listings.length === 0) return null;
  const shown = all ? listings : listings.slice(0, PREVIEW);
  const hidden = listings.length - PREVIEW;
  // ↑ ↓ in a listing's panel walk every new listing, the ones behind Show all too.
  const listIds = listings.map((l) => l.id);
  return (
    <section aria-labelledby="cb-listings-heading" className="space-y-4">
      <BlockHeading id="cb-listings-heading" note="Into your boxes lately. Newest first.">
        New Listings
      </BlockHeading>
      <ul className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-6">
        {shown.map((l) => (
          <li key={l.lineId} className="min-w-0">
            <PanelLink cardId={l.id} side="inventory" list={listIds} className="group block rounded-md focus-outline">
              <span
                aria-hidden="true"
                className="block transition-transform group-hover:-translate-y-1 motion-reduce:transition-none"
              >
                <CardFace model={l.card} size="fill" />
              </span>
              <span className="mt-1.5 block space-y-0.5 text-xs leading-snug">
                <CardTitle card={l} lines={3} className="text-ink" />{" "}
                <span className={`block font-bold ${l.priceCents === null ? "text-ink-3" : "text-neon-green-text"}`}>
                  {priceWords(l.priceCents, l.quantity)}
                </span>{" "}
                <span className="block truncate text-ink-3">
                  {l.quantity} in {l.boxName}
                </span>
              </span>
            </PanelLink>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          aria-expanded={all}
          onClick={toggle}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-control px-3 text-sm text-ink-2 hover:border-neon-blue hover:text-ink focus-outline sm:min-h-9"
        >
          <ChevronDownIcon
            aria-hidden="true"
            className={`size-4 transition-transform motion-reduce:transition-none ${all ? "rotate-180" : ""}`}
          />
          {all ? "Show fewer" : `Show all ${listings.length}`}
          {/* The count it adds is seen, not read: the words on it lead its name (WCAG 2.5.3). */}
          {!all && (
            <span aria-hidden="true" className="text-ink-3">
              {" "}
              (+{hidden})
            </span>
          )}
          <span className="sr-only"> new listings</span>
        </button>
      )}
    </section>
  );
}
