---
name: patterns-cloud-run-cold-start-measurement
description: How to measure a Python Cloud Run cold start for real (gen1 vs gen2 check, per-phase wall/CPU/majflt) and the traps found in NEO-484 - rembg/pymatting numba compile at import, non-portable numba and ORT caches
metadata:
  type: reference
---

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
