import { useEffect, useMemo, useRef, useState } from "react";
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
 * set. The operator names it, and the set that results is NB's own row with
 * the SportLots id on its Base, exactly where the Base picker would have put
 * it.
 *
 * ## The name field starts as the brand's prefix + the label
 *
 * A BSC-synced set under Topps is called "Topps Heritage"; SportLots' label
 * for the same product, brand-stripped, is "Heritage". The server hands each
 * root a `defaultName` ("Topps Heritage") so the set lands beside its BSC
 * siblings, and `brandPrefix` when it prepended one. The row shows the label
 * with the prefix as a muted lead-in ("Topps · Heritage") so the operator
 * sees why the field reads longer than the root; under Unknown there is no
 * prefix and the field starts as the label. The field is editable and the
 * client sends what it holds — nothing is prepended on create.
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
 * ## Skip has a way back
 *
 * A skipped root leaves the list but not the table (the reconcile keeps it
 * as long as upstream still lists it). "Show skipped (N)" at the bottom of
 * the list unfolds them as dimmed, dashed cards — set aside, not gone —
 * each with one "Bring back" button that returns it to the pending list.
 * Nothing else is offered on a skipped row: bringing it back is the way to
 * create it, so the two lists never carry two create paths.
 *
 * ## Focus never leaves the dialog
 *
 * Create, Skip and Bring back each remove their own row on success, and the
 * name field is the control Enter fires Create from. None of them is ever
 * natively `disabled` (that blurs the activated control to <body> before
 * the await starts — the house rule in `NeonButton`); they are
 * `aria-disabled` with the handlers guarding re-entry. When a row leaves
 * either list and focus has ACTUALLY dropped to <body>, it is parked on the
 * dialog container. On close, the pill this opened from may itself be gone
 * (the list drained to zero while the dialog stayed up on "All caught up"),
 * so the restore checks `isConnected` and falls back to the column the
 * pill sat in.
 *
 * ## Grouped by brand in the All Brands view
 *
 * From a brand's own column the list is that brand's. From the view it is
 * every brand's, under a heading per brand, so an operator can see that
 * "Finest" is new under Topps and not under Unknown.
 */

/** A member as the server hands it over: the label only (its id stays server-side). */
export type SetCandidateMember = { label: string };

export type SetCandidate = {
  _id: GenericId<"setCandidates">;
  manufacturerId: GenericId<"selectorOptions">;
  side: "bsc" | "sportlots";
  /** The marketplace's brand-stripped label — the root's visible name. */
  label: string;
  /** What the name field starts as: `<brandPrefix> <label>`, or `label`. */
  defaultName: string;
  /** The prefix `defaultName` leads with; absent when nothing was prepended. */
  brandPrefix?: string;
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

/**
 * The "+ N more starting with it" line under a root. `""` for a root with no
 * members. Says what a member IS — an entry whose label starts with the
 * root's — rather than "variants", which the operator reads as a promise
 * about what the next sync will make of them.
 */
export function memberSummary(members: readonly SetCandidateMember[]): string {
  if (members.length === 0) return "";
  return `+ ${members.length} more starting with it`;
}

/** The disclosure's visible text. `""` when nothing is skipped (the control is not rendered). */
export function skippedToggleText(count: number, open: boolean): string {
  if (count === 0) return "";
  return `${open ? "Hide" : "Show"} skipped (${count})`;
}

/**
 * What the name field starts as: the server's `defaultName` — the brand's
 * prefix in front of the label when the brand carries one the label does not
 * already lead with, the label as-is otherwise.
 */
export function defaultSetName(
  candidate: Pick<SetCandidate, "defaultName">,
): string {
  return candidate.defaultName;
}

/**
 * The muted lead-in the root line shows before the label — the prefix the
 * default name gained — or `null` when the default IS the label (no prefix
 * on the brand, or the label already leads with it). Keyed on the server's
 * `brandPrefix`, and double-checked against `defaultName !== label` so a
 * row can never show a lead-in its field does not carry.
 */
export function prependedPrefix(
  candidate: Pick<SetCandidate, "label" | "defaultName" | "brandPrefix">,
): string | null {
  if (!candidate.brandPrefix) return null;
  if (candidate.defaultName === candidate.label) return null;
  return candidate.brandPrefix;
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
    if (busy || name.trim().length === 0) return;
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
  const leadIn = prependedPrefix(candidate);

  return (
    <div className="border border-gray-700 rounded-md p-3 space-y-2">
      <div className="min-w-0">
        {/* The marketplace's label, as the root. The label stays the <p>'s
            own direct text node so a flow can find the row by the name
            SportLots uses; the brand prefix the name field gained sits in
            front as a muted lead-in (its own span — a middle dot, not a
            chevron, because it is a name part, not a parent). text-gray-400
            on bg-gray-900: 6.8:1. */}
        <p className="text-sm font-semibold text-gray-100 break-words">
          {leadIn && (
            <span className="font-normal text-gray-400">{`${leadIn} · `}</span>
          )}
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
        // Enter in this field fires Create, so this IS the activated control
        // for the keyboard path: read-only while busy, never `disabled`.
        readOnly={busy !== null}
        aria-disabled={busy !== null || undefined}
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
          aria-disabled={busy !== null || name.trim().length === 0 || undefined}
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
          aria-disabled={busy !== null || undefined}
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

/**
 * A skipped root: the same card, dimmed and dashed so it reads as set aside,
 * with the one thing to do about it. No name field, no Create — bringing it
 * back is how it gets created.
 */
function SkippedCandidateRow({
  candidate,
  onUnskip,
}: {
  candidate: SetCandidate;
  onUnskip: (candidateId: GenericId<"setCandidates">) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldClass = useFieldTestClass();

  const bringBack = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onUnskip(candidate._id);
    } catch (e) {
      setError(userFacingMessage(e, "Couldn't bring it back."));
    } finally {
      setBusy(false);
    }
  };

  const summary = memberSummary(candidate.members);

  return (
    <div className="border border-dashed border-gray-600 rounded-md p-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        {/* text-gray-300 on bg-gray-900: 9.6:1 — dimmer than a pending
            root's gray-100, still a name. The label stays the <p>'s direct
            text node for the same reason as on a pending row. */}
        <p className="text-sm text-gray-300 break-words">{candidate.label}</p>
        {summary && (
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
        {error && (
          <p
            role="alert"
            className="mt-2 text-xs p-2 bg-red-900/30 border border-red-700 rounded-md text-red-200"
          >
            {error}
          </p>
        )}
      </div>
      <NeonButton
        secondary
        size="2"
        className={`${fieldClass("btn-bring-back")} shrink-0`}
        aria-disabled={busy || undefined}
        onClick={() => void bringBack()}
        onKeyDown={(e) => activateOnEnter(e, () => void bringBack(), busy)}
        aria-label={`Bring back "${candidate.label}"`}
      >
        {busy ? "Bringing back…" : "Bring back"}
      </NeonButton>
    </div>
  );
}

export default function SetCandidateReviewModal({
  isOpen,
  candidates,
  skipped = [],
  viewMode,
  scopeLabel,
  restoreFocusRef,
  fallbackFocusRef,
  onClose,
  onCreate,
  onSkip,
  onUnskip,
}: {
  isOpen: boolean;
  candidates: SetCandidate[];
  /** The scope's skipped roots — the "Show skipped (N)" list. */
  skipped?: SetCandidate[];
  /** All Brands view: group by brand. */
  viewMode: boolean;
  /** e.g. "1997" (view) or "Topps" (brand) — names the scope in the subline. */
  scopeLabel?: string;
  /** a11y: where focus goes on close — the pill this was opened from. */
  restoreFocusRef?: RefObject<HTMLElement | null>;
  /**
   * a11y: where focus goes on close when the pill is no longer in the
   * document — it unmounts when the list drains to zero while this dialog
   * stays up. A stable ancestor (the column the pill sat in).
   */
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  /** Escape, or the footer's Close. Writes nothing. */
  onClose: () => void;
  onCreate: (candidateId: GenericId<"setCandidates">, name: string) => Promise<void>;
  onSkip: (candidateId: GenericId<"setCandidates">) => Promise<void>;
  onUnskip?: (candidateId: GenericId<"setCandidates">) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  // The footer's running account of what just landed. Content-keyed by
  // `role="status"`: each write changes the text, so each one is announced.
  const [outcome, setOutcome] = useState<string | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const restoreTarget = restoreFocusRef?.current;
    triggerRef.current =
      restoreTarget ?? (document.activeElement as HTMLElement | null);
    // Focus lands on Close: the non-writing control is the safe landing spot.
    const id = requestAnimationFrame(() => closeBtnRef.current?.focus());
    return () => {
      cancelAnimationFrame(id);
      // The pill may have unmounted while this stayed open (list drained to
      // zero); focusing a detached node is a silent no-op that strands focus
      // on <body>. Fall back to the stable anchor the opener supplied.
      const trigger = triggerRef.current;
      if (trigger?.isConnected) {
        trigger.focus();
        return;
      }
      // Read at CLOSE time on purpose: the opener keeps this ref pointing at
      // the column it currently sits in, and the value at mount is exactly
      // the stale one the rule warns about.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- the latest anchor is the one wanted
      const fallback = fallbackFocusRef?.current;
      if (fallback?.isConnected) fallback.focus();
    };
  }, [isOpen, restoreFocusRef, fallbackFocusRef]);

  // A row leaving either list unmounts the control that was just pressed
  // (Create, Skip, Bring back, or the name field Enter fired from). Park on
  // the dialog container — only when focus has ACTUALLY dropped to <body>,
  // never on a same-shape update where a still-mounted control holds it.
  const rowSignature = useMemo(
    () =>
      `${candidates.map((c) => c._id as string).join(",")}|${skipped
        .map((c) => c._id as string)
        .join(",")}`,
    [candidates, skipped],
  );
  const prevSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isOpen) {
      prevSignatureRef.current = null;
      return;
    }
    const prev = prevSignatureRef.current;
    prevSignatureRef.current = rowSignature;
    if (prev === null || prev === rowSignature) return;
    if (document.activeElement === document.body) {
      dialogRef.current?.focus();
    }
  }, [isOpen, rowSignature]);

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
  const handleUnskip = async (candidateId: GenericId<"setCandidates">) => {
    if (!onUnskip) return;
    const label = skipped.find((c) => c._id === candidateId)?.label;
    await onUnskip(candidateId);
    setOutcome(label ? `Brought back '${label}'` : "Brought back");
  };
  const skippedToggle = skippedToggleText(skipped.length, showSkipped);

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
              New on SportLots
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
            {skippedToggle && onUnskip && (
              // The way back, below the pending list and quieter than it: a
              // disclosure, not a tab, because the skipped roots are the
              // same list set aside rather than a second thing to review.
              <section aria-label="Skipped" className="space-y-2 pt-2 border-t border-gray-800">
                <button
                  type="button"
                  aria-expanded={showSkipped}
                  onClick={() => setShowSkipped((on) => !on)}
                  className="text-xs text-gray-400 hover:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF] rounded px-1 -mx-1"
                >
                  <span aria-hidden="true">{showSkipped ? "▾ " : "▸ "}</span>
                  {skippedToggle}
                </button>
                {showSkipped && (
                  <div className="space-y-2">
                    {(viewMode
                      ? groupCandidatesByBrand(skipped)
                      : [{ brand: undefined, brandId: undefined, items: skipped }]
                    ).map((group) => (
                      <div
                        key={`skipped-${(group.brandId as string | undefined) ?? "all"}`}
                        className="space-y-2"
                      >
                        {group.brand && (
                          <h3 className="text-[11px] uppercase tracking-wide text-gray-400">
                            {group.brand}
                          </h3>
                        )}
                        {group.items.map((candidate) => (
                          <SkippedCandidateRow
                            key={candidate._id as string}
                            candidate={candidate}
                            onUnskip={handleUnskip}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </section>
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
  // The skipped roots, read only while the dialog is up: the pill needs the
  // pending count and nothing else, and the way-back list is a dialog thing.
  const skippedForBrand = useQuery(
    api.setDiscovery.getSetCandidates,
    viewMode ? "skip" : { manufacturerId: parentId, status: "skipped" },
  );
  const skippedForYear = useQuery(
    api.setDiscovery.getSetCandidatesForYear,
    viewMode ? { yearId: parentId, status: "skipped" } : "skip",
  );
  // The scope's own value for the subline — deduped against the column's
  // identical read.
  const scope = useQuery(api.selectorOptions.getSelectorOptionById, {
    id: parentId,
  });
  const createFromCandidate = useMutation(api.setDiscovery.createSetFromCandidate);
  const skipCandidate = useMutation(api.setDiscovery.skipSetCandidate);
  const unskipCandidate = useMutation(api.setDiscovery.unskipSetCandidate);
  const [open, setOpen] = useState(false);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  // a11y: the pill unmounts when the list drains to zero while the dialog is
  // up, so the dialog's close needs somewhere stable to land. The column
  // this pill sits in is the nearest programmatic focus target
  // (`tabIndex={-1}` on `EntityColumn`'s container); its element is captured
  // into a ref the dialog's cleanup can still read after this has unmounted.
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const fallbackFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    fallbackFocusRef.current =
      anchorRef.current?.closest<HTMLElement>('[tabindex="-1"]') ?? null;
  });

  const raw = viewMode ? forYear : forBrand;
  // Shape-guarded rather than trusted, like the column's other pills: a row
  // this dialog cannot act on is not one it should count either.
  const candidates: SetCandidate[] | undefined = Array.isArray(raw)
    ? shapeGuard(raw)
    : undefined;
  const rawSkipped = viewMode ? skippedForYear : skippedForBrand;
  const skipped: SetCandidate[] = Array.isArray(rawSkipped)
    ? shapeGuard(rawSkipped)
    : [];

  if (!candidates) return null;
  // The pill goes when the last root is filed; the dialog does NOT — it stays
  // up on its "All caught up" line until the operator closes it, rather than
  // vanishing under their last press.
  if (candidates.length === 0 && !open) return null;

  return (
    <span ref={anchorRef} className="contents">
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
          skipped={skipped}
          viewMode={viewMode}
          scopeLabel={scope?.value}
          restoreFocusRef={pillRef}
          fallbackFocusRef={fallbackFocusRef}
          onClose={() => setOpen(false)}
          onCreate={async (candidateId, name) => {
            await createFromCandidate({ candidateId, name });
          }}
          onSkip={async (candidateId) => {
            await skipCandidate({ candidateId });
          }}
          onUnskip={async (candidateId) => {
            await unskipCandidate({ candidateId });
          }}
        />
      )}
    </span>
  );
}

function shapeGuard(rows: unknown[]): SetCandidate[] {
  return (rows as SetCandidate[]).filter(
    (c) =>
      c &&
      typeof c._id === "string" &&
      typeof c.label === "string" &&
      typeof c.defaultName === "string",
  );
}
