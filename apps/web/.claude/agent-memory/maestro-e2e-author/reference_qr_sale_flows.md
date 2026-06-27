---
name: qr-sale-flows
description: Validated patterns for the /qr-code generator and /u/:username/sale running-total flows (NEO-53/54) — account-matching for getMyPublicProfile, off-fold QR content, reset-on-pay is not testable
metadata:
  type: reference
---

QR + Sale E2E (flows: `qr-code/generate-qr`, `qr-code/no-profile-empty-state`,
`sale/running-total`; producer `profile/fill-profile-data`). All validated GREEN
headless, first attempt, parallelism=1.

**Account matching is load-bearing.** `getMyPublicProfile` is keyed by the
SIGNED-IN Clerk user (`by_user` index). `fill-profile-data.yaml` saves the
profile on the `new-profile` account. So any flow that reads `getMyPublicProfile`
and expects that saved profile (e.g. `qr-code/generate-qr`) MUST sign in with
`account=new-profile` too — otherwise it reads a DIFFERENT (empty) user and the
page shows the empty state. The public `sale` page uses
`getPublicProfileByUsername` (global by-username lookup), so it just needs the
profile to exist for `${TEST_USERNAME}` — no account match needed (it's public,
no sign-in).

**SELF-CONTAINED — NOT a requires/provides chain (CORRECTED).** The earlier
design chained the flows via `requires:`/`provides:` so a producer flow filled the
profile and consumers read it. THAT IS WRONG for the cloud: the cloud queue
(`run-e2e-queue.sh`) regenerates `TEST_USERNAME` FRESH PER FLOW RUN and has NO
requires/provides ordering at all — flows drain off a shared queue in arbitrary
order on arbitrary runners. A flow can NEVER rely on another flow's saved
profile. (Locally `run-e2e-smoke.sh` sets ONE TEST_USERNAME for the whole pick-run
AND honors requires/provides, which masked the bug — green local, red cloud.)
Fix: EACH flow creates the data it needs under its OWN ${TEST_USERNAME}, in-flow.
- `generate-qr` + `running-total`: entry URL signs in (new-profile) → /testing/reset
  → /profile, then `runFlow: ../profile/util-fill-public-profile.yaml` fills+saves
  the profile, then proceeds (generate-qr → /qr-code; running-total →
  `launchApp: clearState` to sign out + clear localStorage → openLink the public
  sale page).
- The shared fill is a `util`-tagged sub-flow (`profile/util-fill-public-profile.yaml`),
  excluded from both local discovery (`flow_has_tag util && continue`) and cloud
  enqueue — so it is NOT queued standalone (R3 dedup without copy-paste). It fills
  username/display/tagline + venmo/paypal/cashapp (the minimal set the QR
  generator and sale page need).
- `no-profile-empty-state`: already self-contained — its own /testing/reset wipes
  the profile and it asserts the empty state. No tags beyond smoke/qr-code.
Confirmed via `npm run test:e2e:plan` — all 3 are Independent (0 dep-graph), and
all 4 (incl. Phase-0 bootstrap) pass GREEN headless, parallelism=1, first attempt.

**QR generated content renders BELOW the 1024×629 fold.** After "Generate QR
Code", the big white QR box pushes the encoded-URL `<p>` text and Download/Print
buttons off the bottom. `assertVisible` on the URL fails until you
`scrollUntilVisible {text:"Download", centerElement:true}` first (Download sits
just below the URL `<p>`, so it surfaces the URL too). Integer amounts render
bare: amt=8 → URL `.../sale?amt=8` (not 8.00).

**Amount entry — select by the VISIBLE LABEL, never the bare HTML id.** The
amount input is `<input id="amount" ...>` with a separate `<label htmlFor="amount">
Sale Amount</label>` and no aria-label. `tapOn: "Sale Amount"` (the visible label)
focuses the input via `htmlFor`, then `inputText: "8"` lands in it — proven by the
QR-URL assert (`.../sale?amt=8`). Do NOT use `tapOn: {id:"amount"}`: a bare HTML id
is an internal identifier no user perceives, which violates the hard rule "target
only visible text or aria-label." (If a future input genuinely can't be reached via
a visible label, add an `aria-label` to the element in source, then `id:"<aria>"`.)

**Reset-on-pay is NOT testable in maestro-web (de-scoped).** The only trigger for
`reset()` → $0.00 on the sale page is tapping a payment button, whose handler does
`window.open(href,"_blank")` to the EXTERNAL payment site (cash.app etc.).
maestro-web FOLLOWS into the new tab, so the original sale tab (where $0.00 would
render) is unreachable — the run lands on the external site (a cash.app 404 in our
run). Sale-page payment buttons also expose NO sr-only href (unlike the
public-profile page), so the total-in-href isn't assertable either. `running-total`
covers accumulation ($5→$8), persistence across reloads, and the FOUR
button-render asserts (visible labels "PayPal (F&F)" / "PayPal (G&S)" / "Venmo" /
"Cash App"); the reset assertion was removed with a de-scope comment. A clean
reset test would need a product change (non-navigating reset affordance or
sr-only total).

**All four payment buttons require their own profile field.** Each sale-page
button only renders when its source field is set (`.filter(l => !!l.href)`):
PayPal (F&F)←paypalUsername, **PayPal (G&S)←paypalEmail**, Venmo←venmoUsername,
Cash App←cashAppUsername. The fill util sets all four (paypalEmail via the
VISIBLE label "PayPal email (Goods & Services)" → htmlFor focuses
`pub-paypal-email`; wrap the matcher in `.*...[(]Goods & Services[)].*` — parens
escaped, `.*` for the label's trailing "Buyer-protected payments" span). The
email value isn't asserted directly (no "→" preview on that field, no sr-only
href on the sale button) — the G&S button rendering is the downstream proof.
