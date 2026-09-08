---
name: clerk-apikeys-component-selectors
description: "NEO-172 /profile/api-keys — Clerk <APIKeys/> (clerk-js 5.127.2) ground-truth selectors read out of the CDN chunks: verbatim en-US strings, the row menu's `Open menu` aria-label, inline (not modal) create form, both reveal/revoke modals, and the `cannot_render_api_keys_disabled` failure mode when the instance toggle is off"
metadata:
  type: reference
---

## How to get ground truth for ANY Clerk prebuilt component (generalisable)

clerk-js is loaded from the instance's FAPI host at runtime, so the component's real
DOM is not in `node_modules`. Read it from the CDN instead:

1. In the running page: `performance.getEntriesByType('resource').map(e=>e.name).filter(n=>/clerk/i.test(n))`
   → gives the FAPI host and the exact version, e.g.
   `https://<instance>.clerk.accounts.dev/npm/@clerk/clerk-js@5.127.2/dist/<chunk>_clerk.browser_<hash>_5.127.2.js`
   (Do NOT try to decode the FAPI host out of `.env.local` — reading the publishable
   key from the env file is blocked by the auto-mode classifier.)
2. `curl` the main `clerk.browser.js` and grep for the webpack chunk-name map
   (`{1033:"planDetails",...,4616:"apiKeys",1642:"revoke-api-key-modal",5672:"copy-api-key-modal",...}`)
   to translate a lazy chunk id into its downloadable filename.
3. `curl` the feature chunk + `ui-common_clerk.browser_*.js`. The **en-US default
   localization table lives in ui-common** — grep `apiKeys:{` (or `<feature>:{`) for
   the verbatim strings, and `formFieldLabel__*` / `formFieldInputPlaceholder__*`
   for field labels/placeholders.
   ⚠ macOS FS is case-insensitive: `curl -o chunk-apiKeys.js` then
   `curl -o chunk-ApiKeys.js` overwrite each other.

Clerk form primitives (`ui-common` 60807/70431/36788), useful for every Clerk form:
- `Form.Input` renders `<input id={fieldId} name={fieldId} placeholder={t(placeholder)}>`.
  **The placeholder IS rendered**, so an empty Clerk field is targetable by
  `tapOn: { text: "<placeholder>" }` (maestro-web `getNodeText` for `<input>` =
  `value || placeholder || ariaLabel`).
- `Form.Label` renders `FormLabel` WITHOUT an explicit `htmlFor` — do not rely on
  "tap the label to focus the input" for Clerk forms; aim at the placeholder.
- `FormButtons` = submit + a reset button labelled `userProfile.formButtonReset`.
- The three-dots row menu (`ui-common` 33009 + 15158) puts
  **`aria-label="Open menu"` / `"Close menu"`** on the trigger → `id: "Open menu"`.
  Menu items are `role="menuitem"` buttons that close the menu on click, so the
  menu item label and a same-named modal submit button never coexist.

## `<APIKeys />` specifics (clerk-js 5.127.2)

Verbatim en-US (confirmed in the bundle, not just docs):
`Add new key` · `Search keys` · headers `Name` / `Last used` / `Actions` ·
empty row `No API keys found` · form title `Add new API key` ·
name label `Secret key name`, placeholder `Enter your secret key name` ·
submit `Create key` · row caption `Created {{date}} • Never expires` ·
row menu `Revoke key` · copy modal title `Copy your "{{name}}" API Key now`,
hint `For security reasons, we won't allow you to view it again later.`,
button `Copy & Close` · revoke modal title `Revoke "{{apiKeyName}}" secret key?`,
input label `Type "Revoke" to confirm` with **placeholder `Revoke`**, submit `Revoke key`.

Behavioural facts that shape a flow:
- The **create form is INLINE** (an `Action.Card` that pushes the table down), not a
  modal, and the `Add new key` trigger stays visible while it is open.
- Create submit is disabled until the name is >2 chars; revoke submit is disabled
  until the confirmation box contains exactly `Revoke`.
- Expiration is a **custom popover**, not a native `<select>` — the native-select
  tap/type-ahead workarounds do not apply, and none are needed. Clerk's Select
  (`ui-common` 3146) is plain-tap drivable, and the details generalise to every
  Clerk dropdown:
  - Trigger (`SelectButton`) shows the placeholder (`"Select date"` here) in a
    `<span>` while unset, and once a value is picked the button's own DIRECT
    text becomes the option label (`buttonRenderOption` returns a raw string).
    The trigger sets `"> *": {pointer-events: none}`, so a tap aimed at the span
    hit-tests to the button — aim at the visible placeholder text.
  - Options are `<Flex onClick>` rows whose innermost `Text` holds the label →
    `tapOn: { text: "1 Day" }`. Selecting closes the popover.
  - **The list is `maxHeight: 18vh; overflow-y: auto`** — ~113px, about 3 rows at
    629px tall — and Maestro cannot scroll an inner container. Only options near
    the top are reachable. It opens scrolled to the CURRENT selection, so with
    nothing selected it opens at the top.
  - `usePopover`'s `shoudFlip` defaults to TRUE and `shift()` is always in the
    middleware, so the panel flips above the trigger rather than going off-screen.
  - Assert the SIDE EFFECT, not the control: the form's caption flips from
    "This key will never expire" to `Expiring {{date}}`. Without that assert a
    missed tap silently falls back to a never-expiring key and the flow is green.
- **Prefer a 1 Day expiration in any flow that creates a key**: the reveal dialog
  puts a live secret on screen, and a CI failure screenshot in that window is a
  public artifact. A 24h self-expiry bounds the exposure if the run dies there.
- Both modals are `canCloseModal: false` (no backdrop/Esc close) and render with
  `outsideElementsInert` — you must click their own button.
- The list is server-filtered: `apiKeys.getAll` sends `query` to `GET /api_keys`.
  The hook debounces 500ms and uses `keepPreviousData: true`, so the UNFILTERED
  list is still on screen for a moment after typing.
- **Safety pattern for a destructive row action**: the revoke dialog quotes the key
  name in its title, so asserting your own name in that title BEFORE typing the
  confirmation word makes "wrong row" impossible to act on. Use that instead of
  trusting a row-menu tap to have hit the right row.
- The copy modal shows the live secret in a read-only input → a Maestro
  failure screenshot taken between `Create key` and `Copy & Close` captures a real
  credential. Say so in the flow header.

## Feature-toggle failure mode (how a blocked run looks)

API keys are a per-instance Clerk setting (`environment.user_api_keys_enabled` /
`orgs_api_keys_enabled`). With it OFF, `clerk.mountAPIKeys()` **throws** at
`componentDidMount`:
`Clerk: 🔒 The <APIKeys/> component cannot be rendered when API keys are disabled.
(code="cannot_render_api_keys_disabled")`.
Our page's `Sentry.ErrorBoundary` catches it and paints
`Error: API keys are unavailable right now. …the feature may not be enabled for this
account yet.` So a flow that gates on `assertVisible: "Add new key"` fails with
`Assertion is false` after the 17s lookup — that is BLOCKED-ON-TOGGLE, not flake.
Nothing in the flow should be weakened to get past it.
