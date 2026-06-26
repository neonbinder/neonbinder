---
name: Idempotent input field targeting — never rely on placeholder text
description: Use label text + eraseText when input may have a value from a prior run; placeholder only shows when empty
type: feedback
---

Input fields with placeholder text will NOT show that placeholder once they have a value from a
previous test run. Any `tapOn: "e.g. DK-"` (or similar placeholder text) fails on re-runs.

**Wrong (breaks on re-run):**
```yaml
- tapOn: "e.g. DK-"
- inputText: "TEST-"
```

**Correct — use the label text and eraseText:**
```yaml
- tapOn: "Prefix:"      # label wraps the input — tapping it focuses the input
- eraseText: 10         # clear whatever is there (no-op if field is empty)
- inputText: "TEST-"    # type the new value
```

This works whether the field is empty (first run, placeholder gone after tap) or has a prior value
(re-run, eraseText clears it).

**Why:** Maestro matches `tapOn: "text"` against visible text rendered on screen. A placeholder is
rendered by the browser as text only when the input value is empty. Once saved, the field shows the
saved value and the placeholder text disappears from the DOM.

**How to apply:** Any time a test focuses an input that might have been filled in a previous run —
always target by label or surrounding context text, never by placeholder text. Follow with eraseText
before inputText.

**Where this bit us:** variant-metadata-read-only.yaml's Prefix input — the test had saved "TEST-"
on a previous run. The `tapOn: "e.g. DK-"` failed because "e.g. DK-" was no longer visible.
Fixed by switching to `tapOn: "Prefix:"` + `eraseText: 10`.
