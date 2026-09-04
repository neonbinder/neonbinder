---
name: neonbutton-contrast-defect
description: NeonButton's secondary (blue) and cancel (pink) variants fail WCAG 1.4.3 contrast — pre-existing, site-wide, not owned by any one feature branch
metadata:
  type: project
---

`apps/web/components/modules/NeonButton.tsx` hardcodes white button-label text
on top of inline `backgroundColor`:

- `secondary` → background `#00C2FF` (neon-blue), text white → **2.07:1** contrast.
- `cancel` → background `#FF2E9A` (neon-pink), text white → **3.44:1** contrast.
- default/primary → background `#00D558` (neon-green), text black → 10.66:1, fine.

Both secondary and cancel need 4.5:1 for normal-size button text (or 3:1 only if
the label qualifies as "large text", which typical Radix Button label sizes do
not). This is a real, mathematically verified WCAG 1.4.3 failure, and because
`NeonButton` is a shared primitive, it silently ships on every page that uses a
secondary or cancel button — not just whatever feature is currently being
worked on. Seen concretely via `components/modules/confirm-dialog.tsx` (Cancel
button = `cancel` variant, pink) and `app/print/placeholders/intake.tsx`
("Finish now" = `secondary` variant, blue, whenever `stage !== "waiting"`).

Recurred again in NEO-212: `PlayerManagement.tsx`'s new "Add stint" button
uses `secondary`, and — more notably — `EntityReviewWizard.tsx`'s `secondary`
prop on the primary "Add as New {kind}" button is now driven by `hasCloseOnly`
(a near-match query result), so the broken-contrast variant is now the PRIMARY
create action on a common wizard path (any close-but-not-exact name match),
not just an occasional secondary button. Worth re-reporting each time with the
new call sites, since the underlying component still isn't fixed.

**Do not silently fix this inside a feature-scoped audit.** It's a shared
component whose colors are the app's branded Primary/Cancel/Accent tokens
(CLAUDE.md), so changing them is a design-system decision with a much larger
blast radius than one feature. Report it clearly with the measured ratios and a
concrete fix option (e.g. darken the button backgrounds, or switch these two
variants to black text like the primary variant does), and let the team decide
whether to take it as its own ticket. This has now been reported at least once
(NEO-152 audit, 2026-08-26) without a fix applied — check whether it's been
addressed before re-reporting from scratch next time; if not, it's still live.
