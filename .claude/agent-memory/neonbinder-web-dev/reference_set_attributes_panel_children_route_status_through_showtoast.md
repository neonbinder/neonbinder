---
name: set-attributes-panel-children-route-status-through-showtoast
description: A child mounted inside SetAttributesPanel must not render its own role="status" (the panel keeps ONE, NEO-412) and must have its api namespace added to SetAttributesPanel.test.tsx's hand-built api mock
metadata:
  type: reference
---

SetAttributesPanel (components/SetSelector) promises exactly one `role="status"` (its toast region, NEO-412); several tests `getByRole("status")` and go red ("Found multiple elements") the moment a child adds its own. A child panel takes an `onStatus` prop and the parent passes `showToast`; a child's own failures may use an inline `role="alert"` (not counted). Dialogs the child portals are outside that count only while closed.

Its test file hand-builds `api` as a fixed object of string refs, so a child calling `api.newModule.fn` crashes EVERY render at that level with "Cannot read properties of undefined". Add the namespace to that mock (its `useQuery` returns undefined for unknown refs, which reads as "loading/none").

Headings inside the panel also collide with a test that finds the header by `name: /<row title>|Set/` (case-sensitive): avoid a capital "Set" in a child's heading.

Related: [[wait-line-mounting-breaks-test-mocks]].
