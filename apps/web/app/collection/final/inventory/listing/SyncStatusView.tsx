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
  SyncStep,
  SyncStepStatus,
  VariantId,
} from "../../data/types";
import {
  CREDENTIALS_PATH,
  EBAY_SETUP_LINE,
  PLATFORM_NAME,
  PLATFORM_PROFILE_PATH,
  pausedLine,
  pausedLineReadOnly,
  problemCardName,
  problemSentence,
  reauthLine,
  reauthLineReadOnly,
  GATHERING_DATA,
  NOTHING_NEW_TO_SEND,
  STEP_STATE_WORD,
  lastStepsName,
  runStepsName,
  sellerConflictLine,
  stepLabels,
  runSnagLine,
  runSyncedLine,
  stepLandedLine,
  stepName,
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
  /**
   * NEO-415 — platforms connected but not set up yet (eBay's shipping,
   * payment, returns or ships-from unpicked): said under the name, with the
   * way to the eBay panel. The collector's tab only; the admin view leaves it
   * out (it can't read another collector's setup).
   */
  unfinishedSetup?: ReadonlyArray<ListingPlatform>;
}

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

export default function SyncStatusView({
  status,
  loadProblems,
  readOnly = false,
  level = 2,
  unfinishedSetup = [],
}: SyncStatusViewProps) {
  const runLine = useRunLine(status.platforms);
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
            or{" "}
            <Link to={PLATFORM_PROFILE_PATH.ebay} className={LINK}>
              connect eBay
            </Link>
            , and syncing starts on its own.
          </>
        )}
      </p>
    );
  }
  return (
    <div className="space-y-6">
      {/*
        The one polite line for every platform's run, mounted empty so its
        first sentence is a change it speaks. One region, not one per
        platform: two runs ending in the same read are one sentence, never
        two regions changing at once (a reader can drop one).
      */}
      <LiveLine text={runLine} />
      {status.platforms.map((p) => (
        <Platform
          key={p.platform}
          platform={p}
          loadProblems={loadProblems}
          readOnly={readOnly}
          level={level}
          unfinished={!readOnly && unfinishedSetup.includes(p.platform)}
        />
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
export function platformState(p: PlatformSyncStatus, unfinished = false): { word: string; tone: string } {
  if (!p.connected) return { word: "Not connected", tone: "border-rule-strong text-ink-2" };
  if (p.sellerConflict) return { word: "Seller account in use", tone: "border-neon-yellow-text text-neon-yellow-text" };
  if (p.paused) return { word: "On a break", tone: "border-neon-yellow-text text-neon-yellow-text" };
  if (p.needsReauth) {
    return {
      word: p.platform === "ebay" ? "Needs reconnect" : "Needs sign-in",
      tone: "border-neon-yellow-text text-neon-yellow-text",
    };
  }
  if (unfinished) return { word: "Setup unfinished", tone: "border-neon-yellow-text text-neon-yellow-text" };
  if (!p.listing) return { word: "Not syncing", tone: "border-rule-strong text-ink-2" };
  return { word: "Listing", tone: "border-neon-green-text text-neon-green-text" };
}

function StateNote({ p, readOnly, unfinished }: { p: PlatformSyncStatus; readOnly: boolean; unfinished: boolean }) {
  const name = PLATFORM_NAME[p.platform];
  const ebay = p.platform === "ebay";
  const profile = (words: string) =>
    readOnly ? null : (
      <>
        {" "}
        <Link to={PLATFORM_PROFILE_PATH[p.platform]} className={LINK}>
          {words}
        </Link>
      </>
    );
  if (!p.connected) {
    return (
      <p className="text-sm text-ink-2">
        {ebay ? `${name} isn't connected, so nothing lists there.` : `No ${name} sign-in saved, so nothing lists there.`}
        {profile(`Connect ${name} in Profile → Credentials`)}
      </p>
    );
  }
  if (p.sellerConflict) return <p className="text-sm text-neon-yellow-text">{sellerConflictLine(name)}</p>;
  if (p.paused) {
    return (
      <p className="text-sm text-neon-yellow-text">
        {readOnly ? pausedLineReadOnly(p.platform) : pausedLine(name)}
      </p>
    );
  }
  if (p.needsReauth) {
    return (
      <p className="text-sm text-neon-yellow-text">
        {readOnly ? reauthLineReadOnly(p.platform) : reauthLine(p.platform)}
        {profile(ebay ? `Connect ${name} again` : `Sign in to ${name} again`)}
      </p>
    );
  }
  if (unfinished) {
    return (
      <p className="text-sm text-neon-yellow-text">
        {EBAY_SETUP_LINE}
        {profile(`Finish your ${name} setup`)}
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
  unfinished,
}: {
  platform: PlatformSyncStatus;
  loadProblems: SyncStatusViewProps["loadProblems"];
  readOnly: boolean;
  level: Level;
  unfinished: boolean;
}) {
  const headingId = useId();
  const name = PLATFORM_NAME[p.platform];
  const state = platformState(p, unfinished);
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
        <StateNote p={p} readOnly={readOnly} unfinished={unfinished} />
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
  const steps = p.running?.steps;
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
      {p.running && steps && steps.length > 0 && (
        <div className="pl-6">
          <StepLedger lines={runLines(steps, p.platform)} name={runStepsName(p.running.setLabel, p.platform)} />
        </div>
      )}
    </section>
  );
}

/** Which ledger glyph a step wears. */
export function stepKind(status: SyncStepStatus): RunLineKind {
  if (status === "working") return "building";
  if (status === "done") return "built";
  return status;
}

/** The step's words beside its glyph: settled ink once it lands, quiet while it waits. */
const STEP_TEXT: Record<SyncStepStatus, string> = {
  waiting: "text-ink-3",
  working: "font-medium text-ink",
  done: "text-ink",
  failed: "font-medium text-neon-pink-text",
};

/** One ledger line: its label (unique within the list) and its state. */
export type LedgerLine = { label: string; status: SyncStepStatus };

/** Every step of a run, one line each, in run order: the "Running now" ledger. */
export function runLines(steps: ReadonlyArray<SyncStep>, platform: ListingPlatform): LedgerLine[] {
  const labels = stepLabels(steps, platform);
  return steps.map((step, i) => ({ label: labels[i], status: step.status }));
}

/** Least finished first: a fold of several steps wears the state of its least-finished one. */
const FOLD_ORDER: readonly SyncStepStatus[] = ["failed", "waiting", "working", "done"];

/**
 * A set row's last run, folded (Jason, 2026-11-02: "collapse those rows down
 * to show just 'Gathering data' and then each of the steps that actually does
 * an update"; the full detail stays on the run going now):
 *
 * - The compare with the boxes and every read fold into one "Gathering data"
 *   line, where the first of them stood (so a run with nothing to do still
 *   shows it). It failed if any of them failed; otherwise it wears its
 *   least-finished one's state (done, on a finished row).
 * - The steps that change something stay, in run order, with their own
 *   labels: Upload photos, Send changes, and eBay's list, price, go live and
 *   take down.
 * - Check-backs are reads too, so they go, except one that failed: a
 *   failure never disappears from the row.
 * - A clean finished run (`rowStatus` idle, every step done) that only gathered
 *   says so with a second line, "Nothing new to send". A row in error or still
 *   running never does, even with every step so far done.
 */
export function foldedLines(
  steps: ReadonlyArray<SyncStep>,
  platform: ListingPlatform,
  rowStatus: SyncSetResult["status"] = "idle",
): LedgerLine[] {
  const labels = stepLabels(steps, platform);
  const gathering = steps.filter((step) => step.kind === "check" || step.kind === "read");
  const gathered = FOLD_ORDER.find((status) => gathering.some((step) => step.status === status)) ?? "done";
  const lines: LedgerLine[] = [];
  steps.forEach((step, i) => {
    if (step.kind === "check" || step.kind === "read") {
      if (step === gathering[0]) lines.push({ label: GATHERING_DATA, status: gathered });
      return;
    }
    if (step.kind === "confirm" && step.status !== "failed") return;
    lines.push({ label: labels[i], status: step.status });
  });
  const onlyGathered = steps.length > 0 && gathering.length === steps.length && gathered === "done";
  if (rowStatus === "idle" && onlyGathered) lines.push({ label: NOTHING_NEW_TO_SEND, status: "done" });
  return lines;
}

/**
 * NEO-415 — the run's steps as the check-mark ledger (Jason, 2026-11-02:
 * check marks beside the conditions, turning green as they land): RunGlyph's
 * clock → spinner → green check, or the snag. Each step is a list item named
 * "label, state", and its own words say the same (the state in a visually
 * hidden tail), so a reader in browse mode and a spec's `getByRole` agree.
 * `inline` wraps the steps onto a line or two, for a set row's last run.
 */
function StepLedger({ lines, name, inline = false }: { lines: ReadonlyArray<LedgerLine>; name: string; inline?: boolean }) {
  return (
    // role="list": Safari/VoiceOver drops a list's semantics under list-style: none unless it is said outright.
    <ol
      role="list"
      aria-label={name}
      // text-sm on the ledger itself, so both placements match the line they sit under.
      className={`text-sm ${inline ? "flex flex-wrap gap-x-4 text-ink-2" : "space-y-0.5"}`}
    >
      {lines.map(({ label, status }) => (
        <li
          key={label}
          // A listitem takes no name from its content, so specs' getByRole("listitem", { name }) needs this aria-label.
          aria-label={stepName(label, status)}
          className="flex items-start gap-1.5 py-0.5 leading-5"
        >
          <RunGlyph kind={stepKind(status)} tones={TONES} />
          <span className={STEP_TEXT[status]}>
            {label}
            <span className="sr-only">, {STEP_STATE_WORD[status]}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** A ledger by value (kind, conditions, state), so an equal read in a new array is no change. */
function stepsKey(steps: ReadonlyArray<SyncStep> | undefined): string {
  if (!steps) return "";
  return steps.map((s) => `${s.kind}:${(s.conditions ?? (s.condition ? [s.condition] : [])).join("+")}:${s.status}`).join("|");
}

/** One platform's run as the last read saw it. */
type SeenRun = {
  key: string;
  stepsKey: string;
  run: { variantId?: VariantId; setLabel?: string; steps: ReadonlyArray<SyncStep> } | null;
};

function seenRunOf(p: PlatformSyncStatus): SeenRun {
  const running = p.running;
  return {
    key: running ? `${running.startedAt}|${running.variantId ?? ""}` : "",
    stepsKey: stepsKey(running?.steps),
    run: running ? { variantId: running.variantId, setLabel: running.setLabel, steps: running.steps ?? [] } : null,
  };
}

/**
 * What the screen's one live line says, from each read of the status
 * compared with the last, during render (by value, so a fresh array holding
 * the same ledger changes nothing and never loops). Every platform's news
 * from one read is one line, in platform order.
 *
 * - A step that lands (done, or a snag) is said once; a step starting is
 *   not, and arriving mid-run says nothing.
 * - When a run ends (or moves on to another set), how it ended is said once
 *   from that set's row: its last steps, which may have landed in the same
 *   read that cleared the run.
 * - A run starting or ending with nothing to say clears the line, so the
 *   same sentence next time is a change the reader hears.
 */
function useRunLine(platforms: ReadonlyArray<PlatformSyncStatus>): string {
  const now = platforms.map((p) => ({ p, at: seenRunOf(p) }));
  const signature = now.map(({ p, at }) => `${p.platform}#${at.key}#${at.stepsKey}`).join("~");
  const [seen, setSeen] = useState(() => ({
    signature,
    runs: new Map(now.map(({ p, at }) => [p.platform, at])),
    line: "",
  }));
  if (seen.signature !== signature) {
    const said: string[] = [];
    let runChanged = false;
    for (const { p, at } of now) {
      const was = seen.runs.get(p.platform);
      if (!was) continue; // A platform that just appeared has nothing to say yet.
      if (was.key === at.key) {
        if (was.stepsKey !== at.stepsKey) said.push(landedLine(was.run?.steps, at.run?.steps, p.platform));
        continue;
      }
      runChanged = true;
      if (was.run) said.push(endedLine(was.run, p));
    }
    const line = said.filter(Boolean).join(" ");
    setSeen({
      signature,
      runs: new Map(now.map(({ p, at }) => [p.platform, at])),
      line: line || (runChanged ? "" : seen.line),
    });
  }
  return seen.line;
}

/**
 * How a run that just ended went, from its set's row: the step that hit a
 * snag, or "Synced 1989 Upper Deck Base with BuySportsCards. 4 of 4 steps
 * done." Nothing when the row isn't there or carries no ledger.
 */
export function endedLine(
  run: { variantId?: VariantId; setLabel?: string; steps: ReadonlyArray<SyncStep> },
  p: Pick<PlatformSyncStatus, "platform" | "sets">,
): string {
  if (run.variantId === undefined) return "";
  const row = p.sets.find((set) => set.variantId === run.variantId);
  const steps = row?.steps;
  if (!row || !steps || steps.length === 0) return "";
  const labels = stepLabels(steps, p.platform);
  const failed = steps.findIndex((step) => step.status === "failed");
  if (failed >= 0) return stepLandedLine(labels[failed], "failed", 0, steps.length);
  const setLabel = run.setLabel ?? row.setLabel;
  if (row.status === "error") return runSnagLine(setLabel, p.platform);
  if (row.status === "running") return landedLine(run.steps, steps, p.platform);
  const done = steps.filter((step) => step.status === "done").length;
  return runSyncedLine(setLabel, p.platform, done, steps.length);
}

/** The newest step to land between two reads, as one sentence; "" when none did. */
export function landedLine(
  before: ReadonlyArray<SyncStep> | undefined,
  now: ReadonlyArray<SyncStep> | undefined,
  platform: ListingPlatform,
): string {
  if (!before || !now || now.length === 0) return "";
  const beforeLabels = stepLabels(before, platform);
  const was = new Map(beforeLabels.map((label, i) => [label, before[i].status]));
  const labels = stepLabels(now, platform);
  let landed: { label: string; status: "done" | "failed" } | null = null;
  for (let i = 0; i < now.length; i++) {
    const status = now[i].status;
    if (status !== "done" && status !== "failed") continue;
    if (was.get(labels[i]) === status) continue;
    landed = { label: labels[i], status };
    // A snag outranks a check mark; otherwise the latest in run order.
    if (status === "failed") break;
  }
  if (!landed) return "";
  const done = now.filter((step) => step.status === "done").length;
  return stepLandedLine(landed.label, landed.status, done, now.length);
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
  // The set syncing now shows its steps under Running now; its row leaves them out rather than draw them twice.
  const live = p.running?.steps?.length ? p.running : null;
  const drawnAbove = (set: SyncSetResult) =>
    live !== null && set.status === "running" && (live.variantId === undefined || live.variantId === set.variantId);
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
            <SetRow
              key={set.variantId}
              set={set}
              platform={p.platform}
              loadProblems={loadProblems}
              readOnly={readOnly}
              showSteps={!drawnAbove(set)}
            />
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
    // NB's error sentences end in their own full stop; drop it before ours. An
    // empty (or dots-only) error falls back like a missing one.
    const why = (set.lastError ?? "").replace(/[.\s]+$/, "") || `${name} didn't answer`;
    return `Hit a snag${when}: ${why}. The next round tries again.`;
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
  showSteps,
}: {
  set: SyncSetResult;
  platform: ListingPlatform;
  loadProblems: SyncStatusViewProps["loadProblems"];
  readOnly: boolean;
  showSteps: boolean;
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
        {showSteps && set.steps && set.steps.length > 0 && (
          <StepLedger lines={foldedLines(set.steps, platform, set.status)} name={lastStepsName(set.setLabel, platform)} inline />
        )}
        {counts && <p className="tabular-nums text-ink-3">{counts}</p>}
        {total > 0 && (
          <div className="space-y-1.5">
            <p className="font-medium text-neon-yellow-text">
              {total} held back:
            </p>
            <ul id={listId} className="space-y-1 border-l-2 border-neon-yellow-text/60 pl-3">
              {shown.map((problem, i) => (
                <li key={`${problem.cardNo ?? "unmatched"}-${problem.reason}-${i}`}>
                  <span className="font-semibold text-ink">{problemCardName(problem, platform)}</span>
                  <span className="text-ink-2"> {problemSentence(problem, readOnly, platform)}</span>
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
