---
name: maestro-web-driver-limits
description: What Maestro's web driver can and cannot observe or send — pressKey supports only Enter/Backspace, the view hierarchy carries only text/bounds/resource-id/selected, and the copyTextFrom+evalScript pattern for asserting a live value without hardcoding it
metadata:
  type: reference
---

Verified by decompiling the installed Maestro 2.8.0 jars
(`~/.maestro/lib/maestro-client.jar`), 2026-08-29. Re-verify after a Maestro bump.

## `pressKey` sends only ENTER and BACKSPACE

`maestro.drivers.WebDriver.mapToSeleniumKey` is a `when` over `KeyCode` with
exactly two arms — `ENTER → Keys.ENTER`, `BACKSPACE → Keys.BACK_SPACE` — and a
`default:` that throws `IllegalStateException`. Everything else in the `KeyCode`
enum (TAB, ESCAPE, HOME, REMOTE_LEFT/RIGHT/UP/DOWN, …) is unsupported on web.

**There is no way to send an arrow key from a Maestro web flow.** So APG
roving-tabindex / arrow-key radiogroup behaviour, arrow-key list navigation, and
Tab-order traversal are NOT coverable at this level — they belong in the
component's own vitest/jsdom tests. Say so in the flow header rather than
inventing a proxy assertion.

`pressKey: Enter` fires the FOCUSED element's handler, which is the only
keyboard mechanism available.

## The web view hierarchy carries four attributes, and that is all

`maestro-web.js`'s `traverse()` emits per node:

| attribute | source |
| -- | -- |
| `text` | **direct child TEXT NODES only** (`input`/`textarea` → `value \|\| placeholder \|\| ariaLabel`; `select` → selected option text) |
| `bounds` | `getBoundingClientRect()` |
| `resource-id` | `flt-semantics-identifier` \|\| `node.id` \|\| **`node.ariaLabel`** \|\| `name` \|\| `title` \|\| `htmlFor` \|\| `data-testid` |
| `selected` | `node.selected` — only ever true on `<option>` |

Consequences worth remembering:

- `ElementSelector` has `checked:`, `focused:` and `enabled:` fields, and they
  are **inert on web** — nothing ever populates them. Do not assert
  `aria-checked` / focus / disabled state through them; find a user-visible
  consequence instead (e.g. assert the VALUE the chosen option produces
  elsewhere in the row).
- `text` is direct text nodes only, so a decorative `<span aria-hidden>✓ </span>`
  inside a button is a SEPARATE node — the button's own `text` is unchanged by
  it. Same trap as the "Custom" badge (see `reference_cdp_scroll_bug_and_badge`).
- `maestro.queryCss(selector)` exists, so `css:` selectors do work on web. Treat
  it as a last resort — it reads as a code reference, not as something a user
  sees.

## Asserting a LIVE value without hardcoding it

`copyTextFrom` + `evalScript` + `${output.x}` interpolation into a later
selector all work on web, and the resolved value is written into
`maestro-report/debug/<flow>/<name>/commands.json`, so you can prove after the
fact that the interpolation was not empty.

```yaml
- copyTextFrom:
    id: "BSC: .* — use this name for #FS-1"      # node text is "BSC: <name>"
- evalScript: '${output.bscName = maestro.copiedText.replace("BSC: ", "").trim()}'
- assertVisible:
    id: "Unlink #FS-1 ${output.bscName}"
```

Notes:
- Single-quote the `evalScript` scalar and use double quotes inside the JS —
  `\s` is an invalid escape in a double-quoted YAML scalar, and a bare scalar
  can break on `": "`.
- Prefer `String.replace("literal ", "")` over a regex: no YAML escaping issues
  and GraalJS-safe.
- **Always pair it with a negative control.** An `assertVisible` on an
  interpolated id plus a later `assertNotVisible` on the same id cannot both
  pass on an empty interpolation, whichever matching semantics apply. Better
  still, run the flow once with the triggering tap removed and confirm it goes
  RED with the fully-resolved value in the failure message.
