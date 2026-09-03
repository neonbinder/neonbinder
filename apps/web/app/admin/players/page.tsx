import PlayerManagement from "@/components/admin/PlayerManagement";

/**
 * /admin/players — Player Management (NEO-212).
 *
 * The mirror of /admin/teams, and it lands for the same reason that one did:
 * players are globally-shared rows created mid-import by the checklist
 * reconciler and the entity-review wizard, and until now there was no screen on
 * which to search them, add one by hand, or correct one that came in wrong.
 *
 * The h1 lives in the section layout, so this heads its content with an h2.
 */
export default function AdminPlayersPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold mb-1">Player Management</h2>
        <p className="text-sm text-slate-400">
          Players are globally shared rows — every collector sees the same
          player data, so edits here affect everyone.
        </p>
      </div>

      <PlayerManagement />
    </div>
  );
}
