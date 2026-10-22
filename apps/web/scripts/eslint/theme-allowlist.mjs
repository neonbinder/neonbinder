/**
 * NEO-356 — who may still use palette classes (theme/no-raw-palette).
 * Paths are apps/web-relative. Only .ts/.tsx files are linted; stylesheets
 * (app/collection/final/binders/*.css, prototypes/_shared/card-face.css) are
 * outside the rule and keep their fixed colours by design.
 */

/**
 * PERMANENT: fixed colours by design. A path ending in `/**` covers the folder.
 * Every entry says why; adding one needs the same justification.
 */
export const PERMANENT = [
  // Paper. Print documents are black on white whatever the screen mode.
  "lib/print/**",
  "components/modules/ShippingLabel/**",
  "components/modules/PlaceholderSheet/**",
  // A QR code must be dark modules on a light ground to scan.
  "components/modules/QrCode/**",
  // Art: white type on its own pink-to-indigo gradient, the same in both modes.
  "components/primitives/Poster.tsx",
  // The NEO-350 reference prototypes (/collection/1-5): forced dark by
  // ForceDark, never migrated. The modules the shipped demo imports are not
  // covered: see SHARED_PROTOTYPE_FILES.
  "app/collection/prototypes/**",
];

/**
 * Prototype modules the shipped collection demo (/collection,
 * /binder-tracking) imports. They render in both modes, so PERMANENT's
 * prototypes entry does not cover them; until migrated they sit in PENDING.
 * theme-allowlist.test.mjs recomputes this from the imports and fails on drift.
 */
export const SHARED_PROTOTYPE_FILES = [
  "app/collection/prototypes/_shared/CardFace.tsx",
  "app/collection/prototypes/_shared/CopyDetailsForm.tsx",
  "app/collection/prototypes/_shared/catalog.ts",
  "app/collection/prototypes/_shared/collector.ts",
  "app/collection/prototypes/_shared/data.ts",
  "app/collection/prototypes/_shared/search.ts",
  "app/collection/prototypes/_shared/types.ts",
  "app/collection/prototypes/_shared/usePrototypeStore.ts",
  "app/collection/prototypes/p1/Cascade.tsx",
  "app/collection/prototypes/p1/ChecklistRow.tsx",
  "app/collection/prototypes/p1/Overlay.tsx",
  "app/collection/prototypes/p1/SleeveStrip.tsx",
  "app/collection/prototypes/p1/StaticColumn.tsx",
  "app/collection/prototypes/p1/drill.ts",
  "app/collection/prototypes/p1/notice.tsx",
  "app/collection/prototypes/p1/range.ts",
  "app/collection/prototypes/p1/ui.ts",
  "app/collection/prototypes/p2/Modal.tsx",
  "app/collection/prototypes/p2/hooks.ts",
  "app/collection/prototypes/p2/model.ts",
  "app/collection/prototypes/p3/Chip.tsx",
  "app/collection/prototypes/p3/Dialog.tsx",
  "app/collection/prototypes/p3/classes.ts",
  "app/collection/prototypes/p3/hooks.ts",
  "app/collection/prototypes/p3/wallModel.ts",
];

/**
 * PENDING: not yet migrated. Each batch's done criterion is deleting its
 * lines here, after which the rule holds the file. theme-allowlist.test.mjs
 * fails on an entry that no longer exists or no longer needs to be here.
 * Regenerate (never hand-add): node scripts/eslint/scan-theme.mjs
 */
export const PENDING = [
  "app/about/page.tsx",
  "app/admin/franchises/page.tsx",
  "app/admin/leagues/page.tsx",
  "app/admin/page.tsx",
  "app/admin/players/page.tsx",
  "app/admin/set-builder/page.tsx",
  "app/admin/teams/page.tsx",
  "app/ai-card-identification/page.tsx",
  "app/binder-tracking/page.tsx",
  "app/collection/final/BinderPicker.tsx",
  "app/collection/final/CardDetail.tsx",
  "app/collection/final/CardDrawer.tsx",
  "app/collection/final/CardRows.tsx",
  "app/collection/final/Checklist.tsx",
  "app/collection/final/ChecklistsTab.tsx",
  "app/collection/final/DemoChrome.tsx",
  "app/collection/final/FinalCollectionPage.tsx",
  "app/collection/final/MyCardsTab.tsx",
  "app/collection/final/RequestCardDialog.tsx",
  "app/collection/final/binders/BinderDesk.tsx",
  "app/collection/final/binders/BinderView.tsx",
  "app/collection/final/binders/LabelDesigner.tsx",
  "app/collection/final/binders/LabelEditorDialog.tsx",
  "app/collection/final/binders/NewBinderDialog.tsx",
  "app/collection/final/binders/PackTray.tsx",
  "app/collection/final/binders/Pocket.tsx",
  "app/collection/final/binders/ShareLink.tsx",
  "app/collection/final/binders/Shelf.tsx",
  "app/collection/final/binders/parts.tsx",
  "app/collection/final/cards/FindCard.tsx",
  "app/collection/final/cards/NeedList.tsx",
  "app/collection/final/cards/OwnedShelf.tsx",
  "app/collection/final/cards/QuickAdd.tsx",
  "app/collection/final/cards/Scoreboard.tsx",
  "app/collection/final/cards/SetPicker.tsx",
  "app/collection/final/cards/Wall.tsx",
  "app/collection/prototypes/_shared/CardFace.tsx",
  "app/collection/prototypes/_shared/CopyDetailsForm.tsx",
  "app/collection/prototypes/p1/ChecklistRow.tsx",
  "app/collection/prototypes/p1/Overlay.tsx",
  "app/collection/prototypes/p1/SleeveStrip.tsx",
  "app/collection/prototypes/p1/StaticColumn.tsx",
  "app/collection/prototypes/p1/notice.tsx",
  "app/collection/prototypes/p1/ui.ts",
  "app/collection/prototypes/p2/Modal.tsx",
  "app/collection/prototypes/p3/Chip.tsx",
  "app/collection/prototypes/p3/Dialog.tsx",
  "app/collection/prototypes/p3/classes.ts",
  "app/dashboard/ComingSoon.tsx",
  "app/design/primitives/page.tsx",
  "app/easypost-setup/page.tsx",
  "app/inventory/page.tsx",
  "app/landing.tsx",
  "app/managing-inventory/page.tsx",
  "app/page.tsx",
  "app/pipeline-runs/page.tsx",
  "app/print-shop/page.tsx",
  "app/print/labels/page.tsx",
  "app/print/page.tsx",
  "app/print/placeholders/dropzone.tsx",
  "app/print/placeholders/intake.tsx",
  "app/print/placeholders/page.tsx",
  "app/print/placeholders/print-run.tsx",
  "app/print/placeholders/review-grid.tsx",
  "app/print/placeholders/scan-image.tsx",
  "app/print/qr/page.tsx",
  "app/print/shipping/blackout/page.tsx",
  "app/print/shipping/page.tsx",
  "app/print/spine-label/page.tsx",
  "app/profile/api-keys/page.tsx",
  "app/profile/credentials/page.tsx",
  "app/profile/postage/page.tsx",
  "app/profile/prizes/page.tsx",
  "app/profile/public/page.tsx",
  "app/profile/shipping/page.tsx",
  "app/shipping-labels/page.tsx",
  "app/sign-up/[[...sign-up]]/page.tsx",
  "app/signin/[[...sign-in]]/page.tsx",
  "app/testing/needs-reauth/page.tsx",
  "app/testing/reset/page.tsx",
  "app/testing/seed-credentials/page.tsx",
  "app/testing/seed-placeholder-run/page.tsx",
  "app/testing/seed-placeholder-upload/page.tsx",
  "app/testing/sign-in/page.tsx",
  "app/u/[username]/page.tsx",
  "app/u/[username]/sale/page.tsx",
  "components/SetSelector/AttachSetsDialog.tsx",
  "components/SetSelector/AutographFormatStep.tsx",
  "components/SetSelector/BaseMappingForm.tsx",
  "components/SetSelector/BaseParallelsBuildSection.tsx",
  "components/SetSelector/BaseSetPicker.tsx",
  "components/SetSelector/CardAttentionBadge.tsx",
  "components/SetSelector/CardAttentionWalker.tsx",
  "components/SetSelector/CardChecklist.tsx",
  "components/SetSelector/CardChecklistItem.tsx",
  "components/SetSelector/CardDetailPanel.tsx",
  "components/SetSelector/CardFeaturesEditor.tsx",
  "components/SetSelector/CardPairingModal.tsx",
  "components/SetSelector/CardPrefixRow.tsx",
  "components/SetSelector/CardTitlesStep.tsx",
  "components/SetSelector/CareerTeamEntry.tsx",
  "components/SetSelector/ChecklistSearch.tsx",
  "components/SetSelector/ChecklistSourceFilter.tsx",
  "components/SetSelector/CrossListingImportModal.tsx",
  "components/SetSelector/EntityColumn.tsx",
  "components/SetSelector/EntityLinkSearch.tsx",
  "components/SetSelector/EntityReviewWizard.tsx",
  "components/SetSelector/EntitySelector.tsx",
  "components/SetSelector/FeatureValueControl.tsx",
  "components/SetSelector/HeldElsewhereNote.tsx",
  "components/SetSelector/MakeInsertControl.tsx",
  "components/SetSelector/MakeParallelControl.tsx",
  "components/SetSelector/ManufacturerForm.tsx",
  "components/SetSelector/ManufacturerSelector.tsx",
  "components/SetSelector/MissingCredentialsBanner.tsx",
  "components/SetSelector/MissingTeamFixer.tsx",
  "components/SetSelector/MoveSetToBrandControl.tsx",
  "components/SetSelector/MultiSourcePanel.tsx",
  "components/SetSelector/NewLeagueForm.tsx",
  "components/SetSelector/NewTeamDialog.tsx",
  "components/SetSelector/NewTeamForm.tsx",
  "components/SetSelector/ParallelBuildPanel.tsx",
  "components/SetSelector/ParallelForm.tsx",
  "components/SetSelector/ParallelGroupingModal.tsx",
  "components/SetSelector/ParallelSelector.tsx",
  "components/SetSelector/PausedNotice.tsx",
  "components/SetSelector/PlayerPicker.tsx",
  "components/SetSelector/PromoteToSetControl.tsx",
  "components/SetSelector/ReauthNotice.tsx",
  "components/SetSelector/ReconciliationModal.tsx",
  "components/SetSelector/RenameEntityControl.tsx",
  "components/SetSelector/ResilientEntityColumn.tsx",
  "components/SetSelector/SameNamePlayerPanel.tsx",
  "components/SetSelector/SelectorSyncReviewModal.tsx",
  "components/SetSelector/SetAttributesPanel.tsx",
  "components/SetSelector/SetForm.tsx",
  "components/SetSelector/SetRowActionButton.tsx",
  "components/SetSelector/SetSelector.tsx",
  "components/SetSelector/SetShapeDialog.tsx",
  "components/SetSelector/SetVariantForm.tsx",
  "components/SetSelector/SetVariantSelector.tsx",
  "components/SetSelector/SkippedNamesPanel.tsx",
  "components/SetSelector/SlSetReviewModal.tsx",
  "components/SetSelector/SportForm.tsx",
  "components/SetSelector/SportSelector.tsx",
  "components/SetSelector/SportSwitch.tsx",
  "components/SetSelector/StoreHoldNotices.tsx",
  "components/SetSelector/SyncDoneNotice.tsx",
  "components/SetSelector/TeamPicker.tsx",
  "components/SetSelector/TeamsOnCardsSection.tsx",
  "components/SetSelector/TitleFixer.tsx",
  "components/SetSelector/TitleLengthMeter.tsx",
  "components/SetSelector/UndatedCareerTeams.tsx",
  "components/SetSelector/UnreviewedNameFixer.tsx",
  "components/SetSelector/VariantForm.tsx",
  "components/SetSelector/VariantSelector.tsx",
  "components/SetSelector/WizardChrome.tsx",
  "components/SetSelector/YearForm.tsx",
  "components/SetSelector/YearSelector.tsx",
  "components/SetSelector/sync-review-modal.tsx",
  "components/admin/AddLeagueDialog.tsx",
  "components/admin/AddLeagueForm.tsx",
  "components/admin/FranchiseManagement.tsx",
  "components/admin/LeagueManagement.tsx",
  "components/admin/PlayerManagement.tsx",
  "components/admin/TeamManagement.tsx",
  "components/entities/NearMatchPanel.tsx",
  "components/entities/TeamMatchSearch.tsx",
  "components/modules/ComingSoon.tsx",
  "components/modules/CopyButton.tsx",
  "components/modules/EasypostKeyEditor.tsx",
  "components/modules/PublicProfileEditor.tsx",
  "components/modules/PurchasedTracking.tsx",
  "components/modules/ReturnAddressEditor.tsx",
  "components/modules/RunLedger.tsx",
  "components/modules/SetSelector.tsx",
  "components/modules/SpineLabelFields.tsx",
  "components/modules/confirm-dialog.tsx",
  "src/layouts/ProtectedLayout.tsx",
  "src/layouts/admin-section-layout.tsx",
  "src/layouts/print-layout.tsx",
  "src/routes/lazy-routes.tsx",
];

const PENDING_SET = new Set(PENDING);
const SHARED_SET = new Set(SHARED_PROTOTYPE_FILES);

function matches(pattern, rel) {
  return pattern.endsWith("/**") ? rel.startsWith(pattern.slice(0, -2)) : rel === pattern;
}

/** Fixed colours by design (a shared prototype module never is). */
export function isPermanent(rel) {
  if (SHARED_SET.has(rel)) return false;
  return PERMANENT.some((pattern) => matches(pattern, rel));
}

export function isAllowlisted(rel) {
  return isPermanent(rel) || PENDING_SET.has(rel);
}
