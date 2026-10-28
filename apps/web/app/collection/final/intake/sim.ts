import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { cards, getCard, type Card, type CardId } from "../../prototypes/_shared/data";

/**
 * NEO-369 — the fake intake pipeline behind the demo's Add cards tab.
 *
 * Nothing here touches Convex. A scripted pile of scans arrives over time and
 * each card walks the real pipeline's stages on its own clock:
 *
 *   uploading → reading (crop, orient, player/number/side) → pairing →
 *   matching → review → saved
 *
 * The script deliberately carries every case the plan says a human must be
 * able to catch and fix ("correct but fixable", Jason 2026-10-27): a low
 * confidence match, a card number shared by two cards, a number/player
 * conflict, a parallel and an insert while Base is pinned, a serial, a slab,
 * a front still waiting for its back, a mispair, a failed read, a card from
 * another set, and a re-scan of a card already in this run. What the
 * collector already owns comes from the demo store (`hadOf`), so a scan of a
 * card already in the binder bumps that line.
 *
 * Nothing saves on its own: a card saves only when the user confirms it,
 * enters a quantity, or saves the batch.
 */

export const SET_ID = "2024-topps-chrome-baseball";
export const SET_LABEL = "2024 Topps Chrome";

export type Stage = "uploading" | "reading" | "pairing" | "matching" | "review" | "saved";
export const STAGES: Stage[] = ["uploading", "reading", "pairing", "matching", "review", "saved"];
export const STAGE_LABEL: Record<Stage, string> = {
  uploading: "Uploading",
  reading: "Cropping & reading",
  pairing: "Pairing",
  matching: "Matching",
  review: "Needs you",
  saved: "Saved",
};

export type Band = "matched" | "check" | "none";
export type Side = "front" | "back";

export interface Grading {
  grader: string;
  grade: string;
  cert: string;
}

export interface Details {
  condition: string;
  grading: Grading | null;
  serial: string;
  costCents: number | null;
  priceCents: number | null;
  location: string;
  notes: string;
}

/** Copies of a card already in a home, before this run: the store's count. */
export type HadOf = (cardId: CardId, homeId: string) => number;

export interface ScanSide {
  /** The file name the user would recognise. */
  file: string;
  rotation: number;
  recropping: boolean;
  failed: boolean;
}

export interface Match {
  cardId: CardId | null;
  /** 0–100. */
  confidence: number;
  /** Cards the user may mean, best first. */
  candidates: CardId[];
  /** Why the matcher is unsure, in a collector's words. */
  reason: string | null;
  /** The pinned variant looks wrong for this card: a prompt, never applied on its own. */
  suggestion: CardId | null;
  /** The user picked or confirmed the card. */
  byUser: boolean;
}

export interface Item {
  id: string;
  /** What the scan really is (the simulation's truth, never shown). */
  truth: CardId | null;
  front: ScanSide;
  back: ScanSide | null;
  stage: Stage;
  /** Wall-clock ms at which the current stage finishes on its own. */
  nextAt: number;
  pairedBy: "scanner" | "scan order" | "pool" | "you";
  match: Match;
  /** Copies already in this home before the run. */
  had: number;
  /**
   * The line's count once saved: what was had, plus this scan (Jason: the
   * quantity starts at what you had and goes up by one per scan).
   */
  qty: number;
  details: Partial<Details>;
  homeId: string;
  /** Another item in this run that looks like the same physical card. */
  rescanOf: string | null;
  /** What was read off the scan, shown while matching. */
  read: { player: string | null; number: string | null };
  /** Set found from the photo when no set was picked. */
  setGuess: string | null;
}

export interface Loose {
  id: string;
  side: ScanSide;
  as: Side;
  read: { player: string | null; number: string | null };
  truth: CardId | null;
}

interface State {
  items: Item[];
  loose: Loose[];
  /** Index into the script of the next scan to arrive. */
  cursor: number;
  paused: boolean;
  setPinned: boolean;
  log: string[];
}

/* ------------------------------------------------------------------ */
/* The script                                                          */
/* ------------------------------------------------------------------ */

const inSet = cards.filter((c) => c.setId === SET_ID);
const base = (n: string, variation: string | null = null): Card =>
  inSet.find((c) => c.variantPath.type === "Base" && c.cardNumber === n && c.variation === variation)!;
const parallel = (name: string, n: string): Card =>
  inSet.find((c) => c.variantPath.name === name && c.cardNumber === n)!;
const insert = (n: string): Card => inSet.find((c) => c.cardNumber === n)!;
const other = cards.find((c) => c.setId !== SET_ID && c.variantPath.type === "Base")!;

/** A card of the pile's own set and variant (2024 Topps Chrome Base), to open the set selector there. */
export const SEED_CARD_ID: CardId = base("1").id;

interface Beat {
  truth: Card | null;
  at: number; // ms after start
  read?: { player: string | null; number: string | null };
  confidence?: number;
  reason?: string;
  candidates?: Card[];
  suggestion?: Card;
  pickedAs?: Card | null;
  grading?: Grading;
  serial?: string;
  failed?: boolean;
  backLate?: number; // the back arrives this many ms later
  mispairWith?: Card;
  rescanOf?: number; // marks a re-scan of a card already in this run
  completes?: number; // the late back for the waiting front at this script index
  rotation?: number;
}

const name = (c: Card) => c.id;

function beats(): Beat[] {
  const ohtani = base("1");
  return [
    { truth: ohtani, at: 0 },
    { truth: base("2"), at: 900 },
    { truth: base("3"), at: 1800 },
    { truth: base("4"), at: 2700 },
    {
      truth: base("13", "Sliding"),
      at: 3600,
      confidence: 54,
      reason: "Two cards share #13: the regular card and the Sliding image variation.",
      candidates: [base("13"), base("13", "Sliding")],
      pickedAs: base("13"),
    },
    {
      truth: base("25"),
      at: 4500,
      read: { player: "Paul Skenes", number: "26" },
      confidence: 38,
      reason: "The number reads #26 (Jackson Holliday) but the name reads Paul Skenes.",
      candidates: [base("25"), base("26")],
      pickedAs: null,
    },
    {
      truth: parallel("Refractor", "10"),
      at: 5400,
      pickedAs: base("10"),
      confidence: 81,
      suggestion: parallel("Refractor", "10"),
      reason: "The finish looks like a Refractor, not Base.",
    },
    {
      truth: insert("RA-PS"),
      at: 6300,
      read: { player: "Paul Skenes", number: "RA-PS" },
      pickedAs: null,
      confidence: 22,
      suggestion: insert("RA-PS"),
      reason: "RA-PS is a Chrome Rookie Autographs number, not a Base card.",
    },
    {
      truth: parallel("Gold Refractor", "8"),
      at: 7200,
      pickedAs: base("8"),
      confidence: 77,
      suggestion: parallel("Gold Refractor", "8"),
      reason: "Gold finish and a serial stamp: looks like the Gold Refractor /50.",
      serial: "23/50",
    },
    {
      truth: base("30"),
      at: 8100,
      grading: { grader: "PSA", grade: "10", cert: "84512277" },
      reason: "Graded slab: cert read from the label.",
      confidence: 93,
    },
    { truth: base("9"), at: 9000, backLate: 14000 },
    {
      truth: base("12"),
      at: 9900,
      mispairWith: base("11"),
      confidence: 31,
      reason: "Front reads Mike Trout, back reads Freddie Freeman. They may be two cards.",
      candidates: [base("12"), base("11")],
      pickedAs: base("12"),
    },
    { truth: base("14"), at: 10800, failed: true },
    { truth: base("27"), at: 11700, rotation: 180 },
    {
      truth: other,
      at: 12600,
      confidence: 6,
      pickedAs: null,
      reason: "Nothing in 2024 Topps Chrome comes close. It may be from another set.",
    },
    { truth: ohtani, at: 13500, rescanOf: 0 },
    { truth: base("7"), at: 14400 },
    { truth: base("24"), at: 15300 },
    { truth: base("20"), at: 16200 },
    { truth: base("16"), at: 17100 },
  ];
}

/** The script with each late back as its own beat, in arrival order. */
function script_(): Beat[] {
  const list = beats();
  const late = list.flatMap((b, i) => (b.backLate ? [{ ...b, at: b.at + b.backLate, backLate: undefined, completes: i }] : []));
  // Late backs land after every scripted front, so the waiting front's index is stable.
  return [...list, ...late.sort((a, b) => a.at - b.at)];
}

const MORE = ["5", "6", "11", "15", "17", "18", "19", "21", "22", "23", "28", "29"];

/* ------------------------------------------------------------------ */
/* Stage timing                                                        */
/* ------------------------------------------------------------------ */

const DURATION: Record<Exclude<Stage, "review" | "saved">, [number, number]> = {
  uploading: [500, 1100],
  reading: [2600, 5200],
  pairing: [700, 1600],
  matching: [900, 2400],
};

function rand(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

function duration(stage: Stage, seed: number, speed: number): number {
  if (stage === "review" || stage === "saved") return Infinity;
  const [lo, hi] = DURATION[stage];
  return (lo + (hi - lo) * rand(seed)) / speed;
}

const NEXT: Partial<Record<Stage, Stage>> = {
  uploading: "reading",
  reading: "pairing",
  pairing: "matching",
  matching: "review",
};

/* ------------------------------------------------------------------ */
/* Reducer                                                             */
/* ------------------------------------------------------------------ */

type Action =
  | { type: "tick"; now: number; elapsed: number; speed: number; script: Beat[]; setChosen: boolean; home: string; hadOf: HadOf }
  | { type: "more"; now: number; speed: number; home: string; hadOf: HadOf }
  | { type: "pause"; paused: boolean }
  | { type: "confirm"; id: string }
  | { type: "qty"; id: string; qty: number; hold?: boolean }
  | { type: "saveAll" }
  | { type: "pick"; id: string; cardId: CardId; hadOf: HadOf }
  | { type: "suggestion"; id: string; accept: boolean; hadOf: HadOf }
  | { type: "rotate"; id: string; side: Side }
  | { type: "recrop"; id: string; side: Side; now: number; speed: number }
  | { type: "swap"; id: string }
  | { type: "unpair"; id: string }
  | { type: "pairLoose"; frontId: string; backId: string; now: number; speed: number; home: string; hadOf: HadOf }
  | { type: "reject"; id: string; side: Side }
  | { type: "drop"; id: string }
  | { type: "retry"; id: string; now: number; speed: number; hadOf: HadOf }
  | { type: "details"; id: string; patch: Partial<Details> }
  | { type: "home"; id: string; homeId: string; hadOf: HadOf }
  | { type: "rescan"; id: string; second: boolean }
  | { type: "pinSet" }
  | { type: "notInSet"; id: string };

let serialNo = 0;
const nextId = (p: string) => `${p}${++serialNo}`;

function sideOf(file: string, rotation = 0): ScanSide {
  return { file, rotation, recropping: false, failed: false };
}

function fileName(n: number, side: Side) {
  return `scan_${String(n).padStart(4, "0")}${side === "front" ? "a" : "b"}.jpg`;
}

function readOf(card: Card | null) {
  if (!card) return { player: null, number: null };
  return { player: card.playerIds[0] ? playerName(card) : null, number: card.cardNumber };
}

function playerName(card: Card): string {
  // The fixture ids are slugs; a human-ish name is enough for a prototype.
  return card.playerIds[0]
    .replace(/^[a-z]+-/, "")
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * The line this scan lands on: the count already in the home, plus one. The
 * demo's copies carry no photos, so a scan always bumps the existing line
 * (the line rule only starts a new line when the old one has a photo).
 */
function lineFor(cardId: CardId | null, homeId: string, hadOf: HadOf) {
  const had = cardId ? hadOf(cardId, homeId) : 0;
  return { had, qty: had + 1 };
}

/** Re-count the line after the card or its home changed. */
function relined(item: Item, hadOf: HadOf): Item {
  return { ...item, ...lineFor(item.match.cardId, item.homeId, hadOf) };
}

function itemFromBeat(
  beat: Beat,
  index: number,
  now: number,
  speed: number,
  setChosen: boolean,
  home: string,
  hadOf: HadOf,
): Item {
  const card = beat.truth;
  const picked = beat.pickedAs === undefined ? card : beat.pickedAs;
  const confidence = beat.confidence ?? 96 - Math.round(rand(index) * 8);
  const { had, qty } = lineFor(picked?.id ?? null, home, hadOf);
  const backCard = beat.mispairWith ?? card;
  return {
    id: nextId("c"),
    truth: card?.id ?? null,
    front: { ...sideOf(fileName(index * 2 + 1, "front"), beat.rotation ?? 0), failed: !!beat.failed },
    back: sideOf(fileName(index * 2 + 2, "back")),
    stage: "uploading",
    nextAt: now + duration("uploading", index, speed),
    pairedBy: beat.mispairWith ? "pool" : index % 3 === 0 ? "scanner" : "scan order",
    match: {
      cardId: picked?.id ?? null,
      confidence: setChosen ? confidence : Math.max(0, confidence - 18),
      candidates: (beat.candidates ?? []).map(name),
      reason: setChosen ? beat.reason ?? null : beat.reason ?? "Set found from the photo; less certain without a set picked.",
      suggestion: beat.suggestion?.id ?? null,
      byUser: false,
    },
    had,
    qty,
    details: beat.grading || beat.serial ? { grading: beat.grading ?? null, serial: beat.serial ?? "" } : {},
    homeId: home,
    rescanOf: null,
    read: beat.read ?? readOf(backCard ?? null),
    setGuess: setChosen ? null : card?.setId === SET_ID ? SET_LABEL : card ? "2000 Topps" : null,
  };
}

function advance(item: Item, now: number, speed: number, seed: number): Item {
  let next = item;
  while (next.nextAt <= now && NEXT[next.stage]) {
    if (next.stage === "reading" && next.front.failed) {
      return { ...next, stage: "review", nextAt: Infinity, match: { ...next.match, cardId: null, confidence: 0, reason: "Couldn't read this scan: it is blurry or cut off. Rescan it." } };
    }
    const stage = NEXT[next.stage]!;
    next = { ...next, stage, nextAt: next.nextAt + duration(stage, seed + STAGES.indexOf(stage), speed) };
  }
  return next;
}

/**
 * A waiting card that can't be saved as it stands: no card picked, a failed
 * read, an unanswered rescan, or a suggestion that says the pick is wrong.
 * Selecting one opens its drawer (Jason, 2026-10-28).
 */
export function needsDrawer(item: Item): boolean {
  return item.stage === "review" && (!item.match.cardId || item.front.failed || !!item.rescanOf || !!item.match.suggestion);
}

export function bandOf(item: Item): Band {
  if (item.match.byUser) return "matched";
  if (!item.match.cardId || item.match.confidence < 20) return "none";
  if (item.match.confidence < 85 || item.match.suggestion || item.rescanOf) return "check";
  return "matched";
}

function reducer(state: State, action: Action): State {
  const patch = (id: string, f: (i: Item) => Item): State => ({
    ...state,
    items: state.items.map((i) => (i.id === id ? f(i) : i)),
  });
  switch (action.type) {
    case "tick": {
      if (state.paused) return state;
      let { items, loose, cursor } = state;
      const log = [...state.log];
      // Arrivals.
      while (cursor < action.script.length && action.script[cursor].at <= action.elapsed) {
        const beat = action.script[cursor];
        const item = itemFromBeat(beat, cursor, action.now, action.speed, action.setChosen || state.setPinned, action.home, action.hadOf);
        if (beat.rescanOf !== undefined) {
          const first = items.find((i) => i.truth === beat.truth?.id && !i.rescanOf);
          if (first) item.rescanOf = first.id;
        }
        if (beat.backLate) {
          // The front lands alone and waits in the loose pile for its back.
          loose = [...loose, { id: `wait-${cursor}`, side: item.front, as: "front", read: readOf(beat.truth), truth: item.truth }];
          log.push(`${item.front.file} is waiting for its back`);
          cursor++;
          continue;
        }
        if (beat.completes !== undefined) {
          const waiting = loose.find((l) => l.id === `wait-${beat.completes}`);
          if (waiting) {
            loose = loose.filter((l) => l !== waiting);
            item.front = waiting.side;
          }
        }
        items = [...items, item];
        cursor++;
      }
      items = items.map((i, n) => advance(i, action.now, action.speed, n));
      return { ...state, items, loose, cursor, log };
    }
    case "more": {
      const start = state.items.length;
      const added = MORE.map((n, k) =>
        itemFromBeat({ truth: base(n), at: 0 }, start + k, action.now + k * 600, action.speed, true, action.home, action.hadOf),
      ).map((i, k) => ({ ...i, nextAt: action.now + 600 * (k + 1) }));
      return { ...state, items: [...state.items, ...added] };
    }
    case "pause":
      return { ...state, paused: action.paused };
    case "confirm":
      return patch(action.id, (i) =>
        i.stage === "review" && i.match.cardId ? { ...i, stage: "saved", match: { ...i.match, byUser: true } } : i,
      );
    case "qty":
      // Entering a quantity is a save (Jason, 2026-10-27), unless it is held
      // while the card's price is filled in.
      return patch(action.id, (i) =>
        i.match.cardId && !action.hold ? { ...i, qty: Math.max(0, action.qty), stage: i.stage === "review" ? "saved" : i.stage } : { ...i, qty: Math.max(0, action.qty) },
      );
    case "saveAll":
      return {
        ...state,
        items: state.items.map((i) => (i.stage === "review" && bandOf(i) === "matched" ? { ...i, stage: "saved" } : i)),
      };
    case "pick":
      return patch(action.id, (i) =>
        relined(
          { ...i, match: { ...i.match, cardId: action.cardId, confidence: 100, byUser: true, suggestion: null, reason: null } },
          action.hadOf,
        ),
      );
    case "suggestion":
      return patch(action.id, (i) =>
        relined(
          {
            ...i,
            match:
              action.accept && i.match.suggestion
                ? { ...i.match, cardId: i.match.suggestion, suggestion: null, byUser: true, confidence: 100, reason: null }
                : { ...i.match, suggestion: null, reason: null },
          },
          action.hadOf,
        ),
      );
    case "rotate":
      return patch(action.id, (i) =>
        action.side === "front"
          ? { ...i, front: { ...i.front, rotation: (i.front.rotation + 90) % 360 } }
          : i.back
            ? { ...i, back: { ...i.back, rotation: (i.back.rotation + 90) % 360 } }
            : i,
      );
    case "recrop":
      return patch(action.id, (i) => ({
        ...i,
        [action.side]: { ...(action.side === "front" ? i.front : i.back!), recropping: true },
        stage: i.stage === "saved" ? "saved" : "reading",
        nextAt: action.now + duration("reading", 7, action.speed),
      }));
    case "swap":
      return patch(action.id, (i) => (i.back ? { ...i, front: i.back, back: i.front } : i));
    case "unpair": {
      const item = state.items.find((i) => i.id === action.id);
      if (!item || !item.back) return state;
      return {
        ...state,
        items: state.items.filter((i) => i.id !== action.id),
        loose: [
          ...state.loose,
          { id: `${item.id}-f`, side: item.front, as: "front", read: item.read, truth: item.truth },
          { id: `${item.id}-b`, side: item.back, as: "back", read: item.read, truth: item.truth },
        ],
      };
    }
    case "pairLoose": {
      const f = state.loose.find((l) => l.id === action.frontId);
      const b = state.loose.find((l) => l.id === action.backId);
      if (!f || !b) return state;
      const truth = f.truth ? getCard(f.truth) : null;
      const item = itemFromBeat({ truth, at: 0 }, state.items.length + 40, action.now, action.speed, true, action.home, action.hadOf);
      return {
        ...state,
        loose: state.loose.filter((l) => l !== f && l !== b),
        items: [
          ...state.items,
          { ...item, front: f.side, back: b.side, pairedBy: "you", stage: "matching", nextAt: action.now + duration("matching", 3, action.speed) },
        ],
      };
    }
    case "reject": {
      const item = state.items.find((i) => i.id === action.id);
      if (!item) return state;
      const keep = action.side === "front" ? item.back : item.front;
      return {
        ...state,
        items: state.items.filter((i) => i.id !== action.id),
        loose: keep
          ? [...state.loose, { id: `${item.id}-k`, side: keep, as: action.side === "front" ? "back" : "front", read: item.read, truth: item.truth }]
          : state.loose,
        log: [...state.log, `Rescan the ${action.side} of ${item.front.file}`],
      };
    }
    case "drop": {
      const item = state.items.find((i) => i.id === action.id);
      if (!item) return state;
      return {
        ...state,
        items: state.items.filter((i) => i.id !== action.id),
        log: [...state.log, `Set aside ${item.front.file}`],
      };
    }
    case "retry":
      return patch(action.id, (i) =>
        relined(
          {
            ...i,
            front: { ...i.front, failed: false },
            stage: "reading",
            nextAt: action.now + duration("reading", 5, action.speed),
            match: { ...i.match, cardId: i.truth, confidence: 92, reason: null },
          },
          action.hadOf,
        ),
      );
    case "details":
      return patch(action.id, (i) => ({ ...i, details: { ...i.details, ...action.patch } }));
    case "home":
      return patch(action.id, (i) => relined({ ...i, homeId: action.homeId }, action.hadOf));
    case "rescan":
      return action.second
        ? patch(action.id, (i) => ({ ...i, rescanOf: null }))
        : { ...state, items: state.items.filter((i) => i.id !== action.id), log: [...state.log, "Dropped a re-scan"] };
    case "pinSet":
      return {
        ...state,
        setPinned: true,
        items: state.items.map((i) =>
          i.setGuess === SET_LABEL && !i.match.byUser
            ? { ...i, setGuess: null, match: { ...i.match, confidence: Math.min(99, i.match.confidence + 18), reason: i.match.reason?.startsWith("Set found") ? null : i.match.reason } }
            : i,
        ),
      };
    case "notInSet":
      return patch(action.id, (i) => ({
        ...i,
        match: { ...i.match, reason: "Filed as a card request. It stays private until the crew adds it.", byUser: true, cardId: null },
        stage: "saved",
      }));
  }
}

/* ------------------------------------------------------------------ */
/* The hook                                                            */
/* ------------------------------------------------------------------ */

export interface SimOptions {
  /** False when the user skipped the set step. */
  setChosen: boolean;
  homeId: string;
  /** What the collector already owns, read when a card or its home changes. */
  hadOf: HadOf;
  /** 1 = the real pipeline's pace; higher is faster. */
  speed?: number;
  /** Start the clock (false while a wizard is still on its setup steps). */
  running?: boolean;
}

/** `?speed=4` runs the pipeline four times faster (demos and the E2E spec). */
function speedFromUrl(fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const n = Number(new URLSearchParams(window.location.search).get("speed"));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function useIntakeSim({ setChosen, homeId, hadOf, speed: requested = 1, running = true }: SimOptions) {
  const [speed] = useState(() => speedFromUrl(requested));
  const script = useMemo(script_, []);
  const [state, dispatch] = useReducer(reducer, {
    items: [],
    loose: [],
    cursor: 0,
    paused: false,
    setPinned: false,
    log: [],
  });
  const started = useRef<number | null>(null);
  const homeRef = useRef(homeId);
  homeRef.current = homeId;
  // The store's latest counts, read when a dispatch needs them (never during render).
  const hadRef = useRef(hadOf);
  hadRef.current = hadOf;
  const had = useCallback<HadOf>((cardId, home) => hadRef.current(cardId, home), []);

  useEffect(() => {
    if (!running) return;
    if (started.current === null) started.current = Date.now();
    const id = window.setInterval(() => {
      const now = Date.now();
      dispatch({ type: "tick", now, elapsed: (now - started.current!) * speed, speed, script, setChosen, home: homeRef.current, hadOf: had });
    }, 250);
    return () => window.clearInterval(id);
  }, [running, speed, script, setChosen, had]);

  const now = () => Date.now();
  const actions = {
    confirm: useCallback((id: string) => dispatch({ type: "confirm", id }), []),
    setQty: useCallback((id: string, qty: number) => dispatch({ type: "qty", id, qty }), []),
    holdQty: useCallback((id: string, qty: number) => dispatch({ type: "qty", id, qty, hold: true }), []),
    saveAllConfident: useCallback(() => dispatch({ type: "saveAll" }), []),
    pick: useCallback((id: string, cardId: CardId) => dispatch({ type: "pick", id, cardId, hadOf: had }), [had]),
    suggestion: useCallback((id: string, accept: boolean) => dispatch({ type: "suggestion", id, accept, hadOf: had }), [had]),
    rotate: useCallback((id: string, side: Side) => dispatch({ type: "rotate", id, side }), []),
    recrop: useCallback((id: string, side: Side) => dispatch({ type: "recrop", id, side, now: now(), speed }), [speed]),
    swap: useCallback((id: string) => dispatch({ type: "swap", id }), []),
    unpair: useCallback((id: string) => dispatch({ type: "unpair", id }), []),
    pairLoose: useCallback(
      (frontId: string, backId: string) =>
        dispatch({ type: "pairLoose", frontId, backId, now: now(), speed, home: homeRef.current, hadOf: had }),
      [speed, had],
    ),
    reject: useCallback((id: string, side: Side) => dispatch({ type: "reject", id, side }), []),
    drop: useCallback((id: string) => dispatch({ type: "drop", id }), []),
    retry: useCallback((id: string) => dispatch({ type: "retry", id, now: now(), speed, hadOf: had }), [speed, had]),
    setDetails: useCallback((id: string, patch: Partial<Details>) => dispatch({ type: "details", id, patch }), []),
    moveHome: useCallback((id: string, homeId: string) => dispatch({ type: "home", id, homeId, hadOf: had }), [had]),
    resolveRescan: useCallback((id: string, second: boolean) => dispatch({ type: "rescan", id, second }), []),
    pinSet: useCallback(() => dispatch({ type: "pinSet" }), []),
    notInSet: useCallback((id: string) => dispatch({ type: "notInSet", id }), []),
    addMore: useCallback(() => dispatch({ type: "more", now: now(), speed, home: homeRef.current, hadOf: had }), [speed, had]),
    pause: useCallback((paused: boolean) => dispatch({ type: "pause", paused }), []),
  };

  const counts = useMemo(() => {
    const by = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
    for (const i of state.items) by[i.stage]++;
    const review = state.items.filter((i) => i.stage === "review");
    return {
      by,
      total: state.items.length + state.loose.length,
      loose: state.loose.length,
      matched: review.filter((i) => bandOf(i) === "matched").length,
      check: review.filter((i) => bandOf(i) === "check").length,
      none: review.filter((i) => bandOf(i) === "none").length,
      savedCopies: state.items.filter((i) => i.stage === "saved").reduce((n, i) => n + Math.max(0, i.qty - i.had), 0),
      newLines: state.items.filter((i) => i.stage === "saved" && i.had === 0).length,
      working: by.uploading + by.reading + by.pairing + by.matching,
      arriving: state.cursor < script.length,
    };
  }, [state.items, state.loose.length, state.cursor, script.length]);

  return { ...state, counts, actions };
}

export type IntakeSim = ReturnType<typeof useIntakeSim>;

/** Every card in the fixture set, for the manual pick. */
export function cardsForPicking(): Card[] {
  return inSet;
}

/** Variants of the fixture set, for the set step. */
export function variantNames(): string[] {
  const names = new Set<string>();
  for (const c of inSet) names.add(c.variantPath.type === "Base" ? "Base" : c.variantPath.name!);
  return [...names];
}

export function cardTitle(id: CardId | null): string {
  if (!id) return "No match";
  const c = getCard(id);
  const variant = c.variantPath.type === "Base" ? "" : ` ${c.variantPath.name}`;
  const variation = c.variation ? ` (${c.variation})` : "";
  return `#${c.cardNumber} ${playerName(c)}${variation}${variant}`;
}

export function cardSetLine(id: CardId | null): string {
  if (!id) return "";
  const c = getCard(id);
  return c.setId === SET_ID ? SET_LABEL : "Another set";
}

export const DEFAULT_DETAILS: Details = {
  condition: "Near Mint",
  grading: null,
  serial: "",
  costCents: null,
  priceCents: 18,
  location: "",
  notes: "",
};

/** The user's common price for each variant (cents). Refractor is missing on purpose. */
export const COMMON_PRICES: Record<string, number | null> = {
  Base: 18,
  Refractor: null,
  "Gold Refractor": 400,
  "Chrome Rookie Autographs": null,
};

export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return cents < 100 ? `${cents}¢` : `$${(cents / 100).toFixed(2)}`;
}
