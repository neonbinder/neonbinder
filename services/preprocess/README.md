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
- **Crop** — a cascade of cheap strategies first, then SAM, whose weights are
  baked into the image at build time so there is no runtime download.
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

## Endpoints

- `GET /health` — liveness probe, returns `{"status":"ok"}`.
- `POST /process` — image preprocessing in three modes (see below).
- `POST /crop` — run one or all crop strategies on an image and return raw
  crops, no orient/classify. Companion to `/process` for human-in-the-loop
  picking when the cascade's automatic choice looks wrong.
- `POST /jobs` — submit a zip of card scans already uploaded to GCS. Returns
  202 immediately; the batch runs in the background.
- `GET /jobs/{job_id}` — poll a batch's progress and result.

Auth: all non-health endpoints require the `x-internal-key` header matching
the `INTERNAL_API_KEY` env var (sourced from Secret Manager in Cloud Run).

### `POST /process` modes

Accepts two optional multipart file fields: `image` (the original photo)
and `precropped` (a client-side crop of the card). At least one is
required. The response shape is the same `ProcessResponse` for all three
modes — the mode only affects which work the server performs.

| Mode | `image` | `precropped` | What runs | When to use |
|---|:-:|:-:|---|---|
| **image-only** | yes | — | Full crop cascade (PIL trim → SAM → Haiku bbox → passthrough) on the original. | Callers with no client-side crop capability. |
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
| 0 | `pil_trim_dark` | PIL blur + threshold + trim, card lighter than background. |
| 1 | `pil_trim_light` | Same, card darker than background. |
| 2 | `sam` | SAM ViT-B semantic segmentation. |
| 3 | `haiku_bbox` | Anthropic Haiku bounding-box crop. |

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
  "detail": "strategy index 4 out of range; valid indices: 0..3",
  "valid": ["pil_trim_dark", "pil_trim_light", "sam", "haiku_bbox"]
}
```

The `valid` array is the authoritative strategy list — agents that want to
know the count up-front can probe with an obviously-out-of-range index
(e.g. `strategy=999`) before iterating, rather than hard-coding 4.

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

### `POST /jobs` — asynchronous zip batches

A 200-card scan session is 400 images. At 2-3s of SAM per image after a 5-15s
cold model load, that is minutes of work — it cannot be a request, and the
result cannot come back as N base64 JPEGs. So the zip goes to GCS, the service
reads it from there, writes its output back there, and the client polls.

**The request carries no object path, and must never be given one.** The
service takes `job_id` + `user_id` and derives every key itself. Both
`neonbinder-convex` and the preprocess runtime SA hold *bucket-wide*
`objectViewer` on the placeholder bucket, so a caller-supplied path would turn
this endpoint into a cross-user read oracle; `jobId` — server-minted, opaque,
and checked against the `placeholderJobs` ownership row by Convex before it
calls us — is what keeps that grant safe. Same rule as the one written into
`apps/web/convex/schema.ts`.

#### Object layout

Everything for one job lives under one prefix in
`$GCS_PLACEHOLDER_BUCKET`:

```
placeholders/{clerkUserId}/{jobId}/
    input.zip                     uploaded by the browser via a signed POST policy
    status/{seq:08d}.json         append-only job-state log
    output/manifest.json          the batch result
    output/images/{n:04d}.jpg     one processed image per input, at its zip ordinal
```

The bucket grants `objectViewer` + `objectCreator` and **no delete**. Every
write carries `if_generation_match=0`, so a write to an occupied key fails with
a 412 rather than silently replacing something. That is deliberate, not a
workaround: it makes write-once a property of each write instead of an accident
of which IAM role happens to be attached.

#### Request / response

```http
POST /jobs
x-internal-key: ...
{"job_id": "3f2504e0-4f89-11d3-9a0c-0305e82c3301", "user_id": "user_2abc..."}
```

```json
HTTP/1.1 202 Accepted
{
  "job_id": "3f2504e0-...",
  "user_id": "user_2abc...",
  "state": "queued",
  "input_uri": "gs://<bucket>/placeholders/user_2abc.../3f2504e0-.../input.zip",
  "output_prefix": "gs://<bucket>/placeholders/user_2abc.../3f2504e0-.../output/"
}
```

| Status | `error_code` | Meaning |
|:-:|---|---|
| 400 | `INVALID_IDENTIFIER` | `job_id` is not a UUID, or `user_id` is not a Clerk subject id. |
| 401 | — | Missing or wrong `x-internal-key`. |
| 404 | `INPUT_NOT_FOUND` | No `input.zip` at the derived path yet. |
| 409 | `JOB_ALREADY_SUBMITTED` | This job id already has a status log. Not retryable — mint a new job. |
| 413 | `INPUT_TOO_LARGE` | The object is over 500 MB, i.e. larger than the upload policy allows. |
| 503 | `JOBS_NOT_CONFIGURED` | `GCS_PLACEHOLDER_BUCKET` unset. Retryable (`Retry-After: 30`). |
| 503 | `INSTANCE_BUSY` | This instance is already running a batch. Retryable (`Retry-After: 30`). |

```http
GET /jobs/{job_id}?user_id=user_2abc...
```

```json
HTTP/1.1 200 OK
{
  "job_id": "3f2504e0-...",
  "user_id": "user_2abc...",
  "state": "running",
  "sequence": 7,
  "created_at": 1755100000000,
  "updated_at": 1755100061234,
  "progress": {"total_images": 400, "processed_images": 35, "failed_images": 1},
  "result": {"manifest_uri": null, "pairs": 0, "unmatched": 0, "resolver_calls": 0},
  "error_code": null,
  "error_detail": null
}
```

`user_id` is a required query parameter because it is half of the object
prefix. The service keeps no job-id-to-owner index on purpose — that index is
the `placeholderJobs` row in Convex, and a second copy here would be a second
place for an ownership check to be wrong.

States: `queued` → `running` → `succeeded` | `failed`. Plus **`stalled`**,
which is never stored — it is what a reader is told when a non-terminal job's
status log has gone quiet for more than five minutes, meaning the instance
running it died. A stalled job cannot be resumed; submit a new one.

404 `JOB_NOT_FOUND` means no status log exists for that pair.

#### The manifest

`result.manifest_uri` points at `output/manifest.json`, read directly from GCS
(Convex has `objectViewer` on the bucket; it is not proxied through this
service). Shape:

```json
{
  "manifest_version": 1,
  "job_id": "...", "user_id": "...",
  "started_at": 1755100000000, "completed_at": 1755100240000,
  "rotation_convention": "ccw",
  "counts": {"images": 6, "processed": 5, "failed": 1,
             "pairs": 2, "unpaired": 1, "resolver_calls": 1},
  "images": [{
    "index": 0, "entry_name": "IMG_4821.JPG",
    "output_key": "placeholders/.../output/images/0000.jpg",
    "content_type": "image/jpeg", "text_count": 2,
    "rotation_degrees": 90, "rotation_applied": true,
    "exif_orientation": 6, "crop_source": "sam"
  }],
  "failures": [{"index": 3, "entry_name": "notes.pdf", "reason": "unsupported_image_type"}],
  "pairs": [{
    "front": {"index": 0, "output_key": "...", "entry_name": "...", "side": "front",
              "player": null, "team": null, "card_number": null,
              "text_count": 2, "identity_resolved": false},
    "back":  {"index": 1, "...": "..."},
    "confidence": "side-only", "mechanism": "adjacency", "score": 0,
    "player": null, "team": null, "card_number": null
  }],
  "unpaired": [{"index": 5, "...": "..."}]
}
```

**Rotation.** Output images are written *already rotated*, which is what
`"rotation_applied": true` means — do not rotate them again.
`rotation_degrees` describes what was done. The service's convention is
counter-clockwise (matching `PIL.Image.rotate`); `sharp.rotate()` in Node is
clockwise, so anywhere a client applies a service-reported rotation itself —
`/process`, not this endpoint — it must negate it:
`sharp(buf).rotate(-rotation_degrees)`.

**EXIF.** Orientation tag 0x0112 is baked into the pixels on extract, before
the cascade, so `rotation_degrees` is always relative to the normalised image.
`exif_orientation` records the tag that was found (1 = nothing to do).

**Partial failure.** One unprocessable image never fails the batch. It lands in
`failures` with a reason and the other 399 complete. A batch where *nothing*
survived is reported as `failed` with `error_code: no_processable_images` — the
manifest is still written so the reason is visible.

#### Zip guards

The archive is treated as attacker-controlled: reaching it needs only an
account. Every header field it declares is used to skip work early and never to
conclude a read was safe — the ceilings are enforced against bytes actually
decompressed.

| Limit | Value | Why |
|---|---|---|
| Input object | 500 MB | Same number as the signed POST policy's `content-length-range`. A bigger object means the policy was bypassed. |
| Entries | 1000 | A 200-card batch is 400 images; 1000 is the largest plausible session, and caps the job at ~50 min of SAM. |
| Central directory | 1 MiB | `ZipFile.__init__` reads exactly the declared directory size into memory, so this is what bounds the parse itself. 1000 entries with max-length names is ~400 KB. |
| Per entry | 32 MB | Identical to `MAX_IMAGE_BYTES` on `/process` — an image the multipart route refuses must not get in through the zip door. |
| Total expansion | 2 GiB | 4x the compressed ceiling. JPEGs deflate to ~1.0x, PNG-heavy zips to ~2x. |
| Compression ratio | 100:1 | Already-compressed image formats sit at 1.0-1.2x; a zeros-bomb is 1000:1+. Only applied above 1 MiB, where ratios stop being noise. |

Zip64 is refused outright: it is only needed past 65534 entries or a 4 GB
directory, both far outside the limits above.

Entry names are rejected for `..` segments, a leading `/`, a drive letter, a
backslash, control characters (NUL included) or a length over 255 bytes — but
that is the second line of defence. Output keys are derived from an entry's
**zip ordinal**, never its name, so a member called `../../etc/passwd` has
nowhere to go regardless. Symlink and encrypted entries are refused too.

Entry types are decided by **magic bytes** (JPEG/PNG/WebP), not by extension
and not by `Content-Type` — a zip entry has no such header, which is why
`/process`'s content-type check is not reused here.

Archive-level violations fail the whole job (`error_code: zip_rejected`, with
the specific reason in `error_detail`). Entry-level ones are recorded per image
and the batch continues.

#### Cost model

Identity extraction is a Haiku call and the dominant marginal cost of a batch.
The cascade therefore runs **without classifying**: it produces the Vision
`text_count` it was going to produce anyway, and `app.pairing.pair_batch` pairs
consecutive images from that alone. Only images the adjacency pre-pass cannot
confidently claim are sent to Haiku, lazily, one at a time.

A cleanly alternating scanner dump costs **zero** identity calls where eager
classification would cost 400. `result.resolver_calls` reports the actual spend
per batch; a unit test asserts it stays a fraction of the image count.

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

`/jobs` additionally needs `GCS_PLACEHOLDER_BUCKET` and application-default
credentials with access to it (`gcloud auth application-default login
--impersonate-service-account=...`). The unit suite never touches GCS — it
drives the real storage wrapper against an in-memory fake — so neither is
needed to run the tests.

`requirements.txt` pins `torch==2.5.1+cpu` against the PyTorch CPU wheel index
(`--extra-index-url`). That build publishes no macOS arm64 wheel, so installing
the full runtime set on Apple Silicon fails on torch. CI installs it on Linux,
where the pin resolves. Locally, either install only what the unit tests need or
run the container.

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

### Prerequisites for `/jobs` (NEO-149) — not yet wired

Both live outside `services/preprocess/`, so neither ships with the code:

1. **`GCS_PLACEHOLDER_BUCKET`** must be set on the Cloud Run service, to the
   `placeholder_uploads_bucket_name` Terraform output (dev:
   `neonbinder-placeholder-uploads-neonbinder-dev`). Same variable name Convex
   uses. Without it `/jobs` answers `503 JOBS_NOT_CONFIGURED`; everything else
   is unaffected.

2. **CPU always on** (`--no-cpu-throttling` / `run.googleapis.com/cpu-throttling:
   "false"`). Cloud Run's default allocates CPU only while a request is being
   handled, and a batch runs *after* the 202 response has gone out. Throttled,
   an instance gets a few percent of a CPU and a three-minute batch becomes an
   hour. Jobs still complete correctly without it — just far too slowly to
   ship. The runtime SA also needs `objectViewer` + `objectCreator` on the
   bucket, which it already has.

Neither is a code change here; both belong to the deploy workflow and
`neonbinder_ioc`.
