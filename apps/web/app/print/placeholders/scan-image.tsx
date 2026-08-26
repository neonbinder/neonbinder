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
  // The caller owns the box. This started life as a fixed `h-40` thumbnail for
  // a list, and a pocket in the 9-up grid needs to be FILLED instead — the
  // default keeps every existing caller rendering as before.
  className = "h-40 w-auto rounded border border-slate-800 object-contain",
  forcePortrait = false,
}: {
  jobId: string;
  entryIndex: number;
  alt: string;
  className?: string;
  /**
   * Turn a landscape crop upright so it fills a portrait pocket.
   *
   * A binder pocket is 2.5in x 3.5in, so a landscape card — 3.5 x 2.5, which
   * the cropper returns at a measured ratio of 1.400 — physically CANNOT go in
   * except rotated. The printed placeholder therefore has to be rotated too,
   * and the pocket grid previews the print. Everywhere else (the in-flight
   * list, unmatched thumbnails) the card stays as scanned, because there the
   * job is to recognise it, not to place it.
   *
   * Detected from the loaded image rather than the row's `rotationDegrees`:
   * that field records what the SERVICE did, and what matters here is the
   * shape of the file actually being displayed.
   */
  forcePortrait?: boolean;
}) {
  const createDownloadUrl = useAction(
    api.adapters.placeholderUploads.createPlaceholderImageDownloadUrl,
  );
  const [url, setUrl] = useState<string | null>(null);
  const [landscape, setLandscape] = useState(false);
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
      <div
        className={`flex items-center justify-center bg-slate-900/60 p-2 text-center text-xs text-slate-400 ${className}`}
      >
        Image unavailable
      </div>
    );
  }

  if (!url) {
    return (
      <div
        className={`flex items-center justify-center bg-slate-900/60 p-2 text-center text-xs text-slate-400 ${className}`}
      >
        Loading image…
      </div>
    );
  }

  return (
    <img
      src={url}
      alt={alt}
      onLoad={(e) => {
        const el = e.currentTarget;
        if (forcePortrait && el.naturalWidth > el.naturalHeight) {
          setLandscape(true);
        }
      }}
      className={
        forcePortrait && landscape
          ? // Sized in the CONTAINER's terms before rotation: a quarter turn
            // swaps the axes, so width must equal the container's height
            // (140% of its width, at the 2.5:3.5 pocket ratio) and height must
            // equal the container's width (100/1.4 = 71.4286% of its height).
            "absolute left-1/2 top-1/2 max-w-none -translate-x-1/2 -translate-y-1/2 rotate-90 object-cover"
          : className
      }
      style={
        forcePortrait && landscape
          ? { width: "140%", height: "71.4286%" }
          : undefined
      }
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
