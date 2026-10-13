---
name: wizard-step-local-drafts-settle-pattern
description: A wizard step with many text fields keeps drafts local and reports up on blur/Enter/settle-timer/unmount; Escape's undo point is focus-time, not settle-time; ref syncs go in effects (react-hooks/refs)
metadata:
  type: reference
---

Pattern from NEO-335 `CardTitlesStep` (one field per card, inside the 4,000+
line `EntityReviewWizard`): calling the parent's `onAnswersChange` per keystroke
re-renders the whole wizard per character, so drafts live in the step.

- Report up on **blur, Enter, a ~300 ms settle timer, and unmount** (an effect
  cleanup calling a ref'd `flush`). Unmount matters: Next/Save can move on
  without a blur ever firing in the step.
- `latest.current = drafts` / `flushRef.current = flush` written during render
  fail the `react-hooks/refs` lint rule. Sync them in effects declared BEFORE
  the timer and unmount effects, so those read this render's values.
- **Escape's undo point is the value at FOCUS** (`onFocusCapture` on the step
  root), never the last settle: the timer settles a beat after typing stops,
  so a settle-based undo makes Escape after a pause fall through to the
  wizard's own Escape (cancel the review). Escape with nothing to undo is
  left to propagate; Enter always `stopPropagation`s (it must not hit the
  wizard's Enter-saves). See [[escape-blur-commits-the-draft]].
- A long single-line value (an 80-char listing title) is unreadable in an
  `<input>`; use `<Textarea bare rows={2}>` with `[field-sizing:content]
  resize-none` and collapse newlines in `onChange`. Tests keep using
  `getByRole("textbox")`.
