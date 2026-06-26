# Maestro agent memory bullets pending restore

Captured 2026-05-21 from the `neonbinder_web-neo22` worktree before removal.
These two bullets were authored during NEO-22 work but never made it into
PR #35 (which only touched code). Add them back to
`.claude/agent-memory/maestro-e2e-author/MEMORY.md` in a small follow-up PR.

```
- Custom Variant Type drill path: selecting a custom Variant Type opens the VARIANTS column (level 6), NOT the CardChecklist directly. CardChecklist only opens after selecting a Variant from the Variants column. Full path for custom-subtree gate test: custom Set → custom Variant Type → custom Variant → CardChecklist ("Fetch from Marketplaces"). Aria-label for Variants column "+ Custom" is "Add custom Variants".
- "Add Custom Entry" form near-viewport-edge pattern: use `scrollUntilVisible: element: text: "Add Custom Entry" timeout: 5000` AFTER `tapOn: {id: "Add custom <Level>"}` instead of `extendedWaitUntil: visible: "Add Custom Entry"`. scrollUntilVisible scrolls the form heading into view when it renders at the viewport edge; extendedWaitUntil does not scroll and times out on edge cases. Confirmed for Variant Types and Variants columns (5th and 6th columns in the overflow-x layout). extendedWaitUntil DOES work for the Sets column (4th, less affected by overflow scrollbar).
```
