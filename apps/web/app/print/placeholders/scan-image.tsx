import { useEffect, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";

/**
 * One cropped scan, behind a signed GET that expires in ~15 minutes.
 *
 * The URL is fetched when the image is first rendered rather than alongside the
 * pair list, because a list fetched at page load is a list of URLs that have
 * already started expiring — a user who leaves the tab open and comes back to
 * broken images is the exact failure this avoids. `onError` re-mints once, which
 * covers the same expiry from the other direction.
 */
export function ScanImage({
  jobId,
  entryIndex,
  alt,
}: {
  jobId: string;
  entryIndex: number;
  alt: string;
}) {
  const createDownloadUrl = useAction(
    api.adapters.placeholderUploads.createPlaceholderImageDownloadUrl,
  );
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await createDownloadUrl({ jobId, entryIndex });
        if (!cancelled) setUrl(result.url);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `createDownloadUrl` is deliberately NOT a dependency: `useAction` returns
    // a new function identity on every render, so including it re-runs this
    // effect forever — the render loop documented for Convex actions in
    // effects. The fetch is keyed on the arguments that actually identify the
    // object, plus `attempt` for the re-mint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, entryIndex, attempt]);

  if (failed) {
    return (
      <div className="flex h-40 items-center justify-center rounded border border-slate-800 bg-slate-900/60 p-2 text-xs text-slate-400">
        Image unavailable
      </div>
    );
  }

  if (!url) {
    return (
      <div className="flex h-40 items-center justify-center rounded border border-slate-800 bg-slate-900/60 p-2 text-xs text-slate-400">
        Loading image…
      </div>
    );
  }

  return (
    <img
      src={url}
      alt={alt}
      className="h-40 w-auto rounded border border-slate-800 object-contain"
      onError={() => {
        // One retry: a signed URL that expired while the tab sat open mints a
        // fresh one. A second failure is a real problem, not an expiry, and
        // retrying it forever would hammer the action.
        if (attempt < 1) {
          setAttempt((previous) => previous + 1);
          setUrl(null);
        } else {
          setFailed(true);
        }
      }}
    />
  );
}
