---
name: patterns-neonbutton
description: NeonButton component accessibility quirks — ref forwarding, color props, inline-style override trap
metadata:
  type: project
---

# NeonButton Accessibility Notes

File: `/apps/web/components/modules/NeonButton.tsx` (monorepo) or equivalent path in apps/web.

## forwardRef — works

`NeonButton` is declared `forwardRef<HTMLButtonElement, NeonButtonProps>` and passes `ref` to Radix `Button`. Use `useRef<HTMLButtonElement>(null)` and `ref={myRef}` on the JSX. Compatible with focus management patterns.

## Color props — use these, not className overrides

NeonButton applies INLINE styles (`style={{ backgroundColor: ... }}`), which **override Tailwind className** with `bg-*` color utilities. Always use the component's own props for color intent:

| Prop | Color | Use for |
|---|---|---|
| (none) | `#00D558` neon green | Primary/confirm action |
| `cancel` | `#FF2E9A` neon pink | Cancel, destructive confirm |
| `secondary` | `#00C2FF` blue | Secondary/test actions |

WRONG: `<NeonButton className="bg-red-600">Yes, Clear</NeonButton>` — bg-red-600 is silently ignored; button renders green.
RIGHT: `<NeonButton cancel>Yes, Clear</NeonButton>` — renders neon pink, visually signals danger.

This is a CSS specificity trap: inline style beats Tailwind utility class. The original code in profile/page.tsx had this bug — "Yes, Clear" was rendering green (#00D558) despite `className="bg-red-600 hover:bg-red-700"`.

## Text contrast — `cancel` and `secondary` CONFIRMED FAILING (script-verified 2026-08-18)

- Green (#00D558) background → `color: "black"` — passes 4.5:1 on dark (not re-verified this pass, prior finding stands)
- **Pink (#FF2E9A) background → `color: "white"` = 3.44:1 — FAILS AA 4.5:1 for normal text.**
- **Blue (#00C2FF) background → `color: "white"` = 2.07:1 — FAILS badly, barely readable.**

Both computed via the standard relative-luminance formula, not eyeballed. This is `NeonButton.tsx`'s
own `color: cancel || secondary ? "white" : "black"` logic (around the `style={{...}}` block) — every
`cancel` (pink/destructive) and every `secondary` (blue) button in the app inherits this, not just one
call site. `secondary` is used in at least 8+ files (`app/print/qr/page.tsx`,
`components/SetSelector/{EntityColumn,AttachSetsDialog,AdminTools,CardPairingModal,MultiSourcePanel,
ParallelGroupingModal,CardChecklist}.tsx`), so this is a pre-existing, widespread Critical finding, not
specific to whatever page you're auditing — flag it every time a `cancel`/`secondary` NeonButton
appears, but note the FIX belongs in `NeonButton.tsx` itself (one line), not in the call site. Likely
fix: `color: cancel || secondary ? "black" : "black"` won't work for pink (black-on-pink also weak —
recheck), safest is picking a text color per-background rather than one shared ternary; e.g. white text
only clears 4.5:1 against pink/blue backgrounds this saturated at much darker shades, so consider
darkening the button fill instead of changing text color, or use `color-mix`/a project design-token
pass. Don't propose a specific replacement hex without re-verifying it — just flag that "white on both
pink and blue fails" is confirmed and needs a deliberate contrast-aware choice, not a quick swap.

When auditing: verify that custom `style` overrides on NeonButton don't break the `color` (text color) declaration.
