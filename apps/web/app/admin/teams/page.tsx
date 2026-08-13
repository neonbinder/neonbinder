import TeamColorAdmin from "@/components/SetSelector/TeamColorAdmin";

/**
 * /admin/teams — team management (NEO-155).
 *
 * Today this is only the NEO-147 team colors worklist, which was originally
 * bolted onto the Set Builder page. Team management is its own concern and will
 * grow (merging duplicate rows, correcting names and leagues, reviewing
 * enrichment), so it gets a page rather than another panel on a page about
 * building sets.
 *
 * The h1 lives in the section layout, so this heads its content with an h2.
 */
export default function AdminTeamsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold mb-1">Teams</h2>
        <p className="text-sm text-slate-400">
          Teams are globally shared rows — every collector sees the same team
          data, so edits here affect everyone.
        </p>
      </div>

      <TeamColorAdmin />
    </div>
  );
}
