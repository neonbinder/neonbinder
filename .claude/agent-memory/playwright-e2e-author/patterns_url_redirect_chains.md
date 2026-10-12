---
name: patterns-url-redirect-chains
description: Sign-in redirect chains — nested ?redirect= for sign-in, reset, seed, destination, via signIn() and the testing hops
metadata:
  type: project
---

## How redirect chains work
`signIn("/dest")` opens `/testing/sign-in?redirect=<dest>&worker=<n>`, signs the
worker in, then forwards to `<dest>`. A nested hop keeps its `?` literal and
writes a nested `&` as `%26`:

```ts
await signIn("/testing/seed-credentials?redirect=/profile");           // seed only
await signIn("/testing/seed-credentials?sites=label-scans%26redirect=/print/labels");
```

- **Seed-only**: the spec needs real credentials available (set-selector specs,
  real-auth credential specs).
- **Reset then seed**: only the `bootstrap` project wipes before seeding; a spec
  never resets (R4, R7).
- **Isolated account**: `signIn(dest, { account: "new-profile" })` for a spec that
  must start from an empty profile.

Always let `signIn` build the URL (it adds the `worker=` parameter that selects
the Clerk user); never hand-assemble the chain.
