# TCDB Enrichment Bug — Overnight Worklog (2026-06-11 → 06-12)

**Operator:** Claude (autonomous overnight). **User:** asleep; review in AM.
**Mandate (verbatim):** "you have the night to try to resolve the tcdb issue. you can push PRs and test against preview deployments but do not merge to production." + "ensure you leave a log behind of decisions made."

## HARD CONSTRAINTS
- ✅ May: push PRs, test against preview/dev deployments.
- ⛔ MUST NOT: merge to production. No prod deploys.
- Branch from latest main; browser+web repos are trunk-based (feature → PR → main).
- Check logs before diagnosing; no speculation without evidence.

## THE BUG (confirmed before bed)
`#34 tcdb-auto-enrich` fails: asserts TCDB Set ID `27845` is visible; it never appears.
Root cause chain (all evidence-backed):
1. Sign-in guard (added tonight) works — flow reaches /set-selector, drills to Topps Chrome. ✅
2. Live data (focused-fox-53): Topps Chrome `setMetadata = {lastSyncedAt: 1781231557786}` ONLY.
   `tcdbSetId` appears **0×** across all 786 selectorOptions rows. No cached SID.
3. So `enrichSetFromTcdb` RUNS (stamps lastSyncedAt) but writes NO tcdbSetId/releaseDate/block.
4. `enrichSetFromTcdb` (convex/adapters/tcdb.ts:264) flow: POST /tcdb/search → need confident
   match (score ≥ MIN_MATCH_SCORE) → POST /tcdb/get-set → write metadata. Empty result ⇒
   `/tcdb/search` returned no confident match (or tcdb-unavailable / HTTP error).
5. 2024 Topps Chrome Baseball IS on TCDB (mock sourceUrl = sid/27845) → search SHOULD match.
   ⇒ Something in browser-service `/tcdb/search` is failing. **← investigating.**

Browser service (dev): `https://neonbinder-browser-xxlo66yxuq-uc.a.run.app` (us-central1).
Code: route in `neonbinder_browser/src/index.ts`; logic in `neonbinder_browser/src/adapters/tcdb-adapter.ts`.
Convex calls it from `convex/adapters/tcdb.ts`. Mapping: `convex/features/tcdbMapping.ts`.

## SIDE RESULT (the test-stabilization walk active set)
At parallelism=2, data seeded: **#28 ✅ #29 ✅ #32 ✅ #34 ❌** (the TCDB bug).
- #28 hang earlier = unseeded-set sync thrashing (1335 CDP errs); seeded → clean 5m5s.
- #32 fixed by the sign-in guard (45s extendedWaitUntil "Set Selector"). Same guard added to #34.
- #34 flow ALSO has 2 latent test bugs to fix AFTER enrichment works:
  (a) never scrolls to the TCDB Set ID row (renders below the 1024×629 fold).
  (b) asserts mock values 27845 / 2024-08-21 (from featurePropagation.test.ts / tcdbMapping.test.ts),
      not live. User chose "exact live values" — but there ARE none until enrichment is fixed.

## DECISIONS LOG (append-only)
- [21:5x] De-isolated #34 (removed `- isolated` tag) — user: all shared data loaded up front, reads safe. Now 0 isolated flows; flat parallel queue.
- [22:0x] Added 45s sign-in guard to #32 + #34 (proven team-picker pattern). Fixed #32.
- [22:1x] Ran setup track to seed Topps Chrome (global reset + 655 Base cards). Enrichment ran but empty.
- [22:2x] User chose "investigate the TCDB bug" (vs accept #34 red). Working it overnight.
- [22:3x] gcloud auth token EXPIRED → can't read Cloud-Run logs or call the private dev browser
  service. Pivoted to live Puppeteer repro vs tcdb.com (no GCP needed).
- [22:4x–23:1x] Repro confirmed root cause (see ROOT CAUSE section). Old search URL dead; new search
  = Google AFS + Cloudflare Turnstile; direct checklist page 403 (but my IP is flagged).
- [23:2x] DECISION: do NOT ship a speculative scraping hack. It would be fragile, possibly ToS-
  violating, and UNVERIFIABLE tonight (flagged IP, gcloud blocked). The honest deliverable is the
  diagnosis + options + recommendation for the user's strategic call. Will do one clean cold retest
  (after IP cooldown) to firm up "is Turnstile universal vs flag-induced" + "does checklist page load
  cold" — the two facts that decide whether ANY fix path is viable.

## RECOMMENDATION (for AM review)
1. **#34 is correctly RED** — it caught a genuinely broken feature (your principle: test reflects the
   feature). The fix is to the FEATURE, not the test.
2. **TCDB enrichment needs a strategic decision** (not a quick patch). Ranked:
   - If the clean retest shows `Checklist.cfm/sid/N` loads cold from a normal IP → **Option A** (cache/
     derive SID, fetch metadata directly, AVOID the Turnstile'd Search.cfm) is the lowest-risk real fix.
     The hard part is the SID lookup (candidate: Google Custom Search JSON API, Option B, if the
     `partner-pub-` cx is queryable; else a small maintained sport/year→SID map for the handful of
     test/anchor sets).
   - Else → **Option C** (residential-proxy / CAPTCHA-solving service) is the only robust path, with
     cost + ToS + a new secret. Or **Option E** (drop TCDB; rely on BSC/SL set metadata).
3. **Unblock PR #53 (the test walk)** — don't let one broken external-dependency feature block the
   3/4-green stabilization work. Options: (a) keep #34 in the suite RED and merge the feature fix
   separately first; or (b) temporarily move #34 OUT of the CI smoke gate (NOT a `wip` tag — a tracked
   "blocked on TCDB feature fix" exclusion) with a Linear ticket, so #28/#29/#32 + the de-isolation
   land. Your call — (a) honors "no quarantine," (b) unblocks the walk. I did NOT decide this for you.
4. The #34 flow ALSO needs (once enrichment works): scroll to the TCDB Set ID row + assert real live
   values. Prepared but NOT committed (can't validate until the feature produces data).

## ════════ AM 2026-06-12 — USER DECISION + IMPLEMENTATION ════════
**User decision:** Keep ALL metadata fields but fill them MANUALLY; DELETE the automated TCDB
scraping entirely (TOS-safe). + a Linear ticket to find a legit way to automate Set/Card Feature data.

**Branches:** both repos on `jburich/remove-tcdb-scraping` off origin/main.
- web in a worktree: `/Users/jburich/workspace/nb-wt-tcdb-removal` (test-walk stays parked in main checkout).
- browser in-place (was clean on main).

**Progress:**
- ✅ Browser service removal DONE + verified: deleted `src/adapters/tcdb-adapter.ts` + its test, removed
  `/tcdb/search` + `/tcdb/get-set` routes from `src/index.ts`, dropped TcdbAdapter from `adapters/index.ts`
  + SiteType + SUPPORTED_SITES + the `platform` log union, fixed package.json test script.
  **`npm run build` = exit 0; `npm test` = 60/60 pass.** (uncommitted, pending security review)
- 🔄 Web/Convex+UI removal IN PROGRESS — delegated to neonbinder-web-dev agent (in the worktree):
  unwire the in-band TCDB preview (fetchCardChecklist→CardChecklist.tsx→commitCardChecklist→
  applyTcdbToSetNameNode), delete adapters/tcdb.ts + features/tcdbMapping.ts + 2 tcdb test files,
  clean backfillCardFeatures/setReconciliation/adapters-types, KEEP schema setMetadata fields,
  make tcdbSetId + sourceUrl manually editable in SetAttributesPanel + drop lastSyncedAt row.
- ⏳ NEXT: Maestro (retire #34 tcdb-auto-enrich, extend #32 for manual tcdbSetId/sourceUrl) via
  maestro-e2e-author; security-auditor review of the full diff (sourceUrl-as-link watch); commit +
  push 2 PRs (web + browser) — DO NOT MERGE. File the Linear ticket.

**⚠️ FLAG for user:** browser PR #32 (`jburich/neo-24-tcdb-adapter`, NEO-24) is still OPEN but the
adapter is already on main — it's stale/superseded by this removal. Recommend CLOSING #32.

**✅ PRs OPENED (not merged):**
- Browser: neonbinder_browser **#47** — build clean, 60/60 tests.
- Web: neonbinder_convex **#54** — tsc clean, lint clean, 140 unit tests. CI watcher armed.
- Security review: **GO** on both (admin-gated writes, sourceUrl=escaped text, BSC/SL intact, no creds in TCDB).
**REMAINING:**
- Validate extended #32 (set-attributes-edit) against #54's preview (regression-tagged, not in smoke gate);
  measure the optimistic-toast save latency → tighten the 15s waits to 7s; push refinement.
- File the Linear automation ticket (still needs user to authorize Linear MCP).
- Close stale browser PR #32 (user decision).
- Merge-ordering: #32 set-attributes-edit.yaml also changes on test-walk #53 → resolve on merge.

## PR #54 CI RESULT (2026-06-12) — e2e gate RED, but NOT from this PR (proven)
Queue: 34 passed / **8 failed** / 42 total → e2e gate red. The 8 failures are ALL pre-existing `main`
flakiness, none touch this PR's files:
- `"Set Selector" not visible` (sign-in race / missing 45s guard): cards-parallel-custom,
  checklist-keyboard-only-dialog, multi-source-panel-opens-dialog, team-picker.
- `"Years" not visible` (drill heading-clip flake): custom-field-known-value-selects,
  parallel-grouping-cancel-discards, parallel-grouping-reject-parallel, variant-metadata-editor-insert.
These are EXACTLY the flows the test-walk (#53) stabilizes; those fixes aren't on main yet, and this
PR is based off main → it inherits them.
**PROOF this PR is clean:** every flow exercising the changed code PASSED — `set-attributes-edit`
(the extended #32, validating manual TCDB Set ID + Source URL editing on the preview),
`topps-chrome-marketplace-read`, `topps-chrome-add-feature`, `checklist-renders-rich-fields`,
`features-propagation`. So #32 IS validated green against the preview.
**Consequence:** PR #54's e2e gate can't go green until main's flakes are fixed (merge #53 first →
rebase, OR rebase #54 onto #53). The TCDB removal itself is correct + verified.
**Pending nit:** tighten #32's new optimistic-toast save waits 15s→7s (safe: toast is synchronous).

## LINEAR TICKET DRAFT (file once Linear is authorized)
**Title:** Automate Set/Card Feature (set-metadata) data acquisition — TOS-compliant source
**Description:**
Background: We removed the automated TCDB scraping (it risked TCDB's TOS, and TCDB is now blanket
Cloudflare-Turnstile protected — search/browse/sitemap/robots all 403, no viable headless path; see
worklog `neonbinder_web/todos/tcdb-enrichment-bug-overnight-2026-06-11.md`). Set/Card metadata
(releaseDate, totalCardCount, block, tcdbSetId, sourceUrl, + features like era/league) is now entered
MANUALLY in the Set Builder.
Goal: find a legitimate, automated, TOS-compliant way to populate Set + Card Feature/metadata.
Options to evaluate: (a) licensed card-data API / data-partnership (TCDB API access, Sportscardspro,
Cardbase, etc.); (b) richer extraction from our already-authorized BSC/SportLots responses; (c)
community/open datasets; (d) operator-assisted bulk entry (CSV import / paste-a-URL-we-parse-with-
consent); (e) derive what we can locally (e.g. era/vintage from a manually-entered release date).
Acceptance: an automated path that fills the setMetadata + feature fields without scraping a site
against its TOS. Out of scope: re-enabling TCDB scraping.

## CLEAN RETEST RESULTS (post-30min-cooldown, ~23:5x) — FIRM
- **Checklist page** `Checklist.cfm/sid/27845`: status 200, **NO Cloudflare challenge** (loads cold).
  BUT content was an **"Error" page** (`h1="Error"`, 14KB) → `27845` is NOT the real SID (the mock value
  was fictional) OR `/sid/N` needs the full slug. So the metadata-fetch step CAN load pages cold, but
  we don't have a real SID and can't get one without search.
- **Search** `Search.cfm?...&q=2024 Topps Chrome` (homepage-warmed, full AFS params): **STILL 403
  Turnstile after cooldown** → the search block is PERSISTENT for headless, not just my flagged IP.
- **Browse** `/ViewAll.cfm/sp/Baseball`, `/Sets.cfm?sp=Baseball`, `/ViewAll.cfm/sp/Baseball/year/2024`:
  **all 403 Turnstile** (after ~2-3 requests). Homepage links exist (`/ViewAll.cfm/sp/<Sport>`,
  `/Browse.cfm`) but the pages themselves challenge. Homepage has no direct set `sid` links.

## FINAL NAIL (00:1x)
`robots.txt`, `sitemap.xml`, `sitemap_index.xml` ALL return **403 Cloudflare managed-challenge**
(`cType:'managed'`). TCDB has BLANKET Cloudflare protection — there is no bot-accessible entry point
(not even the files explicitly meant for bots). Only an interactive-browser-like homepage load
occasionally passes. This is intentional, aggressive anti-scraping.

## FINAL CONCLUSION
**No reliable headless-scraping path to TCDB remains.** Search + browse + sustained page access are
Cloudflare-Turnstile-gated; only the homepage and occasional cold single requests pass. The adapter's
approach (scrape search → scrape checklist) is dead. This is a **strategic decision**, not a code fix:
  - **Option C** (residential proxy + CAPTCHA/Turnstile solver, e.g. ScraperAPI/Bright Data/2captcha) —
    only robust scraping path. Cost + ToS + new secret. RECOMMENDED IF TCDB enrichment must stay.
  - **Option B'** (search API for the SID, then cold checklist fetch) — partial: a Google Programmable
    Search Engine scoped to tcdb.com + API key gives SIDs without Cloudflare; checklist fetch sometimes
    works cold but is ALSO challenge-prone under volume → still fragile.
  - **Option E** (drop TCDB; rely on BSC/SL set metadata) — removes the fragile dependency. Cleanest.
  - **Option F** (keep feature best-effort + observable; mark #34 accordingly) — pragmatic stopgap.

**I did NOT ship a fix** — there is no viable scraping fix to verify, and provisioning a proxy/API/secret
is your call. Recommend: decide B'/C/E in the AM; meanwhile unblock the test walk (see RECOMMENDATION #3).
No PRs pushed tonight (nothing verifiable to push). Working tree retains the valid test-walk changes
(#34 de-isolation, #32/#34 sign-in guards — 3/4 green).

## TEMP ARTIFACTS — being deleted now (never committed)
- `neonbinder_browser/_tcdb-repro{,2,3,4,5}.mjs`, `_tcdb-retest.mjs`, `_tcdb-search-test.mjs`,
  `_tcdb-browse.mjs` — repro scripts; deleted at end of session.

## ROOT CAUSE — CONFIRMED via live reproduction (Puppeteer vs tcdb.com, ~22:30–23:10)
Repro scripts: `neonbinder_browser/_tcdb-repro*.mjs` (TEMP — delete before commit).

**TCDB overhauled their site. The adapter's scraping approach is dead on TWO axes:**
1. **Search endpoint changed.** Adapter hits `Search.cfm?Type=Sets&Keywords=<q>`. Live: a cold
   request returns **HTTP 200 but REDIRECTS to the homepage** (`https://www.tcdb.com/`) → 0
   `Checklist.cfm/sid/` links → `extractSearchResults` returns [] → `matches.length===0` →
   reason `no-confident-match` → enrichment writes ONLY `lastSyncedAt`. **← what prod hit.**
2. **Native set-search replaced by Google AdSense-for-Search (AFS).** Homepage search form is now
   `GET /Search.cfm` with `q` + `SearchCategory`(sport) + Google AFS params
   `cx=partner-pub-2387250451295121:hes0ib-44xp`, `cof=FORID:10`, `ie=ISO-8859-1`.
   Results render client-side via Google's widget — NOT server-side `sid` anchors.
3. **Cloudflare Turnstile now guards `Search.cfm`.** Even after loading the homepage (passes CF,
   sets `cf_clearance`) and submitting the REAL form (cookie+referer carried), the results page
   `Search.cfm?...&q=...` returns a **Turnstile challenge** ("Just a moment...", `__cf_chl_rt_tk`,
   `challenges.cloudflare.com/.../turnstile/`). Headless Puppeteer cannot solve Turnstile.
4. **Direct checklist page** `Checklist.cfm/sid/27845` ALSO returned 403 Turnstile — BUT my home IP
   is heavily flagged now (~30 automated hits). Homepage still loads 200, so plain page fetches may
   work from a clean/low-volume IP. Untested cleanly (IP flagged; gcloud blocked so no Cloud-Run test).
5. Google AFS standalone (`cse.google.com?cx=partner-pub-...`) returned irrelevant sids (1502/1940),
   not the 2024 set — AFS is an ads product, not a clean JSON results source.

## ASSESSMENT (honest)
Robustly scraping TCDB search from a headless datacenter browser is likely **NOT feasible** with the
current approach: native search is gone (Google AFS only) and `Search.cfm` is Turnstile-gated.
This is a **strategic decision**, not a quick code fix. Shipping a stealth/Turnstile-solver hack would
be fragile, possibly ToS-violating, and UNVERIFIABLE tonight (flagged IP + no Cloud-Run log access).
I will NOT ship a speculative non-working "fix."

## FIX OPTIONS (for user decision — tradeoffs)
- **A. Cache SID + direct checklist fetch, skip search.** If `Checklist.cfm/sid/N` loads from Cloud
  Run (untested — flagged IP blocked me), enrichment can work IF we obtain the SID another way. SID
  lookup is the hard part. Lowest-effort IF page fetch works from prod IP.
- **B. Google Custom Search JSON API** (`customsearch/v1?key&cx&q`) for SID — Google-hosted, no CF.
  BUT needs an API key (free 100/day) AND the AFS `partner-pub-` cx may not be JSON-API-queryable
  (that API wants a Programmable Search Engine cx). Then still need B-step metadata fetch (CF).
- **C. Residential-proxy / CAPTCHA-solving service** (e.g. ScraperAPI, Bright Data, 2captcha) to pass
  Turnstile. Works but $$ + ToS + new dependency/secret.
- **D. puppeteer-stealth + turnstile patch.** Fragile arms race; unreliable from datacenter IPs.
- **E. Alternative metadata source** (drop TCDB; use BSC/SL set metadata only). Feature scope change.
- **F. Accept best-effort + make it observable.** Feature already degrades (writes lastSyncedAt). Make
  the failure reason visible (PostHog/log), and change #34 to assert enrichment WHEN AVAILABLE rather
  than hard-require it. Honest about the external dependency.

## NEXT (overnight, low-request to avoid re-flagging)
1. Long cooldown (~45m) → ONE clean test: does `Checklist.cfm/sid/27845` load from a non-flagged IP?
   (decides whether Option A's metadata-fetch step is viable at all).
2. Write up recommendation. Prep #34 flow fixes (scroll + assertion) — but they CANNOT pass until
   enrichment works, so they stay uncommitted/parked behind the decision.
3. Do NOT ship a scraping hack I can't verify. Leave a clear PR/decision doc for AM review.

## ORIGINAL PLAN (superseded by the above once root cause landed)
1. Reproduce /tcdb/search — DONE (root cause found).
2-6. Fix/validate — BLOCKED on the strategic decision above.
