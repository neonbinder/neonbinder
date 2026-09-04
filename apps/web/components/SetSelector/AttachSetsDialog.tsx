import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import { useAction, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import NeonButton from "../modules/NeonButton";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";
import { Input } from "../primitives/Input";
import { NO_MARKETPLACE_IDS_MESSAGE } from "../../convex/marketplaceResolvability";

/**
 * Combined attach dialog (NEO-6 phase 1, reworked in NEO-196). Lists BSC and
 * SportLots sets side-by-side, each searchable + multi-select. Confirm batches
 * the selection into a single `attachPlatformIds` mutation.
 *
 * ## What NEO-196 changed, and why
 *
 * The dialog used to ask `fetchRawOptions` for the NB row's OWN level under its
 * OWN parent. That is the reconciler's question, not this dialog's. A
 * multi-source row exists precisely because some of its cards were released in
 * a DIFFERENT marketplace set (1996 Score DCAP is split across two BSC sets;
 * 2021 Score's last 20 cards shipped in Chronicles), so a pool scoped to this
 * row's parent could never contain the thing the operator came for. It was also
 * wrong in three narrower ways:
 *
 *   • variantType rows were offered BSC's `variant` facet — literally
 *     "Base" / "Insert" / "Parallel" — as attachable marketplace ids.
 *   • parallel rows got a hard "BSC has no aggregation for level: parallel"
 *     and SL's "Unknown level: parallel"; both panes rendered empty.
 *   • variantType and parallel rows got nothing at all from SL, which answers
 *     only at level "insert".
 *
 * In every one of those cases `fetchRawOptions` reported `success: true` with a
 * populated `errors[]` that this component ignored, so a marketplace outage and
 * an empty marketplace looked identical: "No unattached candidates."
 *
 * ## The browse model
 *
 * The two marketplaces do not share a hierarchy, so the panes are scoped
 * separately — but both reach every set under the row's year/manufacturer,
 * which is the breadth the ticket asks for.
 *
 *   SportLots has no set/variant split. `dealsets.tpl` returns a FLAT list of
 *   sets for sport+year+brand, and that list is both the browse surface and
 *   the attachable unit, so the SL pane needs no control: it always shows
 *   every set under the year/manufacturer.
 *
 *   BSC does have the split, and its facet API cannot enumerate variantNames
 *   with their owning set. So the BSC pane browses in two steps — up to the
 *   year's set list, then back down into one set's variants. It opens on the
 *   row's own set, which is the pool the operator had before.
 *
 * ## What NEO-189 changed
 *
 * A BSC set in the set list is now attachable, not just browsable, and every
 * BSC selection carries the FACET it came from (`setName` from the set list,
 * `variantName` from a set's variant list). That facet travels to the slot and
 * the checklist fetch buckets on it.
 *
 * It had to: BSC files Topps Series 1 and Series 2 as two `setName` sets while
 * SportLots files them as one, so an NB Base row must be able to draw from two
 * BSC sets — and a set was the one thing this dialog could not attach.
 *
 * Keyboard model:
 *   Tab     — cycle breadcrumb, search inputs, candidate rows, footer buttons
 *   Space   — toggle the focused candidate's checkbox
 *   Enter   — activate the focused button; confirm when focus owns no control
 *             (Enter on a set row's Browse steps into it, it does not attach)
 *   Escape  — cancel
 */
type Side = "bsc" | "sportlots";

type Candidate = {
  value: string;
  platformValue: string;
};

/**
 * NEO-189 — which BSC facet a selected id is a value of.
 *
 * A BSC slug is not self-describing: `topps-series-1` is a `setName` value and
 * `gold-foil` is a `variantName` value, and the checklist fetch has to filter
 * on the right facet or it returns nothing. The pane's current rung IS the
 * answer — anything in the set list is a setName, anything in a set's variant
 * list is a variantName — so this is recorded at toggle time rather than
 * guessed later from the row's NB level, which is what used to happen and what
 * silently discarded any setName id attached to a Base or Parallel row.
 */
type BscFacet = "setName" | "variantName";

type Selection = {
  id: string;
  label: string;
  /** BSC only; SportLots has a single unit of attachment. */
  facet?: BscFacet;
};

/** Which rung of the BSC ladder the BSC pane is on. */
type BscView = "variants" | "sets";

export default function AttachSetsDialog({
  isOpen,
  parentFilters,
  selectorOptionId,
  alreadyAttached,
  onClose,
}: {
  isOpen: boolean;
  /**
   * Ancestor display values keyed by level. Used for pane headings and the
   * BSC breadcrumb only — the candidate pools are resolved server-side from
   * `selectorOptionId`, so the client cannot construct an incoherent request.
   */
  parentFilters: Record<string, string>;
  selectorOptionId: Id<"selectorOptions">;
  alreadyAttached: { bsc: Set<string>; sportlots: Set<string> };
  onClose: () => void;
}) {
  const fetchSlAttachSets = useAction(api.setReconciliation.fetchSlAttachSets);
  const fetchBscAttachOptions = useAction(
    api.setReconciliation.fetchBscAttachOptions,
  );
  const attachPlatformIds = useMutation(api.selectorOptions.attachPlatformIds);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [bscView, setBscView] = useState<BscView>("variants");
  // undefined → the row's own set, which the server resolves off the chain.
  const [bscSetSlug, setBscSetSlug] = useState<string | undefined>(undefined);
  const [bscSetLabel, setBscSetLabel] = useState<string | undefined>(undefined);

  const [bscCandidates, setBscCandidates] = useState<Candidate[]>([]);
  const [slCandidates, setSlCandidates] = useState<Candidate[]>([]);
  /**
   * NEO-239 — the side was SKIPPED, not asked.
   *
   * A row whose chain carries no ids on one side gets `success: true` with an
   * empty list and the server's fixed skip sentence, because a side with
   * nothing to scope the query is not an error: the operator can still attach
   * on the other pane, and a red alert would say otherwise. But rendering that
   * as the ordinary "No BSC sets for this year." is a lie in the other
   * direction — it reports on a marketplace nobody asked. So the sentence is
   * held per side and shown in place of the empty copy.
   *
   * Matched by EQUALITY against the server's own exported constant, not by
   * sniffing the text: a successful non-skip call also carries a `message`,
   * and it is a count ("BSC: 12 set(s)") that must never surface as an
   * explanation. Importing the constant means a reword moves both sides at
   * once.
   */
  const [bscSkipNote, setBscSkipNote] = useState<string | null>(null);
  const [slSkipNote, setSlSkipNote] = useState<string | null>(null);
  const [bscLoading, setBscLoading] = useState(false);
  const [slLoading, setSlLoading] = useState(false);
  // Per-pane, not shared: one marketplace being down must not blank the other,
  // and the operator needs to know WHICH one failed.
  const [bscError, setBscError] = useState<string | null>(null);
  const [slError, setSlError] = useState<string | null>(null);

  const [bscSelected, setBscSelected] = useState<Map<string, Selection>>(new Map());
  const [slSelected, setSlSelected] = useState<Map<string, Selection>>(new Map());
  const [bscSearch, setBscSearch] = useState("");
  const [slSearch, setSlSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  const yearLabel = parentFilters.year ?? "";
  const manufacturerLabel = parentFilters.manufacturer ?? "";
  const ownSetLabel = parentFilters.setName ?? "this set";
  const shownSetLabel = bscSetLabel ?? ownSetLabel;
  const allBscSetsLabel = yearLabel ? `All ${yearLabel} sets` : "All sets";
  const yearMfr = [yearLabel, manufacturerLabel].filter(Boolean).join(" ");
  const allSlSetsLabel = yearMfr ? `All ${yearMfr} sets` : "All sets";

  // Serialized identity of the fetch inputs. The candidate-load effects key off
  // THIS string rather than the alreadyAttached object reference, so unrelated
  // parent re-renders (which may hand us fresh object identities) never re-fire
  // a load and wipe the search box out from under an in-progress interaction.
  // MultiSourcePanel already memoizes those props; keying the effects on a
  // value-derived string is defense in depth.
  const attachedKey = useMemo(
    () =>
      JSON.stringify({
        id: selectorOptionId,
        bsc: Array.from(alreadyAttached.bsc).sort(),
        sl: Array.from(alreadyAttached.sportlots).sort(),
      }),
    [selectorOptionId, alreadyAttached],
  );

  // Reset transient UI (search text, selection, BSC browse position) ONLY on a
  // genuine closed→open transition — never on unrelated re-renders while the
  // dialog is already open. Tracked via a ref edge so a half-typed search query
  // (e.g. "Chrome") survives any parent re-render that lands mid-interaction;
  // wiping it there was the root cause of the dropped Cancel tap.
  const prevIsOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = isOpen && !prevIsOpenRef.current;
    prevIsOpenRef.current = isOpen;
    if (justOpened) {
      setBscSearch("");
      setSlSearch("");
      setBscSelected(new Map());
      setSlSelected(new Map());
      setBscView("variants");
      setBscSetSlug(undefined);
      setBscSetLabel(undefined);
      setErrorMsg(null);
    }
  }, [isOpen]);

  // ---- SportLots pane. One call, no scope control: SL's list is already the
  // full sport/year/manufacturer set list.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading flag raised before the fetch it guards
    setSlLoading(true);
    setSlError(null);
    setSlSkipNote(null);
    (async () => {
      try {
        const result = await fetchSlAttachSets({ selectorOptionId });
        if (cancelled) return;
        if (!result.success) {
          setSlError(result.message || "Failed to load SportLots sets");
          setSlCandidates([]);
          return;
        }
        if (isSkipMessage(result)) setSlSkipNote(result.message);
        setSlCandidates(
          dedupe(
            result.options.filter(
              (c) => !alreadyAttached.sportlots.has(c.platformValue),
            ),
          ),
        );
      } catch (err) {
        if (cancelled) return;
        setSlError(err instanceof Error ? err.message : String(err));
        setSlCandidates([]);
      } finally {
        if (!cancelled) setSlLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Keyed on attachedKey (the value identity of the row + attached ids)
    // instead of the raw object refs, so a stable-value re-render never
    // re-triggers the fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, attachedKey, fetchSlAttachSets]);

  // ---- BSC pane. Re-fetches on every rung change (set list ⇄ one set's
  // variants), and is independent of the SL effect above so browsing BSC never
  // re-runs SportLots' slow HTML scrape.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading flag raised before the fetch it guards
    setBscLoading(true);
    setBscError(null);
    setBscSkipNote(null);
    (async () => {
      try {
        const result = await fetchBscAttachOptions({
          selectorOptionId,
          view: bscView,
          ...(bscSetSlug ? { setSlug: bscSetSlug } : {}),
        });
        if (cancelled) return;
        if (!result.success) {
          setBscError(result.message || "Failed to load BSC options");
          setBscCandidates([]);
          return;
        }
        if (isSkipMessage(result)) setBscSkipNote(result.message);
        // The variants view drops what is already attached; the set list does
        // NOT. NEO-189 made a set attachable, but it is still the only way to
        // reach a sibling set's variants — filtering an attached set out of
        // the list would make its variants unreachable the moment the operator
        // attached the set itself. Attached sets render with their checkbox
        // replaced by an "attached" marker instead (see `CandidateRow`).
        const options =
          bscView === "variants"
            ? result.options.filter(
                (c) => !alreadyAttached.bsc.has(c.platformValue),
              )
            : result.options;
        setBscCandidates(dedupe(options));
      } catch (err) {
        if (cancelled) return;
        setBscError(err instanceof Error ? err.message : String(err));
        setBscCandidates([]);
      } finally {
        if (!cancelled) setBscLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, attachedKey, bscView, bscSetSlug, fetchBscAttachOptions]);

  // Focus the confirm button when the dialog opens so Enter works without
  // tabbing first. Standing UX rule: preselect defaults + Enter to confirm.
  useEffect(() => {
    if (isOpen) {
      // Defer to next tick so the button has mounted.
      const t = setTimeout(() => confirmButtonRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [isOpen]);

  const totalSelected = bscSelected.size + slSelected.size;

  // Latched separately from the `submitting` state: the document-level Enter
  // handler and the button's own onClick can both fire inside one event, and
  // neither would observe a state update the other made in the same tick.
  const submittingRef = useRef(false);

  const handleConfirm = useCallback(async () => {
    if (submittingRef.current) return;
    if (bscSelected.size + slSelected.size === 0) return;
    submittingRef.current = true;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await attachPlatformIds({
        selectorOptionId,
        additions: {
          // NEO-189: each BSC id goes over with the facet it was selected
          // from. `facet` is optional on the mutation so an older client keeps
          // working, but this one always knows — the pane's rung IS the facet.
          bsc: Array.from(bscSelected.values()).map((sel) => ({
            id: sel.id,
            label: sel.label,
            ...(sel.facet ? { facet: sel.facet } : {}),
          })),
          // SportLots has one unit of attachment, so no facet.
          sportlots: Array.from(slSelected.values()).map((sel) => ({
            id: sel.id,
            label: sel.label,
          })),
        },
      });
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [attachPlatformIds, bscSelected, slSelected, selectorOptionId, onClose]);

  // Escape closes; Enter confirms only when focus is on nothing that owns Enter
  // itself. Buttons are excluded because this handler calls preventDefault(),
  // which suppresses their native activation — before NEO-196 that was harmless
  // (Confirm was the only button worth pressing Enter on), but the BSC pane now
  // has breadcrumb and set-browse buttons, and Enter on one of those must
  // browse, not attach.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!submitting) onClose();
      }
      if (e.key === "Enter") {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "BUTTON" ||
          tag === "A"
        ) {
          return;
        }
        e.preventDefault();
        void handleConfirm();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, submitting, onClose, handleConfirm]);

  const filteredBsc = useMemo(
    () => searchFilter(bscCandidates, bscSearch),
    [bscCandidates, bscSearch],
  );
  const filteredSl = useMemo(
    () => searchFilter(slCandidates, slSearch),
    [slCandidates, slSearch],
  );

  const toggle = (side: Side, candidate: Candidate, facet?: BscFacet) => {
    const setter = side === "bsc" ? setBscSelected : setSlSelected;
    setter((prev) => {
      const next = new Map(prev);
      if (next.has(candidate.platformValue)) {
        next.delete(candidate.platformValue);
      } else {
        next.set(candidate.platformValue, {
          id: candidate.platformValue,
          label: candidate.value,
          ...(facet ? { facet } : {}),
        });
      }
      return next;
    });
  };

  const updateLabel = (side: Side, id: string, label: string) => {
    const setter = side === "bsc" ? setBscSelected : setSlSelected;
    setter((prev) => {
      const existing = prev.get(id);
      if (!existing) return prev;
      const next = new Map(prev);
      next.set(id, { ...existing, label });
      return next;
    });
  };

  // Browsing is a deliberate transition, so clearing the search box here is
  // correct — unlike the reactive-re-render case the open-edge effect guards.
  const browseAllSets = () => {
    setBscView("sets");
    setBscSearch("");
  };
  const browseSet = (candidate: Candidate) => {
    setBscSetSlug(candidate.platformValue);
    setBscSetLabel(candidate.value);
    setBscView("variants");
    setBscSearch("");
  };
  const backToVariants = () => {
    setBscView("variants");
    setBscSearch("");
  };

  if (!isOpen) return null;

  const bscEmptyText =
    bscView === "sets"
      ? "No BSC sets for this year."
      : `Every BSC variant in this set is already attached. Browse ${allBscSetsLabel.toLowerCase()} to reach another set.`;

  return createPortal(
    // NEO-71-74 QA fix: see BaseSetPicker.tsx for why this nested <Theme> is
    // needed — createPortal(document.body) escapes the root Theme's CSS scope.
    <Theme>
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="attach-sets-title"
    >
      <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-xl w-full max-w-5xl max-h-[85vh] flex flex-col">
        <div className="px-6 py-4 border-b border-gray-700">
          <h2 id="attach-sets-title" className="text-lg font-semibold text-gray-100">
            Attach more source sets
          </h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Pick BSC and/or SportLots sets to attach to this NeonBinder variant —
            including sets from elsewhere in {yearMfr || "this year"}. Cards from
            every attached set roll up into a single checklist; users can filter
            by source.
          </p>
        </div>

        <div className="flex-1 overflow-hidden p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
          <Pane
            paneLabel="BSC candidates"
            title={
              bscView === "sets"
                ? `BSC · ${allBscSetsLabel}`
                : `BSC · ${shownSetLabel}`
            }
            // BSC has no manufacturer facet, so the year's set list spans
            // every brand. Unsaid, "All 2024 sets" showing Bowman under a
            // Topps row reads as a bug rather than as the marketplace's shape.
            subtitle={
              bscView === "sets"
                ? "BSC has no manufacturer facet — search to narrow."
                : undefined
            }
            breadcrumb={
              bscView === "sets" ? (
                <BreadcrumbButton
                  label={`Back to ${shownSetLabel}`}
                  ariaLabel={`Back to BSC set ${shownSetLabel}`}
                  onClick={backToVariants}
                />
              ) : (
                <BreadcrumbButton
                  label={allBscSetsLabel}
                  ariaLabel="Browse all BSC sets"
                  onClick={browseAllSets}
                />
              )
            }
            count={filteredBsc.length}
            search={bscSearch}
            onSearch={setBscSearch}
            searchAriaLabel="Search BSC sets"
            loading={bscLoading}
            error={bscError}
            emptyText={bscEmptyText}
            emptyNote={bscSkipNote}
            isEmpty={filteredBsc.length === 0}
          >
            {bscView === "sets"
              ? filteredBsc.map((c) => (
                  <CandidateRow
                    key={c.platformValue}
                    side="bsc"
                    facet="setName"
                    candidate={c}
                    selection={bscSelected.get(c.platformValue)}
                    attached={alreadyAttached.bsc.has(c.platformValue)}
                    onToggle={toggle}
                    onLabel={updateLabel}
                    onBrowse={browseSet}
                  />
                ))
              : filteredBsc.map((c) => (
                  <CandidateRow
                    key={c.platformValue}
                    side="bsc"
                    facet="variantName"
                    candidate={c}
                    selection={bscSelected.get(c.platformValue)}
                    onToggle={toggle}
                    onLabel={updateLabel}
                  />
                ))}
          </Pane>

          <Pane
            paneLabel="SportLots candidates"
            title={`SportLots · ${allSlSetsLabel}`}
            subtitle="SportLots files set and variant as one, so every set here is attachable."
            count={filteredSl.length}
            search={slSearch}
            onSearch={setSlSearch}
            searchAriaLabel="Search SportLots sets"
            loading={slLoading}
            error={slError}
            emptyText="No unattached SportLots sets."
            emptyNote={slSkipNote}
            isEmpty={filteredSl.length === 0}
          >
            {filteredSl.map((c) => (
              <CandidateRow
                key={c.platformValue}
                side="sportlots"
                candidate={c}
                selection={slSelected.get(c.platformValue)}
                onToggle={toggle}
                onLabel={updateLabel}
              />
            ))}
          </Pane>
        </div>

        {errorMsg && (
          <div className="px-6 pb-2 text-sm text-[#FF2EB3]" role="alert">
            {errorMsg}
          </div>
        )}

        <div className="px-6 py-4 border-t border-gray-700 flex items-center justify-between gap-4">
          <div className="text-xs text-gray-400">
            {totalSelected} set{totalSelected === 1 ? "" : "s"} selected
          </div>
          <div className="flex gap-2">
            <NeonButton
              secondary
              onClick={onClose}
              aria-label="Cancel attach sets"
            >
              Cancel
            </NeonButton>
            <NeonButton
              ref={confirmButtonRef}
              onClick={handleConfirm}
              disabled={submitting || totalSelected === 0}
              aria-label="Confirm attach sets"
            >
              {submitting ? "Attaching…" : `Attach ${totalSelected}`}
            </NeonButton>
          </div>
        </div>
      </div>
    </div>
    </Theme>,
    document.body,
  );
}

function dedupe(items: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return items.filter((c) => {
    if (seen.has(c.platformValue)) return false;
    seen.add(c.platformValue);
    return true;
  });
}

function searchFilter(items: Candidate[], query: string): Candidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (c) =>
      c.value.toLowerCase().includes(q) ||
      c.platformValue.toLowerCase().includes(q),
  );
}

/**
 * Did this successful result mean "we did not ask that marketplace"?
 *
 * Only an empty list can be a skip — a side that returned candidates was
 * plainly reached — and only the server's own skip sentence counts, so a
 * genuinely empty marketplace keeps the pane's ordinary empty copy.
 */
function isSkipMessage(result: {
  options: unknown[];
  message?: string;
}): result is { options: unknown[]; message: string } {
  return result.options.length === 0 && result.message === NO_MARKETPLACE_IDS_MESSAGE;
}

/**
 * Shared pane chrome — heading, optional breadcrumb, search box, count, and
 * the loading / error / empty states. Both marketplaces render the same shell
 * so the two sides read as one control surface even though only BSC has a
 * second rung to browse.
 */
function Pane({
  paneLabel,
  title,
  subtitle,
  breadcrumb,
  count,
  search,
  onSearch,
  searchAriaLabel,
  loading,
  error,
  emptyText,
  emptyNote,
  isEmpty,
  children,
}: {
  /**
   * Stable accessible name for the pane. Deliberately NOT the heading, which
   * changes as the BSC pane browses — this is the handle screen readers and
   * tests use to address one side of the dialog.
   */
  paneLabel: string;
  title: string;
  /**
   * Only set where the pane's scope would otherwise read as a bug. Every line
   * of chrome here costs a row of the list, so a subtitle that merely restates
   * the heading is left off.
   */
  subtitle?: string;
  breadcrumb?: React.ReactNode;
  count: number;
  search: string;
  onSearch: (q: string) => void;
  searchAriaLabel: string;
  loading: boolean;
  error: string | null;
  emptyText: string;
  /**
   * Replaces `emptyText` AND the no-matches line when the whole side was
   * skipped. It outranks the search message deliberately: with nothing
   * fetched, every search comes back empty, and "No matches for 'topps'"
   * would blame the filter for a pane that was never populated.
   */
  emptyNote?: string | null;
  isEmpty: boolean;
  children: React.ReactNode;
}) {
  // Unique per-field class so Maestro inputText targets the tapped input rather
  // than the first input sharing the className (see useFieldTestClass).
  const fieldClass = useFieldTestClass();
  return (
    <section className="flex flex-col min-h-0" aria-label={paneLabel}>
      <header className="mb-2">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-gray-200 truncate">
            {title}
          </h3>
          <span className="text-xs text-gray-500 shrink-0">{count}</span>
        </div>
        {subtitle && (
          <p className="text-[11px] text-gray-500 mt-0.5">{subtitle}</p>
        )}
        {breadcrumb && <div className="mt-1.5">{breadcrumb}</div>}
      </header>
      <Input
        bare
        type="text"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="Search…"
        aria-label={searchAriaLabel}
        className={`${fieldClass("search")} px-3 py-1.5 text-sm mb-2`}
      />
      <ul className="flex-1 overflow-y-auto space-y-1 pr-1">
        {loading && (
          <li className="text-xs text-gray-500 italic px-2 py-1">Loading…</li>
        )}
        {!loading && error && (
          // Surfaced per pane, not merged into one dialog-level message: before
          // NEO-196 an adapter failure was swallowed entirely and read as "this
          // marketplace has nothing", which is the opposite of what it means.
          <li
            className="text-xs text-[#FF2EB3] px-2 py-1 break-words"
            role="alert"
          >
            {error}
          </li>
        )}
        {!loading && !error && isEmpty && (
          <li
            // gray-400, not gray-500: on this panel's ground gray-500 lands at
            // 3.67:1, under the 4.5:1 WCAG 1.4.3 floor for body text — and this
            // line is the ONLY explanation an empty pane gives.
            className="text-xs text-gray-400 italic px-2 py-1"
          >
            {emptyNote ??
              (search.trim() ? `No matches for “${search.trim()}”.` : emptyText)}
          </li>
        )}
        {!loading && !error && children}
      </ul>
    </section>
  );
}

/** Steps the BSC pane one rung up or back down. */
function BreadcrumbButton({
  label,
  ariaLabel,
  onClick,
}: {
  label: string;
  ariaLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="text-xs px-2 py-0.5 rounded border border-gray-700 bg-gray-800 text-[#00B7FF] hover:border-[#00B7FF] focus:border-[#00B7FF] focus:outline-none focus:ring-1 focus:ring-[#00B7FF]"
    >
      ‹ {label}
    </button>
  );
}

/**
 * An attachable marketplace set / variant, with its inline label editor and —
 * in the BSC set list — a Browse control to step into that set's variants.
 *
 * ## Why a BSC set now has a checkbox (NEO-189)
 *
 * It used to be a browse target only, on the reasoning that a `setName` slug
 * is a FILTER rather than a source of cards: `fetchBscChecklist` read every
 * BSC id on a row as a `variantName`, so attaching a set handed back an id
 * that silently sourced nothing.
 *
 * That is no longer true. A slot now records the facet its id belongs to and
 * the fetch buckets on the facet, so `setName` + the row's own variant
 * (base / insert / parallel) is a perfectly good query — and it is the ONLY
 * way to express the split this feature exists for: BSC files Topps Series 1
 * and Series 2 as two sets where SportLots has one, so an NB Base row has to
 * draw from two BSC **setName** sets.
 *
 * ## Select and browse are separate controls, deliberately
 *
 * A set row means two different things now, and one click target cannot serve
 * both. The checkbox (green, the select/commit colour) attaches the set; the
 * Browse button (blue ring, the navigation colour) steps down a rung. Merging
 * them would make "I want this set's cards" and "show me what is inside" the
 * same gesture, which is how an operator ends up attaching a whole set when
 * they meant to pick one parallel out of it.
 */
function CandidateRow({
  side,
  facet,
  candidate,
  selection,
  attached,
  onToggle,
  onLabel,
  onBrowse,
}: {
  side: Side;
  /** BSC only — the facet this rung's ids belong to. */
  facet?: BscFacet;
  candidate: Candidate;
  selection: Selection | undefined;
  /**
   * Already attached to this row. Set rows stay listed when attached — the set
   * list is still the only route to a sibling set's variants — but they cannot
   * be attached twice.
   */
  attached?: boolean;
  onToggle: (side: Side, candidate: Candidate, facet?: BscFacet) => void;
  onLabel: (side: Side, id: string, label: string) => void;
  onBrowse?: (c: Candidate) => void;
}) {
  // One class per ROW instance (useId), so Maestro's activeElement→XPath round
  // trip lands in the label field of the row that was tapped.
  const fieldClass = useFieldTestClass();
  const isSelected = !!selection;
  return (
    <li
      className={`flex items-start gap-1 rounded ${
        isSelected ? "bg-gray-800 text-gray-100" : "bg-gray-800/40 text-gray-300"
      }`}
    >
      <label
        className={`flex-1 min-w-0 flex items-start gap-2 px-2 py-1.5 text-sm ${
          attached ? "cursor-default" : "cursor-pointer"
        }`}
      >
        {attached ? (
          <span
            className="mt-0.5 shrink-0 text-[10px] uppercase tracking-wide text-gray-500"
            aria-label={`${candidate.value} is already attached`}
          >
            attached
          </span>
        ) : (
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => onToggle(side, candidate, facet)}
            className="accent-[#00D558] mt-1"
            aria-label={`Toggle ${candidate.value}`}
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="truncate font-medium">{candidate.value}</div>
          <div className="text-[10px] text-gray-500 truncate">
            id: {candidate.platformValue}
          </div>
          {selection && (
            <Input
              bare
              type="text"
              value={selection.label}
              onChange={(e) => onLabel(side, candidate.platformValue, e.target.value)}
              placeholder="Label shown on filter chip"
              aria-label={`Edit label for ${candidate.value}`}
              className={`${fieldClass("label")} mt-1 w-full px-2 py-0.5 text-xs`}
            />
          )}
        </div>
      </label>
      {onBrowse && (
        <button
          type="button"
          onClick={() => onBrowse(candidate)}
          aria-label={`Browse BSC set ${candidate.value}`}
          className="shrink-0 self-start mt-1.5 mr-1 text-xs px-2 py-0.5 rounded border border-gray-700 text-[#00B7FF] hover:border-[#00B7FF] focus:border-[#00B7FF] focus:outline-none focus:ring-1 focus:ring-[#00B7FF]"
        >
          Browse ›
        </button>
      )}
    </li>
  );
}
