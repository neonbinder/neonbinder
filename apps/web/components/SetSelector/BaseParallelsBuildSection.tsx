import { useEffect, useRef, useState } from "react";
import { useConvex, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { activateOnEnter } from "@/lib/dom/activate-on-enter";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";
import NeonButton from "../modules/NeonButton";
import { ConfirmDialog } from "../modules/confirm-dialog";
import ParallelBuildPanel, {
  PARALLEL_BUILD_HEADING_ID,
  SLEEVE_TONE,
  planFailedText,
  possessive,
  type ParallelBuildPlan,
  type ParallelBuildRunner,
  type ParallelLine,
  type ParallelPlanEntry,
} from "./ParallelBuildPanel";

/**
 * NEO-321 — build the base set's parallels in one go.
 *
 * Shown by the set builder when the selected variant type's NB role is
 * `parallel` (`variantTypeRole`, never the row's name), and kept on screen
 * while one of the parallels under it is open. Every row under that type is
 * a parallel of the base set, so its cards are a copy of the Base checklist's
 * NB cards, each re-linked to the parallel's own marketplace card — the
 * NEO-312 model with Base as the source (`ParallelBuildPanel`).
 *
 * ## Only when pressed (Jason, D2)
 *
 * Nothing here runs on its own. An insert builds its parallels right after
 * its checklist is saved (NEO-312 J1), but a Base save does NOT build the
 * base set's parallels: a Base checklist runs to hundreds of cards and a base
 * set to dozens of parallels, so a run is minutes of marketplace fetches, and
 * a Base is saved for many reasons (a fix to one card, a re-map) that are
 * not "rebuild every parallel". The operator decides when, here, with one
 * button.
 *
 * ## Asks first only when it would replace something (D4)
 *
 * A run fills every empty parallel and rebuilds every one that already has
 * cards. Filling an empty one loses nothing, so a run over empty parallels
 * starts at once; when K of them already have cards the button asks first,
 * naming K.
 *
 * ## The run
 *
 * Through the set builder's hosted runner (`useHostedParallelBuildRun`), so
 * a run started here survives the operator moving into a parallel, back up to
 * the set or across to another variant type. While this section is on screen
 * and the run is the one it started, the ledger (with "Stop after this one")
 * is drawn here and nowhere else.
 *
 * Copy is DRAFT (Jason signs off); every string is one constant or one pure
 * function below.
 */

// ---------------------------------------------------------------------------
// Copy (DRAFT)
// ---------------------------------------------------------------------------

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** Before the Base row's name is known. */
const SOURCE_FALLBACK = "the base set";

export function sectionHeading(sourceValue: string | undefined): string {
  return `Parallels of ${sourceValue ?? SOURCE_FALLBACK}`;
}

/** "Build 12 parallels from Base"; no count until the list is in. */
export function buildAllLabel(
  sourceValue: string | undefined,
  total: number | undefined,
): string {
  const source = sourceValue ?? SOURCE_FALLBACK;
  return total === undefined
    ? `Build parallels from ${source}`
    : `Build ${plural(total, "parallel", "parallels")} from ${source}`;
}

export const LOADING_TEXT = "Counting parallels…";
export const NO_SOURCE_TEXT =
  "No single base set to copy from. Mark one variant type as the base set first.";

/** The server's reason there is no source (no Base, or more than one), as a sentence. */
export function noSourceText(serverReason?: string): string {
  return serverReason ? `Nothing to copy from — ${serverReason}.` : NO_SOURCE_TEXT;
}
export const NO_PARALLELS_TEXT = "No parallels here yet. Sync or add some first.";
export const OTHER_RUN_TEXT =
  "Another parallel build is running. Let it finish or stop it first.";
export const CONFIRM_LABEL = "Replace and build";
export const CONFIRM_BUSY_LABEL = "Starting…";

/** Worded like the server's own refusal for the same case, so the two agree. */
export function sourceEmptyText(sourceValue: string): string {
  return `${sourceValue} has no cards yet — save its checklist first.`;
}

/** What the parallels look like before a run. */
export type ParallelTally = {
  total: number;
  /** Parallels that already hold cards. */
  withCards: number;
  /** Buildable parallels holding cards: what a run would REPLACE (D4's K). */
  replaced: number;
  /** Buildable parallels with no cards: what a run would fill. */
  filled: number;
  /** Not linked to any marketplace yet — the run skips them. */
  unlinked: number;
  /** The server already knows a build would be refused. */
  blocked: number;
};

const linked = (p: ParallelPlanEntry) => p.sides.bsc || p.sides.sportlots;

export function tallyParallels(parallels: ParallelPlanEntry[]): ParallelTally {
  const buildable = parallels.filter((p) => !p.blocked && linked(p));
  return {
    total: parallels.length,
    withCards: parallels.filter((p) => p.hasCards).length,
    replaced: buildable.filter((p) => p.hasCards).length,
    filled: buildable.filter((p) => !p.hasCards).length,
    unlinked: parallels.filter((p) => !p.blocked && !linked(p)).length,
    blocked: parallels.filter((p) => p.blocked).length,
  };
}

/**
 * "12 parallels: 9 empty, 3 with cards. 2 aren't linked to a marketplace yet
 * and get skipped. 1 is blocked." — only the sentences that are true.
 */
export function summaryText(tally: ParallelTally): string {
  const { total, withCards } = tally;
  const empty = total - withCards;
  const counts =
    withCards === 0
      ? `${plural(total, "parallel", "parallels")}, all empty.`
      : empty === 0
        ? `${plural(total, "parallel", "parallels")}, all with cards.`
        : `${plural(total, "parallel", "parallels")}: ${empty} empty, ${withCards} with cards.`;
  const parts = [counts];
  if (tally.unlinked > 0) {
    parts.push(
      tally.unlinked === 1
        ? "1 isn't linked to a marketplace yet and gets skipped."
        : `${tally.unlinked} aren't linked to a marketplace yet and get skipped.`,
    );
  }
  if (tally.blocked > 0) {
    parts.push(tally.blocked === 1 ? "1 is blocked." : `${tally.blocked} are blocked.`);
  }
  return parts.join(" ");
}

/** What a run does, said once under the counts. */
export function explainerText(sourceValue: string): string {
  return `Each one gets a fresh copy of ${possessive(sourceValue)} cards, linked to its own marketplace cards.`;
}

/**
 * D4 — asked only when K > 0 parallels already have cards. The title is the
 * question; the description is what confirming does to the cards there.
 */
export function replaceConfirmCopy(
  sourceValue: string,
  tally: ParallelTally,
): { title: string; description: string } {
  const title = `Replace the cards on ${tally.replaced} of ${plural(tally.total, "parallel", "parallels")} with fresh copies of ${possessive(sourceValue)}?`;
  const description = [
    `Every card on ${tally.replaced === 1 ? "that parallel" : "those parallels"} is made fresh from ${sourceValue}: hand edits are replaced, and a card keeps its SKU when it's the same card.`,
    tally.filled > 0
      ? tally.filled === 1
        ? "The empty one just gets filled."
        : `The ${tally.filled} empty ones just get filled.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
  return { title, description };
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/**
 * The base set's parallels and their source, as the server resolves them from
 * the Parallel variant type. Hosted by the set builder, which needs Base's
 * name for a base parallel's own "Build from Base" button (D3) as well as for
 * this section; Convex dedupes the subscription between the two.
 */
export function useBaseParallelsPlan(
  parallelTypeId: Id<"selectorOptions"> | null,
): ParallelBuildPlan | undefined {
  return useQuery(
    api.parallelChecklistBuild.getParallelsForBuild,
    parallelTypeId ? { sourceId: parallelTypeId } : "skip",
  );
}

/** The pre-run sleeve: what each parallel looks like before anything is built. */
function previewKind(entry: ParallelPlanEntry): ParallelLine["kind"] {
  if (entry.blocked) return "blocked";
  if (!linked(entry)) return "skipped";
  return entry.hasCards ? "built" : "waiting";
}

function previewTitle(entry: ParallelPlanEntry): string {
  if (entry.blocked) return `${entry.value} — blocked: ${entry.blocked}`;
  if (!linked(entry)) return `${entry.value} — not linked to a marketplace yet`;
  return entry.hasCards ? `${entry.value} — has cards` : `${entry.value} — empty`;
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

const HEADING_ID = "base-parallels-heading";
const REASON_ID = "base-parallels-reason";

export default function BaseParallelsBuildSection({
  variantTypeId,
  plan,
  runner,
  showsRun,
}: {
  /** The selected variant type, whose NB role is `parallel`. */
  variantTypeId: Id<"selectorOptions">;
  /** From `useBaseParallelsPlan`; undefined while it loads. */
  plan: ParallelBuildPlan | undefined;
  /** The set builder's hosted runner. */
  runner: ParallelBuildRunner;
  /** The run on the runner is the one this section started; draw it here. */
  showsRun: boolean;
}) {
  const convex = useConvex();
  // NEO-260: the E2E driver re-finds a focused control by an XPath built from
  // its class, so the button carries the document-unique marker class — never
  // a DOM id (which would also hide an aria-label from its `id:` finds).
  const fieldClass = useFieldTestClass();
  const [confirming, setConfirming] = useState(false);
  /** The list could not be read when the run started, so nothing was built. */
  const [startError, setStartError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  /**
   * The trigger goes `inert` under the confirm, and going inert blurs it, so
   * the dialog's own restore captured `<body>`. Put focus back here after the
   * commit that lifts `inert` (the house pattern, as on the row's button).
   */
  const restoreRef = useRef(false);
  useEffect(() => {
    if (confirming || !restoreRef.current) return;
    restoreRef.current = false;
    buttonRef.current?.focus();
  }, [confirming]);

  const source = plan?.source ?? undefined;
  const sourceValue = source?.value;
  const parallels = plan?.parallels;
  const tally = parallels ? tallyParallels(parallels) : undefined;
  const ownRunLive = showsRun && runner.active;

  // Why the button cannot run, in the order the operator would fix it.
  const reason: string | null =
    plan === undefined
      ? LOADING_TEXT
      : !source
        ? noSourceText(plan.sourceBlocked)
        : !source.hasCards
          ? sourceEmptyText(source.value)
          : !tally || tally.total === 0
            ? NO_PARALLELS_TEXT
            : runner.active && !showsRun
              ? OTHER_RUN_TEXT
              : null;
  const held = reason !== null || ownRunLive;

  const run = () => {
    if (!source) return;
    setStartError(null);
    void runner
      .start({ id: variantTypeId, value: source.value }, convex)
      .then((failure) => {
        if (failure) setStartError(planFailedText(failure));
      });
  };

  const activate = () => {
    if (held || !tally) return;
    if (tally.replaced > 0) setConfirming(true);
    else run();
  };

  const label = buildAllLabel(sourceValue, tally?.total);
  const copy =
    confirming && sourceValue && tally
      ? replaceConfirmCopy(sourceValue, tally)
      : null;

  return (
    <section
      aria-labelledby={HEADING_ID}
      className="border border-gray-700 rounded-lg bg-gray-900/60 p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 max-w-prose">
          <h3 id={HEADING_ID} className="text-sm font-semibold text-gray-100">
            {sectionHeading(sourceValue)}
          </h3>
          {tally && tally.total > 0 && (
            <p className="mt-0.5 text-xs text-gray-400">
              {summaryText(tally)}
              {sourceValue ? ` ${explainerText(sourceValue)}` : ""}
            </p>
          )}
        </div>
        <NeonButton
          ref={buttonRef}
          className={`${fieldClass("build-all")} shrink-0 max-w-[20rem]`}
          onClick={activate}
          onKeyDown={(event) => activateOnEnter(event, activate, held)}
          // `aria-disabled`, never native `disabled`: the reason below stays
          // reachable from the button, and focus stays put when a run starts.
          aria-disabled={held || undefined}
          aria-describedby={
            reason !== null
              ? REASON_ID
              : ownRunLive
                ? PARALLEL_BUILD_HEADING_ID
                : undefined
          }
          aria-haspopup={tally && tally.replaced > 0 ? "dialog" : undefined}
          inert={confirming || undefined}
          title={label}
        >
          <span className="min-w-0 truncate">{label}</span>
        </NeonButton>
      </div>

      {/* The binder page before the run: one card-shaped sleeve per parallel,
          filled where the parallel already has cards. The run's own ledger
          draws the same sleeves and fills them as it goes, so the strip hands
          over to it rather than sitting beside it. Decorative — the summary
          says the same in words. */}
      {parallels && parallels.length > 0 && !showsRun && (
        <div aria-hidden="true" className="mt-3 flex flex-wrap gap-1">
          {parallels.map((entry) => (
            <span
              key={entry._id}
              title={previewTitle(entry)}
              className={`h-3.5 w-2.5 rounded-[2px] border ${SLEEVE_TONE[previewKind(entry)]}`}
            />
          ))}
        </div>
      )}

      {reason !== null && (
        // Loading is not a problem to fix, so it stays in the summary's grey;
        // every other reason is something the operator has to do first.
        <p
          id={REASON_ID}
          className={`mt-2 text-xs ${reason === LOADING_TEXT ? "text-gray-400" : "text-amber-300"}`}
        >
          {reason}
        </p>
      )}

      {startError && (
        // A failure the operator is waiting on, so an alert (the house split).
        <p role="alert" className="mt-2 text-xs text-pink-300">
          {startError}
        </p>
      )}

      {showsRun && runner.run && (
        <div className="mt-3 [&>section]:mb-0">
          <ParallelBuildPanel run={runner.run} onStop={runner.stop} />
        </div>
      )}

      {copy && (
        <ConfirmDialog
          title={copy.title}
          description={copy.description}
          confirmLabel={CONFIRM_LABEL}
          busyLabel={CONFIRM_BUSY_LABEL}
          busy={false}
          onConfirm={() => {
            restoreRef.current = true;
            setConfirming(false);
            run();
          }}
          onCancel={() => {
            restoreRef.current = true;
            setConfirming(false);
          }}
        />
      )}
    </section>
  );
}
