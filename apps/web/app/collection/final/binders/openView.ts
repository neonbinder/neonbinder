import { setLabel } from "../data/labels";
import { isHome, type Container, type ContainerLabel, type ContainerRule, type SetRef } from "../data/types";
import { containerShareTarget, setShareTarget, type LayoutMode, type ShareTarget, type ViewKey } from "./model";
import type { PocketVariant } from "./Pocket";

/**
 * NEO-350 / NEO-359 — what is open in My Binders, as data for the one open
 * view (`BinderView.tsx`). A binder you file in, a box, a smart binder, a
 * system container, the Want List, All my cards or a set you are browsing
 * all open into the same header and cover: everything that differs between
 * them is decided here, once, and the view only reads it.
 */

export interface Tally {
  have: number | null;
  need: number | null;
  cards: number | null;
}

export interface OpenView {
  /** Stable per view: the container id, `set:<id>`, `all` or `sale`. */
  key: string;
  title: string;
  /** The chip beside the title. */
  badge: { text: string; tone: "smart" | "browse" | "sale" } | null;
  /** What Share shares; null: nothing to share (or no share links here). */
  share: ShareTarget | null;
  /** The layout toggle's current choice; null: not offered. */
  layout: LayoutMode | null;
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
  /** Open as a box (five rows), not a binder of pages. */
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
  tally: Tally;
  /** The label the container wears (its own, else its default). */
  label: ContainerLabel;
  /** A smart binder's rule in words, when the store can say it (the demo). */
  describeRule?: (rule: ContainerRule) => string;
  /** Share links exist here (capability `share`). */
  canShare: boolean;
}

export function openView(input: OpenInput): OpenView {
  const { view, container, set, mode, tally, label, describeRule, canShare } = input;
  const want = container?.system === "want";
  const box = view.kind === "binder" && container?.kind === "box";
  const browsing = view.kind === "set";
  const title = browsing
    ? set
      ? setLabel(set)
      : "Browse a set"
    : view.kind === "all"
      ? "All my cards"
      : view.kind === "sale"
        ? "For sale"
        : (container?.name ?? "Binder");
  let share: ShareTarget | null = null;
  if (canShare) share = browsing ? (set ? setShareTarget(set) : null) : container ? containerShareTarget(container) : null;
  return {
    key: viewKey(view),
    title,
    badge: browsing
      ? { text: "Browsing", tone: "browse" }
      : container?.rule
        ? { text: "Smart", tone: "smart" }
        : box
          ? { text: "For sale", tone: "sale" }
          : null,
    share,
    layout: box || want || view.kind === "sale" ? null : browsing || container ? mode : null,
    pileTools: view.kind === "all",
    label: container ? { container, label } : null,
    editable: container && !container.system ? container : null,
    tally,
    want,
    blurb: blurbFor(input),
    scopeLine: scopeLineFor(view, container),
    vinyl: browsing ? "#1e293b" : label.background,
    pockets: browsing ? "browse" : "binder",
    box,
  };
}

function blurbFor({ view, container, mode, describeRule }: OpenInput): string[] {
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
      "Every card you own, one pocket per copy. A yellow tag means it lives in a box, for sale.",
      "Press a card to pull it out of the sleeve and see the details.",
    ];
  }
  if (view.kind === "sale") {
    return ["Every card in every box you own: the stuff that's for sale."];
  }
  if (!container) return [];
  if (container.system === "want") {
    return [
      "Cards you're chasing, grouped by the binder they're for.",
      "Land one? Press its sleeve to add it.",
      "While this is open, the hunt below adds to your Want List.",
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
  if (mode === "pockets") {
    lines.push("Hunt for a card below and drag it into any pocket, or press an empty pocket to fill that one.");
  } else {
    lines.push("Hunt for a card below and drag it onto the binder to file it here.");
  }
  return lines;
}

function scopeLineFor(view: ViewKey, container: Container | undefined): string | null {
  if (view.kind === "set" || view.kind === "sale") return null;
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
