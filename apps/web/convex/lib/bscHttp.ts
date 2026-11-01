/**
 * The one definition of how NeonBinder addresses BuySportsCards' API: its
 * base URL and the request headers it insists on. Pure and runtime-free, so
 * both the Node adapter (`adapters/buysportscards.ts`) and the default-runtime
 * seller client (`adapters/bscSeller.ts`, NEO-370) read it.
 *
 * Wire vocabulary only; no adapter logic lives here.
 */

/** BSC's API host. (The www host serves pages, not the API: CloudFront 403s.) */
export const BSC_API_BASE = "https://api-prod.buysportscards.com";

/**
 * Browser-mimicking headers BSC requires (without them CloudFront rejects the
 * request as bot traffic). `assumedrole: sellers` is mandatory and scopes the
 * session to a seller context.
 *
 * `json: false` leaves out the JSON content type, for a multipart upload whose
 * boundary the runtime's `FormData` sets itself.
 */
export function bscHeaders(
  bearerToken: string,
  opts: { json?: boolean } = {},
): Record<string, string> {
  return {
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    assumedrole: "sellers",
    ...(opts.json === false ? {} : { "content-type": "application/json" }),
    origin: "https://www.buysportscards.com",
    referer: "https://www.buysportscards.com/",
    "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": "macOS",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    authority: "api-prod.buysportscards.com",
    authorization: `Bearer ${bearerToken}`,
  };
}
