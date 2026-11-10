import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { sideHref } from "./bits";

/**
 * NEO-464 combined dashboard — what stands on an empty shelf: one object
 * from the hobby, drawn in the shelf's own language (flat vinyl and
 * cardboard, a neon accent, sitting on the ledge at spine height), the whole
 * of it one link to Add cards.
 *
 * - Shelf 2, while it holds no binder: the way into Add cards on Collection.
 * - Shelf 3, until the collector has any box: Add cards on Inventory.
 *
 * Three designs of each, for Jason to pick (`?starter=a|b|c` on /dashboard,
 * default a; the losers go once he has). Physical objects, so their colours
 * hold in both themes; the words beside them use the theme's roles.
 */

export type StarterKey = "a" | "b" | "c";

export function starterKeyOf(raw: string | null): StarterKey {
  return raw === "b" || raw === "c" ? raw : "a";
}

/** The marker on cardboard, tape and sticky notes. */
const MARKER = "'Luckiest Guy', 'Lexend', sans-serif";

interface StarterDesign {
  art: ReactNode;
  headline: string;
  action: string;
}

/* ------------------------------------------------------------ collection */

/** C1: a new binder lying on its side, still in its shrink-wrap, a pack of pages leaning on it. */
function FreshBinderArt() {
  return (
    <svg viewBox="0 0 230 140" className="cb-starter-svg" aria-hidden="true" focusable="false">
      {/* The pack of nine-pocket pages, leaning on the binder. */}
      <g transform="rotate(-12 226 140)">
        <rect x="160" y="46" width="62" height="94" rx="2" fill="#cbd5e1" />
        <rect x="163" y="43" width="62" height="94" rx="2" fill="#e2e8f0" />
        <rect x="166" y="40" width="62" height="94" rx="2" fill="#f1f5f9" stroke="#94a3b8" />
        {[0, 1, 2].map((r) =>
          [0, 1, 2].map((c) => (
            <rect
              key={`${r}${c}`}
              x={175 + c * 17}
              y={64 + r * 23}
              width="15"
              height="20.5"
              rx="1.5"
              fill="none"
              stroke="#94a3b8"
              strokeWidth="1"
            />
          )),
        )}
        {[0, 1, 2].map((i) => (
          <circle key={i} cx="170" cy={74 + i * 23} r="1.6" fill="#94a3b8" />
        ))}
        {/* The pack's card header. */}
        <rect x="166" y="40" width="62" height="18" rx="2" fill="#00c2ff" />
        <text x="197" y="53" textAnchor="middle" fontFamily={MARKER} fontSize="11" fill="#04121c">
          9-POCKET
        </text>
      </g>
      {/* The binder, flat on the shelf, spine to us. */}
      <rect x="6" y="94" width="158" height="46" rx="5" fill="#14532d" />
      <rect x="6" y="94" width="158" height="10" rx="5" fill="#1d6b3c" />
      <rect x="6" y="133" width="158" height="7" rx="3" fill="#0e3d21" />
      <rect x="40" y="108" width="90" height="20" rx="2" fill="#0e3d21" />
      <rect x="40" y="116" width="90" height="3" fill="#00d558" />
      {/* Shrink-wrap: a loose skin, its creases and its shine. */}
      <rect x="2" y="90" width="166" height="50" rx="7" fill="#ffffff" fillOpacity="0.1" stroke="#ffffff" strokeOpacity="0.55" />
      <path d="M2 112 l12 -5 l9 9 M168 106 l-12 4 l-6 -10 M74 90 l6 8 l12 -4 M118 140 l4 -8 l14 3" fill="none" stroke="#ffffff" strokeOpacity="0.6" strokeWidth="1.2" />
      <path d="M52 92 L80 92 L60 138 L34 138 Z" fill="#ffffff" fillOpacity="0.22" />
      {/* The NEW sticker, the shelf's own green dot, on the wrap's corner. */}
      <g transform="rotate(-12 22 94)">
        <circle cx="22" cy="94" r="17" fill="#00d558" stroke="#000000" strokeWidth="2" />
        <text x="22" y="98.5" textAnchor="middle" fontFamily={MARKER} fontSize="12" fill="#000000">
          NEW
        </text>
      </g>
    </svg>
  );
}

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

/** C3: the first hit, in a top-loader on a little acrylic stand, catching the light. */
function FirstHitArt() {
  return (
    <svg viewBox="0 0 230 140" className="cb-starter-svg" aria-hidden="true" focusable="false">
      {/* The stand: a clear wedge with a lip that holds the top-loader. */}
      <path d="M70 140 L160 140 L150 118 L80 118 Z" fill="#bae6fd" fillOpacity="0.55" stroke="#7dd3fc" />
      <rect x="78" y="112" width="74" height="8" rx="2" fill="#bae6fd" fillOpacity="0.7" stroke="#7dd3fc" />
      {/* The top-loader, a hair bigger than the card. */}
      <rect x="84" y="10" width="62" height="106" rx="4" fill="#e0f2fe" fillOpacity="0.35" stroke="#e2e8f0" strokeWidth="2" />
      {/* The card: a blank neon face. */}
      <rect x="89" y="18" width="52" height="92" rx="3" fill="#0b1220" stroke="#00c2ff" strokeWidth="2.5" />
      <rect x="95" y="25" width="40" height="66" rx="2" fill="none" stroke="#a44aff" strokeWidth="1.5" />
      <rect x="95" y="96" width="40" height="8" rx="1.5" fill="#00c2ff" fillOpacity="0.7" />
      <path d="M95 91 L135 40 L135 52 L104 91 Z" fill="#ffffff" fillOpacity="0.12" />
      {/* The glint on the plastic. */}
      <g className="cb-starter-glint">
        <path d="M144 8 L147 18 L157 21 L147 24 L144 34 L141 24 L131 21 L141 18 Z" fill="#ffffff" />
      </g>
    </svg>
  );
}

/* ------------------------------------------------------------- inventory */

/** I1: a five-row box, lid slid half back, the first row's divider tab marked. */
function FiveRowArt() {
  const lanes = [0, 1, 2, 3, 4];
  const tabs = ["#00d558", "#00c2ff", "#a44aff", "#ff2e9a", "#ffe600"];
  return (
    <svg viewBox="0 0 230 140" className="cb-starter-svg" aria-hidden="true" focusable="false">
      {/* The top: five lanes running the box's length, back to front. */}
      <path d="M30 40 L222 40 L204 96 L8 96 Z" fill="#d6d0c2" />
      {lanes.map((i) => {
        const y = 42 + i * 11;
        const inset = 22 - i * 3.6;
        return <path key={i} d={`M${8 + inset} ${y} L${206 + inset - 4} ${y} L${204 + inset - 6} ${y + 9} L${6 + inset} ${y + 9} Z`} fill="#3f3a31" />;
      })}
      {/* Each row's divider, its tab up; the front one says so. */}
      {lanes
        .slice()
        .reverse()
        .map((i) => {
          const y = 42 + i * 11;
          const x = 30 - i * 3.6;
          return (
            <g key={i}>
              <rect x={x} y={y - 6} width="5" height="15" fill="#e2e8f0" />
              <rect x={x} y={y - 12} width={i === 4 ? 36 : 14} height="9" rx="2" fill={tabs[i]} />
              {i === 4 && (
                <text x={x + 18} y={y - 5} textAnchor="middle" fontFamily={MARKER} fontSize="8" fill="#000000">
                  ROW 1
                </text>
              )}
            </g>
          );
        })}
      {/* The lid, slid half back over the far end. */}
      <path d="M118 34 L228 34 L210 98 L100 98 Z" fill="#f6f1e6" stroke="#8a8170" />
      <rect x="100" y="98" width="110" height="10" fill="#ece6d8" stroke="#8a8170" />
      <rect x="138" y="58" width="56" height="16" fill="#f3e3a6" transform="rotate(-3 166 66)" />
      {/* The front of the box. */}
      <rect x="8" y="96" width="196" height="44" fill="#ece6d8" stroke="#8a8170" />
      <rect x="8" y="96" width="196" height="6" fill="#ffffff" />
      <rect x="86" y="114" width="40" height="11" rx="5.5" fill="#1f1b14" />
    </svg>
  );
}

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

/** I3: the dollar box: a narrow open box stuffed with cards, and a marker tent card. */
function DollarBoxArt() {
  const tops = [16, 10, 20, 13, 24, 11, 18, 14, 22, 9, 17, 21, 12];
  return (
    <svg viewBox="0 0 230 140" className="cb-starter-svg" aria-hidden="true" focusable="false">
      {/* Cards stuffed in, edge on. */}
      {tops.map((h, i) => (
        <rect
          key={i}
          x={14 + i * 10.5}
          y={64 - h}
          width="10"
          height={h + 14}
          rx="1"
          fill={i === 2 ? "#00d558" : i === 7 ? "#ff2e9a" : i === 10 ? "#00c2ff" : "#f8fafc"}
          stroke="#475569"
          strokeWidth="0.8"
        />
      ))}
      {/* The box: plain brown cardboard, open on top. */}
      <rect x="10" y="64" width="146" height="76" rx="2" fill="#c9a36a" stroke="#8a6a3a" />
      <rect x="10" y="64" width="146" height="6" fill="#b48b52" />
      <path d="M10 64 l-6 -8 l6 0 Z M156 64 l6 -8 l-6 0 Z" fill="#b48b52" />
      <rect x="60" y="96" width="44" height="12" rx="6" fill="#3b2a12" />
      {/* The tent card, folded, in marker. */}
      <path d="M150 140 L166 76 L218 76 L222 140 Z" fill="#f6f1e6" stroke="#8a8170" />
      <path d="M166 76 L218 76 L214 82 L169 82 Z" fill="#ece6d8" />
      <text x="192" y="106" textAnchor="middle" fontFamily={MARKER} fontSize="17" fill="#111827" transform="rotate(-4 192 106)">
        $1
      </text>
      <text x="192" y="126" textAnchor="middle" fontFamily={MARKER} fontSize="14" fill="#111827" transform="rotate(-4 192 126)">
        EACH
      </text>
    </svg>
  );
}

const COLLECTION: Record<StarterKey, StarterDesign> = {
  a: { art: <FreshBinderArt />, headline: "Fresh pages. Zero cards.", action: "Slide in your first card →" },
  b: { art: <ShoeboxArt />, headline: "We all have a shoebox.", action: "Sort it into binders →" },
  c: { art: <FirstHitArt />, headline: "Got a hit? Show it off.", action: "Put your first card in →" },
};

const INVENTORY: Record<StarterKey, StarterDesign> = {
  a: { art: <FiveRowArt />, headline: "Five rows. All empty.", action: "Box your first cards →" },
  b: { art: <ToListArt />, headline: "That to-list pile won't list itself.", action: "Add cards to sell →" },
  c: { art: <DollarBoxArt />, headline: "Every dealer starts with a dollar box.", action: "Stock your first box →" },
};

/** The whole object is the link; the name says where it goes. */
function ShelfStarter({ to, name, design }: { to: string; name: string; design: StarterDesign }) {
  return (
    <Link to={to} aria-label={name} className="cb-starter">
      <span className="cb-starter-art">{design.art}</span>
      <span className="cb-starter-copy">
        <span className="cb-starter-headline">{design.headline}</span>
        <span className="cb-starter-action">{design.action}</span>
      </span>
    </Link>
  );
}

/** Shelf 2's starter: into Add cards on Collection. */
export function CollectionStarter({ design }: { design: StarterKey }) {
  const { pathname } = useLocation();
  return (
    <ShelfStarter
      to={sideHref(pathname, "collection", { tab: "add" })}
      name="Add cards to your collection"
      design={COLLECTION[design]}
    />
  );
}

/** Shelf 3's starter: into Add cards on Inventory. */
export function InventoryStarter({ design }: { design: StarterKey }) {
  const { pathname } = useLocation();
  return (
    <ShelfStarter
      to={sideHref(pathname, "inventory", { tab: "add" })}
      name="Add cards to your inventory"
      design={INVENTORY[design]}
    />
  );
}
