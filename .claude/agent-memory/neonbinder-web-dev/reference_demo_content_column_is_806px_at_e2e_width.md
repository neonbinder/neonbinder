---
name: reference-demo-content-column-is-806px-at-e2e-width
description: The public collection demo's content column is only ~806px wide at the 1024px E2E viewport (lg:pr-[170px] rail gutter + p-6), so a wide table overflows under the Sign up / Back to the tour rail
metadata:
  type: reference
---

`PublicCollectionDemo` gives the page `lg:pr-[170px]` (room for the DemoRail exits) plus `p-6`, so at the 1024x629 CI viewport the tab content is ~806px, not ~976px. A 9-10 column table sized "by eye" at 1024 overflows and slides under the fixed right rail (seen on NEO-500's Pick List: the Order column hid behind "Sign up free").

**How to apply:** budget columns against ~800px; merge a narrow column into a neighbour (serial under condition) before shrinking text; grid filter bars at `xl:` not `lg:` (6 selects at lg truncate "Every sport"). Screenshot at 1024 with a viewport crop, not only full-page (full-page shots downscale and hide the overflow). See [[e2e-viewport-is-the-ux-constraint]].
