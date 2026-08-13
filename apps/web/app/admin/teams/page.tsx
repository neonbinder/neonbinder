import TeamManagement from "@/components/admin/TeamManagement";

/**
 * /admin/teams — Team Management (NEO-155 gave it a home, NEO-156 made it a
 * management screen rather than a colors worklist).
 *
 * The h1 lives in the section layout, so this heads its content with an h2.
 */
export default function AdminTeamsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold mb-1">Team Management</h2>
        <p className="text-sm text-slate-400">
          Teams are globally shared rows — every collector sees the same team
          data, so edits here affect everyone.
        </p>
      </div>

      <TeamManagement />
    </div>
  );
}
