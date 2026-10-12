---
name: reference-vi-mock-stub-component-needs-a-name
description: A stateful stub inside vi.mock's factory written as `default: ({...}) => { useState… }` fails react-hooks/rules-of-hooks; write `default: function StubX(...)`
metadata:
  type: reference
---

When a component test stubs a child with state (e.g. a TeamPicker stub that
opens on click), `vi.mock("./X", () => ({ default: (props) => { const [o] =
useState(false); … } }))` fails `npm run lint` with rules-of-hooks ("called in
function `default`"). Name it: `default: function StubX(props) { … }`. The test
itself passes either way, so only the lint gate catches it.

Related: inside a component, a `useMemo` that reassigns outer `let`s from an
inner helper trips `react-hooks/immutability`; derive the values with
`find`/`map` instead. See [[reference_component_tests_hand_build_the_api_mock]].
