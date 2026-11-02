import { useId, useState, type ReactNode } from "react";
import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { Link } from "react-router";
import { LiveLine, RunGlyph, type RunLineKind } from "@/components/modules/RunLedger";
import { FOCUS } from "../../../prototypes/p1/ui";
import type {
  ListingPlatform,
  PlatformSyncStatus,
  SetProblems,
  SyncProblem,
  SyncSetResult,
  SyncStatus,
  VariantId,
} from "../../data/types";
import {
  BSC_NAME,
  CREDENTIALS_PATH,
  PAUSED_LINE,
  PAUSED_LINE_READ_ONLY,
  REAUTH_LINE,
  REAUTH_LINE_READ_ONLY,
  SELLER_CONFLICT_LINE,
  problemCardName,
  problemSentence,
  whenSynced,
} from "./copy";

/**
 * NEO-370 Rev 4/5 — the Sync status screen, per platform: what is syncing now,
 * the cards waiting for the next sync, and each set's last result (held-back
 * cards with the reason, failures). Last result per set only: no run log.
 *
 * One component, two homes: the collector's Inventory → Sync status tab, and
 * the admin's read-only Sync Status (all collectors, or one). `readOnly`
 * drops every link to the collector's own Profile and says each line about
 * the collector instead of to them (an admin is not that collector). Nothing
 * here ever writes: Sync lives on the checklist.
 *
 * The first five held-back cards of a set show inline; "Show all N held
 * back" reads the whole list once, on demand (`loadProblems`), so the screen
 * never subscribes to a long list.
 *
 * Headings start at `level` (the platform's name) and go one deeper for its
 * three parts, so the screen sits under whatever heading its page has.
 */

type Level = 2 | 3 | 4;

export interface SyncStatusViewProps {
  status: SyncStatus;
  /** The whole held-back list of one set on one platform. */
  loadProblems: (variantId: VariantId, platform: ListingPlatform) => Promise<SetProblems>;
  /** The admin's view: no Profile links, and no line that tells the collector what to do. */
  readOnly?: boolean;
  /** The platform names' heading level; its parts go one deeper. */
  level?: Level;
}

const PLATFORM_NAME: Record<ListingPlatform, string> = { bsc: BSC_NAME };

/** Glyph colours for the ledger on a raised panel (the defaults are the blue banner's). */
const TONES: Record<RunLineKind, string> = {
  waiting: "text-ink-3",
  building: "text-neon-blue-text motion-safe:animate-spin",
  built: "text-neon-green-text",
  skipped: "text-ink-3",
  blocked: "text-neon-yellow-text",
  stopped: "text-ink-3",
  failed: "text-neon-pink-text",
  unfinished: "text-neon-yellow-text",
};

const LINK = "rounded-sm font-medium text-neon-blue-text underline focus-outline";
const RULE = "border-t border-dashed border-rule-strong pt-3";

function Heading({ level, id, className, children }: { level: number; id?: string; className: string; children: ReactNode }) {
  const Tag = `h${Math.min(level, 6)}` as "h2";
  return (
    <Tag id={id} className={className}>
      {children}
    </Tag>
  );
}

export default function SyncStatusView({ status, loadProblems, readOnly = false, level = 2 }: SyncStatusViewProps) {
  if (status.platforms.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-rule-strong px-3 py-2 text-sm text-ink-3">
        {readOnly ? (
          "No marketplaces here yet. Nothing has synced for this collector."
        ) : (
          <>
            No marketplaces hooked up yet.{" "}
            <Link to={CREDENTIALS_PATH} className={LINK}>
              Save a sign-in on your Profile
            </Link>{" "}
            and syncing starts on its own.
          </>
        )}
      </p>
    );
  }
  return (
    <div className="space-y-6">
      {status.platforms.map((p) => (
        <Platform key={p.platform} platform={p} loadProblems={loadProblems} readOnly={readOnly} level={level} />
      ))}
    </div>
  );
}

/**
 * The platform's state, in a word or two. Rev 5: a saved, unpaused sign-in
 * IS listing, so a pause reads before "not listing" (a pause makes listing
 * false), and "Not syncing" is left for a saved sign-in that is none of the
 * others (a testing account only).
 */
export function platformState(p: PlatformSyncStatus): { word: string; tone: string } {
  if (!p.connected) return { word: "Not connected", tone: "border-rule-strong text-ink-2" };
  if (p.sellerConflict) return { word: "Seller account in use", tone: "border-neon-yellow-text text-neon-yellow-text" };
  if (p.paused) return { word: "On a break", tone: "border-neon-yellow-text text-neon-yellow-text" };
  if (p.needsReauth) return { word: "Needs sign-in", tone: "border-neon-yellow-text text-neon-yellow-text" };
  if (!p.listing) return { word: "Not syncing", tone: "border-rule-strong text-ink-2" };
  return { word: "Listing", tone: "border-neon-green-text text-neon-green-text" };
}

function StateNote({ p, readOnly }: { p: PlatformSyncStatus; readOnly: boolean }) {
  const name = PLATFORM_NAME[p.platform];
  const profile = (words: string) =>
    readOnly ? null : (
      <>
        {" "}
        <Link to={CREDENTIALS_PATH} className={LINK}>
          {words}
        </Link>
      </>
    );
  if (!p.connected) {
    return (
      <p className="text-sm text-ink-2">
        No {name} sign-in saved, so nothing lists there.{profile(`Connect ${name} on your Profile`)}
      </p>
    );
  }
  if (p.sellerConflict) return <p className="text-sm text-neon-yellow-text">{SELLER_CONFLICT_LINE}</p>;
  if (p.paused) return <p className="text-sm text-neon-yellow-text">{readOnly ? PAUSED_LINE_READ_ONLY : PAUSED_LINE}</p>;
  if (p.needsReauth) {
    return (
      <p className="text-sm text-neon-yellow-text">
        {readOnly ? REAUTH_LINE_READ_ONLY : REAUTH_LINE}
        {profile(`Sign in to ${name} again`)}
      </p>
    );
  }
  // The pill already says "Not syncing"; there is nothing for the collector to do.
  return null;
}

function Platform({
  platform: p,
  loadProblems,
  readOnly,
  level,
}: {
  platform: PlatformSyncStatus;
  loadProblems: SyncStatusViewProps["loadProblems"];
  readOnly: boolean;
  level: Level;
}) {
  const headingId = useId();
  const name = PLATFORM_NAME[p.platform];
  const state = platformState(p);
  const sub = level + 1;
  return (
    <section aria-labelledby={headingId} className="space-y-4 rounded-lg bg-raised p-4 text-ink shadow-offset sm:p-6">
      <header className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Heading level={level} id={headingId} className="text-lg font-semibold">
            {name}
          </Heading>
          <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${state.tone}`}>{state.word}</span>
        </div>
        <StateNote p={p} readOnly={readOnly} />
      </header>

      <RunningNow p={p} level={sub} />
      <Queue p={p} level={sub} readOnly={readOnly} />
      <Sets p={p} level={sub} loadProblems={loadProblems} readOnly={readOnly} />
    </section>
  );
}

// The platform's three parts are plain sections under their headings, not
// named regions: three more landmarks per platform (more on the admin's
// everyone view) would only be noise in the landmark list.
function RunningNow({ p, level }: { p: PlatformSyncStatus; level: number }) {
  const name = PLATFORM_NAME[p.platform];
  return (
    <section className={`space-y-1.5 ${RULE}`}>
      <Heading level={level} className="text-base font-semibold">
        Running now
      </Heading>
      {p.running ? (
        <p className="flex items-start gap-2 text-sm text-ink">
          <RunGlyph kind="building" tones={TONES} />
          <span>
            Syncing <span className="font-semibold">{p.running.setLabel ?? "a set"}</span> with {name}, started{" "}
            {whenSynced(p.running.startedAt)}.
          </span>
        </p>
      ) : (
        <p className="text-sm text-ink-2">
          Nothing syncing right now.{" "}
          {p.lastDrainAt ? `Last sync finished ${whenSynced(p.lastDrainAt)}.` : "No sync has run yet."}
          {p.scheduledAt ? ` Next round around ${whenSynced(p.scheduledAt)}.` : ""}
        </p>
      )}
    </section>
  );
}

/** Said for a queued card that has since left the catalog (no number, no name). */
export const GONE_CARD = "A card no longer in NeonBinder";

/** "#12 Ken Griffey Jr." for a queued card. */
function cardName(c: { cardNo?: string; cardLabel?: string }): string {
  return c.cardNo || c.cardLabel?.trim() ? problemCardName(c) : GONE_CARD;
}

function Queue({ p, level, readOnly }: { p: PlatformSyncStatus; level: number; readOnly: boolean }) {
  const headingId = useId();
  const { cards, more } = p.queued;
  const n = cards.length;
  const square = `Nothing waiting. ${readOnly ? "Their" : "Your"} boxes and ${PLATFORM_NAME[p.platform]} are square.`;
  return (
    <section className={`space-y-2 ${RULE}`}>
      <Heading level={level} id={headingId} className="text-base font-semibold">
        Queued for the next sync{n > 0 ? ` (${more ? `${n}+` : n})` : ""}
      </Heading>
      {n === 0 ? (
        <p className="text-sm text-ink-2">
          {p.listing ? square : "Nothing waiting."}
        </p>
      ) : (
        <>
          <ul aria-labelledby={headingId} className="divide-y divide-rule text-sm">
            {cards.map((c) => (
              <li key={`${c.cardId}-${c.changedAt}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5">
                <span className="min-w-0 flex-1">
                  <span className="font-semibold tabular-nums text-ink">{cardName(c)}</span>
                  <span className="text-ink-2"> in {c.setLabel}</span>
                </span>
                <span className="tabular-nums text-ink-3">queued {whenSynced(c.changedAt)}</span>
              </li>
            ))}
          </ul>
          {more && (
            <p className="text-xs text-ink-3">And more. The {n} waiting longest show here; the rest follow them up.</p>
          )}
        </>
      )}
    </section>
  );
}

function Sets({
  p,
  level,
  loadProblems,
  readOnly,
}: {
  p: PlatformSyncStatus;
  level: number;
  loadProblems: SyncStatusViewProps["loadProblems"];
  readOnly: boolean;
}) {
  const headingId = useId();
  return (
    <section className={`space-y-2 ${RULE}`}>
      <Heading level={level} id={headingId} className="text-base font-semibold">
        Last sync by set
      </Heading>
      {p.sets.length === 0 ? (
        <p className="text-sm text-ink-2">
          {readOnly
            ? "No sets synced yet."
            : "No sets synced yet. Press Sync on a checklist, or the next round picks up any change in your boxes."}
        </p>
      ) : (
        <ol aria-labelledby={headingId} className="space-y-3">
          {p.sets.map((set) => (
            <SetRow key={set.variantId} set={set} platform={p.platform} loadProblems={loadProblems} readOnly={readOnly} />
          ))}
        </ol>
      )}
    </section>
  );
}

/** Which ledger glyph a set's last result wears. */
export function setKind(set: Pick<SyncSetResult, "status" | "problemsTotal">): RunLineKind {
  if (set.status === "running") return "building";
  if (set.status === "error") return "failed";
  if (set.problemsTotal > 0) return "blocked";
  return "built";
}

/** The set's result in one sentence. */
export function setLine(set: SyncSetResult, platform: ListingPlatform): string {
  const name = PLATFORM_NAME[platform];
  if (set.status === "running") return "Syncing now…";
  if (set.status === "error") {
    const when = set.lastRunAt ? ` ${whenSynced(set.lastRunAt)}` : "";
    return `Hit a snag${when}: ${set.lastError ?? `${name} didn't answer`}. The next round tries again.`;
  }
  if (set.lastSuccessAt) return `Synced ${whenSynced(set.lastSuccessAt)}.`;
  if (set.lastRunAt) return `Last ran ${whenSynced(set.lastRunAt)}.`;
  return "Not synced yet.";
}

/** "12 listed, 3 updated, 1 taken to 0, 2 skipped": the zeros left out, listed always said. */
export function countsLine(counts: SyncSetResult["counts"]): string | null {
  if (!counts) return null;
  const parts = [`${counts.listed} listed`];
  if (counts.pushed > 0) parts.push(`${counts.pushed} updated`);
  if (counts.zeroed > 0) parts.push(`${counts.zeroed} taken to 0`);
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  return parts.join(", ");
}

type Loaded = { state: "idle" } | { state: "loading" } | { state: "error" } | { state: "done"; list: SetProblems };

function SetRow({
  set,
  platform,
  loadProblems,
  readOnly,
}: {
  set: SyncSetResult;
  platform: ListingPlatform;
  loadProblems: SyncStatusViewProps["loadProblems"];
  readOnly: boolean;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>({ state: "idle" });
  const counts = countsLine(set.counts);
  const total = set.problemsTotal;
  const hasMore = total > set.problems.length;
  const shown: SyncProblem[] = open && loaded.state === "done" ? loaded.list.problems : set.problems;

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (loaded.state === "done" || loaded.state === "loading") return;
    setLoaded({ state: "loading" });
    loadProblems(set.variantId, platform).then(
      (list) => setLoaded({ state: "done", list }),
      () => setLoaded({ state: "error" }),
    );
  };

  const live = !open
    ? ""
    : loaded.state === "loading"
      ? `Pulling every held-back card in ${set.setLabel}…`
      : loaded.state === "done"
        ? `Showing all ${loaded.list.problemsTotal} held back in ${set.setLabel}.`
        : loaded.state === "error"
          ? `Couldn't pull the full list for ${set.setLabel}.`
          : "";

  return (
    <li className="flex items-start gap-2">
      <RunGlyph kind={setKind(set)} tones={TONES} />
      <div className="min-w-0 flex-1 space-y-1 text-sm">
        <p>
          <span className="font-semibold text-ink">{set.setLabel}</span>{" "}
          <span className={set.status === "error" ? "text-neon-pink-text" : "text-ink-2"}>{setLine(set, platform)}</span>
        </p>
        {counts && <p className="tabular-nums text-ink-3">{counts}</p>}
        {total > 0 && (
          <div className="space-y-1.5">
            <p className="font-medium text-neon-yellow-text">
              {total} held back:
            </p>
            <ul id={listId} className="space-y-1 border-l-2 border-neon-yellow-text/60 pl-3">
              {shown.map((problem, i) => (
                <li key={`${problem.cardNo ?? "unmatched"}-${problem.reason}-${i}`}>
                  <span className="font-semibold text-ink">{problemCardName(problem)}</span>
                  <span className="text-ink-2"> {problemSentence(problem, readOnly)}</span>
                </li>
              ))}
            </ul>
            {hasMore && (
              <button
                type="button"
                aria-label={`Show all ${total} held back in ${set.setLabel}`}
                aria-expanded={open}
                aria-controls={listId}
                aria-busy={(open && loaded.state === "loading") || undefined}
                onClick={toggle}
                className={`inline-flex min-h-6 items-center gap-1 rounded text-sm font-medium text-neon-blue-text hover:underline max-sm:min-h-11 ${FOCUS}`}
              >
                <ChevronRightIcon
                  aria-hidden="true"
                  className={`h-4 w-4 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
                />
                {/* The name stays put (aria-expanded says open or shut); the words say what a press does. */}
                <span aria-hidden="true">{open ? "Show fewer" : `Show all ${total} held back`}</span>
              </button>
            )}
            {open && loaded.state === "error" && (
              <p className="text-neon-pink-text">Couldn&apos;t pull the full list. Close it and try again.</p>
            )}
            <LiveLine text={live} />
          </div>
        )}
      </div>
    </li>
  );
}
