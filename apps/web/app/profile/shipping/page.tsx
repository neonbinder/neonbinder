import ReturnAddressEditor from "@/components/modules/ReturnAddressEditor";

/**
 * Shipping — NEO-118. Kept separate from Public Profile because a home address
 * is private: publicProfiles is served unauthenticated at /u/:username,
 * userProfiles is not.
 *
 * (This section used to carry a warning that it must stay LAST on /profile or
 * it would push the credentials section past the e2e scroll budget. Its own
 * route now, so that constraint is gone — see src/layouts/profile-layout.tsx.)
 */
export default function ShippingPanel() {
  return (
    <section className="space-y-6 p-6 border border-slate-800 rounded-lg">
      <div>
        <h2 className="text-xl font-semibold">Shipping</h2>
        <p className="text-sm text-slate-400 mt-1">
          Your return address for printed shipping labels
        </p>
      </div>
      <ReturnAddressEditor />
    </section>
  );
}
