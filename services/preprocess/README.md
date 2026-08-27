# preprocess

Python FastAPI image-preprocessing service, deployed to Cloud Run as
`neonbinder-preprocess`. Moves SAM crop, Vision OCR, and Anthropic classify off
local developer machines and onto a shared HTTPS endpoint any client can call.

## Why it exists

The card-intake pipeline originally ran its whole cascade on one developer's
Mac: heavy fallback croppers (SAM ~375MB, Ollama ~7.8GB) plus EasyOCR (~300MB),
which ate memory and intermittently crashed on Apple Silicon. Two things
motivated moving it server-side — the resource cost didn't belong on a laptop,
and the local pipeline wasn't addressable over the network, so nothing else
could reuse it.

The resulting design:

- **One Cloud Run service**, scale-to-zero, 4 CPU / 4Gi / concurrency 3 /
  max-instances 3.
- **Crop** — a scanner-metadata pre-check first (NEO-191), then the benchmarked
  tiered pipeline (classical OpenCV + BiRefNet, NEO-161), then the older
  cascade (PIL trim → SAM → Haiku bbox).
  BiRefNet is NOT a rarely-hit fallback: tiered runs it on virtually every
  image — as the fallback when classical fails its QC gate, and as a
  verification pass when classical succeeds — so size capacity and latency
  expectations around ~5-10s/image of ONNX inference per request. Both model
  weights (BiRefNet via rembg, SAM) are baked into the image at build time so
  there is no runtime download.

  The pre-check is what keeps that cost off the scanner majority. Pixel
  strategies find the card by locating a card/background boundary, which does
  not exist once a scanner has already cropped the background away — and the
  classical detector then locks onto the printed inner panel and shaves the
  card's own border at a clean 2.5:3.5 aspect that no later gate rejects. A
  scanner records its resolution, so resolution × pixel dimensions is a
  physical size, and a frame measuring one 2.5×3.5in card cannot also contain
  a card *plus* background. Measured over a 574-image intake batch: 547 scans
  at 2.450–2.500 × 3.450–3.495in against 27 multi-card bed scans at 8.85 ×
  4.80in, with nothing in between, and 0 false accepts over 338 phone photos
  (all 72dpi, rejected on provenance). See `app/cropper/scan_meta.py`.
- **Orient** — Cloud Vision `DOCUMENT_TEXT_DETECTION` rather than a bundled
  EasyOCR model, keeping ~300MB out of the container.
- **Classify** — Anthropic Claude Haiku, key from Secret Manager, never baked
  into the image.

Clients that can crop locally send an already-cropped image to `/process`;
clients that can't send the raw photo and let the service crop.

> The full design doc — cost modelling, latency budget, and the migration
> history from the original local pipeline — lives in the private config repo.
> It references internal projects and local machine setup, so it is
> deliberately not published here.

## Cold start — the container listens first, then warms

These instances are expensive to hold warm, so the service scales to zero and
**cold start has to be reliable rather than avoided**. The thing that makes it
reliable is that the HEAVY role does NOT load its model before serving.

FastAPI completes every `startup` handler before uvicorn accepts connections,
so anything blocking in there holds the port shut. BiRefNet takes 116-190s to
warm (measured on dev, 2026-08-27) and Cloud Run destroys a revision whose
startup probe has not passed within **240s** — with the torch / transformers /
rembg / onnxruntime imports still to pay first. Warming inline spent ~80% of
that budget before the port opened and lost the race 7 times in prod and 100+
times on dev over 14 days, including one that took down a release
(`HealthCheckContainerError`, NEO-194).

So `_verify_baked_weights` now checks the baked weights synchronously — a
filesystem glob, and a missing-weights boot failure should stay loud — and
starts the warm on a daemon thread. uvicorn listens within seconds, the probe
passes, and the model loads while the container is already healthy.

What that means for callers:

- **`/health`** answers immediately, warm or not. It is a liveness probe, not a
  readiness signal, and it never waited on the model even before this change.
- **`/warmup`** is the readiness signal, and now genuinely does what its name
  says. It blocks until the session is resident (sharing the same
  double-checked lock as the background thread, so the two never double-load)
  and reports `was_cold`. Convex fans it out at session start.
- **A request landing mid-warm** blocks on `_get_session()` — the exact load it
  would have paid anyway. No request is ever served against a half-loaded
  model.
- **A failed warm** is logged and contained. It degrades to a slow first
  request rather than a dead container, because `_get_session()` is lazy.

The FAST role (`PREPROCESS_ROLE=fast`) has no local model and skips all of this;
it has always cold-started in seconds.

## Endpoints

- `GET /health` — liveness probe, returns `{"status":"ok"}`.
- `POST /process` — image preprocessing in three modes (see below).
- `POST /crop` — run one or all crop strategies on an image and return raw
  crops, no orient/classify. Companion to `/process` for human-in-the-loop
  picking when the cascade's automatic choice looks wrong.

Auth: all non-health endpoints require the `x-internal-key` header matching
the `INTERNAL_API_KEY` env var (sourced from Secret Manager in Cloud Run).

Logging: `LOG_LEVEL` (default `INFO`) sets the root logger's level at import.
It has to be set at all because uvicorn configures only its own
non-propagating loggers — before NEO-191 nothing configured root, so every
`logger.info` in `app.*` was silently discarded and production emitted only
the access log. An unrecognised value falls back to `INFO` rather than
raising. `INFO` is what makes the crop cascade's per-image routing decisions
(`scan_meta:`, `fast:`, `tiered:`, `cascade:`) visible in Cloud Logging; drop
to `WARNING` if that volume ever becomes a problem.

### `POST /process` modes

Accepts two optional multipart file fields: `image` (the original photo)
and `precropped` (a client-side crop of the card). At least one is
required. The response shape is the same `ProcessResponse` for all three
modes — the mode only affects which work the server performs.

| Mode | `image` | `precropped` | What runs | When to use |
|---|:-:|:-:|---|---|
| **image-only** | yes | — | Full crop cascade (scan metadata → tiered → PIL trim → SAM → Haiku bbox → passthrough) on the original. | Callers with no client-side crop capability. |
| **image + precropped** | yes | yes | Tries the crop first; if rejected, falls back to the full cascade on the original. | Callers that can guess a crop but want a server-side safety net. |
| **crop-only** | — | yes | Validates the crop; on pass, runs orient + classify on it. On reject, returns 422 so the caller retries with the original. | Bandwidth-constrained callers whose client-side crops are usually good. Skips the 22 MB-per-image upload entirely when the crop passes. |

On success (all modes) you get a `200` with `ProcessResponse`. Crop-only
mode is the only mode that can return a business-logic 422.

#### 422 — crop-only validation failed

```json
HTTP/1.1 422 Unprocessable Entity
{
  "error_code": "CROP_VALIDATION_FAILED",
  "reason": "aspect 0.857 off by 20%",
  "retry_with_original": true
}
```

`reason` is one of (non-exhaustive, mirrors `ValidationResult.reason`):
`too small WxH`, `aspect … off by N%`, `near-uniform (stddev …)`, or the
special `insufficient_text` when Vision finds no text on the crop. Clients
should treat `retry_with_original: true` as the directive and re-issue the
request with the original image attached as `image`.

#### 400 — missing both fields

```json
HTTP/1.1 400 Bad Request
{
  "error_code": "MISSING_IMAGE",
  "detail": "at least one of image or precropped is required"
}
```

### `POST /crop` — pick alternatives by walking strategies

`/crop` runs the crop strategies without the gates `/process` applies — no
orient, no classify, no text-count regression check. It exists so a caller
(human or agent) can survey the alternatives when the cascade's automatic
pick was wrong, then re-POST the chosen bytes back to `/process` as
`precropped`.

Form fields:

| Field | Required | Notes |
|---|:-:|---|
| `image` | yes | The original photo. JPEG/PNG/WebP, ≤ 32 MB. |
| `strategy` | no | Omitted → run every strategy in cascade order. Otherwise: a strategy **name** (e.g. `sam`) or a 0-based **index** as a numeric string (e.g. `2`). |

Strategies, in canonical order (this is `STRATEGY_NAMES` — the same order
`/process` walks):

| Index | Name | What it does |
|:-:|---|---|
| 0 | `tiered` | Benchmarked classical OpenCV + BiRefNet tiered pipeline (NEO-161). Returns the input untouched when it already IS the card (identity guard). |
| 1 | `pil_trim_dark` | PIL blur + threshold + trim, card lighter than background. |
| 2 | `pil_trim_light` | Same, card darker than background. |
| 3 | `sam` | SAM ViT-B semantic segmentation. |
| 4 | `haiku_bbox` | Anthropic Haiku bounding-box crop. |

Response shape — always a list, one entry per strategy that ran (length 1
when `strategy` was supplied, 4 when it was omitted):

```json
{
  "crops": [
    {
      "strategy": "sam",
      "index": 2,
      "image_b64": "/9j/4AAQSk...",   // base64 JPEG, or null
      "error": null                    // exception class name, or null
    }
  ]
}
```

`image_b64` and `error` together describe three outcomes per strategy:

| `image_b64` | `error` | Meaning |
|---|---|---|
| string | `null` | Strategy produced a crop. |
| `null` | `null` | Strategy ran cleanly but couldn't produce a crop (e.g. SAM found no card-shaped mask). |
| `null` | `"SomeError"` | Strategy raised. The class name is the exception type. **The endpoint still returns `200`** — `/crop`'s whole purpose is letting the caller pick from whatever succeeded, even when one strategy is broken. |

#### Walking strategies one at a time by index

Useful when you want to lazily evaluate alternatives — e.g. show the agent
the first crop, let it decide, only spend the SAM/Haiku call if needed.

Loop pattern:

1. Start at `index = 0`.
2. POST `image` plus `strategy=<index>` (as a string, e.g. `"0"`).
3. Inspect `crops[0]`:
   - `image_b64` set → render/save the crop, present it.
   - `image_b64` null + `error` null → strategy declined; advance.
   - `image_b64` null + `error` set → strategy crashed; advance (and log).
4. If the caller accepts the crop, POST those exact bytes to `/process` as
   `precropped` to get the full pipeline (orient + classify).
5. Otherwise, increment `index` and repeat.
6. Stop when the server returns `400 UNKNOWN_STRATEGY` — that's the
   canonical signal that `index` ran past the end of the cascade.

##### Stop signal

```json
HTTP/1.1 400 Bad Request
{
  "error_code": "UNKNOWN_STRATEGY",
  "detail": "strategy index 5 out of range; valid indices: 0..4",
  "valid": ["tiered", "pil_trim_dark", "pil_trim_light", "sam", "haiku_bbox"]
}
```

The `valid` array is the authoritative strategy list — agents that want to
know the count up-front can probe with an obviously-out-of-range index
(e.g. `strategy=999`) before iterating, rather than hard-coding the count.

##### Example — curl

```bash
KEY=dev-key
IMAGE=card.jpg
i=0
while :; do
  body=$(curl -sS -w "\n%{http_code}" -X POST http://localhost:8080/crop \
    -H "x-internal-key: $KEY" \
    -F "image=@$IMAGE" \
    -F "strategy=$i")
  status=$(tail -n1 <<<"$body")
  json=$(sed '$d' <<<"$body")
  if [ "$status" = "400" ]; then
    echo "no more strategies (i=$i)"; break
  fi
  echo "i=$i $(jq -r '.crops[0] | "\(.strategy) image=\(.image_b64 != null) error=\(.error)"' <<<"$json")"
  i=$((i+1))
done
```

##### Example — Python

```python
import base64, requests

URL = "http://localhost:8080/crop"
HEADERS = {"x-internal-key": "dev-key"}


def iter_crops(image_path: str):
    """Yield (index, name, jpeg_bytes_or_None, error_or_None) per strategy."""
    with open(image_path, "rb") as f:
        image_bytes = f.read()
    i = 0
    while True:
        r = requests.post(
            URL,
            headers=HEADERS,
            files={"image": (image_path, image_bytes, "image/jpeg")},
            data={"strategy": str(i)},
        )
        if r.status_code == 400 and r.json().get("error_code") == "UNKNOWN_STRATEGY":
            return
        r.raise_for_status()
        crop = r.json()["crops"][0]
        jpeg = base64.b64decode(crop["image_b64"]) if crop["image_b64"] else None
        yield crop["index"], crop["strategy"], jpeg, crop["error"]
        i += 1
```

Note that each `/crop` call re-uploads the image, so by-index iteration is
chattier than calling `/crop` once with `strategy` omitted and walking the
returned list locally. Use index iteration when each step's decision
depends on inspecting the previous crop; use the all-at-once form when you
just want every alternative.

### Client telemetry (for adopters of crop-only mode)

The server emits per-request structured logs with `mode ∈ {image_only,
image_and_crop, crop_only}` and, on crop-only rejection, the rejection
reason. This is the authoritative signal (no sampling, covers all
callers including the script-frontend CLI which does not run PostHog).

Web/mobile callers adopting crop-only mode should additionally emit the
following events to PostHog so the client-observed upload time (the
dominant cost this optimization attacks) is measurable:

- `preprocess_request_started` — props: `mode`, `original_bytes` (if
  attached), `crop_bytes` (if attached).
- `preprocess_request_completed` — props: `duration_ms` (client
  wall-clock), `http_status`, `cropped_source`.
- `preprocess_crop_rejected` — props: `reason`, `retrying_with_original`.
- `preprocess_retry_completed` — props: `duration_ms`.

Gate the rollout on the PostHog feature flag
`preprocess-crop-only-enabled` so adoption can be ramped or halted
without a code deploy.

## Local dev

Everything here assumes `services/preprocess/` as the working directory.
`pyproject.toml` sets `pythonpath = ["."]` and coverage is measured against
`app`, so running from the repo root will not work.

```bash
cd services/preprocess
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
./run_local.sh                 # or: INTERNAL_API_KEY=dev uvicorn app.main:app --reload --port 8080
pytest tests/unit
ruff check . && ruff format --check .
```

### The four test suites

They differ along two axes — what they run against, and what they assert.

| Suite | Runs against | Asserts | Gate |
|---|---|---|---|
| `tests/unit` | in-process, models stubbed | logic, routing, validators | `preprocess-test`, blocking |
| `tests/functional` | a **deployed** revision | crop / deskew / rotate on real cards | `preprocess-crop-matrix`, blocking |
| `tests/smoke` | a **deployed** revision | response envelope, auth, wiring | `preview-smoke`, advisory |
| `tests/integration` | in-process, real Vision + Anthropic | classify accuracy | manual, `RUN_INTEGRATION_TESTS=1` |

`tests/unit` can never exercise BiRefNet — `tests/unit/conftest.py` blocks
`rembg.new_session` so a stray test cannot pull ~1GB of weights in CI. That is
the whole reason `tests/functional` exists: the crop cascade's behaviour is a
property of the deployed artifact, and the only honest way to assert it is to
send a real card to a real revision. See `tests/functional/test_crop_matrix.py`
for why this does not belong in E2E.

`tests/functional` and `tests/smoke` share the `SMOKE_TARGET_URL` /
`SMOKE_INTERNAL_KEY` / `SMOKE_ID_TOKEN` env contract, and both skip when it is
unset. Neither is in `testpaths`, so a bare `pytest` never picks them up.

### Apple Silicon

`requirements.txt` pins `torch==2.5.1+cpu` against the PyTorch CPU wheel index
(`--extra-index-url`). That build publishes no macOS arm64 wheel, so installing
the full runtime set on Apple Silicon fails on torch, and the whole suite is
unrunnable locally the moment one import chain reaches it.

The `+cpu` **local version** is the only part that is Linux-only — plain
`torch==2.5.1` has a macOS arm64 wheel, and on a Mac it *is* CPU-only anyway.
So the full suite runs locally with a two-token edit:

```bash
sed -e 's|^--extra-index-url.*||' -e 's|^torch==2.5.1+cpu|torch==2.5.1|' \
    requirements-dev.txt > /tmp/requirements-mac.txt
uv venv --python 3.12 .venv && uv pip install -r /tmp/requirements-mac.txt
.venv/bin/python -m pytest tests/unit
```

Python **3.12** is load-bearing: torch 2.5.1 publishes no wheel for 3.13+, so a
default `python3 -m venv` on a current Mac fails to resolve regardless of the
`+cpu` question. `uv venv --python 3.12` fetches the right interpreter itself.

Do not commit the edited file — the `+cpu` pin is what CI and the container
need. This is a local escape hatch, not a second supported dependency set.
First run takes ~8 minutes because the SAM weights download; subsequent runs
are ~1 minute.

## Deploy

Fully wired, in `.github/workflows/preprocess.yml` at the repo root, and
path-filtered on `services/preprocess/**` — a PR that doesn't touch this
directory never triggers a build.

**Per-PR preview.** Each PR builds `:pr-<N>` and deploys it to the dev Cloud Run
service as a *no-traffic* tagged revision. Smoke runs against that tagged URL and
the result lands as a sticky PR comment. Traffic-serving dev is untouched.
`preview-cleanup.yml` removes both the tag and the image when the PR closes.

**Push to main.** Build once, then:

```
build-push → deploy-dev → dev-smoke → dev-promote
                                          ↓
                                     deploy-prod → prod-smoke → prod-promote
```

Both environments use blue/green: the new revision lands at 0% traffic under a
`sha-<short>` tag, smoke exercises that tagged URL, and only then does a single
atomic `update-traffic` shift 100% of traffic *and* drop the scratch tag. Prod
reuses the exact image bytes dev smoked — it never rebuilds.

There is deliberately **no rollback job**. Nothing is promoted until smoke
passes, so a failure leaves the environment already serving its previous
revision; there is nothing to roll back. An earlier version deployed dev at 100%
first and then tried to repair failures with a rollback that picked the
"previous" revision via a query which could select one that wasn't actually
serving. Deploying at 0% removes the failure class instead of patching it.

The deploy lane is gated on the `PREPROCESS_DEPLOY_ENABLED` repo variable; unset
means dormant.
