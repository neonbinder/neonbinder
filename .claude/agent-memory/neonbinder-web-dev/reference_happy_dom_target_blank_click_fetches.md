---
name: happy-dom-target-blank-click-fetches
description: In a happy-dom component test, clicking a target="_blank" link opens a new happy-dom window that fetches the href from localhost:3000; the test still passes but logs ECONNREFUSED noise
metadata:
  type: reference
---

React Router's `<Link target="_blank">` leaves the click to the browser. In happy-dom
that default opens a new window and FETCHES the href against `http://localhost:3000`,
so the run prints an `ECONNREFUSED` AggregateError plus a happy-dom `NetworkError`.
The test still passes, and the NEO-188 network guard does not report it.

**How to apply:** when a test must click a new-tab link (for example to prove the page
behind it is untouched), hold back the default for that one click only:
`document.addEventListener("click", e => e.preventDefault())` around `fireEvent.click`,
then remove the listener. React's root listener runs first, so the app's own handler
still runs. When you only need to check `target`/`rel`/`aria-describedby`, assert the
attributes and do not click. Found in NEO-350 (PrintShopLink).
