import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import { useMutation, useQuery } from "convex/react";
import type { GenericId } from "convex/values";
import { api } from "../../convex/_generated/api";
import { Input } from "../primitives/Input";
import NeonButton from "../modules/NeonButton";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";
import { activateOnEnter } from "@/lib/dom/activate-on-enter";
import { userFacingMessage } from "@/lib/errors/user-facing-message";

/**
 * NEO-237 (D11–D13) — "new on SportLots": the sets SportLots lists under a
 * brand that NeonBinder has no set for yet.
 *
 * ## Why this is a review screen and not a sync step
 *
 * A sync is additive and id-keyed: it links what it can to rows that exist
 * and never invents a row from a marketplace label alone (product invariant
 * 3). So when SportLots lists a set under a brand and nothing under that
 * brand holds its id, the sync does not mint it — it records the entry as a
 * CANDIDATE and this dialog is the only thing that ever turns one into a
 * set. The operator names it (the marketplace label is only the default),
 * and the set that results is NB's own row with the SportLots id on its Base,
 * exactly where the Base picker would have put it.
 *
 * ## Per ROOT, written immediately
 *
 * Every card here is a root: the shortest of a family of entries sharing a
 * stem ("Chrome", with "Chrome Sepia" and "Chrome Refractor" folded under
 * it as `members`). Creating the root is what makes the members classify as
 * that set's variants on the next sync, so members are shown but never
 * created from here. Create set and Skip each write on press — there is no
 * Apply, because the two decisions are independent per root and an operator
 * working down a long list wants each one to land as they go. A row leaves
 * the list when its write lands (the query is reactive); the footer says
 * what just happened.
 *
 * ## Escape closes and writes nothing
 *
 * Same rule as the name-check dialog: nothing is staged, so closing loses
 * nothing. Every root not acted on is still listed next time.
 *
 * ## Grouped by brand in the All Brands view
 *
 * From a brand's own column the list is that brand's. From the view it is
 * every brand's, under a heading per brand, so an operator can see that
 * "Finest" is new under Topps and not under Unknown.
 */

export type SetCandidateMember = { id: string; label: string };

export type SetCandidate = {
  _id: GenericId<"setCandidates">;
  manufacturerId: GenericId<"selectorOptions">;
  side: "bsc" | "sportlots";
  marketplaceId: string;
  label: string;
  members: SetCandidateMember[];
  /** Present on rows from the All Brands view. */
  brand?: string;
};

export type CandidateGroup = {
  /** The brand's display value; `undefined` groups rows that carry none. */
  brand: string | undefined;
  /** `undefined` for the single ungrouped list a brand's own column shows. */
  brandId: GenericId<"selectorOptions"> | undefined;
  items: SetCandidate[];
};

/** The pill's visible text — what a flow asserts and taps. */
export function candidatePillText(count: number): string {
  return `${count} new on SportLots`;
}

/** The "+ N variants" line under a root. `""` for a root with no members. */
export function memberSummary(members: readonly SetCandidateMember[]): string {
  if (members.length === 0) return "";
  return `+ ${members.length} variant${members.length === 1 ? "" : "s"}`;
}

/** What the name field starts as: the marketplace label, exactly. */
export function defaultSetName(candidate: SetCandidate): string {
  return candidate.label;
}

/**
 * Rows → one group per brand, in first-seen order (the year query already
 * orders brands by folded value). Rows without a `brand` — a brand column's
 * own list — form a single group keyed on the manufacturer id.
 */
export function groupCandidatesByBrand(
  candidates: readonly SetCandidate[],
): CandidateGroup[] {
  const groups: CandidateGroup[] = [];
  const byBrandId = new Map<string, CandidateGroup>();
  for (const c of candidates) {
    const key = c.manufacturerId as string;
    let group = byBrandId.get(key);
    if (!group) {
      group = { brand: c.brand, brandId: c.manufacturerId, items: [] };
      byBrandId.set(key, group);
      groups.push(group);
    }
    group.items.push(c);
  }
  return groups;
}

/**
 * The server's structured refusals for a create, read from `data` (production
 * redacts the message). Same discipline as `EntityColumn.customRefusal`.
 */
export function createRefusal(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return null;
  const data = (e as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const { code, reason, value, matches } = data as {
    code?: unknown;
    reason?: unknown;
    value?: unknown;
    matches?: unknown;
  };
  if (code === "CUSTOM_VALUE_INVALID") {
    return typeof reason === "string" && reason.length > 0
      ? reason
      : "That name isn't allowed here.";
  }
  if (code === "SET_NAME_CLASH_AT_TARGET") {
    const existing = typeof value === "string" ? value : "that name";
    return `'${existing}' is already a set under this brand. Give it another name, or skip it.`;
  }
  if (code === "CUSTOM_EXISTS_ELSEWHERE") {
    const first = Array.isArray(matches) ? matches[0] : undefined;
    const path = (first as { path?: Array<{ _id: string; value: string }> } | undefined)
      ?.path;
    const where =
      Array.isArray(path) && path.length > 1
        ? path
            .slice(0, -1)
            .slice(-2)
            .map((p) => p.value)
            .join(" › ")
        : "";
    return where
      ? `A set with this name already exists under ${where}. Give it another name, or skip it.`
      : "A set with this name already exists under another brand. Give it another name, or skip it.";
  }
  return null;
}

function CandidateRow({
  candidate,
  onCreate,
  onSkip,
}: {
  candidate: SetCandidate;
  onCreate: (candidateId: GenericId<"setCandidates">, name: string) => Promise<void>;
  onSkip: (candidateId: GenericId<"setCandidates">) => Promise<void>;
}) {
  const [name, setName] = useState(() => defaultSetName(candidate));
  const [busy, setBusy] = useState<"create" | "skip" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fieldClass = useFieldTestClass();

  const create = async () => {
    if (busy) return;
    setBusy("create");
    setError(null);
    try {
      await onCreate(candidate._id, name);
    } catch (e) {
      setError(createRefusal(e) ?? userFacingMessage(e, "Couldn't create the set."));
    } finally {
      setBusy(null);
    }
  };
  const skip = async () => {
    if (busy) return;
    setBusy("skip");
    setError(null);
    try {
      await onSkip(candidate._id);
    } catch (e) {
      setError(userFacingMessage(e, "Couldn't skip it."));
    } finally {
      setBusy(null);
    }
  };

  const summary = memberSummary(candidate.members);

  return (
    <div className="border border-gray-700 rounded-md p-3 space-y-2">
      <div className="min-w-0">
        {/* The marketplace's label, as the root. Its own text node so a flow
            can find the row by the name SportLots uses. */}
        <p className="text-sm font-semibold text-gray-100 break-words">
          {candidate.label}
        </p>
        {summary && (
          // text-gray-400 on bg-gray-900: 6.8:1. The member labels ride on
          // `title` for a hover and are listed for AT in the sr-only span,
          // because a variant count with no names is a number, not
          // information.
          <p
            className="text-xs text-gray-400"
            title={candidate.members.map((m) => m.label).join(", ")}
          >
            {summary}
            <span className="sr-only">
              {`: ${candidate.members.map((m) => m.label).join(", ")}`}
            </span>
          </p>
        )}
      </div>
      <Input
        bare
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void create();
        }}
        className={`${fieldClass("name")} w-full p-2 text-sm`}
        aria-label={`Name for "${candidate.label}"`}
        disabled={busy !== null}
      />
      {error && (
        <p
          role="alert"
          className="text-xs p-2 bg-red-900/30 border border-red-700 rounded-md text-red-200"
        >
          {error}
        </p>
      )}
      <div className="flex gap-2">
        {/* WCAG 2.5.3: every label leads with its visible words. The root's
            label disambiguates rows sharing the same two words, and keeps
            "Create set" from being a full match for the Sets column's own
            confirm button of that name. */}
        <NeonButton
          size="2"
          className={fieldClass("btn-create")}
          disabled={busy !== null || name.trim().length === 0}
          onClick={() => void create()}
          onKeyDown={(e) => activateOnEnter(e, () => void create(), busy !== null)}
          aria-label={`Create set from "${candidate.label}"`}
        >
          {busy === "create" ? "Creating…" : "Create set"}
        </NeonButton>
        <NeonButton
          secondary
          size="2"
          className={fieldClass("btn-skip")}
          disabled={busy !== null}
          onClick={() => void skip()}
          onKeyDown={(e) => activateOnEnter(e, () => void skip(), busy !== null)}
          aria-label={`Skip "${candidate.label}"`}
        >
          {busy === "skip" ? "Skipping…" : "Skip"}
        </NeonButton>
      </div>
    </div>
  );
}

export default function SetCandidateReviewModal({
  isOpen,
  candidates,
  viewMode,
  scopeLabel,
  restoreFocusRef,
  onClose,
  onCreate,
  onSkip,
}: {
  isOpen: boolean;
  candidates: SetCandidate[];
  /** All Brands view: group by brand. */
  viewMode: boolean;
  /** e.g. "1997" (view) or "Topps" (brand) — names the scope in the subline. */
  scopeLabel?: string;
  /** a11y: where focus goes on close — the pill this was opened from. */
  restoreFocusRef?: RefObject<HTMLElement | null>;
  /** Escape, or the footer's Close. Writes nothing. */
  onClose: () => void;
  onCreate: (candidateId: GenericId<"setCandidates">, name: string) => Promise<void>;
  onSkip: (candidateId: GenericId<"setCandidates">) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  // The footer's running account of what just landed. Content-keyed by
  // `role="status"`: each write changes the text, so each one is announced.
  const [outcome, setOutcome] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const restoreTarget = restoreFocusRef?.current;
    triggerRef.current =
      restoreTarget ?? (document.activeElement as HTMLElement | null);
    // Focus lands on Close: the non-writing control is the safe landing spot.
    const id = requestAnimationFrame(() => closeBtnRef.current?.focus());
    return () => {
      cancelAnimationFrame(id);
      triggerRef.current?.focus?.();
    };
  }, [isOpen, restoreFocusRef]);

  if (!isOpen) return null;

  const groups = viewMode
    ? groupCandidatesByBrand(candidates)
    : [{ brand: undefined, brandId: undefined, items: candidates }];

  const handleCreate = async (
    candidateId: GenericId<"setCandidates">,
    name: string,
  ) => {
    await onCreate(candidateId, name);
    setOutcome(`Created '${name.trim()}'`);
  };
  const handleSkip = async (candidateId: GenericId<"setCandidates">) => {
    const label = candidates.find((c) => c._id === candidateId)?.label;
    await onSkip(candidateId);
    setOutcome(label ? `Skipped '${label}'` : "Skipped");
  };

  return createPortal(
    <Theme>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="set-candidates-heading"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
            return;
          }
          if (e.key !== "Tab") return;
          // aria-modal="true" promises Tab stays inside; deliver on it.
          const root = dialogRef.current;
          if (!root) return;
          const focusable = root.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), [href], select, textarea, [tabindex]:not([tabindex="-1"])',
          );
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-2xl max-h-[92vh] flex flex-col">
          <header className="p-4 border-b border-gray-700">
            <h2
              id="set-candidates-heading"
              className="text-lg font-semibold text-gray-100"
            >
              New on SportLots — Sets
            </h2>
            <p className="text-xs text-gray-400 mt-1">
              {scopeLabel
                ? `SportLots lists these under ${scopeLabel} and NeonBinder has no set for them yet.`
                : "SportLots lists these and NeonBinder has no set for them yet."}{" "}
              Name the ones you want and create them; skip the rest and they stay
              out of the way.
            </p>
          </header>

          <div className="p-4 overflow-y-auto space-y-4">
            {candidates.length === 0 ? (
              // The pill never opens this at zero, so this is the
              // worked-down-to-empty case. Deliberately does not auto-close:
              // that would fire under the operator's last keystroke.
              <p className="text-sm text-gray-400">
                All caught up — nothing new to file.
              </p>
            ) : (
              groups.map((group) => (
                <section
                  key={(group.brandId as string | undefined) ?? "all"}
                  aria-label={
                    group.brand ? `New under ${group.brand}` : undefined
                  }
                  className="space-y-2"
                >
                  {group.brand && (
                    // The brand, as an eyebrow over its roots — the one
                    // thing the view adds to the list.
                    <h3 className="text-[11px] uppercase tracking-wide text-[#00C2FF]">
                      {group.brand}
                    </h3>
                  )}
                  {group.items.map((candidate) => (
                    <CandidateRow
                      key={candidate._id as string}
                      candidate={candidate}
                      onCreate={handleCreate}
                      onSkip={handleSkip}
                    />
                  ))}
                </section>
              ))
            )}
          </div>

          <footer className="p-4 border-t border-gray-700 flex items-center justify-between gap-2 flex-wrap">
            <span className="text-xs text-gray-400" role="status">
              {outcome ??
                `${candidates.length} to look at`}
            </span>
            <NeonButton
              ref={closeBtnRef}
              cancel
              size="2"
              onClick={onClose}
              aria-label="Close — the rest stay listed"
            >
              Close
            </NeonButton>
          </footer>
        </div>
      </div>
    </Theme>,
    document.body,
  );
}

/**
 * The "N new on SportLots" pill, and the dialog it opens.
 *
 * Owns its own read so the column it sits in (`EntityColumn`, through its
 * `extraPills` slot) never learns this domain — the same reason "Group
 * Parallels" arrives through `extraActions`. `parentId` is the brand row in a
 * brand's column, or the year in the All Brands view (`viewMode`), where the
 * read is the year-wide one and the dialog groups by brand.
 *
 * Rendered only when the query has RESOLVED to a non-empty list — no ghost
 * "0 new" while loading, no dialog that opens on nothing. Blue, not the
 * name-check pill's amber: that one is a disagreement to settle, this one is
 * something new to file, and the two sit side by side.
 */
export function SetCandidatesPill({
  parentId,
  viewMode,
}: {
  parentId: GenericId<"selectorOptions">;
  viewMode: boolean;
}) {
  const forBrand = useQuery(
    api.setDiscovery.getSetCandidates,
    viewMode ? "skip" : { manufacturerId: parentId },
  );
  const forYear = useQuery(
    api.setDiscovery.getSetCandidatesForYear,
    viewMode ? { yearId: parentId } : "skip",
  );
  // The scope's own value for the subline — deduped against the column's
  // identical read.
  const scope = useQuery(api.selectorOptions.getSelectorOptionById, {
    id: parentId,
  });
  const createFromCandidate = useMutation(api.setDiscovery.createSetFromCandidate);
  const skipCandidate = useMutation(api.setDiscovery.skipSetCandidate);
  const [open, setOpen] = useState(false);
  const pillRef = useRef<HTMLButtonElement | null>(null);

  const raw = viewMode ? forYear : forBrand;
  // Shape-guarded rather than trusted, like the column's other pills: a row
  // this dialog cannot act on is not one it should count either.
  const candidates: SetCandidate[] | undefined = Array.isArray(raw)
    ? (raw as SetCandidate[]).filter(
        (c) => c && typeof c._id === "string" && typeof c.label === "string",
      )
    : undefined;

  if (!candidates) return null;
  // The pill goes when the last root is filed; the dialog does NOT — it stays
  // up on its "All caught up" line until the operator closes it, rather than
  // vanishing under their last press.
  if (candidates.length === 0 && !open) return null;

  return (
    <>
      {candidates.length > 0 && (
        <button
          type="button"
          ref={pillRef}
          onClick={() => setOpen(true)}
          aria-label={`${candidatePillText(candidates.length)} — review new sets`}
          className="text-xs px-2.5 py-1 rounded-full border border-sky-700 dark:border-[#00C2FF]/70 bg-[#00C2FF]/10 text-sky-800 dark:text-[#00C2FF] focus:outline-none focus:ring-2 focus:ring-[#00B7FF]"
        >
          {candidatePillText(candidates.length)}
        </button>
      )}
      {open && (
        <SetCandidateReviewModal
          isOpen
          candidates={candidates}
          viewMode={viewMode}
          scopeLabel={scope?.value}
          restoreFocusRef={pillRef}
          onClose={() => setOpen(false)}
          onCreate={async (candidateId, name) => {
            await createFromCandidate({ candidateId, name });
          }}
          onSkip={async (candidateId) => {
            await skipCandidate({ candidateId });
          }}
        />
      )}
    </>
  );
}
