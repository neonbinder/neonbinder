import { describeRule, getSet, setLabel } from "../../prototypes/_shared/data";
import type { LayoutMode, ViewKey } from "../../prototypes/p2/model";
import type { CollectionBinder, CollectionStore } from "../store";
import { binderShareTarget, binderTally, liveryOf, setShareTarget, type ShareTarget } from "./model";
import type { PocketVariant } from "./Pocket";

/**
 * NEO-350 — what is open in My Binders, as data for the one binder view
 * (`BinderView.tsx`). A binder you file in, a smart binder, a system binder,
 * the Want List, All my cards or a set you are browsing all open into the
 * same header, cover and spread: everything that differs between them is
 * decided here, once, and the view only reads it.
 */

export interface Tally {
  have: number | null;
  need: number | null;
  cards: number | null;
}

export interface OpenView {
  /** Stable per view: the binder id, `set:<id>` or `all`. */
  key: string;
  title: string;
  /** The chip beside the title. */
  badge: { text: string; tone: "smart" | "browse" } | null;
  /** What Share shares; null: nothing to share. */
  share: ShareTarget | null;
  /** The layout toggle's current choice; null: not offered. */
  layout: LayoutMode | null;
  /** Sort and filters for the master pile (All my cards). */
  pileTools: boolean;
  /** The binder whose spine label the cover offers to edit and print. */
  label: CollectionBinder | null;
  tally: Tally;
  /** Tally as wants (to chase, landed), in the Want List's pink. */
  want: boolean;
  /** The cover's lines, first one also on a phone. */
  blurb: string[];
  /** What Checklists and My Cards look through with this open; null: unchanged. */
  scopeLine: string | null;
  /** The binder's vinyl. */
  vinyl: string;
  /** Sleeves with Add on every card (a set), or a binder's own pockets. */
  pockets: PocketVariant;
}

/** The default layout of a view: real pages where it has them, else a stack. */
export function defaultLayout(view: ViewKey, binder: CollectionBinder | undefined): LayoutMode {
  if (view.kind === "set") return "pockets";
  return !binder ? "stack" : binder.kind === "smart" || binder.layout ? "pockets" : "stack";
}

export function viewKey(view: ViewKey): string {
  return view.kind === "binder" ? view.binderId : view.kind === "set" ? `set:${view.setId}` : "all";
}

export function openView(
  view: ViewKey,
  binder: CollectionBinder | undefined,
  store: CollectionStore,
  mode: LayoutMode,
): OpenView {
  const want = binder?.system === "want";
  const set = view.kind === "set" ? getSet(view.setId) : null;
  return {
    key: viewKey(view),
    title: set ? setLabel(set) : view.kind === "binder" ? (binder?.name ?? "Binder") : "All my cards",
    badge: set
      ? { text: "Browsing", tone: "browse" }
      : binder?.kind === "smart"
        ? { text: "Smart", tone: "smart" }
        : null,
    share: set ? setShareTarget(set) : binder ? binderShareTarget(binder) : null,
    layout: set || (binder && !want) ? mode : null,
    pileTools: view.kind === "all",
    label: binder ?? null,
    tally: tallyFor(view, binder, store),
    want,
    blurb: blurbFor(view, binder, mode),
    scopeLine: scopeLineFor(view, binder),
    vinyl: set ? "#1e293b" : liveryOf(binder ?? "all").primary,
    pockets: set ? "browse" : "binder",
  };
}

function tallyFor(view: ViewKey, binder: CollectionBinder | undefined, store: CollectionStore): Tally {
  const { copies } = store.state;
  if (view.kind === "set") {
    const c = store.completion(view.setId);
    return { have: c.owned, need: c.total - c.owned, cards: null };
  }
  if (view.kind === "all") {
    return { have: null, need: null, cards: copies.reduce((n, c) => n + c.quantity, 0) };
  }
  if (!binder) return { have: null, need: null, cards: 0 };
  if (binder.system === "want") {
    const landed = store.wantCardIds.filter((id) => store.ownedCount(id) > 0).length;
    return { have: landed, need: store.wantCardIds.length - landed, cards: null };
  }
  const count = binderTally(binder, copies);
  return { have: count.have ?? null, need: count.need ?? null, cards: count.cards };
}

function blurbFor(view: ViewKey, binder: CollectionBinder | undefined, mode: LayoutMode): string[] {
  if (view.kind === "set") {
    return [
      mode === "pockets"
        ? "Every card in the set, in checklist order. Each insert starts a fresh page."
        : "Every card in the set, in checklist order, packed tight.",
      "Got one? Hit Add on its sleeve.",
    ];
  }
  if (view.kind === "all") {
    return [
      "Every card you own, one pocket per copy. A yellow tag means it's for sale.",
      "Press a card to pull it out of the sleeve and see the details.",
    ];
  }
  if (!binder) return [];
  if (binder.system === "want") {
    return [
      "Cards you're chasing, grouped by the binder they're for.",
      "Land one? Press its sleeve to add it.",
      "While this is open, the hunt below adds to your Want List.",
    ];
  }
  const lines: string[] = [];
  if (binder.description) lines.push(binder.description);
  if (binder.kind === "smart") {
    lines.push(`Fills itself: ${describeRule(binder.rule)}.`);
    if (mode === "pockets") lines.push("Empty sleeves are your needs. Got one? Press it.");
  } else if (mode === "pockets") {
    lines.push("Hunt for a card below and drag it into any pocket, or press an empty pocket to fill that one.");
  } else {
    lines.push("Hunt for a card below and drag it onto the binder to file it here.");
  }
  return lines;
}

function scopeLineFor(view: ViewKey, binder: CollectionBinder | undefined): string | null {
  if (view.kind === "set") return null;
  if (view.kind === "all") return "Checklists and My Cards are looking through everything.";
  if (!binder) return null;
  if (binder.system === "want") {
    return "Checklists and My Cards are looking through everything, with your wants lit up.";
  }
  if (binder.kind === "smart") {
    return `${binder.name} fills itself, so Checklists and My Cards look through everything.`;
  }
  return `Checklists and My Cards are looking through ${binder.name}.`;
}
