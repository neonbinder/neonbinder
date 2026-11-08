import { useState } from "react";
import { Navigate, useLocation } from "react-router";
import { EBAY_PATH } from "@/lib/marketplace/listing-copy";
import { ebayReturnFrom, readEbayReturn, type EbayReturnState } from "@/app/profile/credentials/ebay/oauth-return";

/**
 * `/profile/ebay` — NEO-415. eBay is set up under Profile → Credentials, and
 * this address is only where eBay's trip home lands: NEO-422's static return
 * pages forward to it (`EBAY_RETURN_DESTINATION`), and they are live in
 * production, so it stays.
 *
 * `src/ebay-return-address.ts` has already moved what eBay sent off the address
 * into this history entry's state. This swaps itself for Credentials with eBay
 * picked (`replace`: Back never lands here), handing that on in location state,
 * and the eBay panel spends it and clears it. A plain visit (an old link, a
 * bookmark) just opens the panel.
 *
 * The query is still read for an arrival by client-side navigation, which that
 * module, running once at startup, cannot see.
 */
export default function EbayReturnLanding() {
  const { search } = useLocation();
  // Read once: the forward below replaces the history entry straight away, and a
  // re-render before this unmounts must not forward again with nothing.
  const [state] = useState<EbayReturnState | null>(() => {
    const handed = ebayReturnFrom(window.history.state) ?? readEbayReturn(new URLSearchParams(search));
    return handed ? { ebayReturn: handed } : null;
  });
  return <Navigate to={EBAY_PATH} replace state={state} />;
}
