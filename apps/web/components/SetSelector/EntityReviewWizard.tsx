import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import NeonButton from "../modules/NeonButton";
import EntityLinkSearch from "./EntityLinkSearch";

/**
 * NEO-92: step-through review wizard, replaces the old single-screen
 * UnknownEntitiesDialog (a flat checkbox list of every unknown name at
 * once, no per-name info). Presents ONE player/team at a time, showing
 * whatever the background Wikidata lookup (entityReviewQueue.ts +
 * adapters/wikidata.ts's processEntityReviewQueue) has already found —
 * fully reactive via `getBatch`, so a row's status flips live as the
 * queue drains without polling.
 *
 * "Current item" = the earliest-inserted row that is no longer "pending"
 * and has no decision yet. Because the background queue is a single
 * serial chain (one Wikidata request at a time — see INTER_ENTITY_DELAY_MS
 * in wikidata.ts), completion order IS insertion order, so this is exactly
 * "present as soon as its lookup completes" — rows still "pending" are
 * simply skipped over, never blocking the wizard on a straggler.
 *
 * Every name resolves to exactly one of two decisions — there is no skip:
 *   - "Add as New" — recordDecision({action:"create"}); commitCardChecklist
 *     seeds the new row directly from this row's cached enrichment.
 *   - "Link to Existing…" — EntityLinkSearch picks a real existing row;
 *     recordDecision({action:"link", linked*Id}); no new row is created.
 * Both are patched immediately (recordDecision), not just kept in local
 * React state — wizard progress survives a page refresh.
 *
 * "Add All Remaining as New" (recordAllRemainingAsCreate) is the bulk
 * fast path for the common case — a first-time real-set sync can surface
 * hundreds of genuinely-new names (every rookie in a brand-new set), where
 * one-at-a-time review only has value for the names that look wrong.
 * Nothing is written to players/teams/cardChecklist until the final
 * Confirm & Save either way — this only marks decisions early.
 *
 * Cancel only ever deletes this batch's entityReviewQueue rows
 * (cancelBatch) — players/teams/cardChecklist are never touched during
 * review, matching the old dialog's exact all-or-nothing Cancel semantics.
 */
export default function EntityReviewWizard({
  isOpen,
  selectorOptionId,
  batchId,
  cardCount,
  onConfirm,
  onCancel,
  saving,
}: {
  isOpen: boolean;
  selectorOptionId: Id<"selectorOptions">;
  batchId: string;
  /** Number of cards this fetch will save once committed — shown on the final step. */
  cardCount: number;
  /** All rows decided, user clicked "Confirm & Save". Parent calls commitCardChecklist. */
  onConfirm: () => void;
  /** Parent should clear its pending-preview state and show a "cancelled" message. */
  onCancel: () => void;
  /** True while commitCardChecklist is in flight. Disables the final Save button. */
  saving?: boolean;
}) {
  const rows = useQuery(
    api.entityReviewQueue.getBatch,
    isOpen ? { selectorOptionId, batchId } : "skip",
  );
  const recordDecision = useMutation(api.entityReviewQueue.recordDecision);
  const cancelBatch = useMutation(api.entityReviewQueue.cancelBatch);
  const recordAllRemainingAsCreate = useMutation(
    api.entityReviewQueue.recordAllRemainingAsCreate,
  );

  const [linkingOpen, setLinkingOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [bulkCreating, setBulkCreating] = useState(false);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  const total = rows?.length ?? 0;
  const decided = useMemo(() => rows?.filter((r) => r.decision).length ?? 0, [rows]);
  const stillLookingUp = useMemo(
    () => rows?.filter((r) => r.status === "pending").length ?? 0,
    [rows],
  );
  const current = useMemo(
    () => rows?.find((r) => r.status !== "pending" && !r.decision) ?? null,
    [rows],
  );
  const allDecided = total > 0 && decided === total;

  // Closing the "Link to Existing" search whenever the current item changes
  // (e.g. after a decision advances the wizard) so it doesn't stay open for
  // the wrong row.
  useEffect(() => {
    setLinkingOpen(false);
  }, [current?._id]);

  // Focus the final Save button as soon as it appears so Enter immediately
  // works, mirroring the old dialog's keyboard contract.
  useEffect(() => {
    if (allDecided) confirmButtonRef.current?.focus();
  }, [allDecided]);

  const handleCancel = async () => {
    if (cancelling || saving) return;
    setCancelling(true);
    try {
      await cancelBatch({ selectorOptionId, batchId });
    } finally {
      // onCancel() lives in finally so the wizard always closes and the parent
      // always clears its pending-preview state — even if cancelBatch rejects
      // (transient network/auth error). Leaving it after the try/finally would
      // let a rejection (swallowed by the caller's `void handleCancel()`) strand
      // the dialog permanently open.
      setCancelling(false);
      onCancel();
    }
  };

  const handleBulkCreate = async () => {
    if (bulkCreating || saving) return;
    setBulkCreating(true);
    try {
      await recordAllRemainingAsCreate({ selectorOptionId, batchId });
    } finally {
      setBulkCreating(false);
    }
  };

  if (!isOpen || rows === undefined) return null;

  const handleCreate = async (reviewRowId: Id<"entityReviewQueue">) => {
    await recordDecision({ reviewRowId, action: "create" });
  };
  const handleLink = async (
    reviewRowId: Id<"entityReviewQueue">,
    kind: "player" | "team",
    linkedId: Id<"players"> | Id<"teams">,
  ) => {
    await recordDecision({
      reviewRowId,
      action: "link",
      linkedPlayerId: kind === "player" ? (linkedId as Id<"players">) : undefined,
      linkedTeamId: kind === "team" ? (linkedId as Id<"teams">) : undefined,
    });
  };

  const kindLabel = (kind: "player" | "team") => (kind === "player" ? "Player" : "Team");

  return createPortal(
    // See BaseSetPicker.tsx / SetAttributesPanel.tsx for why createPortal
    // needs a nested <Theme> — it escapes the root Theme's CSS scope.
    <Theme>
      <div
        className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="entity-review-wizard-title"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !linkingOpen) {
            e.preventDefault();
            void handleCancel();
          } else if (
            e.key === "Enter" &&
            allDecided &&
            !saving &&
            (e.target as HTMLElement)?.tagName !== "INPUT"
          ) {
            e.preventDefault();
            onConfirm();
          }
        }}
      >
        <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-xl w-full max-w-md flex flex-col">
          {/* Header: progress counter (satisfies "show N remaining"). */}
          <div className="px-6 py-4 border-b border-gray-700">
            <h2
              id="entity-review-wizard-title"
              className="text-lg font-semibold text-gray-100"
            >
              Confirm New Players &amp; Teams
            </h2>
            <p className="text-xs text-gray-400 mt-0.5" role="status" aria-live="polite">
              {decided} of {total} reviewed
              {stillLookingUp > 0 ? ` · ${stillLookingUp} still being looked up` : ""}
            </p>
          </div>

          <div className="p-6 space-y-4">
            {current ? (
              <>
                <div>
                  <h3 className="text-sm font-semibold text-gray-200">
                    {current.name}{" "}
                    <span className="text-xs font-normal text-gray-500">
                      ({kindLabel(current.kind)} · {current.sport})
                    </span>
                  </h3>
                  <div className="mt-2 text-xs text-gray-400 space-y-1">
                    {current.status === "error" || !current.enrichment ? (
                      <p className="italic">No Wikidata match found.</p>
                    ) : current.kind === "player" ? (
                      <>
                        {current.enrichment.isHallOfFame && (
                          <p className="text-[#00D558] font-semibold">Hall of Fame</p>
                        )}
                        {current.enrichment.careerTeams &&
                        current.enrichment.careerTeams.length > 0 ? (
                          <ul className="list-disc list-inside">
                            {current.enrichment.careerTeams.map((ct) => (
                              <li key={ct.name}>
                                {ct.name} ({ct.fromYear}
                                {ct.toYear ? `–${ct.toYear}` : "–present"})
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p>No career-team history found.</p>
                        )}
                      </>
                    ) : (
                      <>
                        {current.enrichment.league && <p>League: {current.enrichment.league}</p>}
                        {current.enrichment.city && <p>City: {current.enrichment.city}</p>}
                        {current.enrichment.yearsActive && (
                          <p>
                            Active: {current.enrichment.yearsActive.from}
                            {current.enrichment.yearsActive.to
                              ? `–${current.enrichment.yearsActive.to}`
                              : "–present"}
                          </p>
                        )}
                        {current.enrichment.colors?.primary && (
                          <p className="flex items-center gap-1">
                            Colors:
                            <span
                              aria-hidden="true"
                              className="inline-block w-3 h-3 rounded-full border border-gray-600"
                              style={{ backgroundColor: current.enrichment.colors.primary }}
                            />
                            {current.enrichment.colors.secondary && (
                              <span
                                aria-hidden="true"
                                className="inline-block w-3 h-3 rounded-full border border-gray-600"
                                style={{ backgroundColor: current.enrichment.colors.secondary }}
                              />
                            )}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {linkingOpen ? (
                  <EntityLinkSearch
                    kind={current.kind}
                    sport={current.sport}
                    onSelect={(id) => {
                      void handleLink(current._id, current.kind, id);
                    }}
                    onCancel={() => setLinkingOpen(false)}
                  />
                ) : (
                  <div className="flex flex-col gap-2">
                    <NeonButton onClick={() => void handleCreate(current._id)}>
                      Add as New {kindLabel(current.kind)}
                    </NeonButton>
                    <button
                      type="button"
                      onClick={() => setLinkingOpen(true)}
                      aria-label="Link to existing instead"
                      className="text-xs text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none underline decoration-dotted"
                    >
                      Link to Existing…
                    </button>
                  </div>
                )}
              </>
            ) : allDecided ? (
              <p className="text-sm text-gray-200">
                All reviewed — save {cardCount} {cardCount === 1 ? "card" : "cards"}?
              </p>
            ) : (
              <p className="text-sm text-gray-400 italic">
                Looking up {stillLookingUp} more {stillLookingUp === 1 ? "name" : "names"}…
              </p>
            )}
          </div>

          <div className="px-6 py-4 border-t border-gray-700 flex items-center justify-between gap-3">
            <div>
              {!allDecided && total - decided > 0 && (
                <button
                  type="button"
                  onClick={() => void handleBulkCreate()}
                  disabled={bulkCreating || saving}
                  aria-label={`Add all remaining as new (${total - decided})`}
                  className="text-xs text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none underline decoration-dotted disabled:opacity-50"
                >
                  {bulkCreating
                    ? "Adding all remaining…"
                    : `Add All Remaining as New (${total - decided})`}
                </button>
              )}
            </div>
            <div className="flex items-center gap-3">
              <NeonButton cancel onClick={() => void handleCancel()} disabled={cancelling || saving}>
                Cancel (Esc)
              </NeonButton>
              {allDecided && (
                <NeonButton ref={confirmButtonRef} onClick={onConfirm} disabled={saving}>
                  {saving ? "Saving..." : "Confirm & Save (Enter)"}
                </NeonButton>
              )}
            </div>
          </div>
        </div>
      </div>
    </Theme>,
    document.body,
  );
}
