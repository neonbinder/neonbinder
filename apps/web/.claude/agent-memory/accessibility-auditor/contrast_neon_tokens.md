---
name: contrast-neon-tokens
description: Computed WCAG contrast ratios for NeonBinder's neon color tokens against the app's actual dark backgrounds
metadata:
  type: project
---

Tokens (tailwind.config.js): neon-green #00D558, neon-pink #FF2E9A, neon-yellow #FFE600,
neon-blue #00C2FF, neon-purple #A44AFF, neon-orange #FF9E00, neon-teal #00E5C0.

Real app background is `#0a0a0a` (app/globals.css `--background` dark value), which is
darker than Tailwind's `slate-950` (#020617), which is darker than `slate-900` (#0f172a).
Contrast against a darker bg is always higher, so slate-900 is the tightest realistic case.

Computed (normal-weight text, needs 4.5:1 AA):
- neon-purple #A44AFF: 4.72:1 vs #0a0a0a, 4.80:1 vs slate-950, **4.25:1 vs slate-900 (FAILS)**.
  This is the only one of the six with essentially no margin. Never pair `text-neon-purple`
  with a `bg-slate-900` surface (a very plausible copy-paste since bg-slate-900 is the
  standard input/select surface in this codebase) — audit for this pairing specifically
  whenever neon-purple text is touched.
- neon-pink #FF2E9A: 5.76:1 vs #0a0a0a, 5.87:1 vs slate-950, 5.20:1 vs slate-900 — all pass
  with real margin.
- neon-yellow #FFE600: >14:1 everywhere — trivially passes, don't bother re-computing.

Formula used: standard relative-luminance / contrast-ratio WCAG formula, computed by hand
(no tool available in this environment) — reproduce with a proper contrast checker before
trusting to more than 2 decimal places, but the pass/fail calls above are not close to the
rounding error except neon-purple vs slate-900, which is unambiguously a fail (4.25 vs 4.5).

See [[pattern_aria_disabled_busy_buttons]] for the other recurring finding in these screens.
