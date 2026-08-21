import EasypostKeyEditor from "@/components/modules/EasypostKeyEditor";

/**
 * Postage — NEO-120. The seller's EasyPost API key, used to buy USPS letter
 * postage for printed shipping labels.
 *
 * Its own section rather than a block inside Shipping: the return address is
 * data we render onto labels, while the EasyPost key is a credential that
 * spends the seller's money — different sensitivity, different lifecycle, and
 * the key editor never displays what is stored (see EasypostKeyEditor).
 *
 * No entry in profile-layout's useWarmProfileQueries: the panel's state comes
 * from Convex ACTIONS (the browser service owns the answer), so there is no
 * query subscription to keep warm.
 */
export default function PostagePanel() {
  return (
    <section className="space-y-6 p-6 border border-slate-800 rounded-lg">
      <div>
        <h2 className="text-xl font-semibold">Postage</h2>
        <p className="text-sm text-slate-400 mt-1">
          Buy USPS letter postage for your labels
        </p>
      </div>
      <EasypostKeyEditor />
    </section>
  );
}
