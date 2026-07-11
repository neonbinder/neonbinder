import type { GenericId } from "convex/values";
import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { SourceChips } from "../SetSelector/ChecklistSourceFilter";

import SportSelector from "../SetSelector/SportSelector";
import YearSelector from "../SetSelector/YearSelector";
import ManufacturerSelector from "../SetSelector/ManufacturerSelector";
import SetSelectorComponent from "../SetSelector/SetSelector";
import SetVariantSelector from "../SetSelector/SetVariantSelector";
import VariantSelector from "../SetSelector/VariantSelector";
import ParallelSelector from "../SetSelector/ParallelSelector";

import { SportForm } from "../SetSelector/SportForm";
import YearForm from "../SetSelector/YearForm";
import ManufacturerForm from "../SetSelector/ManufacturerForm";
import SetForm from "../SetSelector/SetForm";
import SetVariantForm from "../SetSelector/SetVariantForm";
import VariantForm from "../SetSelector/VariantForm";
import ParallelForm from "../SetSelector/ParallelForm";

// NEO-83: ResilientEntityColumn wraps EntityColumn with a stalled-read backstop
// (auto re-subscribe + Retry) so a column never hangs forever on "Loading…".
import ResilientEntityColumn from "../SetSelector/ResilientEntityColumn";
import CardChecklist from "../SetSelector/CardChecklist";
import BaseMappingForm from "../SetSelector/BaseMappingForm";
import VariantMetadataEditor from "../SetSelector/VariantMetadataEditor";
import ParallelGroupingModal from "../SetSelector/ParallelGroupingModal";
import MultiSourcePanel from "../SetSelector/MultiSourcePanel";
import SetAttributesPanel from "../SetSelector/SetAttributesPanel";
import NeonButton from "./NeonButton";

export default function SetSelector() {
  // Level 1: Sport
  const [selectedSportId, setSelectedSportId] =
    useState<GenericId<"selectorOptions"> | null>(null);
  // Level 2: Year
  const [selectedYearId, setSelectedYearId] =
    useState<GenericId<"selectorOptions"> | null>(null);
  // Level 3: Manufacturer (SL only)
  const [selectedManufacturerId, setSelectedManufacturerId] =
    useState<GenericId<"selectorOptions"> | null>(null);
  // Level 4: Set (BSC only)
  const [selectedSetId, setSelectedSetId] =
    useState<GenericId<"selectorOptions"> | null>(null);
  // Level 5: Variant Type (BSC only)
  const [selectedVariantTypeId, setSelectedVariantTypeId] =
    useState<GenericId<"selectorOptions"> | null>(null);
  // Level 6: Variant (reconciled BSC + SL)
  const [selectedVariantId, setSelectedVariantId] =
    useState<GenericId<"selectorOptions"> | null>(null);
  // Level 7: Variant of Variant (NB only)
  const [selectedVariantOfVariantId, setSelectedVariantOfVariantId] =
    useState<GenericId<"selectorOptions"> | null>(null);

  const [sportExpanded, setSportExpanded] = useState(false);
  const [yearExpanded, setYearExpanded] = useState(false);
  const [manufacturerExpanded, setManufacturerExpanded] = useState(false);
  const [setExpanded, setSetExpanded] = useState(false);
  const [variantTypeExpanded, setVariantTypeExpanded] = useState(false);
  const [variantExpanded, setVariantExpanded] = useState(false);
  const [variantOfVariantExpanded, setVariantOfVariantExpanded] = useState(false);

  // useCallback([]) is safe: the body only calls state setters, whose
  // identities React guarantees stable. A stable clearFrom lets the level-select
  // handlers below (e.g. handleVariantTypeSelect) themselves be stable, which
  // keeps the onSelect prop feeding the memoized Variant Types column referen-
  // tially stable across parent re-renders (NEO-85).
  const clearFrom = useCallback((level: number) => {
    if (level <= 2) setSelectedYearId(null);
    if (level <= 3) setSelectedManufacturerId(null);
    if (level <= 4) setSelectedSetId(null);
    if (level <= 5) setSelectedVariantTypeId(null);
    if (level <= 6) setSelectedVariantId(null);
    if (level <= 7) setSelectedVariantOfVariantId(null);
  }, []);

  // Base is a terminal variantType: when selected, the cascade stops
  // there and the CardChecklist attaches to the variantType row itself
  // (no Variant / Variant-of-Variant columns). Read the row to detect
  // value === "Base" and to drive the auto-mapping prompt.
  const selectedVariantType = useQuery(
    api.selectorOptions.getSelectorOptionById,
    selectedVariantTypeId ? { id: selectedVariantTypeId } : "skip",
  );
  // Stabilize the derived booleans across transient `useQuery` undefined
  // returns. Convex reactive queries can briefly return undefined during
  // refetches triggered by mutations on the watched row — including
  // cross-worker mutations in parallel test runs, or any background
  // re-write by a different tab in real-user traffic. Without this cache,
  // isBaseVariantTypeSelected and baseHasMapping flip to false during the
  // refetch window, which collapses cardChecklistId below to null and
  // unmounts <CardChecklist> — taking the in-progress Add Card form with
  // it (resets showAddForm + typed input). The cache invalidates only on
  // selectedVariantTypeId change, so real user navigation still
  // re-evaluates correctly.
  const stableVariantTypeFlagsRef = useRef<{
    forId: GenericId<"selectorOptions"> | null;
    isBase: boolean;
    hasMapping: boolean;
    value: string;
  }>({ forId: null, isBase: false, hasMapping: false, value: "" });
  if (stableVariantTypeFlagsRef.current.forId !== selectedVariantTypeId) {
    stableVariantTypeFlagsRef.current = {
      forId: selectedVariantTypeId,
      isBase: false,
      hasMapping: false,
      value: "",
    };
  }
  if (selectedVariantType !== undefined) {
    stableVariantTypeFlagsRef.current.isBase =
      selectedVariantType?.value.toLowerCase().trim() === "base";
    // Auto-prompt is gated on the SportLots mapping specifically. The BSC
    // slug on the row is auto-populated by "Sync Variant Types" (BSC's
    // variant facet returns "Base" with a slug), so testing it would
    // suppress the auto-prompt on every freshly-synced Base. Only the
    // SportLots value is exclusively written by BaseSetPicker, so its
    // presence is the reliable "user has mapped this Base" signal.
    stableVariantTypeFlagsRef.current.hasMapping =
      !!selectedVariantType?.platformData?.sportlots;
    stableVariantTypeFlagsRef.current.value = selectedVariantType?.value ?? "";
  }
  const isBaseVariantTypeSelected = stableVariantTypeFlagsRef.current.isBase;
  const baseHasMapping = stableVariantTypeFlagsRef.current.hasMapping;
  // Pluralized variantType label ("Insert" → "Inserts") used as the column
  // header and Sync button text on the Variants column. Falls back to the
  // generic "Variants" while the variantType row is still loading or when
  // no variantType is selected.
  const variantTypeLabel = stableVariantTypeFlagsRef.current.value;
  const variantsColumnLabel = variantTypeLabel
    ? variantTypeLabel.endsWith("s")
      ? variantTypeLabel
      : `${variantTypeLabel}s`
    : "Variants";
  // Manual re-map trigger; the form also auto-opens on first selection
  // when no platformData exists yet.
  const [baseMappingOpen, setBaseMappingOpen] = useState(false);
  // Parallel-grouping modal trigger for the Variants column.
  const [groupingOpen, setGroupingOpen] = useState(false);

  const handleSportSelect = (id: GenericId<"selectorOptions">) => {
    setSelectedSportId(id);
    clearFrom(2);
  };
  const handleYearSelect = (id: GenericId<"selectorOptions">) => {
    setSelectedYearId(id);
    clearFrom(3);
  };
  const handleManufacturerSelect = (id: GenericId<"selectorOptions">) => {
    setSelectedManufacturerId(id);
    clearFrom(4);
  };
  const handleSetSelect = (id: GenericId<"selectorOptions">) => {
    setSelectedSetId(id);
    clearFrom(5);
  };
  // Stable across re-renders (NEO-85): fed as onSelect into the memoized Variant
  // Types column via SetVariantSelector, so a bare parent re-render doesn't churn
  // the list under Maestro's coordinate taps.
  const handleVariantTypeSelect = useCallback(
    (id: GenericId<"selectorOptions">) => {
      setSelectedVariantTypeId(id);
      clearFrom(6);
    },
    [clearFrom],
  );
  const handleVariantSelect = (id: GenericId<"selectorOptions">) => {
    setSelectedVariantId(id);
    clearFrom(7);
  };
  const handleVariantOfVariantSelect = (id: GenericId<"selectorOptions">) => {
    setSelectedVariantOfVariantId(id);
  };

  // CardChecklist attaches to the deepest selected node — for Base
  // variantTypes that's the variantType row itself (Base is terminal).
  const cardChecklistId =
    selectedVariantOfVariantId ||
    selectedVariantId ||
    (isBaseVariantTypeSelected ? selectedVariantTypeId : null);

  // NEO-38: the deepest selected node at setName-or-deeper. Drives
  // SetAttributesPanel so the attributes editor follows the selection down
  // (setName → variantType → insert → parallel) and never vanishes when a
  // variant (e.g. "Base") is active. We deliberately do NOT mount it at the
  // sport/year/manufacturer levels: a panel rendered there during drill-down
  // adds height below the selector columns, and the cascade's drill flows
  // (e.g. Football → custom year 2026) scroll DOWN to reach the column's
  // "Add custom" button, which then pushed the year dropdown's top (2026)
  // out of view → "2026 not visible" e2e failures (NEO-38). Those levels are
  // auto-seeded by the heuristic at commit anyway; manual editing there
  // (rare) is a follow-up needing a non-drill-disrupting placement.
  const deepestSelectedId =
    selectedVariantOfVariantId ||
    selectedVariantId ||
    selectedVariantTypeId ||
    selectedSetId ||
    null;

  // NEO-6: read the cardChecklist row here (once) and derive the source-
  // set chip data + per-card label maps. Previously this lived inside
  // CardChecklist, but the two useMemos sat below an `if (!cards) return`
  // early return — a Rules-of-Hooks violation that crashed the page with
  // React error #310 after the variantType chip was tapped. Lifting them
  // to the parent puts these hooks alongside the other unconditional
  // top-level hooks. Convex deduplicates same-arg queries, so the Base
  // case (cardChecklistId === selectedVariantTypeId) does not refetch.
  const cardChecklistRow = useQuery(
    api.selectorOptions.getSelectorOptionById,
    cardChecklistId ? { id: cardChecklistId } : "skip",
  );
  const sourceChips: SourceChips = useMemo(() => {
    if (!cardChecklistRow) return {};
    const out: SourceChips = {};
    for (const side of ["bsc", "sportlots"] as const) {
      const raw = cardChecklistRow.platformData?.[side];
      const ids = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
      if (ids.length <= 1) continue;
      const labels = cardChecklistRow.platformLabels?.[side] ?? {};
      const primaryId =
        cardChecklistRow.primaryPlatformId?.[side] ?? ids[0];
      out[side] = {
        primaryId,
        chips: ids.map((id) => ({ id, label: labels[id] ?? id })),
      };
    }
    return out;
  }, [cardChecklistRow]);
  const sourceLabelMaps = useMemo(
    () => ({
      bsc: cardChecklistRow?.platformLabels?.bsc ?? {},
      sportlots: cardChecklistRow?.platformLabels?.sportlots ?? {},
    }),
    [cardChecklistRow],
  );

  return (
    <div className="max-w-full mx-auto p-6 flex flex-col gap-6">
      {/* pb-4 prevents the horizontal scrollbar from overlapping each
          EntityColumn's action-button row (Sync X / + Custom). Without it,
          Maestro web taps at the action-button y-coordinate hit the
          scrollbar instead of the button — see PR #31 diagnosis.

          pl-4 keeps the leftmost column's "Sync <X>" button clear of the
          viewport's left edge. This page sits in a vw-based full-bleed wrapper
          that leaves the first column only ~6px of edge clearance; under a
          CLASSIC scrollbar (Linux/Windows, incl. CI headless Chrome) the
          full-bleed math over-pulls ~8px left, rendering "Sync Sports" at
          x=-2 (~98% visible). Maestro's scrollUntilVisible(visibility:100%)
          then can't tap it. Mac overlay scrollbars (0px) hide this locally —
          custom-entry-survives-resync 8/8 CI failure, NEO root-cause. */}
      <div
        data-set-selector-scroll
        className="flex flex-row gap-4 overflow-x-auto pb-4 pl-4"
      >
        {/* 1. Sport (SL & BSC) */}
        <ResilientEntityColumn
          selector={
            <SportSelector
              selectedSportId={selectedSportId}
              onSportSelect={handleSportSelect}
              expanded={sportExpanded}
              setExpanded={setSportExpanded}
            />
          }
          renderForm={(onDone) => <SportForm onDone={onDone} />}
          addButtonText="Sync Sports"
          isVisible={true}
          level="sport"
          onSelectExisting={handleSportSelect}
          useEnsureSync
          syncingLabel="Syncing Sport Options"
        />

        {/* 2. Year (SL & BSC) */}
        <ResilientEntityColumn
          selector={
            <YearSelector
              sportId={selectedSportId!}
              selectedYearId={selectedYearId}
              onYearSelect={handleYearSelect}
              expanded={yearExpanded}
              setExpanded={setYearExpanded}
            />
          }
          renderForm={(onDone) => (
            <YearForm sportId={selectedSportId!} onDone={onDone} />
          )}
          addButtonText="Sync Years"
          isVisible={!!selectedSportId}
          level="year"
          parentId={selectedSportId || undefined}
          onSelectExisting={handleYearSelect}
          useEnsureSync
          syncingLabel="Syncing Year Options"
        />

        {/* 3. Manufacturer (SL only) */}
        <ResilientEntityColumn
          selector={
            <ManufacturerSelector
              yearId={selectedYearId!}
              selectedManufacturerId={selectedManufacturerId}
              onManufacturerSelect={handleManufacturerSelect}
              expanded={manufacturerExpanded}
              setExpanded={setManufacturerExpanded}
            />
          }
          renderForm={(onDone) => (
            <ManufacturerForm yearId={selectedYearId!} onDone={onDone} />
          )}
          addButtonText="Sync Manufacturers"
          isVisible={!!selectedYearId}
          level="manufacturer"
          parentId={selectedYearId || undefined}
          onSelectExisting={handleManufacturerSelect}
          useEnsureSync
          syncingLabel="Syncing Manufacturer Options"
        />

        {/* 4. Set (BSC only) */}
        <ResilientEntityColumn
          selector={
            <SetSelectorComponent
              manufacturerId={selectedManufacturerId!}
              selectedSetId={selectedSetId}
              onSetSelect={handleSetSelect}
              expanded={setExpanded}
              setExpanded={setSetExpanded}
            />
          }
          renderForm={(onDone) => (
            <SetForm
              manufacturerId={selectedManufacturerId!}
              onDone={onDone}
            />
          )}
          addButtonText="Sync Sets"
          isVisible={!!selectedManufacturerId}
          level="setName"
          parentId={selectedManufacturerId || undefined}
          onSelectExisting={handleSetSelect}
          useEnsureSync
          syncingLabel="Syncing Sets"
        />

        {/* 5. Variant Type (BSC only: Base, Insert, Parallel, Promo) */}
        <ResilientEntityColumn
          selector={
            <SetVariantSelector
              setId={selectedSetId!}
              selectedVariantTypeId={selectedVariantTypeId}
              onVariantTypeSelect={handleVariantTypeSelect}
              expanded={variantTypeExpanded}
              setExpanded={setVariantTypeExpanded}
            />
          }
          renderForm={(onDone) => (
            <SetVariantForm setId={selectedSetId!} onDone={onDone} />
          )}
          addButtonText="Sync Variant Types"
          isVisible={!!selectedSetId}
          level="variantType"
          parentId={selectedSetId || undefined}
          onSelectExisting={handleVariantTypeSelect}
          useEnsureSync
          syncingLabel="Syncing Variant Types"
        />

        {/* 6. Variant (reconciled BSC variantName + SL set list) — hidden
            when Base is selected (Base is terminal). */}
        {!isBaseVariantTypeSelected && (
          <ResilientEntityColumn
            selector={
              <>
                <VariantSelector
                  variantTypeId={selectedVariantTypeId!}
                  selectedVariantId={selectedVariantId}
                  onVariantSelect={handleVariantSelect}
                  expanded={variantExpanded}
                  setExpanded={setVariantExpanded}
                  title={variantsColumnLabel}
                />
                {selectedVariantId && (
                  <VariantMetadataEditor optionId={selectedVariantId} />
                )}
              </>
            }
            renderForm={(onDone) => (
              <VariantForm
                variantTypeId={selectedVariantTypeId!}
                onDone={onDone}
              />
            )}
            addButtonText={`Sync ${variantsColumnLabel}`}
            isVisible={!!selectedVariantTypeId}
            level="insert"
            parentId={selectedVariantTypeId || undefined}
            onSelectExisting={handleVariantSelect}
            extraActions={
              selectedVariantTypeId ? (
                <NeonButton
                  secondary
                  onClick={() => setGroupingOpen(true)}
                >
                  Group Parallels
                </NeonButton>
              ) : undefined
            }
          />
        )}

        {/* 7. Variant of Variant (NB only — translates to variant on BSC/SL) */}
        {!isBaseVariantTypeSelected && selectedVariantId && (
          <ResilientEntityColumn
            selector={
              <>
                <ParallelSelector
                  insertId={selectedVariantId!}
                  selectedParallelId={selectedVariantOfVariantId}
                  onParallelSelect={handleVariantOfVariantSelect}
                  expanded={variantOfVariantExpanded}
                  setExpanded={setVariantOfVariantExpanded}
                />
                {selectedVariantOfVariantId && (
                  <VariantMetadataEditor optionId={selectedVariantOfVariantId} />
                )}
              </>
            }
            renderForm={(onDone) => (
              <ParallelForm insertId={selectedVariantId!} onDone={onDone} />
            )}
            addButtonText="Sync Sub-Variants"
            isVisible={true}
            level="parallel"
            parentId={selectedVariantId || undefined}
            onSelectExisting={handleVariantOfVariantSelect}
          />
        )}

      </div>

      {/* Base mapping: auto-prompts BaseSetPicker the first time a Base
          variantType without platformData is selected; user can also re-map
          via the Re-map Base button below. */}
      {selectedVariantTypeId && isBaseVariantTypeSelected && (
        <>
          {(!baseHasMapping || baseMappingOpen) && (
            <BaseMappingForm
              key={`${selectedVariantTypeId}-${baseMappingOpen ? "remap" : "auto"}`}
              variantTypeId={selectedVariantTypeId}
              autoOpen={true}
              onClose={() => setBaseMappingOpen(false)}
            />
          )}
          {baseHasMapping && !baseMappingOpen && (
            <div>
              <NeonButton secondary onClick={() => setBaseMappingOpen(true)}>
                Re-map Base
              </NeonButton>
            </div>
          )}
        </>
      )}

      {/* NEO-6: multi-source attach panel for the active variant row.
          Renders for variantType (when Base/terminal), insert, and
          parallel rows once they have a reconciliation primary mapped. */}
      {cardChecklistId && <MultiSourcePanel selectorOptionId={cardChecklistId} />}

      {/* NEO-38: set ATTRIBUTES editor (features + metadata) — operator
          edits keys here and the propagation engine writes through to every
          descendant cardChecklist row. Mounts at the DEEPEST selected node
          at any level (sport → parallel) so it follows the selection down
          and never vanishes when a variant (e.g. "Base") is active. ALWAYS
          starts COLLAPSED (a slim summary bar): expanding it at sport/year/
          manufacturer during drill-down used to push the selector columns and
          hid the year list (broke the cascade's Football → 2026 pre-warm,
          NEO-38). The operator taps "Edit attributes" to edit; flows expand it
          via an idempotent guard. */}
      {deepestSelectedId && (
        <SetAttributesPanel
          selectorOptionId={deepestSelectedId as Id<"selectorOptions">}
          defaultCollapsed={true}
        />
      )}

      {/* Cards — full width below the selector row. `cardChecklistId`
          stays stable across transient query refetches because the
          `isBaseVariantTypeSelected` it depends on is cached via
          `stableVariantTypeFlagsRef` above. */}
      {cardChecklistId && (
        <CardChecklist
          variantId={cardChecklistId}
          sourceChips={sourceChips}
          sourceLabelMaps={sourceLabelMaps}
        />
      )}

      {/* Parallel-grouping modal — mounted at the page root so it overlays
          on top of the selector row regardless of horizontal scroll. */}
      {selectedVariantTypeId && !isBaseVariantTypeSelected && (
        <ParallelGroupingModal
          isOpen={groupingOpen}
          onClose={() => setGroupingOpen(false)}
          variantTypeId={selectedVariantTypeId}
        />
      )}
    </div>
  );
}
