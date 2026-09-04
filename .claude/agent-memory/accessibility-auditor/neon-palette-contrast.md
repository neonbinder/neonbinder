---
name: neon-palette-contrast
description: Measured WCAG contrast ratios for NeonBinder's neon accent palette against the app's dark surfaces — which pairs pass/fail 4.5:1 text / 3:1 UI, so future audits don't re-derive them.
metadata:
  type: project
---

Palette (from `apps/web/tailwind.config.js`): neon-green `#00D558`, neon-pink `#FF2E9A`, neon-yellow `#FFE600`, neon-blue `#00C2FF`, neon-purple `#A44AFF`, neon-orange `#FF9E00`, neon-teal `#00E5C0`. App background is forced dark (`<Theme appearance="dark">` in `src/main.tsx`, page bg `#0a0a0a`/`#000000`). Standard slate scale: 300 `#cbd5e1`, 400 `#94a3b8`, 500 `#64748b`, 700 `#334155`, 800 `#1e293b`, 900 `#0f172a`, 950 `#020617`.

Measured (WCAG relative-luminance formula, matches `apps/web/lib/print/contrast.ts`'s own implementation):

- **Text — all comfortably pass 4.5:1** on slate-900/black: neon-teal ~9–11:1, neon-blue ~9.7–10.2:1, neon-orange ~8.6–10.1:1, neon-pink ~5.2–6.1:1 (pink is the tightest, but still clears the floor). slate-300 on slate-900 ~12:1, slate-400 on slate-900/black ~7–8:1 (this is why the codebase deliberately avoids slate-500, which is only 3.75:1 on slate-900 — under the floor. Comments in LeagueManagement.tsx/PlayerManagement.tsx call this out explicitly).
- **Translucent neon fills** (`bg-neon-*/5` through `/15`, text in the same neon color) also clear 4.5:1 by wide margins (~8–11:1) because the tint barely lifts the near-black background's luminance.
- **`border-slate-700` on `bg-slate-900`** (the shared `Input` primitive's `BASE_INPUT` border, reused by every `<select>` and the new `LevelGroup` toggle buttons) is only **~1.72:1** — fails the SC 1.4.11 3:1 non-text floor. `bg-slate-900` itself against the page's near-black background is only **~1.18:1** — a filled control is nearly invisible without its border. This is a pervasive, pre-existing design-system pattern (not introduced by any one PR) — worth a systemic ticket, but don't block an individual PR for reusing the app's standard input/select chrome.
- **`NeonButton secondary` is white text on `#00C2FF`** = **2.07:1**, a real SC 1.4.3 failure. `PlayerManagement.tsx`'s own "Re-enrich from Wikidata" button has this defect uncorrected — it is NOT a clean exemplar. The one `NeonButton secondary` call site in the codebase that IS fixed adds `style={{ color: "#000000" }}` (black on `#00C2FF` = 10.2:1). When auditing a new `secondary` call site, check for that literal override, not just "does it match the Players page" — Players page is inconsistent.

See [[wcag-recurring-findings]] for how these numbers turn into audit findings.
