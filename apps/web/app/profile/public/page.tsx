import PublicProfileEditor from "@/components/modules/PublicProfileEditor";

export default function PublicProfilePanel() {
  return (
    <section className="space-y-6 p-6 border border-rule rounded-lg">
      <div>
        <h2 className="text-xl font-semibold">Public Profile</h2>
        <p className="text-sm text-ink-3 mt-1">
          Your public collector page at neonbinder.com/u/[username]
        </p>
      </div>
      <PublicProfileEditor />
    </section>
  );
}
