import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

type CardChecklistItemProps = {
  card: {
    _id: Id<"cardChecklist">;
    selectorOptionId: Id<"selectorOptions">;
    cardNumber: string;
    cardName: string;
    playerIds?: Array<Id<"players">>;
    teamOnCardIds?: Array<Id<"teams">>;
    attributes?: string[];
    isRookie?: boolean;
    isRelic?: boolean;
    printRun?: number;
    autographType?: string;
    cardVariation?: string;
    features?: Record<string, string>;
    platformData: {
      bsc?: string;
      sportlots?: string;
    };
    sourcePlatformIds?: {
      bsc?: string;
      sportlots?: string;
    };
    isCustom?: boolean;
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

  const handleDelete = async () => {
    await deleteCard({ id: card._id });
    setConfirmDelete(false);
  };

  const teamLabel = useMemo(() => {
    if (!teamRows || teamRows.length === 0) return "";
    return teamRows.map((t) => t.name).join(", ");
  }, [teamRows]);

  // Build the secondary line: "<team(s)> · /99 · Refractor · On-Card auto"
  const subParts: string[] = [];
  if (teamLabel) subParts.push(teamLabel);
  if (card.printRun) subParts.push(`/${card.printRun}`);
  if (card.cardVariation) subParts.push(card.cardVariation);
  if (card.autographType) subParts.push(`${card.autographType} auto`);

  return (
    <div
      className={`flex items-center gap-3 p-2.5 border rounded-md dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700/50 group ${
        isSelected
          ? "ring-2 ring-[#00B7FF] border-[#00B7FF] bg-blue-50/40 dark:bg-blue-900/10"
          : ""
      }`}
    >
      <span className="text-sm font-mono text-gray-500 dark:text-gray-400 w-12 text-right shrink-0">
        #{card.cardNumber}
      </span>
      {/* Clicking the card body opens the detail panel. Kept as a plain div
          (not a button) so we don't add a focusable tab-stop per row into the
          virtualized list — the always-rendered "Edit" button is the
          keyboard/Maestro-targeted opener. */}
      <div
        onClick={() => onEdit(card._id)}
        className="flex-1 min-w-0 cursor-pointer"
      >
        <div className="text-sm font-medium truncate">{card.cardName}</div>
        {subParts.length > 0 && (
          <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
            {subParts.join(" · ")}
          </div>
        )}
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
      {/* Platform badges */}
      <div className="flex gap-1 shrink-0 items-center flex-wrap justify-end">
        {/* NEO-6 source-set badges: rendered only when the parent variant
            exposes a label map for that side AND this card carries a
            sourcePlatformIds entry. Replaces the bare "SL" / "BSC" tag
            with the operator-given label (e.g. "Series 2"). */}
        {sourceLabelMaps?.sportlots[card.sourcePlatformIds?.sportlots ?? ""] ? (
          <span
            className="text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-200 border border-blue-300 dark:border-blue-700"
            title={`SL source: ${card.sourcePlatformIds?.sportlots}`}
          >
            SL: {sourceLabelMaps.sportlots[card.sourcePlatformIds!.sportlots!]}
          </span>
        ) : (
          card.platformData.sportlots && (
            <span className="text-xs px-1 py-0.5 rounded bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300">
              SL
            </span>
          )
        )}
        {sourceLabelMaps?.bsc[card.sourcePlatformIds?.bsc ?? ""] ? (
          <span
            className="text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-200 border border-blue-300 dark:border-blue-700"
            title={`BSC source: ${card.sourcePlatformIds?.bsc}`}
          >
            BSC: {sourceLabelMaps.bsc[card.sourcePlatformIds!.bsc!]}
          </span>
        ) : (
          card.platformData.bsc && (
            <span className="text-xs px-1 py-0.5 rounded bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300">
              BSC
            </span>
          )
        )}
        {card.isCustom && (
          <span className="text-xs px-1 py-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-700">
            Custom
          </span>
        )}
      </div>
      {/* Actions always rendered. Hiding them behind hover (opacity-0
          group-hover:opacity-100) made the buttons unreachable for
          Maestro headless web (no mouse hover) — taps registered
          but the edit panel never opened. Always-on also keeps the
          flow keyboard-accessible (feedback_keyboard_navigation).
          Subtle text-only buttons stay visually quiet enough not
          to clutter the row. */}
      <div className="flex gap-1 shrink-0">
        <button
          onClick={() => onEdit(card._id)}
          aria-label={`Edit card ${card.cardNumber}`}
          className="px-1.5 py-0.5 text-xs text-gray-500 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-400"
          title="Edit"
        >
          Edit
        </button>
        {confirmDelete ? (
          <button
            onClick={handleDelete}
            aria-label={`Confirm delete card ${card.cardNumber}`}
            className="px-1.5 py-0.5 text-xs text-red-600 dark:text-red-400 font-medium"
          >
            Confirm?
          </button>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            onBlur={() => setConfirmDelete(false)}
            aria-label={`Delete card ${card.cardNumber}`}
            className="px-1.5 py-0.5 text-xs text-gray-500 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400"
            title="Delete"
          >
            Del
          </button>
        )}
      </div>
    </div>
  );
}
