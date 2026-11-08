import { scrubOAuthParams } from "./scrub-oauth-params";
import { scrubSignedStorageUrls } from "./scrub-signed-urls";

/**
 * Every URL scrub, in one pass per payload: upload and read capabilities, then
 * the eBay return's code and state. Sentry and PostHog both send through this,
 * so a new secret shape added to either scrub reaches both (NEO-434).
 */
export const scrubUrlSecrets = <T>(value: T): T => scrubOAuthParams(scrubSignedStorageUrls(value));
