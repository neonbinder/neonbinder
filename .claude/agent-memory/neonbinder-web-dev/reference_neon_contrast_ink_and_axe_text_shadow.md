---
name: neon-contrast-ink-and-axe-text-shadow
description: Neon fills take black ink, purple TEXT takes text-neon-purple-text, and axe's colour-contrast rule counts opacity animations and blurred text-shadow halos as lost contrast
metadata:
  type: reference
---

Contrast rules for the neon palette that the axe gate (WCAG 2.2 AA, NEO-341) enforces:

- **Ink on neon fills is black**, never white. White is 3.44:1 on #FF2E9A and 2.07:1 on #00C2FF; black is 6.1 / 10.2 / 10.7 on pink / cyan / green. NeonButton and the Button primitive's `destructive` variant both paint black. Radix's own `--pink-contrast` / `--blue-contrast` are set to black under `.dark` in globals.css.
- **Purple text uses `text-neon-purple-text` (#B56BFF)**. Plain `neon-purple` (#A44AFF) is for borders, rings, fills and glows: as text it is 4.2:1 on gray-900 and 3.5:1 on gray-800.
- **`animate-pulse` on text fails contrast**: axe samples mid-fade (it caught neon pink at about 78% opacity, #c62478). Use `.animate-neon-glow` (globals.css) instead, which pulses a text-shadow and leaves the letters at full colour.
- **axe blends a blurred text-shadow into the background.** Its alpha is `0.185 / (blur/fontSize + 0.4)`, and the halos stack. Two halos (6px and 14px) on 18px pink text dropped it to 4.4:1. One 12px halo stays above 4.5:1. Re-check the maths before making a glow brighter.
- Hover states count too. `hover:text-neon-purple/80` fails, so purple links go `hover:text-white`.

**How to apply:** any new neon-on-dark text or neon-filled control. Related: [[reference-slate-border-contrast-on-slate-900]].
