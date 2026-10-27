import { setLabel } from "../data/labels";
import { isHome, type Container, type ContainerLabel, type ContainerRule, type SetRef, type Side } from "../data/types";
import {
  containerShareTarget,
  setShareTarget,
  type BinderLayout,
  type LayoutMode,
  type ShareTarget,
  type ViewKey,
} from "./model";
import { describeSmartRule } from "./RuleBuilder";
import type { PocketVariant } from "./Pocket";

/**
 * NEO-350 / NEO-359 — what is open in My Binders, as data for the one open
 * view (`BinderView.tsx`). A binder you file in, a box, a smart binder, a
 * system container, the Want List, All my cards or a set you are browsing
 * all open into the same header and cover: everything that differs between
 * them is decided here, once, and the view only reads it.
 *
 * NEO-364: the side matters for one container. The Up for Trade pile is the
 * one view that spans both sides; from My Binders it opens as a binder
 * (unchanged), from My Boxes as a box (`box: true`, a stack with no rows).
 * Same pile, same count.
 */

export interface Tally {
  have: number | null;
  need: number | null;
  cards: number | null;
}

export interface OpenView {
  /** Stable per view: the container id, `set:<id>` or `all`. */
  key: string;
  title: string;
  /** The chip beside the title. `sale`: the yellow tag (a box, or the trade pile drawn as one). */
  badge: { text: string; tone: "smart" | "browse" | "sale" } | null;
  /** What Share shares; null: nothing to share (or no share links here). */
  share: ShareTarget | null;
  /** NEO-362 — the binder has a Settings button (order, empty slots, its rule). */
  settings: boolean;
  /** NEO-362 — a smart binder: Find cards is a button in its header. */
  findCards: boolean;
  /** Sort and filters for the master pile (All my cards). */
  pileTools: boolean;
  /** The container whose spine label the cover offers to edit and print, and the label it wears. */
  label: { container: Container; label: ContainerLabel } | null;
  /** The container the cover offers to rename or delete (the collector's own). */
  editable: Container | null;
  tally: Tally;
  /** Tally as wants (to chase, landed), in the Want List's pink. */
  want: boolean;
  /** The cover's lines, the first one also on a phone. */
  blurb: string[];
  /** What Checklists and My Cards look through with this open; null: unchanged. */
  scopeLine: string | null;
  /** The binder's vinyl. */
  vinyl: string;
  /** Sleeves with Add on every card (a set), or a binder's own pockets. */
  pockets: PocketVariant;
  /**
   * A copy in a box wears a "For sale" tag on its pocket. Only the Up for
   * Trade pile: the one collection view that lists box copies (trade spans
   * collection and inventory).
   */
  saleTags: boolean;
  /**
   * Open as a box, not a binder of pages: a home box's five rows, or (the
   * trade pile from My Boxes) one stack with no rows.
   */
  box: boolean;
}

/** The default layout of a view: pockets for binders, sets and smart binders; a stack for the piles. */
export function defaultLayout(view: ViewKey, container: Container | undefined): LayoutMode {
  if (view.kind === "set") return "pockets";
  if (view.kind !== "binder" || !container) return "stack";
  return container.system === "trade" ? "stack" : "pockets";
}

export function viewKey(view: ViewKey): string {
  if (view.kind === "binder") return view.binderId;
  if (view.kind === "set") return `set:${view.setId}`;
  return view.kind;
}

export interface OpenInput {
  view: ViewKey;
  container: Container | undefined;
  /** The browsed set, once it is in. */
  set: SetRef | null | undefined;
  mode: LayoutMode;
  /** NEO-362 — a binder's layout, its settings resolved; null: no settings here. */
  layout?: BinderLayout | null;
  tally: Tally;
  /** The label the container wears (its own, else its default). */
  label: ContainerLabel;
  /** A smart binder's rule in words, when the store can say it (the demo). */
  describeRule?: (rule: ContainerRule) => string;
  /**
   * Which Share this store has: `"example"` (the demo's, capability `share`:
   * binders, the Want List, Up for Trade and sets), `"live"` (capability
   * `shareLinks`: binders, the Want List and Up for Trade, never a set), or
   * none.
   */
  share: "example" | "live" | null;
  /** The screen it opens on: My Binders (default) or My Boxes. */
  side?: Side;
}

export function openView(input: OpenInput): OpenView {
  const { view, container, set, mode, tally, label, describeRule, side = "collection" } = input;
  const want = container?.system === "want";
  const tradeBox = view.kind === "binder" && container?.system === "trade" && side === "inventory";
  const box = view.kind === "binder" && (container?.kind === "box" || tradeBox);
  const browsing = view.kind === "set";
  const title = browsing
    ? set
      ? setLabel(set)
      : "Browse a set"
    : view.kind === "all"
      ? "All my cards"
      : (container?.name ?? "Binder");
  let share: ShareTarget | null = null;
  // The inventory has no Share of its own: no Share on a box, Unsorted, or
  // Up for Trade drawn as a box (the for-sale stock's page is the profile's).
  if (side === "inventory") {
    share = null;
  } else if (input.share === "example") {
    share = browsing ? (set ? setShareTarget(set) : null) : container ? containerShareTarget(container) : null;
  } else if (input.share === "live" && view.kind === "binder" && container && !container.rule) {
    share = containerShareTarget(container);
  }
  return {
    key: viewKey(view),
    title,
    badge: browsing
      ? { text: "Browsing", tone: "browse" }
      : container?.rule || container?.smartRule
        ? { text: "Smart", tone: "smart" }
        : tradeBox
          ? { text: "Trade", tone: "sale" }
          : box
            ? { text: "For sale", tone: "sale" }
            : null,
    share,
    settings: !!input.layout && side !== "inventory",
    findCards: !!input.layout && !!container?.smartRule && side !== "inventory",
    pileTools: view.kind === "all",
    label: container ? { container, label } : null,
    editable: container && !container.system ? container : null,
    tally,
    want,
    blurb: blurbFor(input),
    // The inventory never narrows the collection's counts.
    scopeLine: side === "inventory" ? null : scopeLineFor(view, container),
    vinyl: browsing ? "#1e293b" : label.background,
    pockets: browsing ? "browse" : "binder",
    saleTags: view.kind === "binder" && container?.system === "trade" && !tradeBox,
    box,
  };
}

const SORTED_BY = { checklist: "checklist", player: "player", team: "team" } as const;

function blurbFor({ view, container, mode, layout, describeRule, side }: OpenInput): string[] {
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
      "Every card in your binders, one pocket per copy.",
      "Press a card to pull it out of the sleeve and see the details.",
    ];
  }
  if (!container) return [];
  if (container.system === "want") {
    return [
      "Cards you're chasing, grouped by the binder they're for.",
      "Land one? Press its sleeve to add it.",
      "While this is open, the hunt below adds to your Want List.",
    ];
  }
  if (container.system === "trade" && side === "inventory") {
    return [
      "Copies you'd swap, wherever they live: a box, or one of your binders.",
      "Each one stays where it lives. Press a card to see it, or to take it off the pile.",
    ];
  }
  if (container.system === "unsorted") {
    return [
      "Everything in here is for sale. A card lands here when you don't pick a box.",
      "Drag a card between rows, or pick its row.",
    ];
  }
  if (container.system === "trade") {
    return [
      "Copies you'd swap. Each one still lives in its own binder or box.",
      "Hunt for a card below and put it up for trade.",
    ];
  }
  const lines: string[] = [];
  if (container.description) lines.push(container.description);
  if (container.rule) {
    lines.push(describeRule ? `Fills itself: ${describeRule(container.rule)}.` : "Fills itself from its rule.");
    return lines;
  }
  if (container.kind === "box") {
    lines.push("Everything in here is for sale. Drag a card between rows, or pick its row.");
    return lines;
  }
  if (container.smartRule) {
    lines.push(`Takes ${describeSmartRule(container.smartRule, container.ruleNames)}. Find cards pulls in the ones you have.`);
  }
  if (layout?.sort) {
    lines.push(
      `Keeps itself sorted by ${SORTED_BY[layout.sort]}${layout.emptySlots ? ", with empty slots for the cards it still needs" : ""}. Hunt for a card below and drop it on the binder.`,
    );
  } else if (mode === "pockets") {
    lines.push("Hunt for a card below and drag it into any pocket, or press an empty pocket to fill that one.");
  } else {
    lines.push("Hunt for a card below and drag it onto the binder to file it here.");
  }
  return lines;
}

function scopeLineFor(view: ViewKey, container: Container | undefined): string | null {
  if (view.kind === "set") return null;
  if (view.kind === "all") return "Checklists and My Cards are looking through everything.";
  if (!container) return null;
  if (container.system === "want") {
    return "Checklists and My Cards are looking through everything, with your wants lit up.";
  }
  if (container.rule) {
    return `${container.name} fills itself, so Checklists and My Cards look through everything.`;
  }
  if (!isHome(container)) return "Checklists and My Cards are looking through everything.";
  // A box is Inventory's: it never narrows the collection.
  if (container.kind === "box") return null;
  return `Checklists and My Cards are looking through ${container.name}.`;
}
