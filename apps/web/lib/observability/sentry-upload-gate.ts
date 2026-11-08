/**
 * NEO-439: the Sentry build plugin creates a release and uploads source maps
 * only from a Vercel hosted build (preview and production both run there).
 * A local `npm run build` must never touch Sentry, whatever a developer's
 * .env.local holds (a pulled SENTRY_AUTH_TOKEN, even a pulled VERCEL=1).
 *
 * Pass the process environment as it was BEFORE vite.config.ts merges .env
 * files into it. Vercel sets VERCEL=1 in the real build environment, and the
 * plugin itself recognises Vercel through the same variable.
 */
export function shouldUploadSentrySourcemaps(
  processEnv: Readonly<Record<string, string | undefined>>,
): boolean {
  return processEnv.VERCEL === "1";
}
