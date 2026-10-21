/**
 * NEO-350 — one collector's state: the copies they own, their binders, and
 * the sets they say they are building. Seed data for `usePrototypeStore`.
 *
 * A copy is one physical card (or a stack of identical raw ones), the NEO-27
 * shape. Dupes appear both ways: a second record for a different copy (Reggie
 * White raw AND slabbed) and `quantity > 1` for a stack of identical commons.
 */

import { cards } from "./catalog";
import type {
  Binder,
  BinderPage,
  Card,
  CardId,
  Copy,
  CopyDetails,
  SetId,
} from "./types";

/** Short handles for the six sets, local to this file. */
const SET = {
  contenders: "1996-playoff-contenders",
  udHockey: "1996-97-upper-deck-hockey",
  score: "2024-score-football",
  finest: "1993-finest-baseball",
  chrome: "2024-topps-chrome-baseball",
  topps: "2000-topps-football",
} as const;

/**
 * The one card at (set, variant name, number, variation). Throws unless
 * exactly one card matches: a card number is never unique on its own.
 */
function ref(
  setId: SetId,
  variantName: string | null,
  cardNumber: string | number,
  variation: string | null = null,
): CardId {
  const matches = cards.filter(
    (c: Card) =>
      c.setId === setId &&
      c.variantPath.name === variantName &&
      c.cardNumber === String(cardNumber) &&
      c.variation === variation,
  );
  if (matches.length !== 1) {
    throw new Error(
      `collector: ${setId} ${variantName ?? "Base"} #${cardNumber} matched ${matches.length} cards`,
    );
  }
  return matches[0].id;
}

/** Deterministic acquisition dates, spread over 2024-2026. */
function dateFor(index: number): string {
  const start = Date.UTC(2024, 0, 6);
  const day = 24 * 60 * 60 * 1000;
  return new Date(start + ((index * 11) % 650) * day).toISOString().slice(0, 10);
}

const B = {
  contenders: "binder-contenders-96",
  slabs: "binder-slab-case",
  tradeBait: "binder-trade-bait",
  ohtani: "binder-ohtani-rainbow",
  reggie: "smart-reggie-white",
  redWings: "smart-red-wings",
  score: "smart-score-no-low-numbers",
  badgers: "smart-badgers-alumni",
} as const;

export const myCopies: Copy[] = [];

function own(cardId: CardId, details: Partial<CopyDetails> = {}): Copy {
  const index = myCopies.length;
  const copy: Copy = {
    id: `copy-${String(index + 1).padStart(3, "0")}`,
    cardId,
    quantity: 1,
    acquiredAt: dateFor(index),
    binderIds: [],
    notes: "",
    forSale: false,
    ...details,
  };
  myCopies.push(copy);
  return copy;
}

// --- 1996 Playoff Contenders: a set build, 24 of 40 ------------------------
const CONTENDERS_MISSING = new Set([
  3, 6, 9, 13, 17, 20, 22, 26, 28, 31, 33, 35, 36, 37, 38, 40,
]);
const contendersSlotCopy = new Map<number, string>();
for (let n = 1; n <= 40; n++) {
  if (CONTENDERS_MISSING.has(n)) continue;
  const copy = own(ref(SET.contenders, null, n), {
    condition: n % 5 === 0 ? "Excellent" : "Near Mint",
    location: "Binder shelf",
    binderIds: [B.contenders],
    costBasis: n === 4 ? 6 : 1.5,
  });
  contendersSlotCopy.set(n, copy.id);
}
own(ref(SET.contenders, null, 1), {
  condition: "Near Mint",
  location: "Box 2",
  binderIds: [B.tradeBait],
  notes: "Second Favre from the same box.",
  forSale: true,
  askPrice: 4,
});
own(ref(SET.contenders, null, 4), {
  graded: { grader: "PSA", grade: "9", cert: "48213377" },
  costBasis: 85,
  location: "Slab case",
  binderIds: [B.slabs],
  notes: "Bought at the National.",
});
own(ref(SET.contenders, "Pennant Flyers", 1), { condition: "Near Mint", location: "Box 2" });
own(ref(SET.contenders, "Pennant Flyers", 2), {
  condition: "Mint",
  location: "Box 2",
  costBasis: 12,
});
own(ref(SET.contenders, "Pennant Flyers", 4), { condition: "Excellent", location: "Box 2" });

// --- 1996-97 Upper Deck hockey: Red Wings first ----------------------------
for (const n of [1, 2, 3, 4, 5, 7, 8, 9, 10, 11]) {
  own(ref(SET.udHockey, null, n), { condition: "Near Mint", location: "Box 3" });
}
own(ref(SET.udHockey, null, 1), {
  quantity: 3,
  condition: "Near Mint",
  location: "Box 3",
  binderIds: [B.tradeBait],
  notes: "Stack of extra Yzermans.",
  forSale: true,
  askPrice: 2,
});
own(ref(SET.udHockey, null, 18), { condition: "Near Mint", location: "Box 3" });
own(ref(SET.udHockey, "Legends", 1), { condition: "Mint", location: "Box 3", costBasis: 15 });
own(ref(SET.udHockey, "Legends", 2), {
  condition: "Near Mint",
  location: "Box 3",
  costBasis: 18,
  notes: "Howe in Whalers green.",
});
own(ref(SET.udHockey, "Game Jerseys", "GJ1"), {
  graded: { grader: "BGS", grade: "9.5", cert: "0011849273" },
  costBasis: 140,
  location: "Slab case",
  binderIds: [B.slabs],
});

// --- 2024 Score: base, a few parallels, two legends ------------------------
for (const n of [1, 2, 10, 11, 12, 13, "13b", 301, 302, 304]) {
  const variation = n === "13b" ? "Kelly Green" : null;
  own(ref(SET.score, null, n, variation), { condition: "Mint", location: "Box 4" });
}
own(ref(SET.score, "Red", 1), { condition: "Mint", location: "Box 4", costBasis: 3 });
own(ref(SET.score, "Lava", 302), { condition: "Mint", location: "Box 4", costBasis: 5 });
own(ref(SET.score, "Gold Zone", 10), {
  serialNumber: "23/50",
  condition: "Mint",
  location: "Box 4",
  costBasis: 20,
});
own(ref(SET.score, "Artist's Proof", 301), {
  serialNumber: "07/25",
  condition: "Mint",
  location: "Box 4",
  costBasis: 45,
  forSale: true,
  askPrice: 60,
  binderIds: [B.tradeBait],
});
own(ref(SET.score, "Gridiron Heritage", 1), { condition: "Mint", location: "Box 4" });
own(ref(SET.score, "Gridiron Heritage", 2), { condition: "Mint", location: "Box 4" });

// --- 1993 Finest: the other set build --------------------------------------
for (const n of [1, 2, 4, 5, 6, 7, 8, 9, 10, 12]) {
  own(ref(SET.finest, null, n), {
    condition: n === 6 ? "Very Good" : "Near Mint",
    location: "Box 1",
    notes: n === 6 ? "Chrome is clouded at the bottom edge." : "",
  });
}
own(ref(SET.finest, "Refractor", 2), {
  graded: { grader: "PSA", grade: "8", cert: "30927711" },
  costBasis: 450,
  location: "Slab case",
  binderIds: [B.slabs],
});
own(ref(SET.finest, "Refractor", 1), {
  condition: "Excellent",
  costBasis: 120,
  location: "Box 1",
  notes: "Small corner ding, top left.",
});

// --- 2024 Topps Chrome: chasing the Ohtani rainbow -------------------------
for (const [n, variation] of [
  [1, null],
  [2, null],
  [3, null],
  [13, null],
  [13, "Sliding"],
  [25, null],
  [26, null],
] as const) {
  own(ref(SET.chrome, null, n, variation), { condition: "Mint", location: "Box 5" });
}
const ohtaniParallels: [string, string | undefined, number][] = [
  ["Refractor", undefined, 8],
  ["Prism Refractor", undefined, 10],
  ["Negative Refractor", undefined, 14],
  ["Aqua Refractor", "112/199", 30],
  ["Green Refractor", "45/99", 55],
  ["Gold Refractor", "50/50", 140],
];
for (const [name, serialNumber, costBasis] of ohtaniParallels) {
  own(ref(SET.chrome, name, 1), {
    condition: "Mint",
    serialNumber,
    costBasis,
    location: "Box 5",
    binderIds: [B.ohtani],
  });
}
own(ref(SET.chrome, "Refractor", 25), { condition: "Mint", location: "Box 5", costBasis: 12 });
own(ref(SET.chrome, "Orange Refractor", 25), {
  serialNumber: "19/25",
  condition: "Mint",
  location: "Box 5",
  costBasis: 210,
});
own(ref(SET.chrome, "Chrome Rookie Autographs", "RA-PS"), {
  condition: "Mint",
  costBasis: 520,
  location: "Slab case",
  forSale: true,
  askPrice: 650,
  binderIds: [B.tradeBait],
  notes: "Clean on-card auto.",
});

// --- 2000 Topps ------------------------------------------------------------
own(ref(SET.topps, null, 1), { condition: "Near Mint", location: "Box 2" });
own(ref(SET.topps, null, 2), { condition: "Near Mint", location: "Box 2" });
own(ref(SET.topps, null, 12), { condition: "Near Mint", location: "Box 2", costBasis: 2 });
own(ref(SET.topps, null, 340), {
  graded: { grader: "PSA", grade: "10", cert: "62119054" },
  costBasis: 2800,
  location: "Slab case",
  binderIds: [B.slabs],
  notes: "The grail.",
});

// ---------------------------------------------------------------------------
// Binders
// ---------------------------------------------------------------------------

/** Nine-pocket pages for the Contenders build: slot N holds card #N+1. */
const contendersLayout: BinderPage[] = [];
for (let page = 0; page < 5; page++) {
  const slots: (string | null)[] = [];
  for (let slot = 0; slot < 9; slot++) {
    const n = page * 9 + slot + 1;
    slots.push(contendersSlotCopy.get(n) ?? null);
  }
  contendersLayout.push({ slots });
}

export const binders: Binder[] = [
  {
    id: B.contenders,
    kind: "manual",
    name: "'96 Contenders",
    description: "The set build, in number order. Empty pockets are the want list.",
    layout: contendersLayout,
  },
  {
    id: B.slabs,
    kind: "manual",
    name: "Slab case",
    description: "Everything graded.",
  },
  {
    id: B.tradeBait,
    kind: "manual",
    name: "Trade bait",
    description: "Dupes and cards I'd move at a show.",
  },
  {
    id: B.ohtani,
    kind: "manual",
    name: "Ohtani rainbow",
    description: "Every 2024 Chrome #1 parallel I can find.",
  },
  {
    id: B.reggie,
    kind: "smart",
    name: "All Reggie White",
    description: "Every Reggie White card, any team, any year.",
    rule: { kind: "player", playerId: "reggie-white" },
  },
  {
    id: B.redWings,
    kind: "smart",
    name: "Red Wings",
    description: "Anything with the winged wheel on the front.",
    rule: { kind: "teamOnCard", teamId: "red-wings" },
  },
  {
    id: B.score,
    kind: "smart",
    name: "Score, minus the low numbers",
    description: "All Score cards except numbered under /50.",
    rule: {
      kind: "and",
      rules: [
        { kind: "brand", brandId: "brand-score" },
        { kind: "not", rule: { kind: "printRunBelow", max: 50 } },
      ],
    },
  },
  {
    id: B.badgers,
    kind: "smart",
    name: "Badgers alumni",
    description: "Anyone who played at Wisconsin, in any uniform.",
    rule: { kind: "playedFor", teamId: "wisconsin" },
  },
];

/** Sets the collector has said they are building. */
export const buildingSetIds: SetId[] = [
  SET.contenders,
  SET.finest,
  SET.udHockey,
];
