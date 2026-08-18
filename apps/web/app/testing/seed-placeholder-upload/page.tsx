import { Suspense, useEffect, useRef, useState } from "react";
import { useConvexAuth } from "convex/react";
import { useNavigate, useSearchParams } from "react-router";
import { usePlaceholderUpload } from "@/src/hooks/usePlaceholderUpload";

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
 * ## The fixture manifest
 * `/placeholder-fixtures/manifest.json`, listing filenames **in upload order** —
 * order is the pairing signal (front, back, front, back), so the manifest is the
 * fixture's most important content, not just an index of it. Both shapes are
 * accepted: a bare `["a.jpg", "b.jpg"]` array, or `{ "files": [...] }`.
 *
 * ## Gating
 * Client-gated on `VITE_CLERK_TESTING_ENABLED`, exactly like /testing/sign-in
 * and /testing/needs-reauth. That is a convenience gate, not a security one: the
 * pipeline underneath is the ordinary user-scoped one, so the worst this page
 * can do is upload images to the signed-in user's own session — which is what a
 * user can already do from /placeholders.
 */

const MANIFEST_URL = "/placeholder-fixtures/manifest.json";

async function loadFixtureFiles(): Promise<File[]> {
  const manifestResponse = await fetch(MANIFEST_URL);
  if (!manifestResponse.ok) {
    throw new Error(
      `No fixture manifest at ${MANIFEST_URL} (HTTP ${manifestResponse.status})`,
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
    const response = await fetch(`/placeholder-fixtures/${name}`);
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
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Where to land afterwards. `{jobId}` in the value is substituted with the
  // session that was just created, so a flow can ask for the run view directly:
  // ?redirect=/placeholders%3FjobId%3D{jobId}
  const redirect = searchParams.get("redirect") || "/placeholders?jobId={jobId}";
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
        setStatus("Loading fixtures...");
        const files = await loadFixtureFiles();

        setStatus(`Uploading ${files.length} fixtures...`);
        const outcome = await upload(files);
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
  }, [isAuthenticated, isLoading, navigate, redirect, upload]);

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
