---
name: react-hooks-refs-flags-helper-arguments
description: react-hooks/refs ("Cannot access refs during render") fires when a ref-reading callback is passed as an ARGUMENT to a render helper like renderRow(), but not when the same closure is a JSX prop
metadata:
  type: reference
---

The React Compiler lint cannot tell that a local render helper
(`const renderRow = (info, ..., onJump) => <Row onJump={onJump} />`) never
calls its function arguments, so passing `() => handleJump(id)` (where
`handleJump` reads `ref.current`) INTO the helper is flagged as a ref read
during render. Pass a boolean to the helper and build the closure inside the
JSX prop instead (`onJump={jumpable ? () => handleJump(info._id) : undefined}`);
JSX props are treated as handlers and pass.

Same family: "reset a piece of state when a prop changes" in a `useEffect`
trips the set-state-in-effect rule; use the render-phase
`if (prev !== prop) { setPrev(prop); ... }` pattern
([[render-phase-state-for-previous-render-values]]).
