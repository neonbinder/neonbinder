import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import NeonButton from "../modules/NeonButton";
import type { GenericId } from "convex/values";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";

export default function CardForm({
  setVariantId,
  onDone,
}: {
  setVariantId: GenericId<"selectorOptions">;
  onDone?: () => void;
}) {
  const [cardNumber, setCardNumber] = useState("");
  const [playerName, setPlayerName] = useState("");
  // NEO-26: free-text team string is collected here for the
  // UnknownEntitiesDialog confirmation flow (`teams: [string]` →
  // pendingTeamNames → operator confirm → teams entity). No longer
  // written to a `cardChecklist.team` column.
  const [team, setTeam] = useState("");
  const [attributes, setAttributes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const addCustomCard = useMutation(api.selectorOptions.addCustomCard);

  // Unique per-field class so Maestro inputText targets the tapped field rather
  // than the first input sharing the className (see useFieldTestClass).
  const fieldClass = useFieldTestClass();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cardNumber.trim()) return;

    setSaving(true);
    setError(null);
    try {
      const teamTrimmed = team.trim();
      await addCustomCard({
        selectorOptionId: setVariantId,
        cardNumber: cardNumber.trim(),
        cardName: playerName.trim() || `Card #${cardNumber.trim()}`,
        // NEO-26: route the team string via `teams` for entity-link
        // resolution; no `team` arg anymore.
        ...(teamTrimmed ? { teams: [teamTrimmed] } : {}),
        attributes: attributes.trim()
          ? attributes
              .split(",")
              .map((a) => a.trim())
              .filter(Boolean)
          : undefined,
      });
      setCardNumber("");
      setPlayerName("");
      setTeam("");
      setAttributes("");
      onDone?.();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to add card",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
      <h2 className="text-xl font-semibold mb-4">Add Card</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-2">
            Card Number
          </label>
          <input
            type="text"
            value={cardNumber}
            onChange={(e) => setCardNumber(e.target.value)}
            className={`${fieldClass("cardNumber")} w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600`}
            placeholder="e.g., 1, 2A, 2B"
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-2">
            Player Name
          </label>
          <input
            type="text"
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
            className={`${fieldClass("playerName")} w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600`}
            placeholder="e.g., Mike Trout"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-2">
            Team (optional)
          </label>
          <input
            type="text"
            value={team}
            onChange={(e) => setTeam(e.target.value)}
            className={`${fieldClass("team")} w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600`}
            placeholder="e.g., Los Angeles Angels"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-2">
            Attributes (comma-separated)
          </label>
          <input
            type="text"
            value={attributes}
            onChange={(e) => setAttributes(e.target.value)}
            className={`${fieldClass("attributes")} w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600`}
            placeholder="e.g., RC, AU, SP"
          />
        </div>
        {error && (
          <div className="p-3 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded-md text-red-800 dark:text-red-200 text-sm">
            {error}
          </div>
        )}
        <div className="flex gap-2">
          <NeonButton type="submit" disabled={saving}>
            {saving ? "Adding..." : "Add Card"}
          </NeonButton>
          <NeonButton cancel onClick={onDone}>
            Cancel
          </NeonButton>
        </div>
      </form>
    </div>
  );
}
