import LeagueManagement from "@/components/admin/LeagueManagement";

/**
 * /admin/leagues — League Management (NEO-240).
 *
 * The third entity editor, and it lands for the reason the other two did:
 * NEO-156 made leagues a real table but gave them no screen, so every row
 * `findOrCreateLeague` wrote mid-import stayed exactly as that one caller left
 * it — often with no abbreviation, no level and no era, and sometimes as a
 * second spelling of a league that was already there.
 *
 * The h1 lives in the section layout, so this heads its content with an h2.
 */
export default function AdminLeaguesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold mb-1">League Management</h2>
        <p className="text-sm text-slate-400">
          Leagues are globally shared rows — every collector sees the same
          league data, so edits here affect everyone.
        </p>
      </div>

      <LeagueManagement />
    </div>
  );
}
