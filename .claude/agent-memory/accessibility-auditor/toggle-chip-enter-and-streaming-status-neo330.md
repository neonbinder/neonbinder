---
name: toggle-chip-enter-and-streaming-status-neo330
description: NEO-330 verdicts - Enter on an aria-pressed chip must stay a toggle (offer Ctrl+Enter to save); showToast in SetSelector is the persistent syncNotice banner; ConfirmDialog children is ONE labelled scroll group; streaming-status live region chatter and no completion announcement
metadata:
  type: project
---

- Enter/Space on a focused `aria-pressed` chip toggles; never also save (native contract, multi-select up to the cap, and an ambiguous team pick must not write on a keystroke). Shorten the Tab walk with a Ctrl/Cmd+Enter save handled before the keydown guard that skips BUTTON, and say so in the hint.
- `showToast` in FillTeamsControl is `CardChecklist.setSyncMessage`: a persistent role=status banner (no timer seen), not a transient toast. Counts-only is acceptable if the text says where to go next. Same text twice in a row is silent (key is the tone, content unchanged).
- `confirm-dialog.tsx` renders `children` in ONE role=group, max-h-60, named by `childrenLabel`. Anything appended there inherits that name - FillTeams put "left alone" cards inside "Who gets which team".
- CardPairingModal `pairing-streaming-status`: conditionally mounted role=status whose whole sentence changes per tick (chatty) and unmounts on completion (no "Confirm is ready" announcement). Confirm's visible "Loading..." is not in its E2E-contract aria-label "Confirm card matches" (2.5.3); coordinate with maestro-e2e-author before touching.
