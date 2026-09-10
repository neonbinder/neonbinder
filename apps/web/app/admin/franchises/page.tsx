import FranchiseManagement from "@/components/admin/FranchiseManagement";

/**
 * /admin/franchises — Franchise Management (NEO-254).
 *
 * The fourth entity editor. Teams are one row per historical NAME, which is
 * what a card says and what a stint has to read as; a franchise is the
 * operator saying which of those rows are one continuous club. Nothing infers
 * it — see `convex/franchises.ts`.
 *
 * The h1 lives in the section layout, so this heads its content with an h2.
 */
export default function AdminFranchisesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold mb-1">Franchise Management</h2>
        <p className="text-sm text-slate-400">
          String a club's old names together — Oilers to Titans, Expos to Nats.
          Franchises are globally shared rows, so edits here affect everyone.
        </p>
      </div>

      <FranchiseManagement />
    </div>
  );
}
