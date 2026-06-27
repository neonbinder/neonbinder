---
name: when-true-env-var-gating
description: Confirmed JS semantics for when: { true: "${VAR}" } — unset var is undefined (falsy), set var is truthy. Cumulative AND gating pattern. With source citations.
metadata:
  type: feedback
---

## Rule

`when: { true: "${VAR}" }` gates a runFlow block on whether VAR is set and non-empty.

- **Unset var** (not passed by caller): not injected into JS bindings → evaluates to `undefined` → falsy → block **skipped**.
- **Set non-empty string** (e.g. "Baseball"): injected as JS binding → `"Baseball"` → truthy → block **runs**.
- **Empty string** (`VAR=""`): empty string → falsy → block **skipped** (same as unset).

## Cumulative gating for Level N

Level N runs only if vars 1..N are ALL non-empty. Use `&&`:

```yaml
# Level 4 — runs only if SPORT, YEAR, MANUFACTURER, and SET_NAME are all set
- runFlow:
    when:
      true: "${SPORT && YEAR && MANUFACTURER && SET_NAME}"
    commands:
      ...
```

`&&` in JS returns the last truthy value OR the first falsy value:
- All set: `"Baseball" && "2024" && "Topps" && "tp-0"` → `"tp-0"` → truthy → runs.
- Any unset: `"Baseball" && undefined && ...` → `undefined` → falsy → skipped.

## What you do NOT need

- No quoted comparison: `"'${VAR}' != ''"` is NOT needed (and may be fragile with YAML escaping).
- No `${!!VAR}`: `${VAR}` alone is sufficient since non-empty strings are already truthy.
- No `|| "default"` fallbacks in drill utils: absence means "stop here", not "use default".

## Source / confidence: HIGH

**GraalJsEngine.kt** (maestro-client) sets up the JS context with:
```javascript
Object.setPrototypeOf(globalThis, new Proxy(Object.prototype, {
    has(target, key) { return true; }
}))
```
This makes undeclared variables return `undefined` instead of throwing ReferenceError.
Env vars are injected via `envBinding.putMember(k, v)` — unset vars are never added.

**IntegrationTest case 065** (maestro-test/src/test/resources/065_when_true.yaml + IntegrationTest.kt):
- `when: { true: "${undefined}" }` → **skipped** (confirmed by assertEvents not including "Undefined")
- `when: { true: "${true}" }` → runs
- `when: { true: "${'String'}" }` → runs (non-empty string)
- `when: { true: "${false}" }` / `${null}` / `${0}` → skipped

**Why:** This is Maestro's documented behavior for "custom expressions" in conditions.
Source: https://docs.maestro.dev/maestro-flows/flow-control-and-logic/conditions + GraalJsEngine.kt source.

**How to apply:** In any util that accepts optional vars and drills to the deepest provided level,
wrap each level's commands in `when: { true: "${var1 && var2 && ... && varN}" }`. Drop all `|| "default"` fallbacks.
