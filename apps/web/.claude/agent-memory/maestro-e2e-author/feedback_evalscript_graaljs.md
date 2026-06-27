---
name: evalscript-graaljs-context
description: evalScript runs in Maestro's GraalJS JVM sandbox, NOT the browser. Pattern for bridging browser values into evalScript.
metadata:
  type: feedback
---

`evalScript` in Maestro 2.x uses GraalJS (`org.graalvm.polyglot`) running in Maestro's JVM process — NOT in the browser via CDP. This means:

- NO access to `window.*`, `document`, `fetch()`, `Clerk`, or any browser API
- YES access to `http.post(url, opts)`, `http.get(url)`, `maestro.copiedText`, `output.*`, `env.*`

**How to apply:**
- Never write `window.__convexUrl` in `evalScript` — it will be `undefined`
- To get a browser-side value into `evalScript`, render it in a DOM element and use `copyTextFrom` first, then read `maestro.copiedText`

**The copyTextFrom → evalScript bridge pattern:**
```yaml
# 1. Render the value in DOM: <span aria-label="test:my-value">the-actual-value</span>
# 2. In the flow:
- copyTextFrom:
    id: "test:my-value"
- evalScript: |
    var myValue = maestro.copiedText;
    // now use myValue in http.post() etc.
```

**http.post() API:**
```javascript
var res = http.post('https://example.com/endpoint', {
  headers: {
    'Content-Type': 'application/json',
    'x-custom-header': 'value'
  },
  body: JSON.stringify({ key: 'value' })
});
// res.status is integer, res.body is string
```

**Why:** Confirmed by decompiling `maestro-client.jar`: `GraalJsEngine` uses `org.graalvm.polyglot.Context`. `CdpClient.evaluate()` exists in `maestro-web.jar` but is used internally for DOM interactions, not exposed as a YAML command. `evalScript` on web does NOT use CDP evaluate.
