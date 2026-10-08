---
name: present-in-failure-dump-means-late-arrival
description: A positive assert that FAILED while its target sits fully on-screen in the failure screenshot/hierarchy means the node arrived in the ~0.4s between the last poll and the dump; heading gates on ProtectedLayout pages are Clerk-only, so nothing proves the Convex socket is live before the first query-rendered node
metadata:
  type: reference
---

**Signature.** `Assertion is false: "<X>" is visible` after the full timeout, yet the
failure PNG and `screen-hierarchy/step-N-*.json` both show `<X>` fully inside the
1024x629 viewport with the right text. The dump is taken about 0.4s after
`CommandFailed` (compare the `CommandFailed` and `takeScreenshot` stamps in
maestro.log). `extendedWaitUntil` re-reads the hierarchy every ~0.3s, so a node that
had been present for one poll would have passed. **It arrived late**, in that last
gap. It is not a selector or viewport problem. Before reading it that way, check
the bounds and the exact text in the dump.

**What to do next (never raise the timeout):**
1. Check whether the data is right. If the late node shows the correct row, the
   query's output never changed during the wait, and nothing wrote in the window
   (check the convex-logs mutations for that user), the product computed the right
   answer and only DELIVERY was slow.
2. Run the in-run cross-client control ([[flake-runtime-forensics]]): other runners
   doing fresh page loads with query-rendered asserts at the same moment, plus the
   same flow's own earlier openLink and query-rendered gates. If they are all fast,
   the preview backend and Clerk are healthy and the lag is one tab's.
3. Diff the failing page's whole import tree between the green and red heads
   (`git diff --stat A B -- <page> <layouts> <primitives> <convex fn>`). An empty
   diff rules out the branch's code for that render.

**Why heading gates prove nothing about Convex.** `ProtectedLayout` renders on
Clerk `isLoaded && isSignedIn`. The binder tabs' Admin entry is Clerk-role based,
and `/print` warms its queries without rendering them. So on a freshly opened
`/print/*` (or any page whose first Convex-backed node needs user input), the
heading gate passes before the document's Convex websocket and Authenticate have
delivered anything. The first query-rendered node the flow waits on is the first
proof. A delivery lag on that fresh connection (a slow token fetch or socket open,
or the NEO-84 wedged-socket class) shows up at that step and nowhere earlier.
Seen on the spine-label player search (NEO-326 CI): about 16s, one runner, and
seven healthy runners around it.

See also [[never-diagnose-timing-first]], [[negative-asserts-pass-on-a-dead-page]].
