---
name: public-admin-functions-are-the-scripting-api
description: The set builder's public requireAdmin functions ARE the scripting API (a headless caller gets a real Clerk JWT via NEO-172 machine auth); internal *FromCli armed functions are only for destructive/armed work; operator-decision assembly must live in env-free lib modules, not components.
metadata:
  type: project
---

Two kinds of server surface exist; a plan should not invent a third.

- **Public `requireAdmin` functions** are what the UI calls: `ensureSelectorOptions`,
  `fetchRawOptions`, `storeReconciledOptions`, `setVariantTypePlatformData`,
  `fetchCardChecklist`, `resolveChecklistEntities`, `entityReviewQueue.*`,
  `commitCardChecklist`, `buildParallelChecklist`, `applySlSetReview`. A Node
  script or MCP server calls the same functions as a real admin: it gets a real
  Clerk session JWT (an API key traded at `POST /machine/token`, or on a preview
  the existing testing sign-in ticket redeemed like the browser does) and uses
  the Convex client with `setAuth`.
- **Internal `*FromCli` armed actions** are for destructive or one-shot work:
  deploy key only, a confirm literal plus an env arm flag, never `--identity`.

**Why:** a wrapper surface would need its own auth audit and could drift from
the UI. Marketplace calls need the caller's stored credentials, so a mocked
identity cannot build a set.

**How to apply:** drive the public functions with a real JWT and keep the
orchestration on the client side. Decision assembly that lives in components
belongs in env-free `lib/` modules shared by the UI and the tool (see
[[fe-imported-convex-modules-stay-env-free]]).
