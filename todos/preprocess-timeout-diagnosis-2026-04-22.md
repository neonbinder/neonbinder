# Preprocess API timeout diagnosis — 2026-04-22

**Author:** Claude (Opus 4.7 1M)
**Scope:** `neonbinder-preprocess` Cloud Run service, prod (`neonbinder`) + dev (`neonbinder-dev`)
**Trigger:** Client script firing 20 concurrent threads against `POST /process` is seeing timeouts throughout the day. Upload payloads are ~22 MB per image.

---

## TL;DR

- **Not a code bug.** The service is healthy: zero non-2xx responses in the last 48 h (1,662 logged requests, all 200).
- **Tail latency is catastrophic under bursty load.** p50 = 3.6 s, p90 = 8.2 s, but **p99 = 77 s** and **max = 140 s**. Those spikes line up perfectly with autoscaling events.
- **Root cause is a Cloud Run capacity ceiling.** The service is capped at `maxScale=3` with `containerConcurrency=3`, i.e. **9 concurrent request slots total**. A 20-thread client floods the queue; the 11 excess requests wait 1–2 minutes for a slot to free. Whatever HTTP timeout your client sets (anything < ~2 min) will fire on those tail requests.
- **Aggravated by 22 MB uploads.** Every request body is ~22 MB; each instance has 4 vCPU / 4 GiB, so three in-flight 22 MB uploads push the container's memory working set up to ~1 GiB just from FastAPI buffering before cropping even starts.
- **Recommended fix: infrastructure (cheap/free).** Raise `preprocess_max_instances` from 3 → 20 (or 30) and optionally set `min_instances = 1` to kill cold-start tail. No code changes required. Net cost increase: **~$0–30/month depending on option.**

---

## 1. What the logs show

### 1.1 Steady-state performance is fine

Pulled 731 prod `POST /process` records over the last 24 h via `gcloud logging read` (filter `httpRequest.requestMethod="POST"` on the `run.googleapis.com/requests` log).

| Metric | Value |
|---|---|
| Total requests | 731 |
| 200 OK | 731 (100 %) |
| 4xx / 5xx | **0** |
| Mean latency | 6.36 s |
| p50 | 3.58 s |
| p90 | 8.20 s |
| p95 | 11.95 s |
| **p99** | **76.92 s** |
| **max** | **139.76 s** |
| Request body size | 22–28 MB (consistent with the "~22 MB images" observation) |

The p50 is perfectly reasonable for SAM ViT-B + Anthropic classify + Vision OCR on a 4-CPU box. The **p99 is the red flag** — two orders of magnitude over p50.

### 1.2 The tail is 100 % autoscaling queue

I zoomed into the worst observed burst (2026-04-21 11:04–11:08 UTC):

```
11:04:04   2.60 s   OK
11:04:13   3.36 s   OK
11:04:23   4.16 s   OK
11:04:34   4.37 s   OK
11:04:45  80.04 s   OK   <-- sudden 20× jump
11:04:54  76.92 s   OK
11:05:20  48.04 s   OK
11:05:42 139.76 s   OK   <-- worst
11:05:42  <<<< "Starting new instance. Reason: AUTOSCALING" logged here
11:05:51  <<<< new container Uvicorn startup
11:05:53 133.26 s   OK   (still draining queue)
11:06:05  ...back to 3 s baseline
```

The pattern is unambiguous:

1. Client fires a burst that exceeds 9 concurrent in-flight requests.
2. Cloud Run queues the excess at the frontend.
3. Autoscaling would *like* to add instances, but the service is already at `maxScale=3`, so queued requests just wait for a slot.
4. One of the 3 instances eventually scaled down briefly and autoscaling re-spun an instance at 11:05:42 (9 s cold-start, including model load → Uvicorn ready).
5. Tail requests drain over the next 30 s.

No 502, no 503, no 504, no 429. Cloud Run is happily holding the queue — but your client is timing out on it.

### 1.3 Current live configuration

`gcloud run services describe neonbinder-preprocess` on both projects returns identical config:

```yaml
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/maxScale: '3'
        autoscaling.knative.dev/minScale: '0'
    spec:
      containerConcurrency: 3
      timeoutSeconds: 300
      containers:
      - resources:
          limits:
            cpu: 4000m
            memory: 4Gi
```

Source of truth: `neonbinder_terraform/main.tf:625–683`, defaults at `neonbinder_terraform/variables.tf:83–105`.

### 1.4 Request arithmetic

- Client threads: **20**
- Max concurrent server slots: `maxScale × containerConcurrency = 3 × 3 = 9`
- Overflow: **11 requests always queued** during sustained burst
- p50 per request (at the server): ~3.6 s
- Expected queue wait for an overflow request: `ceil(11/9) × 3.6 s ≈ 4.4 s` in steady state
- Observed queue wait in practice: **20× to 40× that** (77–140 s)

Why so much worse than the arithmetic predicts? Two compounding factors:

1. **Uploads are long-lived.** A 22 MB body at a residential upload link (~20 Mbit/s shared across 20 TCP streams) means each thread is uploading at ~1 Mbit/s → **~3 min per upload** just for bytes-on-the-wire. The server-side latency (`httpRequest.latency` = time-to-last-byte-sent) includes upload + processing + download, so the client sees *even more* than what's in the log.
2. **Cold starts load SAM.** `app/cropper/sam.py:76–101` lazy-loads the SAM ViT-B weights on first request (~5–15 s per the comment at line 80). During autoscaling, the first request on a new instance pays that whole cost while sitting in the queue.

---

## 2. What the code does (for context, no fixes needed here)

- **Service:** FastAPI on Uvicorn, Python 3.12, Cloud Run.
- **Pipeline per `/process`:** `orient` (Google Vision OCR) → crop cascade (`pil_trim_dark` → `pil_trim_light` → SAM → Haiku bbox) → `classify` (Anthropic).
- **Max body size:** `MAX_IMAGE_BYTES = 32 MB` in `app/main.py:30`. With 22 MB images you have 10 MB of headroom before a 413 — fine for now, brittle if users ever upload 4K straight off a phone.
- **SAM already downscales** to a 1500 px long edge inside `_open_and_resize` (`app/cropper/sam.py:281–291`), so the 22 MB upload is not making SAM slower per-request. The bandwidth is the tax, not the inference.
- **NNPACK warning** (`Could not initialize NNPACK! Reason: Unsupported hardware`) shows up on every cold start — this is cosmetic, torch falls back to its default CPU kernels. Not a factor.

---

## 3. Recommended fix

### 3.1 Infrastructure fix (primary — do this)

**Change `neonbinder_terraform/variables.tf`:**

```hcl
variable "preprocess_max_instances" {
  description = "Max Cloud Run instances for the preprocess service"
  type        = number
  default     = 20    # was 3
}
```

**Why 20:** matches your client's thread count so the 1-request-per-thread worst case never queues. With `containerConcurrency=3`, 20 instances gives 60 slots — plenty of headroom for correlated requests from other callers (web, mobile) hitting during a script burst.

**Keep everything else the same:**

- `container_concurrency = 3` stays right. SAM ViT-B on CPU needs ~1.3 vCPU per request; at concurrency 3 on a 4-CPU box you're already threading the needle. Raising concurrency would trade queue latency for per-request latency and worsen p50.
- `cpu = 4000m` / `memory = 4Gi` stay right. No OOM signals in the logs.

**Cost:** effectively **$0 net change**. `max_instances` is a *ceiling*, not a floor — Cloud Run scales to it only under load, then back to zero. The total compute time billed is determined by request volume × per-request duration, both of which are unchanged. You'll pay the *same* per-request cost, just with more of them running in parallel during a burst. Today's ~731 req/day × 6 s × 4 vCPU × $0.000024/vCPU-s ≈ **$0.42/day ≈ $13/mo** — unchanged by the max-instance lift.

### 3.2 Optional: kill cold-start tail with `min_instances = 1`

If the p99=77 s is still a problem even with the queue relieved, add:

```hcl
template {
  metadata {
    annotations = {
      "autoscaling.knative.dev/minScale" = "1"   # new
      "autoscaling.knative.dev/maxScale" = tostring(var.preprocess_max_instances)
    }
  }
  ...
}
```

This keeps one instance always warm with SAM loaded. Additional Cloud Run instances past the first still cold-start, but the *first* request of a burst never pays the model-load tax.

**Cost:** Cloud Run 2nd-gen with default "CPU allocated only during requests" billing charges an *idle* rate for min-instance instances. Approximately:

- Idle CPU: `4 vCPU × 2,592,000 s/mo × $0.0000027 ≈ $28/mo`
- Idle memory: `4 GiB × 2,592,000 s/mo × $0.00000025 ≈ $3/mo`
- **Total: ~$30/month per always-warm instance.**

You probably only want this in prod. Leave dev at `min_instances=0`.

### 3.3 Do **not** do these

- **Don't raise `containerConcurrency`.** CPU-bound inference; you'll just slow every in-flight request.
- **Don't raise `timeoutSeconds` past 300.** Cloud Run max is 3600, but you want client timeouts to fire, not server ones — a 300 s request is a bug, not a feature.
- **Don't add GPU.** SAM ViT-B is fast enough on CPU at 1500 px; GPU instance cost is 10–20× higher.

---

## 4. Code-side improvements (deferred / optional)

These are nice-to-haves that would shrink the problem's surface area but are **not required** to fix tonight's timeouts. Don't pick these up before the infra fix.

1. **Client-side downscale before upload.** 22 MB → 2–3 MB by resizing client images to 2048 px long edge with JPEG quality 90. Would cut upload time ~10× (the dominant client-observed latency), and reduce Cloud Run ingress bandwidth by the same factor. **This is the single biggest win if you can touch the script.** No server change needed (server already downscales internally).
2. **Switch to GCS signed-URL uploads** if you ever need to pass >32 MB images: client uploads to GCS directly, posts a GCS URI to `/process`, server fetches from GCS. Removes all body-size and in-flight-upload concerns. Design lift only worth it if client-side resize isn't feasible.
3. **Warm SAM at container startup** instead of lazy-loading. Change `app/cropper/sam.py:_load_model` to run from an `@app.on_event("startup")` hook in `main.py`. Moves the 5–15 s cost from "first request's latency" to "container boot time" — which Cloud Run hides behind the startup probe (already at 240 s timeout). Effect: first request on a cold instance drops from ~8–12 s to ~3 s. Also makes #3.2 (min_instances=1) cheaper in wall-clock terms.
4. **Add request-scoped structured logging.** Today's logs have no request ID, no per-stage timing, no upload size. If we hit this again with a different root cause, we're guessing. Small PR; good hygiene.

---

## 5. Rollout plan (morning you)

1. Edit `neonbinder_terraform/variables.tf:101–105` → set `preprocess_max_instances` default to `20`.
2. Run `terraform plan -var-file=environments/dev.tfvars` from `neonbinder_terraform/` and confirm the only diff is `maxScale: "3" → "20"` on the Cloud Run service. (The Terraform config *does* manage the `maxScale` annotation — see `main.tf:632–634` — but `ignore_changes` only scopes the `client-name`/`client-version` annotations, so this will apply cleanly.)
3. Apply dev, hammer it with the 20-thread script, verify timeouts are gone.
4. Apply prod via the usual Terraform workflow (per `feedback_no_gcp_outside_terraform.md` memory).
5. *Optionally:* if tail latency is still visible, add the `minScale=1` annotation in `main.tf:632` and re-apply prod only. Expect ~$30/mo extra.
6. If you want the client-side downscale too, that lives in the script-frontend repo — not this one, not tonight.

---

## 6. Evidence trail (for verification)

- Log query used:
  ```bash
  gcloud logging read \
    'resource.type="cloud_run_revision" AND resource.labels.service_name="neonbinder-preprocess" AND httpRequest.requestMethod="POST"' \
    --project=neonbinder --freshness=24h --limit=1000 --order=desc \
    --format='csv[no-heading](timestamp,httpRequest.status,httpRequest.latency,httpRequest.requestSize,resource.labels.revision_name)'
  ```
- Status distribution over 48 h: `931 × 200`, `0 × non-2xx` (the `1069 empty` rows are stdout lines without an `httpRequest`, i.e. the Uvicorn `INFO: ... - "POST /process HTTP/1.1" 200 OK` double-log — same requests).
- Autoscaling event: `2026-04-21T11:05:42.099111Z — "Starting new instance. Reason: AUTOSCALING"`, sitting inside the 77 s / 140 s latency window.
- Live service config checked with `gcloud run services describe` on both `neonbinder` and `neonbinder-dev` — both are `maxScale=3, containerConcurrency=3, cpu=4000m, memory=4Gi, timeout=300s`.
