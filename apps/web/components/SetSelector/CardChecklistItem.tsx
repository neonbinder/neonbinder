import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import CardAttentionBadge from "./CardAttentionBadge";
import { deriveCardAttention } from "./card-attention";

type CardChecklistItemProps = {
  card: {
    _id: Id<"cardChecklist">;
    selectorOptionId: Id<"selectorOptions">;
    cardNumber: string;
    cardName: string;
    playerIds?: Array<Id<"players">>;
    teamOnCardIds?: Array<Id<"teams">>;
    // NEO-102: the rest of what `deriveCardAttention` reads, beyond
    // `teamOnCardIds` above and the required `platformData` below. All
    // optional, so a caller that has not been updated still typechecks and
    // simply never shows the attention mark — but note the direction each one
    // fails in: omit a timestamp and the mark is missed; omit
    // `pendingTeamNames` and every card carrying a typed team is WRONGLY
    // marked, which is the louder bug.
    teamCheckDoneAt?: number;
    teamNoneConfirmedAt?: number;
    /**
     * Team names typed by an operator that no `teams` row exists for yet.
     *
     * NEO-208: also RENDERED now, as `Name (unconfirmed)` in the sub-line
     * below — previously this prop was read only by `deriveCardAttention`, so
     * a row could carry a team name that appeared nowhere on screen while its
     * badge stayed off, which read as the name having been dropped.
     *
     * Since NEO-208 the quick-add form sends real ids, so no NEW row is born
     * with these. They still arrive on rows written before that (and from an
     * old SPA bundle mid-cutover), and they are cleared by `updateCard` the
     * moment a real team is linked — so this is a display of legacy state,
     * not a state the product creates any more.
     */
    pendingTeamNames?: string[];
    attributes?: string[];
    isRookie?: boolean;
    isRelic?: boolean;
    printRun?: number;
    // NEO-217: legacy, still passed down by `CardChecklist` from the stored
    // row but no longer rendered — see the sub-line below, which reads
    // `features.autographed` instead.
    autographType?: string;
    cardVariation?: string;
    features?: Record<string, string>;
    // NEO-137: `ref` is the card's marketplace identity, `src` the slot on
    // the parent row naming which marketplace SET it came from.
    platformData: {
      bsc?: { ref: string; src?: string };
      sportlots?: { ref: string; src?: string };
    };
    isCustom?: boolean;
    // NEO-189: the card this row is a variation OF, when it is one.
    variationOfCardId?: Id<"cardChecklist">;
    // NEO-21: present only on guest rows — a card printed in another product
    // that also completes this checklist. `selectorOptionId` above still
    // points at its HOME set, so these three carry the guest-side context.
    isCrossListed?: boolean;
    crossListingId?: Id<"cardCrossListings">;
    homeSetLabel?: string;
  };
  // NEO-6: id→label map for the parent variant's attached platform IDs.
  // When sourcePlatformIds.<side> is set AND a label exists for that ID,
  // we render a small "Source (SL): Series 2" badge.
  sourceLabelMaps?: {
    bsc: Record<string, string>;
    sportlots: Record<string, string>;
  };
  // NEO-25: whether this row is the one open in the detail panel.
  isSelected?: boolean;
  // NEO-25: open the card detail panel for this card. State is hoisted into
  // CardChecklist; the row no longer owns an inline edit modal.
  onEdit: (id: Id<"cardChecklist">) => void;
  // NEO-189 — variation grouping. A set can be 20% variations (183 of 908 in
  // 2021 Topps Heritage), and rendering them flat buries five near-identical
  // rows between consecutive card numbers. So a parent owns its variations and
  // reveals them on demand.
  //
  // How many variations hang off this card. 0/undefined on a variation row and
  // on an ordinary card.
  variationCount?: number;
  // This row IS a variation — indented under its parent.
  isVariation?: boolean;
  // Whether this parent's variations are currently showing.
  isExpanded?: boolean;
  // Toggle this parent open/closed. Absent when the row has no variations.
  onToggleVariations?: (id: Id<"cardChecklist">) => void;
  // a11y: the parent's card number, present only on a variation row. The
  // ml-8 + left-border nesting that shows this row belongs to another card is
  // entirely visual — a screen reader (and a keyboard user tabbing straight to
  // this row's Edit/Delete button without reading the row first) gets none of
  // it otherwise, especially once virtualization has unmounted the parent row
  // this one is indented under. Folded into the subtitle text and the
  // Edit/Delete labels below so the relationship travels with the row itself
  // rather than depending on a DOM relationship to a node that may not be
  // mounted.
  parentCardNumber?: string;
};

/**
 * Map raw attribute tokens to display-friendly badge content.
 * "unmatched-bsc" / "unmatched-sl" indicate cards that only appeared on
 * one side during reconciliation — surfaced to the user as a review tag.
 */
function badgeLabel(token: string): { label: string; cls: string } {
  switch (token) {
    case "RC":
      return { label: "RC", cls: "bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-700" };
    case "AU":
      return { label: "AU", cls: "bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 border-purple-300 dark:border-purple-700" };
    case "RELIC":
      return { label: "RELIC", cls: "bg-pink-100 dark:bg-pink-900 text-pink-700 dark:text-pink-300 border-pink-300 dark:border-pink-700" };
    case "SP":
    case "SSP":
      return { label: token, cls: "bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 border-red-300 dark:border-red-700" };
    case "NUM":
      return { label: "#'d", cls: "bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-700" };
    case "unmatched-bsc":
    case "unmatched-sl":
      return { label: token === "unmatched-bsc" ? "SL only" : "BSC only", cls: "bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300 border-orange-300 dark:border-orange-700" };
    default:
      return { label: token, cls: "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 border-gray-300 dark:border-gray-600" };
  }
}

export default function CardChecklistItem({
  card,
  sourceLabelMaps,
  isSelected,
  onEdit,
  variationCount,
  isVariation,
  isExpanded,
  onToggleVariations,
  parentCardNumber,
}: CardChecklistItemProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Resolve team display names for the row sub-line. Skipped when the card
  // has no teams.
  const teamsToShow = card.teamOnCardIds ?? [];
  const teamRows = useQuery(
    api.teams.getManyByIds,
    teamsToShow.length > 0 ? { ids: teamsToShow } : "skip",
  );

  const deleteCard = useMutation(api.selectorOptions.deleteCard);
  const removeCrossListing = useMutation(
    api.selectorOptions.removeCrossListing,
  );

  // NEO-21: on a guest row the destructive action is UNLINK, not delete. The
  // card belongs to the set it was printed in — destroying it from a checklist
  // it's only visiting would take it out of its home set too (and out of every
  // other set it's cross-listed into). Only the junction row goes.
  const isCrossListed = card.isCrossListed === true && !!card.crossListingId;

  const handleDelete = async () => {
    if (isCrossListed) {
      await removeCrossListing({ crossListingId: card.crossListingId! });
    } else {
      await deleteCard({ id: card._id });
    }
    setConfirmDelete(false);
  };

  const teamLabel = useMemo(() => {
    if (!teamRows || teamRows.length === 0) return "";
    return teamRows.map((t) => t.name).join(", ");
  }, [teamRows]);

  // Build the secondary line: "<team(s)> · /99 · Refractor · On-Card auto"
  const subParts: string[] = [];
  // NEO-189/a11y: said in words, not just in indentation — see the
  // `parentCardNumber` prop note above.
  if (isVariation && parentCardNumber) {
    subParts.push(`Variation of #${parentCardNumber}`);
  }
  if (teamLabel) subParts.push(teamLabel);
  // NEO-208: an operator-typed team no `teams` row exists for yet. Rendered
  // right after the resolved teams, marked so the two are not mistaken for
  // each other — a resolved team is a link the rest of the product can act on,
  // an unconfirmed one is a string waiting for the next sync's resolve pass.
  //
  // TEXT ONLY, and inside the SAME single truncated sub-line as everything
  // else. Not a chip, not a second line, not a link: this row's height must
  // not depend on its content. A row that changes size re-measures the
  // Virtuoso list and reflows every row below it, which is the dropped-tap
  // flake the reserved-height note on that line explains at length. Pending
  // names disappear from a row (updateCard clears them on a real link) exactly
  // like an enrichment-resolved team appears on one, so this is precisely the
  // content that must not move a row.
  for (const pendingName of card.pendingTeamNames ?? []) {
    subParts.push(`${pendingName} (unconfirmed)`);
  }
  if (card.printRun) subParts.push(`/${card.printRun}`);
  if (card.cardVariation) subParts.push(card.cardVariation);
  // NEO-217: `features.autographed` is the ONE truth for whether this card is
  // an autograph — it is what the listing title and description read, and the
  // only autograph value the card detail drawer has written since NEO-71-74.
  // The legacy `autographType` column is deliberately not consulted: BSC never
  // sent it and SportLots sends the literal "Unknown", so reading it made
  // every SportLots auto render "Unknown auto". "None" is a real stored value
  // meaning "not an autograph", so it prints nothing.
  const autographed = card.features?.autographed;
  if (autographed && autographed !== "None") {
    subParts.push(`${autographed} auto`);
  }
  // NEO-189: say it in words on the parent. The caret alone shows there is
  // something to open but not that it is worth opening.
  if ((variationCount ?? 0) > 0) {
    subParts.push(
      `${variationCount} variation${variationCount === 1 ? "" : "s"}`,
    );
  }

  const hasVariations = (variationCount ?? 0) > 0;

  // NEO-102 — derived, never stored: see card-attention.ts. Cheap enough to
  // run per row inside the virtualized list (three field reads), and deriving
  // it here rather than accepting it as a prop keeps the rule in exactly one
  // place for the row, the header count, the filter and the walker.
  const attention = deriveCardAttention(card);

  return (
    <div
      onClick={() => onEdit(card._id)}
      className={`flex items-center gap-3 p-2.5 border rounded-md dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700/50 group cursor-pointer ${
        isVariation ? "ml-8 border-l-2 border-l-gray-300 dark:border-l-gray-500" : ""
      } ${
        isSelected
          ? "ring-2 ring-[#00B7FF] border-[#00B7FF] bg-blue-50/40 dark:bg-blue-900/10"
          : ""
      }`}
    >
      {/* NEO-189: the disclosure sits in a fixed-width slot on EVERY row, not
          just parents. An element that appears only on some rows would change
          their width and re-measure the virtualized list — the same reflow the
          reserved subtitle line below exists to avoid.

          a11y: the slot is w-6/h-6 (24px), not w-5 — WCAG 2.2 SC 2.5.8 Target
          Size (Minimum) requires a 24×24 CSS-pixel hit area for a control like
          this, and the glyph alone (a 12px caret with no padding) was well
          under half that. The button fills the slot so the whole 24×24 box is
          clickable/tappable, not just the visible caret — same reasoning as
          the always-reserved slot itself: uniform across every row, so this
          never changes row width based on whether a given row has variations. */}
      <span className="w-6 h-6 shrink-0 flex items-center justify-center">
        {hasVariations && onToggleVariations && (
          <button
            type="button"
            onClick={(e) => {
              // The whole row opens the detail panel; disclosing variations is
              // a different action and must not do both.
              e.stopPropagation();
              onToggleVariations(card._id);
            }}
            aria-expanded={isExpanded ? true : false}
            aria-label={
              isExpanded
                ? `Hide ${variationCount} variation${variationCount === 1 ? "" : "s"} of card ${card.cardNumber}`
                : `Show ${variationCount} variation${variationCount === 1 ? "" : "s"} of card ${card.cardNumber}`
            }
            className="w-6 h-6 flex items-center justify-center text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF] rounded"
          >
            <span aria-hidden="true" className="text-xs">
              {isExpanded ? "▾" : "▸"}
            </span>
          </button>
        )}
      </span>
      <span className="text-sm font-mono text-gray-500 dark:text-gray-400 w-12 text-right shrink-0">
        #{card.cardNumber}
      </span>
      {/* Clicking anywhere on the row opens the detail panel (the whole row
          now carries the onClick above — previously only this inner name/
          subtitle div did, so clicking the card number, badges, or empty
          row space silently did nothing). Kept as a plain div (not a
          button) so we don't add a focusable tab-stop per row into the
          virtualized list — the always-rendered "Edit" button is the
          keyboard/Maestro-targeted opener. */}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{card.cardName}</div>
        {/* Always reserve this secondary line's height, even when empty. The
            NEO-90 background enrichment resolves a card's team AFTER the row
            first renders; if this line only existed when non-empty, that later
            team would ADD a line and GROW the row. A row height change
            re-measures the Virtuoso list and reflows every row below it, which
            shifts the Edit button out from under Maestro's already-read tap
            coordinate mid-tap — CardChecklist.tsx's "bounds-then-tap window
            races Virtuoso's height recompute", the long-standing dropped-tap
            flake (checklist-bsc-team-enrichment). A constant row height,
            regardless of enrichment state, removes that reflow; a resolved team
            fills the reserved space instead of growing the row. min-h matches
            the filled text-xs line height so the reserved line is invisible. */}
        <div
          className="text-xs text-gray-500 dark:text-gray-400 truncate min-h-[1rem]"
          aria-hidden={subParts.length === 0 ? true : undefined}
        >
          {subParts.join(" · ")}
        </div>
      </div>
      {/* Attribute badges */}
      {card.attributes && card.attributes.length > 0 && (
        <div className="flex gap-1 shrink-0 flex-wrap max-w-[40%] justify-end">
          {card.attributes.map((attr) => {
            const { label, cls } = badgeLabel(attr);
            return (
              <span
                key={attr}
                className={`text-xs px-1 py-0.5 rounded border ${cls}`}
              >
                {label}
              </span>
            );
          })}
        </div>
      )}
      {/* Platform badges.

          These answer ONE question — which marketplaces can this card be listed
          to — so the visible text is always the bare platform tag. NEO-6 briefly
          rendered the source-set label inline ("SL: Base Set"), but on a 500-row
          checklist that detail is noise: every row repeats the same label, and
          which slot a card came from is a pairing concern, not a listing one.
          The label survives as a tooltip, and CardPairingModal still shows it
          inline because there it IS the thing being decided.

          One style for both sides, deliberately: two visually distinct badges
          carrying identical text would imply a distinction the row no longer
          draws. */}
      <div className="flex gap-1 shrink-0 items-center flex-wrap justify-end">
        {card.platformData.sportlots && (
          <span
            className="text-xs px-1 py-0.5 rounded bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300"
            title={
              sourceLabelMaps?.sportlots[card.platformData.sportlots.src ?? ""]
                ? `SL source: ${sourceLabelMaps.sportlots[card.platformData.sportlots.src!]}`
                : "Listable on SportLots"
            }
          >
            SL
          </span>
        )}
        {card.platformData.bsc && (
          <span
            className="text-xs px-1 py-0.5 rounded bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300"
            title={
              sourceLabelMaps?.bsc[card.platformData.bsc.src ?? ""]
                ? `BSC source: ${sourceLabelMaps.bsc[card.platformData.bsc.src!]}`
                : "Listable on BuySportsCards"
            }
          >
            BSC
          </span>
        )}
        {card.isCustom && (
          <span className="text-xs px-1 py-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-700">
            Custom
          </span>
        )}
        {/* NEO-21: names the set this card was physically printed in, so it's
            obvious the row is a visitor and not a mis-filed card. Gated on
            `isCrossListed` alone (not `homeSetLabel` truthiness) — a home
            chain missing year/manufacturer/setName would otherwise blank the
            badge entirely and the row would look like an ordinary card. */}
        {isCrossListed && (
          <span
            className="text-xs px-1.5 py-0.5 rounded bg-[#00B7FF]/10 text-[#00B7FF] border border-[#00B7FF]/50"
            title={`Cross-release card — physically printed in ${card.homeSetLabel || "another set"}, but it completes this set's checklist.`}
          >
            ↗ {card.homeSetLabel || "another set"}
          </span>
        )}
      </div>
      {/* NEO-102 — attention mark, in an ALWAYS-RESERVED slot.

          Same reasoning as the disclosure slot on the left and the reserved
          subtitle line above: this state flips under the operator (the
          background BSC team pass lands, or they fix the card in the walker),
          and a row that changes size when it flips re-measures the Virtuoso
          list and reflows every row below — the dropped-tap flake. A constant
          20px slot on every row means the mark can appear and disappear
          without moving anything. */}
      <span className="w-5 h-5 shrink-0 flex items-center justify-center">
        {attention.length > 0 && (
          <CardAttentionBadge items={attention} cardNumber={card.cardNumber} />
        )}
      </span>
      {/* Actions always rendered. Hiding them behind hover (opacity-0
          group-hover:opacity-100) made the buttons unreachable for
          Maestro headless web (no mouse hover) — taps registered
          but the edit panel never opened. Always-on also keeps the
          flow keyboard-accessible (feedback_keyboard_navigation).
          Subtle text-only buttons stay visually quiet enough not
          to clutter the row. */}
      <div className="flex gap-1 shrink-0">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit(card._id);
          }}
          aria-label={`Edit card ${card.cardNumber}`}
          className="px-1.5 py-0.5 text-xs text-gray-500 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-400"
          title="Edit"
        >
          Edit
        </button>
        {confirmDelete ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              void handleDelete();
            }}
            aria-label={
              isCrossListed
                ? `Confirm remove card ${card.cardNumber} from this set`
                : `Confirm delete card ${card.cardNumber}`
            }
            className="px-1.5 py-0.5 text-xs text-red-600 dark:text-red-400 font-medium"
          >
            Confirm?
          </button>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setConfirmDelete(true);
            }}
            onBlur={() => setConfirmDelete(false)}
            aria-label={
              isCrossListed
                ? `Remove card ${card.cardNumber} from this set`
                : `Delete card ${card.cardNumber}`
            }
            className="px-1.5 py-0.5 text-xs text-gray-500 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400"
            title={
              isCrossListed
                ? "Remove from this set — the card stays in the set it was printed in"
                : "Delete"
            }
          >
            {isCrossListed ? "Unlink" : "Del"}
          </button>
        )}
      </div>
    </div>
  );
}
