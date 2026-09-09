---
name: patterns-preprocess-service
description: Security posture of services/preprocess (FastAPI crop/orient/classify on Cloud Run) — auth shape, the decompression-bomb gap, the model-weight bake pattern, and the two test allowlists that silently break whenever a crop strategy is added
metadata:
  type: project
---

`services/preprocess` (monorepo) is a FastAPI Cloud Run service: `/health`,
`/process`, `/crop`. Internal-key auth only — no per-user identity, no
credentials, no PII beyond the uploaded card image. Audit it as an
**availability + supply-chain** surface, not a credential surface.

## Auth + input boundary (verified good, keep it)

- `app/main.py::_verify_internal_key` — `hmac.compare_digest` against
  `INTERNAL_API_KEY`; **503 when the env var is unset** (fail-closed, not
  fail-open). Every route calls it first.
- `_read_upload` gates content-type (`image/jpeg|png|webp`) and a 32MB cap
  (`MAX_IMAGE_BYTES`) before any decode.
- Error hygiene is deliberate and worth preserving: `/process` collapses every
  cascade exception to a fixed `502 "preprocess pipeline upstream failure"`;
  `/crop` returns only the exception **class name**, never its message.

## The standing gap: decoded-pixel bombs

The 32MB byte cap is the ONLY input bound. Nothing sets
`Image.MAX_IMAGE_PIXELS`, so PIL's default allows ~179MP before it errors and
only *warns* above 89.5MP — and `app/cropper/sam.py` calls
`warnings.filterwarnings("ignore")` at import time, which is imported by
`app/cropper/__init__.py`, so **the bomb warning is globally suppressed for the
whole process**. A ~1MB flat-colour JPEG decodes to ~537MB per copy, and each
cropper holds several copies. Cloud Run is 4Gi / concurrency 3.

**Always check on a cropper change:** does the strategy decode at full
resolution, and how many simultaneous full-res arrays does it hold? Ask for an
explicit `Image.MAX_IMAGE_PIXELS` (or a dimension pre-check in `_read_upload`)
rather than accepting "the 32MB cap covers it".

## Strategy outputs are unbounded once a cropper drops its output cap

`detect_orientation` (`app/orient.py`) sends candidate bytes **verbatim** to
Cloud Vision with no downscale — an oversized candidate raises and 502s the
whole request. `classify.py::_prepare_for_anthropic` DOES downscale (5MB
ceiling), so only the Vision leg is exposed. `/crop` base64s *every* strategy's
output into one in-memory response. So any change that removes a cropper's
output-resolution cap multiplies response size and Vision-leg failure risk.

## Model weights: bake-at-build pattern and what it does NOT guarantee

Both SAM (HF, `HF_HOME=/opt/hf-cache`) and BiRefNet (rembg,
`U2NET_HOME=/opt/u2net-cache`) are downloaded in the Dockerfile so "the first
request never touches the network". That claim is **unenforced**:

- rembg resolves weights through `pooch.retrieve`, which re-verifies the cached
  hash on every `new_session` and **re-downloads from github.com on miss or
  mismatch**. Its integrity check is `md5:` against a *mutable* GitHub release
  asset on a third-party repo (`danielgatis/rembg` releases tag `v0.0.0`).
- `MODEL_CHECKSUM_DISABLED` (any value) silently turns that check off.
- The Dockerfile `chown -R appuser` on the cache dirs makes the weights
  writable by the runtime user, so nothing fails closed.
- **Cloud Run's writable filesystem is in-memory** — a runtime re-download of a
  ~930MB model consumes ~930MB of the 4Gi limit *and* makes an unauthenticated
  outbound fetch from the service.

Ask for: root-owned read-only cache dirs, a first-party mirror (GCS/AR) with a
sha256, and a startup assert that the file exists.

`rembg` also ships a `withoutbg` session that POSTs the image to
`api.withoutbg.com`. It needs `WITHOUTBG_API_KEY` so it cannot fire by
accident, but any code that reads a model name from an env var
(`REMBG_MODEL`) should **allowlist** it rather than pass it through.

## Dependency resolution is two-index and unhashed

`requirements.txt` carries `--extra-index-url https://download.pytorch.org/whl/cpu`
(for `torch==2.5.1+cpu`). pip then resolves **every** package name across PyPI
*and* the PyTorch index, highest-version-wins — classic dependency confusion.
Direct pins are exact but there are no hashes and transitive deps are
unpinned, so each `docker build` re-resolves. Any PR adding a dep with a wide
transitive tree (rembg pulls ~20: pooch, requests, scikit-image, scipy, numba,
llvmlite, jsonschema, protobuf, …) materially widens this. Fix is
`--require-hashes` or a direct wheel URL for torch, not index reordering.

## Two hard-coded `cropped_source` allowlists break on every new strategy

`tests/smoke/test_deployed.py` and `tests/integration/test_fixtures_e2e.py`
each assert `body["cropped_source"] in {…}` with a literal set. Neither is
derived from `cropper.STRATEGY_NAMES`, and they are already out of sync with
each other. **Adding a strategy without updating both is a post-deploy smoke
failure.** Flag it every time.

## The `/process` echo contract

`cropped_image_b64` is populated only when `CropResult.returned_bytes_differ`
is True. `app/main.py`'s `ProcessResponse` docstring claims that field is null
**only** for `cropped_source == "precropped"`. Any strategy that can return its
input untouched (an "identity"/passthrough guard) breaks that documented
contract while being perfectly safe byte-wise — the echoed bytes are always the
same caller's upload from the same request, and nothing caches pixels across
requests (module globals hold models, not images). Treat it as a docs/contract
finding, not a data-leak one.

## Deploy/auth topology (terraform-managed) + the allUsers discrepancy

Preprocess IS terraform-managed: `google_cloud_run_service.neonbinder_preprocess`
(terraform/main.tf:1351) with its own `neonbinder-preprocess-runtime`
+ `-deployer` SAs, `anthropic-api-key` secret (runtime accessor at :1344; value
populated out-of-band, never in tf state), shared `internal-api-key` secret, and
placeholder_uploads objectViewer(:781)+objectCreator(:788) — NOT objectAdmin, so
write-once/no-delete. Both INTERNAL_API_KEY + ANTHROPIC_API_KEY are `--set-secrets`
env at runtime; Dockerfile bakes NO secrets (public-repo clean). GCS keys are
server-derived from {user_id,job_id,index}; objectViewer is bucket-WIDE (no
per-user GCS isolation — Convex owns ownership).

**KEY DISCREPANCY (HIGH):** unlike the BROWSER service (NEO-20 removed allUsers,
now IAM-only + `convex_invoker` SA), the preprocess service STILL declares
`allUsers` run.invoker unconditionally (`preprocess_public_access` main.tf:1442,
no env/count guard) and has NO convex-SA invoker. Its comment ("matching the
browser service's pattern") is STALE — browser no longer uses that pattern. So
today the heavy service is internet-reachable, protected only by the shared
static internal key. The Convex adapter DOES mint an OIDC token (belt) but it's
not enforced while allUsers stands. "allUsers removed on prod" claims in designs
are the TARGET of the phased flip, not the committed tf state — verify before
trusting.

## Dockerfile supply-chain: prior gaps partially closed (2026-08 / NEO-170 worktree)

`REQUIRE_BAKED_WEIGHTS=1` + a startup hook (main.py:99) now fail LOUD if weights
are missing; model caches are root-owned read-only (`chmod a+rX-w /opt/*-cache`);
REMBG_MODEL is allowlisted (`ALLOWED_REMBG_MODELS`, tiered.py). rembg's
mutable-md5-from-github + `--extra-index-url` dep-confusion gaps still stand.

## The "lean fast service" is NOT credential-free (NEO-170 split)

The classical fast path's ACCEPT branch still calls `detect_orientation` (Cloud
Vision) AND `classify_card` (Anthropic) via the `_try_stage` gates — "model-free"
means no local ONNX, NOT no external APIs. A lean/no-weights fast service still
needs the anthropic-api-key accessor + Vision (ADC) exactly like heavy; only the
BiRefNet/SAM bake + warm_up drop out. `check_raster_size` (pixel-bomb cap) lives
IN /process-entry (main.py:921) and must be retained in any fast equivalent —
higher concurrency multiplies simultaneous full-res decodes.

## OIDC audience is NOT normalized for preprocess

`credentials.ts` wraps browser's audience in `oidcAudienceFor()` (a base-host
allowlist regex that is BOTH a preview-tagged-host fix AND a security control vs
attacker-named-audience coercion). `adapters/preprocess.ts:195` passes
`preprocessUrl()` RAW. Harmless while allUsers is on; once IAM is enforced,
preview tagged hosts (`pr-N---...`) mint a token Cloud Run rejects → 403. Any
new preprocess service (fast) needs a preprocess base-host normalizer or a
guarantee its URL env is always the base URL. Classical crop path is stateless
(all per-call BytesIO; only module globals are the model sessions) → higher
concurrency is data-leak-safe, availability-only.

Related: [[feedback-reviewing-a-live-worktree]], [[patterns-neo170-workpool-pipeline]]
