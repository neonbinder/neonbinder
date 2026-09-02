# Accessibility Auditor Memory — NeonBinder

- [Contrast reference for the neon palette](contrast-reference.md) — measured ratios for every neon token and slate gray against the app's real dark backgrounds; stop re-deriving these by hand
- [NeonButton contrast defect (pre-existing, site-wide)](neonbutton-contrast-defect.md) — `secondary` and `cancel` variants fail 1.4.3; affects every page that uses them, not just the one being audited
- [Focus-park pattern already established in this codebase](focus-park-pattern.md) — where it's used correctly, and the gap it had in review-grid.tsx before NEO-152's audit fix
- [role/aria-live consistency for always-mounted live regions](live-region-role-pattern.md) — the one correct way and the one bug found doing it wrong
- [Nested opacity contrast math + aria-pressed-pair→radiogroup pattern](nested-opacity-contrast-and-radiogroup.md) — how to compute contrast through chained `bg-*/NN` layers, and the mutually-exclusive-toggle fix from CardPairingModal (NEO-189)
- [Nested-dialog focus trap + restore](nested-dialog-focus-trap.md) — a confirm dialog inside another dialog's ref leaks Tab focus and drops focus on close unless it traps/restores itself; plus an unfixed cross-modal `document.activeElement` staleness case (NEO-203)
