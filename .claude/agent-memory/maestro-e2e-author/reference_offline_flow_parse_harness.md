---
name: offline-flow-parse-harness
description: "Parse any Maestro flow OFFLINE with Maestro's own YAML reader — no Chrome, no Convex, no run lock. Catches invented command properties (a hard parse error that kills a whole flow) in seconds, reproduces CI's exact `Unknown Property … at file:line:col`, and prints the parsed command objects so a schema question is settled by evidence."
metadata:
  type: reference
---

# Offline flow parsing — the check `MAESTRO_PLAN_ONLY` does NOT do

`MAESTRO_PLAN_ONLY=1 ./run-e2e-smoke.sh <selector>` only resolves the SELECTOR.
It never opens the flow bodies, so an invented property sails through it and
dies in CI instead. `maestro.orchestra.yaml.YamlCommandReader.readCommands(Path)`
is the real parser and runs happily from the installed jars with no browser and
no app server — so it needs **no run lock** and costs about a second.

Harness kept at `tools/ParseFlow.java` beside this note.

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
CP=$(ls ~/.maestro/lib/*.jar | tr '\n' ':')
"$JAVA_HOME/bin/javac" -cp "$CP" -d /tmp/parse tools/ParseFlow.java
# one flow, or the whole suite:
"$JAVA_HOME/bin/java" -cp "$CP:/tmp/parse" ParseFlow \
  $(find .maestro/flows -name '*.yaml' | sort | tr '\n' ' ')
```

Exit 0 iff every file parses. It prints `OK <file> commands=N` per flow and, for
a failure, Maestro's own message — byte-identical to CI's, line:col included.

## Why this matters (NEO-236, CI run 6)

An agent invented `maxRuns:` on `repeat`. That is not a soft warning: an unknown
property is a **hard SyntaxError that kills the entire flow before command one**,
so the seed job died with `Unknown Property: maxRuns at …/setup.yaml:645:7` and
took the whole E2E gate with it. The harness reproduced it exactly and, in the
same pass, found the same defect in two more flows CI had not reached yet.

**Run the sweep after ANY new command idiom, and after any agent-authored flow
edit you did not write yourself.** 93 flows parse in ~2s.

## Settling a schema question with evidence, not docs

`javap` the model class for the allowed keys; the parse output confirms how a
value is coerced and whether keys combine:

```bash
javap -cp ~/.maestro/lib/maestro-orchestra.jar maestro.orchestra.yaml.YamlRepeatCommand
# getTimes():String · getWhile():YamlCondition · getCommands() · getLabel() · getOptional()
```

`repeat` therefore takes **`times` and `while`, and they COMBINE** — proven, not
assumed: the parsed object comes back as
`RepeatCommand(times=250, condition=Condition(notVisible=ElementSelector(textRegex=…)))`.
The loop runs while the condition holds and stops at whichever limit comes
first, so `while:` carries the intent and `times:` is the runaway guard. Note
`times` is typed `String` and an unquoted YAML integer coerces cleanly.

Same trick settled `above:`/`below:` combining on `ElementSelector` (see
[[patterns-asserting-spatial-order]]).
