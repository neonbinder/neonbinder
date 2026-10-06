import { Suspense, useEffect, useRef, useState } from "react";
import { useConvexAuth, useMutation } from "convex/react";
import { useNavigate, useSearchParams } from "react-router";
import { api } from "@/convex/_generated/api";
import { usePlaceholderUpload } from "@/src/hooks/usePlaceholderUpload";
import { useWarmPreprocess } from "@/src/hooks/useWarmPreprocess";

/**
 * Test-only entry into the real scan-upload path (NEO-170).
 *
 * ## Why this page exists
 * maestro-web cannot drive a file input. There is no working `addMedia` on the
 * web platform — the command is a silent no-op stub, so a flow that "attaches" a
 * file passes every step and uploads nothing. That leaves the entire streaming
 * intake untestable end to end, which is the half of the pipeline most likely to
 * break silently.
 *
 * So the file PICKER is bypassed and nothing else is. The fixtures are fetched
 * from the app's own `public/` directory, then pushed through
 * `usePlaceholderUpload` — the identical hook /placeholders uses, which means
 * the identical sequence: `startPlaceholderStream`, then per file
 * `createPlaceholderImageUploadUrl` → form-POST to GCS → confirm. Real signed
 * policies, real objects, real work items. If any of that breaks, this page goes
 * red for the same reason the product page would.
 *
 * ## Reset FIRST, every run — the reason this page needs a lever /placeholders
 * must not have
 * A stream job holds one of the caller's two active-job slots from the moment it
 * opens until it reaches a terminal status, and `startPlaceholderStream` refuses
 * once a caller has two active. That cap is correct product behaviour, but it
 * makes the naive test entry point self-poisoning: run it twice and the worker
 * account has two `collecting` jobs and the third run cannot start, failing the
 * flow at its first assert. Closing a stream does NOT help — close lands it in
 * `pairing`/`processing`, still active, still holding the slot (verified against
 * `closeStreamImpl`).
 *
 * So this page cancels the caller's own active jobs before it starts, through
 * the real cancel path (`seedCancelMyActivePlaceholderJobs`), which reaches a
 * terminal status and frees the slots. Unconditional, not retry-only: a page
 * that only reset after a cap failure would still be one leaked slot away from
 * flaky. This affordance is appropriate HERE and only here — it is
 * `TESTING_RESET_SECRET`-gated and destroys the caller's in-flight runs, which
 * is exactly what a person on /placeholders must never trigger.
 *
 * ## The fixture manifest
 * `/<set>/manifest.json`, listing filenames **in upload order**, written as
 * front, back, front, back. Order is the scan order pairing sees (the entry
 * index is allocated per upload, in the order files are sent), so the manifest
 * is the fixture's most important content, not just an index of it. Both
 * shapes are accepted: a bare `["a.jpg", "b.jpg"]` array, or
 * `{ "files": [...] }`.
 *
 * `?order=back-first` swaps each adjacent pair of the manifest after it loads
 * — 02, 01, 04, 03, 06, 05 — so every card's BACK is uploaded before its
 * front. Since NEO-327 pairing decides which image of a pair is the front from
 * the images themselves (text count first, then labels), never from which one
 * arrived first; this is the lever a flow uses to prove that live. Any other
 * value (or none) uploads in manifest order. Allowlisted like `?fixtures=`, and
 * a trailing unpaired file (an odd-length manifest) keeps its place.
 *
 * `<set>` is `?fixtures=` (default `placeholder-fixtures`) — the NEO-175
 * fast/heavy split needs one fixture set per route a scan can take, all through
 * this one entry point: the default INSET cards, which the fast service's quad
 * stage crops (NEO-320, the fast-crop flow); `placeholder-fixtures-corner`,
 * cards laid in the scanner bed's corner, which the fast service declines so
 * they escalate to the heavy service (the cold-start flow); and
 * `placeholder-fixtures-fullbleed`, frame-filling cards the fast path accepts
 * as they are (the fast-path flow). Allowlisted so a URL param can never point
 * the fetch at an arbitrary path.
 *
 * ## Gating
 * Client-gated on `VITE_CLERK_TESTING_ENABLED`, exactly like /testing/sign-in
 * and /testing/needs-reauth. That is a convenience gate, not a security one: the
 * pipeline underneath is the ordinary user-scoped one, so the worst this page
 * can do is upload images to the signed-in user's own session — which is what a
 * user can already do from /placeholders.
 */

// The fixture sets this page will serve. An allowlist, not a free path: the set
// name is interpolated into a fetch URL, so only these known-good public
// directories may be selected — never an arbitrary caller-supplied path.
const DEFAULT_FIXTURE_SET = "placeholder-fixtures";
const ALLOWED_FIXTURE_SETS = new Set([
  DEFAULT_FIXTURE_SET, // 3 inset pairs → the fast quad stage crops all 6 (no escalation) — the fast-crop flow (NEO-320)
  "placeholder-fixtures-corner", // 3 cornered pairs → all 6 escalate (heavy) — the escalation cold-start flow (NEO-175; six images since NEO-299)
  "placeholder-fixtures-fullbleed", // frame-filling cards → fast identity (no escalation) — the fast-path and flip-edge flows
]);

// `?order=` values this page understands. Only one non-default ordering
// exists; anything else is the manifest's own order.
const BACK_FIRST_ORDER = "back-first";

/**
 * Swap each adjacent pair — [f1, b1, f2, b2] becomes [b1, f1, b2, f2] — so a
 * manifest written front-first uploads back-first. A trailing odd file stays
 * last. Returns a new array; the manifest order is not mutated.
 */
function backFirst<T>(files: readonly T[]): T[] {
  const swapped: T[] = [];
  for (let i = 0; i < files.length; i += 2) {
    if (i + 1 < files.length) swapped.push(files[i + 1]);
    swapped.push(files[i]);
  }
  return swapped;
}

async function loadFixtureFiles(fixtureSet: string): Promise<File[]> {
  const manifestUrl = `/${fixtureSet}/manifest.json`;
  const manifestResponse = await fetch(manifestUrl);
  if (!manifestResponse.ok) {
    throw new Error(
      `No fixture manifest at ${manifestUrl} (HTTP ${manifestResponse.status})`,
    );
  }

  const manifest: unknown = await manifestResponse.json();
  const names = Array.isArray(manifest)
    ? manifest
    : (manifest as { files?: unknown })?.files;
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error("Fixture manifest lists no files");
  }

  // Sequential, like the upload itself: these are small files, and fetching
  // them in order keeps the array in manifest order without a sort.
  const files: File[] = [];
  for (const name of names) {
    if (typeof name !== "string") continue;
    const response = await fetch(`/${fixtureSet}/${name}`);
    if (!response.ok) {
      throw new Error(`Fixture ${name} is missing (HTTP ${response.status})`);
    }
    const blob = await response.blob();
    files.push(
      new File([blob], name, { type: blob.type || "image/jpeg" }),
    );
  }
  return files;
}

function TestingSeedPlaceholderUploadContent() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { upload, progress } = usePlaceholderUpload();
  // Same mount warm-up as the product page — this IS the web upload path with
  // the picker bypassed, so the model should start loading here too.
  useWarmPreprocess();
  const resetSessions = useMutation(
    api.placeholderPipeline.seedCancelMyActivePlaceholderJobs,
  );
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Where to land afterwards. `{jobId}` in the value is substituted with the
  // session that was just created, so a flow can ask for the run view directly:
  // ?redirect=/placeholders%3FjobId%3D{jobId}
  const redirect = searchParams.get("redirect") || "/print/placeholders?jobId={jobId}";
  // Which fixture set to upload (NEO-175). Allowlisted; anything unrecognised
  // (or absent) falls back to the default inset set.
  const requestedSet = searchParams.get("fixtures");
  const fixtureSet =
    requestedSet && ALLOWED_FIXTURE_SETS.has(requestedSet)
      ? requestedSet
      : DEFAULT_FIXTURE_SET;
  // Upload each card's back before its front (NEO-327) — see the manifest
  // note above. Allowlisted: only the exact value switches it on.
  const uploadBackFirst = searchParams.get("order") === BACK_FIRST_ORDER;
  const [status, setStatus] = useState("Initializing...");
  const ranRef = useRef(false);

  useEffect(() => {
    if (import.meta.env.VITE_CLERK_TESTING_ENABLED !== "true") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- status readout of an async driver effect; test-only page
      setStatus("Testing mode is not enabled in this environment.");
      return;
    }
    // Wait for the Convex client to finish syncing the Clerk session token.
    if (isLoading) return;
    if (!isAuthenticated) {
      // Transient during the Clerk → Convex handoff; the effect re-runs when
      // isAuthenticated flips true.
      setStatus("Waiting for authentication...");
      return;
    }
    if (ranRef.current) return;
    ranRef.current = true;

    void (async () => {
      try {
        // FIRST, before anything can consume a slot: free the caller's active
        // jobs so startPlaceholderStream cannot hit the 2-active cap. See the
        // "Reset FIRST" note above for why this is unconditional.
        setStatus("Resetting previous sessions...");
        const reset = await resetSessions();

        // This message stays up through the (awaited) fixture load rather than
        // being overwritten in the same tick — a `setStatus` immediately
        // followed by another batches into one render, so "Reset N" would never
        // paint. The manifest-missing case still surfaces as its own Error line
        // below, so folding away a separate "Loading fixtures..." note costs no
        // diagnosability.
        setStatus(`Reset ${reset.canceled} previous sessions.`);
        const manifestFiles = await loadFixtureFiles(fixtureSet);
        const files = uploadBackFirst ? backFirst(manifestFiles) : manifestFiles;

        setStatus(
          `Uploading ${files.length} fixtures${uploadBackFirst ? " back-first" : ""}...`,
        );
        // Web-originated, same as the product page — this IS the web upload path
        // with the picker bypassed, so it must label runs the same way.
        const outcome = await upload(files, { source: "web" });
        if (!outcome.ok) {
          setStatus(`Error: could not start a session — ${outcome.reason}`);
          return;
        }

        setStatus(
          `Uploaded ${outcome.uploaded} of ${outcome.total} (${outcome.failed} failed) — redirecting...`,
        );
        navigate(redirect.replace("{jobId}", outcome.jobId));
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : JSON.stringify(error);
        setStatus(`Error: ${message}`);
      }
    })();
  }, [
    isAuthenticated,
    isLoading,
    navigate,
    redirect,
    resetSessions,
    upload,
    fixtureSet,
    uploadBackFirst,
  ]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-2 bg-background p-6">
      <p className="font-mono text-sm text-slate-400">
        [testing-seed-placeholder-upload] {status}
      </p>
      {/* Per-file lines, so a flow that fails mid-upload says WHICH fixture and
          why instead of only "redirect never happened". */}
      {progress.length > 0 && (
        <ul className="font-mono text-xs text-slate-500">
          {progress.map((row) => (
            <li key={row.position}>
              {row.name}: {row.state}
              {row.error ? ` — ${row.error}` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function TestingSeedPlaceholderUploadPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-background">
          <p className="font-mono text-sm text-slate-400">
            [testing-seed-placeholder-upload] Loading…
          </p>
        </div>
      }
    >
      <TestingSeedPlaceholderUploadContent />
    </Suspense>
  );
}
