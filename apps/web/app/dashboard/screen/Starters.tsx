import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { sideHref } from "./bits";

/**
 * NEO-464 combined dashboard — what stands on an empty shelf: one object
 * from the hobby, drawn in the shelf's own language (flat vinyl and
 * cardboard, a neon accent, sitting on the ledge at spine height), the whole
 * of it one link to Add cards.
 *
 * - Shelf 2, while it holds no binder: the shoebox, into Add cards on Collection.
 * - Shelf 3, until the collector has any box: the to-list pile, into Add cards
 *   on Inventory.
 *
 * Jason picked these two (review round 2, 2026-11-10). Physical objects, so
 * their colours hold in both themes; the words beside them use the theme's
 * roles. The link is named by its words (WCAG 2.5.3): the art is hidden.
 */

/** The marker on cardboard, tape and sticky notes. */
const MARKER = "'Luckiest Guy', 'Lexend', sans-serif";

interface StarterDesign {
  art: ReactNode;
  headline: string;
  action: string;
}

/* ------------------------------------------------------------ collection */

/** C2: the shoebox every collector has, lid knocked crooked, card tops poking out. */
function ShoeboxArt() {
  const tops = [6, 11, 4, 14, 8, 12, 5, 10, 15, 7, 9, 13, 6, 11, 8];
  return (
    <svg viewBox="0 0 230 140" className="cb-starter-svg" aria-hidden="true" focusable="false">
      {/* The cards, standing in rows, a few taller than the rest. */}
      {tops.map((h, i) => (
        <rect
          key={i}
          x={22 + i * 11}
          y={70 - h}
          width="13"
          height={h + 10}
          rx="1.5"
          fill={i === 3 ? "#ff2e9a" : i === 8 ? "#00c2ff" : i === 12 ? "#ffe600" : "#f8fafc"}
          stroke="#475569"
          strokeWidth="0.8"
        />
      ))}
      {/* The box. */}
      <rect x="14" y="70" width="186" height="70" rx="3" fill="#e2622a" />
      <rect x="14" y="70" width="186" height="7" fill="#c24f1c" />
      <rect x="14" y="132" width="186" height="8" rx="2" fill="#a8441a" />
      {/* Marker on masking tape, on the end. */}
      <g transform="rotate(-3 107 105)">
        <rect x="52" y="94" width="110" height="24" fill="#f3e3a6" />
        <text x="107" y="112" textAnchor="middle" fontFamily={MARKER} fontSize="15" fill="#111827">
          COMMONS &apos;89
        </text>
      </g>
      {/* The lid, knocked crooked, one corner down on the shelf. */}
      <g transform="rotate(13 214 70)">
        <rect x="84" y="48" width="130" height="22" rx="3" fill="#ef7a3c" />
        <rect x="84" y="65" width="130" height="5" fill="#c24f1c" />
      </g>
    </svg>
  );
}

/* ------------------------------------------------------------- inventory */

/** I2: the to-list pile: rubber-banded stacks in penny sleeves, and the sticky note. */
function ToListArt() {
  const stack = (x: number, h: number, band: string, tilt: number) => (
    <g transform={`rotate(${tilt} ${x + 30} 140)`}>
      {Array.from({ length: h }, (_, i) => (
        <rect key={i} x={x} y={140 - 12 - i * 4} width="60" height="12" rx="1.5" fill={i % 2 ? "#e2e8f0" : "#f8fafc"} stroke="#94a3b8" strokeWidth="0.8" />
      ))}
      {/* The top card in its penny sleeve: a blank neon face. */}
      <rect x={x - 2} y={140 - 16 - h * 4} width="64" height="10" rx="2" fill="#e0f2fe" fillOpacity="0.6" stroke="#cbd5e1" />
      <rect x={x + 2} y={140 - 14 - h * 4} width="56" height="6" rx="1" fill="#0b1220" stroke="#00c2ff" strokeWidth="1.2" />
      <rect x={x + 22} y={140 - 18 - h * 4} width="5" height={h * 4 + 18} fill={band} />
    </g>
  );
  return (
    <svg viewBox="0 0 230 140" className="cb-starter-svg" aria-hidden="true" focusable="false">
      {stack(8, 15, "#c2410c", -2)}
      {stack(78, 10, "#b45309", 3)}
      {stack(148, 18, "#c2410c", -1)}
      {/* The sticky note, hot pink, in marker. */}
      <g transform="rotate(-8 112 40)">
        <rect x="84" y="14" width="58" height="52" fill="#ff2e9a" />
        <rect x="84" y="14" width="58" height="8" fill="#e01f86" />
        <text x="113" y="40" textAnchor="middle" fontFamily={MARKER} fontSize="13" fill="#1a0010">
          TO
        </text>
        <text x="113" y="56" textAnchor="middle" fontFamily={MARKER} fontSize="13" fill="#1a0010">
          LIST
        </text>
      </g>
    </svg>
  );
}

const COLLECTION: StarterDesign = {
  art: <ShoeboxArt />,
  headline: "We all have a shoebox.",
  action: "Sort it into binders",
};

const INVENTORY: StarterDesign = {
  art: <ToListArt />,
  headline: "That to-list pile won't list itself.",
  action: "Add cards to sell",
};

/**
 * The whole object is the link, named by the words on it (headline, then
 * action); the art and the arrow are not read.
 */
function ShelfStarter({ to, design }: { to: string; design: StarterDesign }) {
  return (
    <Link to={to} className="cb-starter">
      <span className="cb-starter-art">{design.art}</span>
      <span className="cb-starter-copy">
        <span className="cb-starter-headline">{design.headline}</span>{" "}
        <span className="cb-starter-action">
          {design.action}
          <span aria-hidden="true"> →</span>
        </span>
      </span>
    </Link>
  );
}

/** Shelf 2's starter: into Add cards on Collection. */
export function CollectionStarter() {
  const { pathname } = useLocation();
  return <ShelfStarter to={sideHref(pathname, "collection", { tab: "add" })} design={COLLECTION} />;
}

/** Shelf 3's starter: into Add cards on Inventory. */
export function InventoryStarter() {
  const { pathname } = useLocation();
  return <ShelfStarter to={sideHref(pathname, "inventory", { tab: "add" })} design={INVENTORY} />;
}
