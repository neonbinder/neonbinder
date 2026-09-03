/**
 * NEO-212 — "before you create this, is it one of these?"
 *
 * Two screens ask the same question about the same globally-shared rows: the
 * entity review wizard, deciding whether an unresolved checklist name is a
 * player/team we already know, and `/admin/players`' add form, where an
 * operator is about to hand-type a name that may already exist under a
 * different spelling. Both are guarding the SAME failure — a second Mike Trout
 * row that no lookup can ever tell from the first — so the affordance is one
 * component rather than two that drift.
 *
 * ## Why the default pick label is `Link to {name}`
 * The wizard's Maestro flows already tap `Link to {name}`. Changing that
 * default to something neutral would have been a silent rename of an E2E
 * contract, so the default IS the wizard's wording and the admin page passes
 * its own (`Open {name}`) — the page opens a row for editing, it does not link
 * anything to anything, and saying "Link" there would describe an action the
 * button does not perform.
 *
 * ## Exact matches come first, and are tagged
 * `confidence: "exact"` means the normalized name is identical — the operator
 * is almost certainly looking at the row they were about to re-create. Sorting
 * it to the top and labelling it "same name" is the difference between the
 * panel being a warning and it being a list.
 */

/** One candidate row. Deliberately structural, not `Doc<"players">`: the panel
 *  is shared by the player and team wizards and must not import either shape. */
export interface NearMatch {
  _id: string;
  name: string;
  confidence: "exact" | "close";
}

export interface NearMatchPanelProps {
  /** Which entity table the matches came from. Names the list for a screen
   *  reader, so a screen showing both lists stays unambiguous. */
  kind: "player" | "team";
  /**
   * `undefined` is "not asked / still loading" and renders nothing, exactly as
   * an empty array does — a panel that flickers "Possible matches" with no
   * rows while a query is in flight is worse than no panel.
   */
  matches: NearMatch[] | undefined;
  onPick: (id: string, name: string) => void;
  /** Accessible name for each row's button. Defaults to the wizard's wording. */
  pickLabel?: (name: string) => string;
  className?: string;
}

/**
 * Is one of these the same name, normalized? Exported because the CALLER, not
 * this panel, owns the consequence: the admin add form demotes its create
 * button to "Create anyway" when this is true, and only the form knows what
 * its primary action should become.
 */
export function hasExact(matches: NearMatch[] | undefined): boolean {
  return (matches ?? []).some((m) => m.confidence === "exact");
}

const defaultPickLabel = (name: string) => `Link to ${name}`;

export function NearMatchPanel({
  kind,
  matches,
  onPick,
  pickLabel = defaultPickLabel,
  className = "",
}: NearMatchPanelProps) {
  // Exact first, otherwise stable in the order the server ranked them.
  const ordered = [...(matches ?? [])].sort((a, b) => {
    const aExact = a.confidence === "exact" ? 0 : 1;
    const bExact = b.confidence === "exact" ? 0 : 1;
    return aExact - bExact;
  });

  const count = ordered.length;

  return (
    // The live region is mounted from the FIRST render, empty, and stays
    // mounted when there is nothing to show. A live region inserted at the
    // same instant its text appears is announced unreliably (notably
    // VoiceOver) — the same reason `primitives/CopyButton` keeps its status
    // node always-on. The visible panel below is what is conditional; this
    // span renders no pixels either way.
    <>
      <span aria-live="polite" className="sr-only">
        {count === 0
          ? ""
          : `${count} possible match${count === 1 ? "" : "es"}`}
      </span>

      {count > 0 && (
        <div
          className={`rounded-md border border-neon-blue/40 bg-neon-blue/5 p-3 space-y-2 ${className}`.trim()}
        >
          <p className="text-sm font-medium text-neon-blue">Possible matches</p>
          <ul className="space-y-1" aria-label={`Possible ${kind} matches`}>
            {ordered.map((match) => (
              <li key={match._id}>
                <button
                  type="button"
                  onClick={() => onPick(match._id, match.name)}
                  aria-label={pickLabel(match.name)}
                  // min-h-6 keeps the row on the WCAG 2.2 SC 2.5.8 24px floor
                  // even when the name wraps to a single short line.
                  className="flex min-h-6 w-full items-center gap-2 rounded px-2 py-1 text-left text-sm text-slate-200 transition-colors hover:bg-neon-blue/10 focus:outline-none focus:ring-2 focus:ring-neon-blue"
                >
                  <span className="flex-1 truncate">{match.name}</span>
                  {match.confidence === "exact" && (
                    <span className="shrink-0 rounded bg-neon-blue/20 px-1.5 py-0.5 text-xs text-neon-blue">
                      same name
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

export default NearMatchPanel;
