# Agent memory index — neonbinder-web-dev

- [Linking UIs are drag-and-drop, and say so](feedback-linking-uis-are-drag-and-drop.md) — Jason on NEO-189: wrong gesture AND an unannounced affordance are two separate defects
- [No self-opening modals](feedback-no-self-opening-modals.md) — a dialog must never open off a background event; advertise the count in a live region and let the operator press
- [Notice CTAs need a structural marker](feedback-notice-ctas-need-a-structural-marker.md) — gate a banner's extra affordance on an explicit `kind` on the state, never the tone bucket or the text
- [E2E viewport is the UX constraint](e2e-viewport-is-the-ux-constraint.md) — status text goes next to its control; 1024x629 is the bar, and `role="status"` can hide a sighted-user gap
- [Mid-build security conditions override the brief](feedback_midbuild_security_conditions.md) — security-auditor verdicts arrive mid-task as numbered conditions; fold them in, report per-condition with test names
- [Verify external ids live](external-ids-must-be-verified-live.md) — hard-coded QIDs/vendor ids must be resolved against the source before merge; four HoF QIDs were wrong for months
- [sportConfig is copied onto rows](sport-config-is-copied-onto-rows.md) — editing the defaults never reaches an existing deployment; a repair has to ship with the change
- [PlayerManagement deep-link test flakes under load](reference_playermanagement_deeplink_test_flakes_under_load.md) — fails in a full components run, passes alone; re-run before blaming your diff
- [No inline sub-object forms](feedback-no-inline-sub-object-forms.md) — a "+ Add a new …" select option opens a modal that creates and selects; never inline fields saved by the parent form
