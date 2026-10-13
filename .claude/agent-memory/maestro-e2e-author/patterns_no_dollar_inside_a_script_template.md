---
name: no-dollar-inside-a-script-template
description: Maestro recognises `${…}` with the regex `(?<!\\)\$\{([^$]*)}` — a `$` anywhere in the body (a JS regex end-anchor) means it is NOT run; evalScript "COMPLETES", the output stays undefined, and a later assertTrue reads NaN as "false is true"
metadata:
  type: reference
---

Read out of `maestro-orchestra-models` `maestro/orchestra/util/Env.class`
(cli 2.8.0): the script finder is `(?<!\\)\$\{([^$]*)}`. The body may not
contain `$`. So

```yaml
- evalScript: '${output.TOTAL = maestro.copiedText.match(/of ([0-9]+)$/)[1]}'   # never runs
```

is left as literal text: the command reports COMPLETED, `output.TOTAL` stays
undefined, and a later `assertTrue: '${Number(x) < Number(output.TOTAL)}'`
compares against NaN and fails as `Assertion is false: false is true` on a
screen that is entirely right. NEO-335, CI run 38198207277: the header read
"Step 27 of 28"; re-run locally with the copied text logged through an
optional `assertVisible: { text: "DBG ${maestro.copiedText}", optional: true }`
(commands.json `evaluatedCommand` shows the evaluated text), which proved the
copy was right and the script never ran.

**How to apply:** never write `$` inside `${…}` — drop regex end-anchors
(`match(/of ([0-9]+)/)`), avoid template literals. When an assertTrue fails
"false is true", log the inputs with the optional-assert trick before
theorising. A one-off grep finds offenders: any `${` whose body hits a `$`
before its `}`.

Related: [[runtime-names-need-regex-escaping]], [[branch-on-copied-button-text]].
