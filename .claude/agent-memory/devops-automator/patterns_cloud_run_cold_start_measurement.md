---
name: patterns-cloud-run-cold-start-measurement
description: Measuring Cloud Run cold starts for real - startup log timestamps lie (use startup_latencies, no-op latency, idle-gap binning; NEO-481); gen1 vs gen2 and per-phase wall/CPU/majflt, numba and ORT cache traps (NEO-484)
metadata:
  type: reference
---

Measuring cold start on a Cloud Run service (done for the preprocess fast
service, NEO-481):

- **Startup stdout log timestamps are not trustworthy.** "Started server
  process" / "Application startup complete" and even the system "STARTUP TCP
  probe succeeded" line were often timestamped seconds AFTER the instance had
  already answered requests (sometimes ~0.1 s after the first response ended).
  Do not compute cold start as `startup log - request arrival`.
- **Trust these instead:**
  1. Monitoring metric `run.googleapis.com/container/startup_latencies`
     (distribution; query with ALIGN_DELTA + REDUCE_SUM over the window via
     the monitoring REST API and a `gcloud auth print-access-token` bearer).
  2. Latency of a no-op route (e.g. preprocess `/warmup` on the fast role,
     ~5 ms warm) on the first request per `labels.instanceId`: anything over
     ~1 s is pure platform cold-start wait. The request-log `timestamp` is
     request arrival; `httpRequest.latency` includes the cold wait.
  3. **Idle-gap binning:** per revision, gap from the last request end to the
     next request start, binned (0-1, 1-5, 5-10, 10-15, 15-20, 20-30 min...),
     counting how often the next request lands on a new instanceId. The bin
     where it jumps to ~100% is the idle retention (was ~15 min with
     minScale 0).
- "First request on a new instanceId" is bimodal when callers fan out N
  warm-ups: the autoscaler starts extra instances that are ready before their
  first request. Use "first request after the revision was fully idle >= 15
  min" for the true from-zero number.
- `gcloud logging read --limit` silently truncates; check the oldest
  timestamp returned and page older windows with a `timestamp<` filter.
- The preprocess fast role runs the SAME image as the heavy role (torch,
  transformers, baked model weights), so its ~20-25 s cold start is image
  size + imports, not app startup (app startup logs ~10 ms).
Patterns from the NEO-484 cold-start spike (2026-11-10). Verify versions before relying on numbers.

- **An unset execution environment can mean gen1 (gVisor).** The v2 API shows `executionEnvironment: None`; that is not gen2. Check from inside: `/proc/version` reads `4.19.0-gvisor` on gen1. Cloud Run Jobs always run gen2, so a job benchmark does NOT reproduce a service with no environment set. Run a throwaway service with `--execution-environment=gen1|gen2` beside the job.
- **gen1 is slow at file I/O and memory.** Reading a large model baked into the image, Python imports even with a warm page cache, and multi-GB activation allocations all cost noticeably more wall time and CPU than on gen2.
- **Measure in child processes:** `time.perf_counter`, `time.process_time` and `getrusage` majflt/inblock per step. The first process in a fresh container is cold; a second process is warm-page-cache. If wall time is much higher than CPU time, it is lazy image loading. If they are about equal, it is compute.
- **`import rembg` compiles numba.** `rembg.bg` imports pymatting, whose `@njit("sig", cache=True)` decorators compile eagerly at import. That is about 55-90 s of CPU, and rembg's remove() never uses it unless alpha_matting is on. The cache lands in `~/.cache/numba`, which is lost with each container.
- **A numba cache baked on one CPU misses on another.** Build on Intel and run on AMD, and it fully recompiles. Bake and run with `NUMBA_CPU_NAME=generic` and `NUMBA_CACHE_DIR` set to the baked directory, and the cache hits across machines.
- **ORT `optimized_model_filepath`:** a model saved at ENABLE_ALL contains NCHWc layout nodes that are tied to the build CPU. It crashes on another CPU with "ReorderOutput nchwc_block_size". If you save at EXTENDED and load at DISABLE_ALL, the output is no longer bit-identical. Save at EXTENDED and load at ENABLE_ALL: that gave output bit-identical to the original model, also across CPUs.
- **A fixed-shape model's warm-up is a full inference.** Check `get_inputs()[0].shape`. rembg resizes every input to 1024, so a "tiny dummy" warm-up still runs the full pass.
- **Cloud Build in the dev project:** `gcloud builds submit` defaults to the compute SA, which cannot read the staging bucket, and that bucket is auto-created on first use. The legacy cloudbuild SA cannot be named explicitly. To bake artefacts on x86, a job that writes to a temp bucket worked instead.

**gen1 vs gen2 A/B on a small service (fast-role pattern, S0b):**
- Each redeploy (bump a dummy env var) starts a DEPLOYMENT_ROLLOUT instance. Read start → ready from the system log pair "Starting new instance" and "Default STARTUP TCP probe succeeded", grouped by `labels.instanceId`. No need to wait for scale-to-zero.
- **Five samples is too few.** Starts ranged from 16 s to 151 s in both environments, and one outlier per batch moves the median by about 15%. A second batch of five reversed the first batch's verdict. Take at least 10 per side, interleaved in time.
- **In-container timing without a job:** deploy a revision with `--command sh --args '^@^-c@echo "$BENCH_B64" | base64 -d > /tmp/b.py && exec python /tmp/b.py'` and pass the script base64-encoded in an env var set with a custom delimiter (`^@^`). It serves a POST endpoint that times only the stages you want. To restore the image CMD afterwards, pass `--command "" --args ""`.
- When start → ready is almost entirely before uvicorn's "Started server process" and the import's wall time is about 5× its CPU time, the cost is lazy image loading of the shared heavy image, not app code.

**Measuring a PR preview revision end to end (NEO-484 push 1):**
- **Break cold-start stats down by `cpu_model`.** One newer Intel part imported the same modules 4-5x slower than other hosts on identical gen2 config (about 130 s against 20-35 s), so a pooled p50 hides it and the p95 is that class alone.
- **Start-to-first-timing-line only means something if the request arrives at the start.** In an E2E the autoscaler starts instances and the request lands minutes later. Use start to first response of a controlled burst of N concurrent calls (with concurrency 1, N calls start N instances).
- **A Cloud Run job lands one image on several hosts.** Use `--tasks N --parallelism N`, the script as gzip+base64 in an env var, output to a throwaway bucket, and an EXIT trap that cancels executions, deletes the job and removes the bucket.
- **Service-level `container/memory/utilizations` is one distribution series with no per-instance label.** A p99 aligner understates the peak; read the raw points and take the highest non-empty bucket per minute (the count is the number of instances sampled).
- **Minting credentials:** do it inside the measuring script and never echo them; a user identity token works for a tagged `pr-N---` URL.
- **Playwright blob reports** (`report/blob/*.zip` -> `report.jsonl`) carry `onStepBegin`/`onStepEnd` with epoch ms, so each `expect`'s wall time can be read from a CI artifact when `results.json` has only step durations.
- **`/process` writes no timing line**, so `maxrss_mb` is not available from it; only the entry routes log it.
