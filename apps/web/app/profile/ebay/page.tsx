import { Navigate, useLocation } from "react-router";
import { EBAY_PATH } from "@/lib/marketplace/listing-copy";
import { readEbayReturn, type EbayReturnState } from "@/app/profile/credentials/ebay/oauth-return";

/**
 * `/profile/ebay` — NEO-415. eBay is set up under Profile → Credentials, and
 * this address is only where eBay's trip home lands: NEO-422's static return
 * pages forward to it (`EBAY_RETURN_DESTINATION`), and they are live in
 * production, so it stays.
 *
 * It swaps itself for Credentials with eBay picked (`replace`: Back never
 * lands here, and the code-carrying address leaves history at once). What
 * eBay sent rides along in location state, never the URL, and the eBay
 * panel spends it and clears it. A plain visit (an old link, a bookmark) just
 * opens the panel.
 */
export default function EbayReturnLanding() {
  const { search } = useLocation();
  const handed = readEbayReturn(new URLSearchParams(search));
  const state: EbayReturnState | null = handed ? { ebayReturn: handed } : null;
  return <Navigate to={EBAY_PATH} replace state={state} />;
}
