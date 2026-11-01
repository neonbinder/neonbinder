import { useEffect, useRef, useState } from "react";
import { LiveLine } from "@/components/modules/RunLedger";
import { SkeletonBars } from "../../catalog/Skeleton";
import { useListing, type ListingExtension } from "../../data/store";
import type { SyncStatus } from "../../data/types";
import SyncStatusView from "./SyncStatusView";
import { BSC_NAME } from "./copy";
import { takeSyncStatusArrival } from "./ListingGate";

/**
 * NEO-370 Rev 4 — Inventory → Sync status (`/inventory?tab=sync`): the
 * collector's own `SyncStatusView`, read live. What Sync on a checklist sets
 * going, what the next round will send, and how each set's last sync went.
 *
 * One polite line says when one of their sets finishes syncing (running →
 * done, or running → a snag), so a collector who pressed Sync and came here
 * hears it land. The queue coming and going is not announced: it churns.
 *
 * Arriving by "See what's syncing" (NEO-370), the keyboard lands on the
 * first heading once the status is drawn (the intro line when there is
 * none), since the link it came from is gone.
 *
 * Hidden in a store with no listing (the demo): the page leaves the tab out.
 */
export default function SyncStatusTab() {
  const listing = useListing();
  if (!listing) return null;
  return <Status listing={listing} />;
}

const PLATFORM_NAME: Record<string, string> = { bsc: BSC_NAME };

/**
 * What finished between two reads of the status: each set that was running
 * and now is not. One sentence, or "" when nothing finished.
 */
export function finishedLine(before: SyncStatus | undefined, now: SyncStatus | undefined): string {
  if (!before || !now) return "";
  const said: string[] = [];
  for (const p of now.platforms) {
    const was = before.platforms.find((b) => b.platform === p.platform);
    if (!was) continue;
    const name = PLATFORM_NAME[p.platform] ?? p.platform;
    for (const set of p.sets) {
      const prior = was.sets.find((s) => s.variantId === set.variantId);
      if (prior?.status !== "running" || set.status === "running") continue;
      said.push(
        set.status === "error"
          ? `${set.setLabel} hit a snag syncing with ${name}.`
          : `${set.setLabel} finished syncing with ${name}.`,
      );
    }
  }
  return said.join(" ");
}

function Status({ listing }: { listing: ListingExtension }) {
  const status = listing.useSyncStatus();
  // The last read seen and the last line said, compared during render (no
  // effect): a new read that finishes a set replaces the line.
  const [seen, setSeen] = useState<{ status: SyncStatus | undefined; line: string }>({ status, line: "" });
  const root = useRef<HTMLDivElement>(null);
  const arrived = useRef<boolean | null>(null);
  useEffect(() => {
    if (arrived.current === null) arrived.current = takeSyncStatusArrival();
    if (!arrived.current || status === undefined || !root.current) return;
    arrived.current = false;
    const target = root.current.querySelector<HTMLElement>("h2, h3") ?? root.current.querySelector<HTMLElement>("p");
    if (!target) return;
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus();
  }, [status]);
  if (seen.status !== status) {
    const line = finishedLine(seen.status, status);
    setSeen({ status, line: line || seen.line });
  }
  return (
    <div ref={root} className="space-y-4">
      <p className="text-sm text-ink-2">
        What&apos;s going up to your marketplaces, what&apos;s waiting, and how each set&apos;s last sync went. Changes go up
        within 15 minutes, or right away when you press Sync on a checklist.
      </p>
      <LiveLine text={seen.line} />
      {status === undefined ? (
        <div aria-busy="true">
          <SkeletonBars rows={5} />
        </div>
      ) : (
        <SyncStatusView status={status} loadProblems={listing.loadSetProblems} />
      )}
    </div>
  );
}
