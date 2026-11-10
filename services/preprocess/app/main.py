"""FastAPI entrypoint for the neonbinder-preprocess service.

Slice 1: `/health` + `/process` with orient→rotate→classify pipeline.
Slice 2a: optional `precropped` multipart field, crop cascade.
Slice 2b: SAM added to the cascade; text-count + classify-error gates
          applied uniformly across every crop strategy via the wrapper
          in `app.cropper`. Main.py is now a thin layer: auth + upload
          validation → cropper.crop() → response packaging.
NEO-170:  `/extract` + `/process-entry` — stateless batch routes behind the
          Convex workpool. Convex owns ALL orchestration and job state; these
          routes read and write GCS at keys derived from `{user_id, job_id,
          index}` (`app.jobs.layout`) and return metadata only. Same thin-layer
          rule: this file does auth, request shape and error-code mapping.
NEO-427:  `/process-entry` also stores the listing and thumbnail sizes of the
          output it writes, for Convex to read when the card is saved.
          `/derive-copy-photos` makes them on request for an entry without them.
NEO-484:  `/process-entry` answers a terminal 422 `ENTRY_UNDECODABLE` for bytes
          that are not an image, binds the dev cache policy for its request
          (`app.devcache`), and the heavy startup hook loads the BiRefNet ORT
          session directly (`app.cropper.birefnet`) with no warm-up inference.
"""

# The import time of this module is part of the `cold_start` line, so the clock
# starts before any other import; every import below therefore sits after a
# statement, which is what E402 would otherwise refuse.
# ruff: noqa: E402
from __future__ import annotations

import time

_MODULE_IMPORT_STARTED = time.perf_counter()

import base64
import hmac
import json
import logging
import os
import platform
import re
import sys
from collections.abc import Mapping
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from typing import Annotated, Any, Literal

from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile, status
from fastapi.responses import JSONResponse
from PIL import UnidentifiedImageError
from pydantic import BaseModel, Field, ValidationError

from app import cropper
from app.classify import ClassifyError
from app.copy_photos import CopyPhotoTooLargeError, derive_copy_photos
from app.cropper import (
    CROP_QUALITIES,
    CROP_QUALITY_FAST,
    STRATEGY_NAMES,
    CropDeclined,
    CropRejected,
    UnknownStrategyError,
    birefnet,
)
from app.cropper._utils import rotate_image_bytes
from app.devcache import policy as devcache_policy
from app.dhash import compute_dhash
from app.exif import apply_exif_orientation
from app.imaging import RasterTooLargeError, check_raster_size
from app.jobs import layout, zipsafe
from app.jobs.gcs import ObjectAlreadyExistsError, ObjectRef, ObjectStore
from app.jobs.layout import InvalidJobIdentifierError
from app.orient import OrientationResult
from app.timing import Timings, timing_logger

# ── Logging (NEO-191) ───────────────────────────────────────────────────────
# Nothing in this service used to configure logging, and uvicorn only ever
# configures its OWN loggers ("uvicorn", "uvicorn.error", "uvicorn.access", all
# with propagate=False). Every `logging.getLogger(__name__)` in `app.*`
# therefore propagated to a bare root logger sitting at the default WARNING and
# was dropped: for the whole week before this was found, production had zero
# `cascade:` / `tiered:` / `process:` lines and only uvicorn's access log. A
# crop pipeline whose every routing decision is invisible cannot be diagnosed
# from logs at all — the 2026-08-27 border-shaving investigation had to be
# reconstructed on a laptop.
LOG_LEVEL_ENV = "LOG_LEVEL"
DEFAULT_LOG_LEVEL = "INFO"


def _configure_logging() -> None:
    """Attach a stdout handler to the root logger so `app.*` INFO is visible.

    Cloud Run captures stdout, so this is all it takes for the crop cascade's
    decisions to reach Cloud Logging. Touching only the root logger leaves
    uvicorn's non-propagating loggers alone, so access lines are not doubled.

    Deliberately NOT `force=True`. basicConfig is a no-op when the root logger
    already has handlers, which is the right deference to an embedder that
    configured logging itself (a `--log-config`, or pytest's capture plugin —
    forcing there would tear out the handlers a test is asserting against). The
    level is then set explicitly, since that part must apply either way.

    An unparseable `LOG_LEVEL` falls back to INFO rather than raising — a typo
    in an env var must not take the container down on import.
    """
    requested = os.environ.get(LOG_LEVEL_ENV, DEFAULT_LOG_LEVEL).strip().upper()
    level = logging.getLevelNamesMapping().get(requested, logging.INFO)
    logging.basicConfig(
        level=level,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )
    logging.getLogger().setLevel(level)


_configure_logging()

logger = logging.getLogger(__name__)

app = FastAPI(title="neonbinder-preprocess", version="0.3.0")

INTERNAL_API_KEY_ENV = "INTERNAL_API_KEY"
MAX_IMAGE_BYTES = 32 * 1024 * 1024
ALLOWED_CONTENT_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})

# ── Service role (NEO-175) ──────────────────────────────────────────────────
# The SAME image runs as two Cloud Run services selected by PREPROCESS_ROLE:
#
#   HEAVY (default) — current behaviour, unchanged: loads BiRefNet + SAM at
#       startup and runs the full crop cascade (classical → BiRefNet → SAM →
#       Haiku → passthrough).
#   FAST — classical-only. NEVER loads or calls a local model: it skips the
#       startup model warm-up (cold-starts in seconds) and runs only the
#       classical fast path on /process-entry, returning `needs_escalation`
#       (see ProcessEntryResponse) whenever that path does not settle the card
#       so Convex re-enqueues the entry to the HEAVY service.
#
# The default is HEAVY so an unset var preserves today's single-service
# behaviour; terraform sets PREPROCESS_ROLE=fast on the fast service only. The
# value is read per request/hook (not cached at import) so a redeploy — and the
# tests — can flip it without reimporting.
PREPROCESS_ROLE_ENV = "PREPROCESS_ROLE"
ROLE_FAST = "fast"
ROLE_HEAVY = "heavy"


def _preprocess_role() -> str:
    """Return the configured service role: ROLE_FAST or ROLE_HEAVY.

    Anything other than an explicit, case-insensitive ``"fast"`` resolves to
    HEAVY — an unset or misspelled var must never silently downgrade a service
    that is supposed to run the full cascade into skipping the model.
    """
    configured = os.environ.get(PREPROCESS_ROLE_ENV, "").strip().lower()
    return ROLE_FAST if configured == ROLE_FAST else ROLE_HEAVY


# Concurrency for the GCS uploads inside /extract. The zip itself is read and
# EXIF-normalised sequentially (one seekable stream, CPU-bound transposes), but
# each derived object's upload is an independent round trip — overlapping them
# keeps a large archive well inside Cloud Run's 300s request cap. 8 is small
# enough that a 4Gi / concurrency-3 instance never holds more than a few
# entries' bytes in flight per request.
EXTRACT_UPLOAD_WORKERS = 8

# Byte budget for the upload futures /extract may hold in flight at once.
#
# The executor's work queue is unbounded and every submitted-but-incomplete
# future retains its entry's decompressed bytes, so without a bound a producer
# that outruns GCS (a crafted low-compression archive, or an ordinary one on a
# slow storage day) re-materializes up to MAX_TOTAL_UNCOMPRESSED_BYTES (2 GiB)
# of image data in RAM for one request, on an instance that may be serving
# others — exactly the OOM class the streaming zip read exists to prevent. The
# bound has to be a BYTE budget, not
# a future count: entry sizes span three orders of magnitude (a tens-of-KB
# thumbnail up to the 32 MiB per-entry cap), so any count small enough to be
# safe for the largest entries would needlessly serialize the small ones.
# When the budget (or the companion count cap below) is hit, the producer
# blocks on FIRST_COMPLETED until a pending upload finishes.
EXTRACT_PENDING_BYTES_BUDGET = 256 * 1024 * 1024

# Companion count cap: keeps a run of tiny entries from queueing hundreds of
# futures while staying comfortably under the byte budget.
EXTRACT_PENDING_MAX_FUTURES = 32

# Retry-After sent with the batch routes' NOT_CONFIGURED 503. A missing bucket
# env var is a deploy in progress, not a permanent condition — mirror the
# NEO-149 branch's treatment of missing job config.
NOT_CONFIGURED_RETRY_AFTER_SECONDS = 30

# Extensions /process-entry probes for an extracted object, most common first.
# Exactly the set /extract can write — the values of
# `zipsafe.EXTENSION_BY_CONTENT_TYPE`. /derive-copy-photos probes an output
# object the same way, because /process-entry names it from the same map.
_EXTRACTED_EXTENSIONS = ("jpg", "png", "webp")

# Storage client for the batch routes. Construction is credential-free (the
# real google client is built lazily on first use — see app.jobs.gcs), so this
# is safe at import; tests monkeypatch this attribute with a fake-backed store.
_object_store = ObjectStore()


# ── Cold start (NEO-484) ────────────────────────────────────────────────────
# One `cold_start` JSON line per process, from the startup hook, through the
# same bare-JSON `timing` logger as `process_entry_timing`, so a cold start can
# be split into its phases from the logs alone (`scripts/cold-start-report.py`
# joins it with Cloud Run's start and probe events). Host facts use the same
# definitions as `scripts/golden_masks.py`'s fingerprint, so a slow start and a
# mask difference can be put down to the same machine.
COLD_START_MSG = "cold_start"

# CPU features that pick different onnxruntime (MLAS) kernels, in a fixed order
# so the ISA string is stable. Mirrors `scripts/golden_masks.RELEVANT_CPU_FLAGS`.
_ISA_FLAGS = (
    "sse4_1",
    "avx",
    "f16c",
    "fma",
    "avx2",
    "avx_vnni",
    "avx512f",
    "avx512bw",
    "avx512dq",
    "avx512vl",
    "avx512_vnni",
    "avx512_bf16",
    "avx512_fp16",
    "amx_tile",
    "amx_bf16",
)

# gVisor (Cloud Run gen1) reports an old fixed kernel; some builds also name it.
_GVISOR_KERNEL = re.compile(r"Linux version 4\.4\.0\b|gvisor", re.IGNORECASE)


def _read_text(path: str) -> str:
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""


def _exec_env(proc_version: str, environ: Mapping[str, str]) -> str:
    """`gen1` (gVisor), `gen2` (any other Cloud Run), or `local`."""
    if _GVISOR_KERNEL.search(proc_version or ""):
        return "gen1"
    if environ.get("K_SERVICE") or environ.get("CLOUD_RUN_JOB"):
        return "gen2"
    return "local"


def _cpu_facts(cpuinfo: str, machine: str) -> tuple[str, str]:
    """`(isa, cpu_model)` from /proc/cpuinfo text: the first processor's values."""
    cpu_model = "unknown"
    flags: set[str] = set()
    for line in cpuinfo.splitlines():
        key, sep, value = line.partition(":")
        if not sep:
            continue
        key = key.strip()
        if key == "model name" and cpu_model == "unknown":
            cpu_model = " ".join(value.split())
        elif key in ("flags", "Features") and not flags:
            flags = set(value.split())
    isa = "+".join([machine, *[flag for flag in _ISA_FLAGS if flag in flags]])
    return isa, cpu_model


def _nproc() -> int:
    try:
        return len(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        return os.cpu_count() or 0


def _process_age_s() -> float | None:
    """Seconds since this process started, from /proc; None where there is no /proc.

    Covers what `main_module_import_s` cannot: the interpreter's own start and
    uvicorn's import, before this module's clock began.
    """
    try:
        stat = _read_text("/proc/self/stat")
        uptime = _read_text("/proc/uptime")
        if not stat or not uptime:
            return None
        # Field 22 (starttime, clock ticks since boot). Fields counted after the
        # command name, which is parenthesised and may contain spaces.
        after_comm = stat.rsplit(")", 1)[1].split()
        start_ticks = int(after_comm[19])
        age = float(uptime.split()[0]) - start_ticks / os.sysconf("SC_CLK_TCK")
        return round(age, 3) if age >= 0 else None
    except (IndexError, ValueError, OSError):
        return None


def _host_facts() -> dict[str, Any]:
    machine = platform.machine() or "unknown"
    isa, cpu_model = _cpu_facts(_read_text("/proc/cpuinfo"), machine)
    if cpu_model == "unknown":
        cpu_model = platform.processor() or "unknown"
    return {
        "exec_env": _exec_env(_read_text("/proc/version"), os.environ),
        "isa": isa,
        "cpu_model": cpu_model,
        "nproc": _nproc(),
    }


def _emit_cold_start(*, role: str, session_load_s: float | None, hook_started: float) -> None:
    """Write the one `cold_start` line. Never raises: it must not fail a boot."""
    try:
        body: dict[str, Any] = {"msg": COLD_START_MSG, "role": role}
        body.update(_host_facts())
        body["main_module_import_s"] = round(_MAIN_MODULE_IMPORT_S, 3)
        body["session_load_s"] = session_load_s
        body["startup_hook_s"] = round(time.perf_counter() - hook_started, 3)
        body["process_age_at_ready_s"] = _process_age_s()
        # C6 (deferred SDK imports) fills this in; null until it lands.
        body["prewarm"] = None
        timing_logger.info(json.dumps(body, separators=(",", ":")))
    except Exception:  # noqa: BLE001 - a log line must never take the container down
        logger.exception("startup: could not write the cold_start line")


@app.on_event("startup")
def _verify_baked_weights() -> None:
    """Load the BiRefNet session at boot (heavy role), then log one `cold_start` line.

    Only the HEAVY role loads a model, and only when REQUIRE_BAKED_WEIGHTS=1
    (set in the Dockerfile; unit tests don't set it). It first checks that the
    baked model exists at `$BIREFNET_HOME/$BIREFNET_MODEL.onnx` and raises if
    not: a missing model is a broken image, and failing the boot is louder and
    cheaper than failing every request.

    It then creates the onnxruntime session (`birefnet.load_session`) while
    Cloud Run still allocates full startup CPU and no request is waiting. No
    warm-up inference runs (NEO-484): the model's input is fixed at 1024x1024,
    so a dummy pass costs a full inference, and the first real run is only a
    few seconds slower than later ones. The session load is what is kept, so
    the instance is ready the moment the startup probe passes (NEO-194).

    The FAST role (`PREPROCESS_ROLE=fast`, NEO-175) runs classical-only and
    never constructs a model session, so it skips both the check and the load,
    even with REQUIRE_BAKED_WEIGHTS still set on the shared image.

    SAM is deliberately NOT loaded here (NEO-315). Measured on a HEAVY
    revision, loading it at startup took 46-94s (p50 56s) even at 8 vCPU and
    sat on every cold start's critical path, while SAM wins under 1% of cards.
    It lazy-loads on first use instead (`sam._load_model`, behind a lock).

    Every role and path writes the `cold_start` line, except a boot that fails
    the weights check.
    """
    hook_started = time.perf_counter()
    role = _preprocess_role()
    session_load_s: float | None = None
    if role != ROLE_HEAVY:
        logger.info(
            "startup: %s=%s — skipping baked-weight check and model load",
            PREPROCESS_ROLE_ENV,
            role,
        )
    elif os.environ.get("REQUIRE_BAKED_WEIGHTS") == "1":
        model_path = birefnet.model_path()
        if not os.path.isfile(model_path):
            raise RuntimeError(
                f"REQUIRE_BAKED_WEIGHTS=1 but no baked model at {model_path!r} "
                f"({birefnet.HOME_ENV}={os.environ.get(birefnet.HOME_ENV)!r}, "
                f"{birefnet.MODEL_ENV}={os.environ.get(birefnet.MODEL_ENV)!r})"
            )
        loaded = birefnet.load_session()
        session_load_s = loaded["session_load_s"]
        logger.info(
            "BiRefNet session %s loaded in %.1fs (onnxruntime %s)",
            loaded["model"],
            session_load_s,
            loaded["ort"],
        )
    _emit_cold_start(role=role, session_load_s=session_load_s, hook_started=hook_started)


class CropStrategyOutput(BaseModel):
    """One strategy's output in a /crop response.

    `image_b64` is null when the strategy returned None (ran cleanly but
    couldn't produce a crop) OR when it raised. The two cases are
    distinguished by `error`: null means "ran cleanly, no crop"; a string
    is the exception class name. Crashes do NOT 5xx the endpoint — the
    whole point of /crop is letting the human pick from whatever
    succeeded, even when one strategy is broken.
    """

    strategy: str
    index: int
    image_b64: str | None
    error: str | None


class CropResponse(BaseModel):
    """Response body for POST /crop.

    `crops` is a list with one entry per strategy that was run:
      - one entry when `strategy` was supplied
      - len(STRATEGY_NAMES) entries when it was omitted
    Order matches `cropper.STRATEGY_NAMES` (the canonical cascade order).
    """

    crops: list[CropStrategyOutput]


class ProcessResponse(BaseModel):
    """Response body for POST /process.

    `players` is the canonical list of every player visible on the card
    (one entry for single-player cards, many for leaders/combo/dual-
    rookie/team set cards, empty when unidentifiable). `player` is a
    back-compat convenience: first entry or null.

    `rotation_degrees` is the CCW rotation that was applied to the chosen
    crop before classification; clients that store the corrected image
    should apply the same rotation to keep their copy aligned with what
    the model actually saw.

    `cropped_source` tells the client which stage of the crop cascade
    won. `cropped_image_b64` is null whenever the winning bytes are ones
    the client already has: the `"precropped"` win, `"passthrough"`, and
    `"tiered"`'s identity result (the upload already IS the card, returned
    untouched). For any source where the server produced new bytes, they
    come back base64-encoded in `cropped_image_b64` — so key off the null
    check, not off which source won.
    """

    players: list[str]
    player: str | None
    team: str | None
    card_number: str | None
    side: str | None
    rotation_degrees: int
    orient_confidence: float
    text_count: int
    cropped_source: str
    cropped_image_b64: str | None


def _verify_internal_key(x_internal_key: str | None) -> None:
    expected = os.environ.get(INTERNAL_API_KEY_ENV)
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="internal api key not configured",
        )
    if not x_internal_key or not hmac.compare_digest(x_internal_key, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid internal key",
        )


def _validate_content_type(content_type: str | None, *, field: str) -> None:
    if (content_type or "").split(";")[0].strip() not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"unsupported content-type for {field}: {content_type}",
        )


async def _read_upload(upload: UploadFile, *, field: str) -> bytes:
    _validate_content_type(upload.content_type, field=field)
    data = await upload.read()
    if not data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"empty {field}",
        )
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"{field} exceeds max size of {MAX_IMAGE_BYTES} bytes",
        )
    # Pixels, not bytes: the byte cap alone doesn't bound memory — a ~1MB
    # flat-colour JPEG can decode to >500MB. `check_raster_size` reads the
    # lazy header (no pixel decode) and raises ONE exception type for
    # everything over the ceiling — including headers Pillow refuses to even
    # size (its DecompressionBombError is re-raised as RasterTooLargeError
    # inside app.imaging), so a bomb can never fall through to the cascade
    # and surface as a 502. Unreadable bytes pass through — the pipeline's
    # existing error paths own that case.
    try:
        check_raster_size(data)
    except RasterTooLargeError as exc:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"{field}: {exc}",
        ) from None
    return data


def _resolve_cache_policy(host: str | None) -> devcache_policy.CachePolicy:
    """The dev cache policy for a request's Host. Never raises: a failure is off.

    `devcache_policy.resolve` already turns its own errors into `off:error`;
    this guard keeps a bug there from failing the request that asked.
    """
    try:
        return devcache_policy.resolve(host)
    except Exception:  # noqa: BLE001 - a cache decision must never fail a request
        logger.warning("devcache: policy resolution raised, cache off", exc_info=True)
        return devcache_policy.CachePolicy(enabled=False, mode="off:error", bucket=None)


@app.get("/health")
def health(http_request: Request) -> dict[str, str]:
    """Liveness, plus the dev cache mode this Host would get (NEO-484).

    `dev_cache` is `on` only on the dev base URL with the cache bucket
    configured; previews, the `sha-*` blue/green URLs and prod all read
    `off:<reason>`. CI checks it after every deploy. It names a mode only,
    never the bucket.
    """
    policy = _resolve_cache_policy(http_request.headers.get("host"))
    return {"status": "ok", "dev_cache": policy.mode}


class WarmupResponse(BaseModel):
    """Response body for POST /warmup.

    `status` is always "warm" on success — the model is resident when the
    response is sent. `was_cold` distinguishes the two ways that came to be:
    True when THIS call triggered the model load (the instance was genuinely
    cold), False when the session was already resident and the call was the
    idempotent fast path. Callers show a "warming up…" message only on
    was_cold=True; a pre-warmed instance stays silent.
    """

    status: str
    was_cold: bool


@app.post("/warmup", response_model=WarmupResponse)
def warmup(
    x_internal_key: Annotated[str | None, Header()] = None,
) -> WarmupResponse:
    """Make the BiRefNet session resident on this instance, then report warm.

    A heavy instance loads the session in its startup hook, so by the time it
    serves a request this is normally the idempotent fast path. Convex still
    calls it at session start: Cloud Run holds the request while a cold
    instance starts, so a 200 tells the caller an instance is up and ready.

    Synchronous "load then return": the load is `birefnet.load_session`, the
    same session a real crop uses. It runs NO inference (NEO-484: the model's
    input is fixed at 1024x1024, so a warm-up pass would cost a full one), needs
    no GCS object or real image, does no GCS / Vision / Anthropic I/O, and
    writes nothing.

    Idempotent and cheap when already warm: `birefnet.is_session_loaded()`
    short-circuits, and the response reports `was_cold=False`. `was_cold=True`
    means THIS call created the session.

    Concurrency: the service runs container_concurrency=1, so one /warmup warms
    the ONE instance that happens to handle it. Warming all N instances of a
    scaled-out revision needs N concurrent /warmup calls (Convex fans out N =
    capacity); this endpoint only ever warms its own instance.

    NEO-175: the FAST role has no local model to make resident, so it must not
    reach the loader at all (the whole point of the role is that it never
    constructs a model session). It short-circuits to `was_cold=False`.
    """
    _verify_internal_key(x_internal_key)

    if _preprocess_role() != ROLE_HEAVY:
        logger.info(
            "warmup: %s=%s — no model to warm, reporting ready", PREPROCESS_ROLE_ENV, ROLE_FAST
        )
        return WarmupResponse(status="warm", was_cold=False)

    was_cold = not birefnet.is_session_loaded()
    if was_cold:
        birefnet.load_session()
    return WarmupResponse(status="warm", was_cold=was_cold)


@app.post("/process", response_model=ProcessResponse)
async def process(
    image: Annotated[UploadFile | None, File()] = None,
    precropped: Annotated[UploadFile | None, File()] = None,
    crop_quality: Annotated[str, Form()] = CROP_QUALITY_FAST,
    x_internal_key: Annotated[str | None, Header()] = None,
) -> ProcessResponse | JSONResponse:
    """Preprocess an image for card identification.

    Three request modes:
      - **image-only** (unchanged default): `image` attached, no `precropped`.
        Runs the full crop cascade on the original.
      - **image + precropped** (unchanged opt-in): both attached. The
        precropped is tried as the cascade's stage-1 candidate; if it's
        rejected, the server falls back to its own crop strategies on the
        original. Saves SAM/Haiku cost when the client crop is good; costs
        full upload bandwidth regardless.
      - **crop-only** (new): only `precropped` attached. Server validates the
        crop and runs orient+classify on it if it passes. If validation
        fails, returns `422 {"error_code":"CROP_VALIDATION_FAILED", ...,
        "retry_with_original": true}` so the caller can retry with the
        original. No silent server-side fallback — saving upload bandwidth
        is the whole point.

    `crop_quality` (form field, NEO-173) tunes the image cascade: `"fast"`
    (default) runs a classical-only identity short-circuit that skips the
    ~35s BiRefNet pass on the pre-cropped-scanner majority, escalating every
    other image to the full pipeline; `"strong"` forces the tiered/BiRefNet
    cascade. It has no effect in crop-only mode.
    """
    _verify_internal_key(x_internal_key)

    if crop_quality not in CROP_QUALITIES:
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={
                "error_code": "INVALID_CROP_QUALITY",
                "detail": f"crop_quality must be one of {sorted(CROP_QUALITIES)}",
            },
        )

    image_bytes: bytes | None = None
    precropped_bytes: bytes | None = None
    if image is not None:
        image_bytes = await _read_upload(image, field="image")
    if precropped is not None:
        precropped_bytes = await _read_upload(precropped, field="precropped")

    if image_bytes is None and precropped_bytes is None:
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={
                "error_code": "MISSING_IMAGE",
                "detail": "at least one of image or precropped is required",
            },
        )

    mode = _request_mode(image_bytes, precropped_bytes)
    logger.info("process: mode=%s", mode)

    # The cascade handles orient + rotate + classify internally so every
    # crop strategy is evaluated through the same quality gates. Upstream
    # failures (Vision / Anthropic) surface as exceptions we translate to
    # 502 here.
    try:
        result = cropper.crop(
            image_bytes=image_bytes,
            precropped_bytes=precropped_bytes,
            crop_quality=crop_quality,
        )
    except ClassifyError:
        logger.exception("classify failed to parse after retry")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="classify response unparseable",
        ) from None
    except Exception:
        logger.exception("cascade failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="preprocess pipeline upstream failure",
        ) from None

    # Crop-only mode can reject the upload with a specific reason. The
    # handler surfaces this as 422 with a structured body so callers can
    # distinguish "crop no good, retry with original" from server errors.
    if isinstance(result, CropRejected):
        logger.info("process: mode=%s crop_rejected reason=%s", mode, result.reason)
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            content={
                "error_code": "CROP_VALIDATION_FAILED",
                "reason": result.reason,
                "retry_with_original": True,
            },
        )

    logger.info("process: mode=%s source=%s", mode, result.source)

    cropped_image_b64: str | None = None
    if result.returned_bytes_differ:
        cropped_image_b64 = base64.b64encode(result.image_bytes).decode("ascii")

    return ProcessResponse(
        players=list(result.classification.players),
        player=result.classification.player,
        team=result.classification.team,
        card_number=result.classification.card_number,
        side=result.classification.side,
        rotation_degrees=result.orientation.rotation_degrees,
        orient_confidence=result.orientation.confidence,
        text_count=result.orientation.text_count,
        cropped_source=result.source,
        cropped_image_b64=cropped_image_b64,
    )


def _request_mode(image_bytes: bytes | None, precropped_bytes: bytes | None) -> str:
    """Single-word mode label for structured logging.

    Matches the three-mode taxonomy in the crop-only plan; feeds Cloud
    Logging dashboards so `mode=crop_only rejection_rate` is a
    one-liner query.
    """
    if image_bytes is not None and precropped_bytes is not None:
        return "image_and_crop"
    if image_bytes is not None:
        return "image_only"
    return "crop_only"


@app.post("/crop", response_model=CropResponse)
async def crop_alternatives(
    image: Annotated[UploadFile, File()],
    strategy: Annotated[str | None, Form()] = None,
    x_internal_key: Annotated[str | None, Header()] = None,
) -> CropResponse | JSONResponse:
    """Run one or all crop strategies on an uploaded image and return raw crops.

    Companion to `/process`: when the cascade's "best" pick looks wrong to
    a human, this endpoint surfaces the alternatives. No orient, no
    classify, no gates — just raw cropped bytes per strategy so a human
    can pick a different one. If they pick one, they re-POST it to
    `/process` as `precropped` to get the full pipeline.

    Strategy identifier (form field):
      - omitted → run every strategy in cascade order
      - name (e.g. `sam`) → run just that one
      - 0-based index as a numeric string (e.g. `2`) → run just that one
    """
    _verify_internal_key(x_internal_key)

    image_bytes = await _read_upload(image, field="image")

    if strategy is not None:
        try:
            resolved = cropper.resolve_strategy_identifier(strategy)
        except UnknownStrategyError as exc:
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={
                    "error_code": "UNKNOWN_STRATEGY",
                    "detail": str(exc),
                    "valid": list(STRATEGY_NAMES),
                },
            )
        names: tuple[str, ...] = (resolved,)
    else:
        names = STRATEGY_NAMES

    crops: list[CropStrategyOutput] = []
    for name in names:
        produced, error = cropper.run_strategy_capturing(name, image_bytes)
        image_b64 = base64.b64encode(produced).decode("ascii") if produced else None
        crops.append(
            CropStrategyOutput(
                strategy=name,
                index=STRATEGY_NAMES.index(name),
                image_b64=image_b64,
                error=error,
            )
        )

    logger.info(
        "crop: ran=%d produced=%d crashed=%d",
        len(crops),
        sum(1 for c in crops if c.image_b64 is not None),
        sum(1 for c in crops if c.error is not None),
    )

    return CropResponse(crops=crops)


# ── NEO-170 batch routes ─────────────────────────────────────────────────
#
# Convex's workpool drives these. Neither route holds any state: /extract
# turns `input.zip` into one EXIF-uprighted original per accepted entry at
# `extracted/{index:04d}.{ext}`, /process-entry turns one of those into a
# cropped, rotated `output/images/{index:04d}.{ext}` plus metadata. Every
# object key is derived in `app.jobs.layout` from `{user_id, job_id, index}`
# — no request or response ever carries a path (see the layout module
# docstring for why that rule is load-bearing).


class ExtractRequest(BaseModel):
    """Body for POST /extract.

    **There is no object-path field, and there must never be one.** Both
    `neonbinder-convex` and the preprocess runtime SA hold bucket-wide
    `objectViewer` on the placeholder bucket, so a caller-supplied path would
    make this endpoint a cross-user read oracle. The service takes the two
    identifiers and derives every key itself (`app.jobs.layout`); the caller's
    authority to use them was established by Convex, which owns the
    `placeholderJobs` ownership row and re-derives the same path from it.
    """

    job_id: str = Field(description="The jobId minted by createPlaceholderUploadUrl (a UUID).")
    user_id: str = Field(description="The Clerk subject id that owns the job.")


class ExtractEntry(BaseModel):
    """One archive member's outcome, in natural filename order.

    `index` is the member's ordinal among non-ignored zip members, after the
    natural filename sort in `zipsafe.iter_zip_members` — downstream pairing
    in Convex reads it as scan order, so it is load-bearing, not cosmetic.
    Callers only ever hold `{job_id, user_id, index}`; there is deliberately no
    object key or path here (the service derives keys — see `ExtractRequest`).

    Accepted entries carry the sniffed `content_type` and `size_bytes` of the
    bytes actually stored (post EXIF normalisation); rejected ones carry a
    stable machine `reason` instead and never fail the archive.
    """

    index: int
    name: str
    accepted: bool
    content_type: str | None
    size_bytes: int | None
    reason: str | None


class ExtractResponse(BaseModel):
    """Response body for POST /extract.

    `entries` has one row per non-ignored zip member, in natural filename order.
    `accepted_count + rejected_count == len(entries)`.
    """

    entries: list[ExtractEntry]
    accepted_count: int
    rejected_count: int


# Upper bound on a baseline's `text_count` — shared with the Convex validator
# (NEO-315). A trading card yields tens to a few hundred words.
BASELINE_MAX_TEXT_COUNT = 100_000


class BaselineOrientation(BaseModel):
    """A Vision orient of the whole extracted image (NEO-315).

    Returned by the FAST service when it declines, and handed back by Convex
    to the HEAVY service on the escalated request, so HEAVY does not pay a
    second Vision call on the same bytes. Same three numbers as the
    completed-result fields `rotation_degrees` / `orient_confidence` /
    `text_count`, but describing the uncropped original, not a crop.
    """

    rotation_degrees: Literal[0, 90, 180, 270]
    # Finite only: NaN/inf are refused explicitly rather than relying on how
    # a NaN compares against the bounds.
    confidence: float = Field(ge=0.0, le=1.0, allow_inf_nan=False)
    text_count: int = Field(ge=0, le=BASELINE_MAX_TEXT_COUNT, strict=True)

    @classmethod
    def from_result(cls, result: OrientationResult) -> BaselineOrientation | None:
        """The wire form of an orient, or None when it falls outside the contract.

        Convex drops a baseline with any out-of-range field, so one is never
        emitted: an orient that cannot be represented (it cannot happen from
        `detect_orientation`, but this is the boundary) is simply omitted and
        HEAVY recomputes it.
        """
        try:
            return cls(
                rotation_degrees=result.rotation_degrees,  # type: ignore[arg-type]
                confidence=result.confidence,
                text_count=result.text_count,
            )
        except ValidationError:
            logger.warning("process_entry: baseline orient outside the wire contract, omitting")
            return None

    def to_result(self) -> OrientationResult:
        return OrientationResult(
            rotation_degrees=self.rotation_degrees,
            confidence=self.confidence,
            text_count=self.text_count,
        )


# The serialised dHash: 16 lowercase hex characters (see ProcessEntryResponse).
DHASH_PATTERN = r"^[0-9a-f]{16}$"


class ProcessEntryRequest(BaseModel):
    """Body for POST /process-entry. Same no-path rule as `ExtractRequest`.

    `baseline` and `dhash` (NEO-315) are optional reuse hints. Convex copies
    them from a FAST decline into the escalated HEAVY request; both roles
    accept them. They describe the same extracted object this request reads —
    EXIF uprighting is deterministic, so the bytes are identical — and when
    present the service skips the whole-image Vision call and/or the dHash
    instead of recomputing them. Unknown fields are ignored (pydantic's
    default), so either deploy order of Convex and this service is safe.
    """

    job_id: str = Field(description="The jobId minted by createPlaceholderUploadUrl (a UUID).")
    user_id: str = Field(description="The Clerk subject id that owns the job.")
    # `le` mirrors the archive ceiling: /extract can never have produced an
    # ordinal past MAX_ZIP_ENTRIES, so an absurd index is a 422 validation
    # error here rather than an over-long GCS key turning into a 502 (the
    # zero-padded name layout assumes the same ceiling — app.jobs.layout).
    entry_index: int = Field(
        ge=0,
        le=zipsafe.MAX_ZIP_ENTRIES,
        description="The entry's zip ordinal, from /extract.",
    )
    # NEO-173: same "fast" default as /process. "fast" skips the ~35s BiRefNet
    # pass on the pre-cropped-scanner majority (classical identity short-circuit)
    # and escalates every other image to the full pipeline; "strong" forces the
    # tiered/BiRefNet cascade. Convex sets this per placeholder job.
    crop_quality: Literal["fast", "strong"] = Field(
        default=CROP_QUALITY_FAST,
        description="Crop cascade quality: 'fast' (classical identity skip) or 'strong'.",
    )
    baseline: BaselineOrientation | None = Field(
        default=None,
        description=(
            "Whole-image Vision orient from a FAST decline; skips the HEAVY baseline call."
        ),
    )
    dhash: str | None = Field(
        default=None,
        pattern=DHASH_PATTERN,
        description="dHash from a FAST decline (16 lowercase hex); skips recomputing it.",
    )


class ProcessEntryResponse(BaseModel):
    """Response body for POST /process-entry. Metadata only — never image bytes.

    ── The `needs_escalation` contract (NEO-175) ───────────────────────────
    Two mutually exclusive outcomes share this one 200 response, distinguished
    by `needs_escalation`:

      (a) `needs_escalation == false` — a COMPLETED crop result. Every
          crop-result field below is populated (identity + dhash +
          output_written, exactly as before this field existed) and the
          processed image has been written to its derived output key. This is
          the HEAVY role's only outcome, and the FAST role's outcome when the
          classical fast path settled the card. The pre-existing fields keep
          their pre-NEO-175 values byte-for-byte; the only additive change is
          `needs_escalation: false`.

      (b) `needs_escalation == true` — the FAST role (`PREPROCESS_ROLE=fast`)
          DECLINED: the classical-only fast path did not settle this card and
          the FAST service must never run the model-backed cascade. There is
          NO crop result (every crop-result field is left at its default —
          empty `players`, null identity, `output_written=false`) and
          nothing was written to the output key. Convex re-enqueues this entry
          to the HEAVY service. The body carries no crop, no image bytes, and
          no secrets. Since NEO-315 it does carry the two values the FAST
          service already computed on the whole image — `baseline` (its
          Vision orient) and `dhash` — so Convex can pass them on the HEAVY
          request and HEAVY skips recomputing them.

    A consumer decides purely on `needs_escalation`; it is always present. The
    crop-result fields are documented per (a)/(b) above.

    The processed image (case a) lives at its derived output key; Convex
    re-derives that key from `{user_id, job_id, entry_index}` when it needs the
    object.

    `dhash` is the 64-bit perceptual hash of the extracted, EXIF-uprighted
    ORIGINAL — computed before any cropping, matching cardlister's "hash the
    original scan, never the crop" rule — serialized as 16 lowercase hex
    characters because a 64-bit integer does not survive JSON's float64.
    Populated in both cases (a) and (b) (NEO-315; it used to be null in (b)).

    `baseline` is populated only in the escalation case (b): the whole-image
    orient the FAST service paid for. It is NOT the crop's orientation — a
    completed result's `rotation_degrees` / `orient_confidence` / `text_count`
    describe the winning crop and always supersede it.

    `output_written` is False when the output object already existed (a
    retried entry): the write is once-only (`if_generation_match=0`) and
    first-write-wins on retry is the documented, accepted behaviour. It is
    also False in the escalation case (b), where nothing is written at all.
    """

    # NEO-175 role split — see the class docstring for the full contract.
    needs_escalation: bool = False
    # Crop-result fields. Always populated when needs_escalation is False;
    # left at these defaults (no crop result) when needs_escalation is True.
    players: list[str] = Field(default_factory=list)
    player: str | None = None
    team: str | None = None
    card_number: str | None = None
    side: str | None = None
    rotation_degrees: int | None = None
    orient_confidence: float | None = None
    text_count: int | None = None
    cropped_source: str | None = None
    dhash: str | None = None
    output_written: bool = False
    # NEO-315 — whole-image Vision orient, only on a FAST decline (case b).
    baseline: BaselineOrientation | None = None


class DeriveCopyPhotosRequest(BaseModel):
    """Body for POST /derive-copy-photos. Same no-path rule as `ExtractRequest`."""

    job_id: str = Field(description="The jobId minted by createPlaceholderUploadUrl (a UUID).")
    user_id: str = Field(description="The Clerk subject id that owns the job.")
    entry_index: int = Field(
        ge=0,
        le=zipsafe.MAX_ZIP_ENTRIES,
        description="The entry's zip ordinal, from /extract.",
    )


class DeriveCopyPhotosResponse(BaseModel):
    """Response body for POST /derive-copy-photos: both sizes, base64-encoded.

    Unlike the other batch routes this one returns image bytes, because the
    objects they become live in R2, which this service holds no key for.
    """

    image: str
    thumb: str
    content_type: str


def _invalid_identifier_response(exc: InvalidJobIdentifierError) -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_400_BAD_REQUEST,
        content={"error_code": "INVALID_IDENTIFIER", "detail": str(exc)},
    )


def _not_configured_response() -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        content={
            "error_code": "EXTRACT_NOT_CONFIGURED",
            "detail": f"{layout.BUCKET_ENV} is not set",
        },
        headers={"Retry-After": str(NOT_CONFIGURED_RETRY_AFTER_SECONDS)},
    )


def _prepare_member(
    member: zipsafe.ZipMember, *, user_id: str, job_id: str
) -> tuple[ExtractEntry, tuple[str, bytes, str] | None]:
    """Turn one zip member into its response row and, if accepted, its upload.

    Returns `(entry, upload)` where `upload` is `(object_key, data,
    content_type)` for accepted members and None for rejected ones. Rejections
    here are per-entry by design — a bad image must not cost the user the rest
    of the archive.
    """

    def _rejected(reason: str) -> tuple[ExtractEntry, None]:
        return (
            ExtractEntry(
                index=member.index,
                name=member.name,
                accepted=False,
                content_type=None,
                size_bytes=None,
                reason=reason,
            ),
            None,
        )

    if not member.accepted:
        return _rejected(member.reason or "no_data")
    assert member.data is not None  # accepted implies data; narrows the type

    try:
        # Pixels, not bytes: a 506 KB PNG can decode to 484 MB, clearing every
        # byte ceiling in zipsafe. Checked from the lazy header before the
        # EXIF transpose becomes the first full-size decode — see app.imaging.
        check_raster_size(member.data)
        upright, _orientation = apply_exif_orientation(member.data)
    except RasterTooLargeError:
        return _rejected("image_too_many_pixels")
    except Exception:  # noqa: BLE001 - one undecodable member must not 502 the batch
        logger.warning("extract: entry %d undecodable during EXIF normalisation", member.index)
        return _rejected("entry_undecodable")

    # The EXIF re-encode runs at high quality and can grow an image past the
    # ceiling it came in under. The object written here is read back through
    # that same ceiling by /process-entry, so an oversized one could only fail
    # later and less clearly.
    if len(upright) > zipsafe.MAX_ENTRY_UNCOMPRESSED_BYTES:
        return _rejected("entry_too_large")

    # Re-sniff rather than reusing the member's type: EXIF normalisation can
    # re-encode into a different format (see app.exif), and the stored object
    # must describe the bytes actually written.
    content_type = zipsafe.sniff_image_type(upright)
    if content_type is None:  # pragma: no cover - EXIF output is always a known format
        return _rejected("unsupported_output_type")

    key = layout.extracted_image_object(
        user_id, job_id, member.index, zipsafe.EXTENSION_BY_CONTENT_TYPE[content_type]
    )
    entry = ExtractEntry(
        index=member.index,
        name=member.name,
        accepted=True,
        content_type=content_type,
        size_bytes=len(upright),
        reason=None,
    )
    return entry, (key, upright, content_type)


def _upload_extracted(store: ObjectStore, ref: ObjectRef, data: bytes, content_type: str) -> None:
    """Write-once upload of one extracted image.

    `ObjectAlreadyExistsError` (GCS 412) is idempotent success: the only way
    the key is occupied is a re-run of a timed-out extract, which derived the
    same key from the same ordinal. First write wins.

    That holds while the entry ordering stays the same. A job extracted before
    a change in ordering and restarted after it could disagree: its rows would
    follow the new order and its stored objects the old one. This is accepted,
    since it takes one job in flight across that one deploy.
    """
    try:
        store.create(ref, data, content_type=content_type)
    except ObjectAlreadyExistsError:
        logger.info("extract: %s already exists, treating as idempotent success", ref.name)


def _extract_entries(
    store: ObjectStore, input_ref: ObjectRef, object_size: int, *, user_id: str, job_id: str
) -> list[ExtractEntry]:
    """Stream the archive through zipsafe's guards and upload accepted entries.

    The zip is read one entry at a time through one seekable stream, in natural
    filename order rather than file order, so it seeks between entries. Only
    the GCS uploads are overlapped, on a small pool, and the producer is
    throttled so the bytes retained by not-yet-finished uploads never exceed
    `EXTRACT_PENDING_BYTES_BUDGET` (see the constant for the OOM class this
    prevents). Raises `ZipRejectedError` for archive-level violations —
    uploads already submitted are drained first (they are write-once and
    idempotent, so a partial extract that later gets rejected leaves nothing a
    re-run can't cope with).
    """
    entries: list[ExtractEntry] = []
    # Uploads submitted but not yet observed complete, and the bytes each one
    # still retains. This is the producer's ledger for the byte budget.
    pending: dict[Future[None], int] = {}

    def _harvest(done: set[Future[None]]) -> None:
        # Propagate upload failures exactly like the final drain does:
        # `.result()` re-raises, and the pool context on the way out still
        # waits for whatever else was in flight.
        for future in done:
            pending.pop(future)
            future.result()

    with store.open_stream(input_ref) as stream:
        with ThreadPoolExecutor(max_workers=EXTRACT_UPLOAD_WORKERS) as pool:
            for member in zipsafe.iter_zip_members(stream, object_size=object_size):
                entry, upload = _prepare_member(member, user_id=user_id, job_id=job_id)
                entries.append(entry)
                if upload is None:
                    continue
                key, data, content_type = upload
                # Backpressure: block until this entry's bytes fit the budget
                # (and the future count is sane). A single entry larger than
                # the whole budget still goes through — alone.
                while pending and (
                    sum(pending.values()) + len(data) > EXTRACT_PENDING_BYTES_BUDGET
                    or len(pending) >= EXTRACT_PENDING_MAX_FUTURES
                ):
                    done, _ = wait(pending, return_when=FIRST_COMPLETED)
                    _harvest(done)
                future = pool.submit(
                    _upload_extracted,
                    store,
                    ObjectRef(bucket=input_ref.bucket, name=key),
                    data,
                    content_type,
                )
                pending[future] = len(data)
    # The pool context has drained; surface the first remaining upload
    # failure, if any.
    _harvest(set(pending))
    return entries


@app.post("/extract", response_model=ExtractResponse)
def extract(
    request: ExtractRequest,
    x_internal_key: Annotated[str | None, Header()] = None,
) -> ExtractResponse | JSONResponse:
    """Unpack a job's `input.zip` into per-entry EXIF-uprighted originals.

    Stateless and idempotent: re-running a timed-out extract re-derives the
    same keys and treats each occupied key (GCS 412) as success. Archive-level
    rejections (`ZIP_REJECTED`, 422) are terminal — they describe an archive
    nobody assembled by accident, so the caller must not retry. Per-entry
    problems never fail the archive; they come back as `accepted=false` rows.

    Failure codes: `INVALID_IDENTIFIER` (400), `INPUT_NOT_FOUND` (404),
    `INPUT_TOO_LARGE` (413), `ZIP_REJECTED` (422, terminal),
    `EXTRACT_NOT_CONFIGURED` (503, retryable); unexpected storage failures
    surface as 502.
    """
    _verify_internal_key(x_internal_key)

    try:
        layout.validate_identifiers(request.user_id, request.job_id)
    except InvalidJobIdentifierError as exc:
        return _invalid_identifier_response(exc)

    bucket = os.environ.get(layout.BUCKET_ENV)
    if not bucket:
        return _not_configured_response()

    input_ref = ObjectRef(bucket=bucket, name=layout.input_object(request.user_id, request.job_id))
    try:
        input_stat = _object_store.stat(input_ref)
    except Exception:
        logger.exception("extract: input stat failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="placeholder storage unavailable",
        ) from None

    if input_stat is None:
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={"error_code": "INPUT_NOT_FOUND", "detail": "no input.zip for this job"},
        )
    if input_stat.size > zipsafe.MAX_INPUT_OBJECT_BYTES:
        # The signed POST policy caps uploads at this same number; an object
        # over it means the contract was bypassed, not a big batch.
        return JSONResponse(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            content={
                "error_code": "INPUT_TOO_LARGE",
                "detail": (
                    f"input.zip is {input_stat.size} bytes, over the "
                    f"{zipsafe.MAX_INPUT_OBJECT_BYTES} byte ceiling"
                ),
            },
        )

    try:
        entries = _extract_entries(
            _object_store,
            input_ref,
            input_stat.size,
            user_id=request.user_id,
            job_id=request.job_id,
        )
    except zipsafe.ZipRejectedError as exc:
        # Terminal, not retryable: the archive itself is hostile or unusable,
        # and the same bytes will be rejected the same way every time.
        logger.info("extract: archive rejected (%s)", exc.reason)
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            content={"error_code": "ZIP_REJECTED", "reason": exc.reason, "retryable": False},
        )
    except Exception:
        logger.exception("extract: pipeline failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="extract storage failure",
        ) from None

    accepted_count = sum(1 for entry in entries if entry.accepted)
    logger.info(
        "extract: entries=%d accepted=%d rejected=%d",
        len(entries),
        accepted_count,
        len(entries) - accepted_count,
    )
    return ExtractResponse(
        entries=entries,
        accepted_count=accepted_count,
        rejected_count=len(entries) - accepted_count,
    )


# Pillow's answers for bytes it cannot decode: an unrecognised header
# (`UnidentifiedImageError`, an OSError), truncated or corrupt data (OSError),
# and malformed headers or segments (SyntaxError, ValueError). In the EXIF and
# dHash steps these mean the stored entry is not an image we can open: the same
# bytes fail the same way every time, so they are a terminal 422, never a
# retryable 502.
_DECODE_ERRORS: tuple[type[BaseException], ...] = (
    UnidentifiedImageError,
    OSError,
    SyntaxError,
    ValueError,
)

ENTRY_UNDECODABLE = "ENTRY_UNDECODABLE"


def _entry_undecodable(timings: Timings, detail: str) -> JSONResponse:
    timings.error_code = ENTRY_UNDECODABLE
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        content={"error_code": ENTRY_UNDECODABLE, "detail": detail},
    )


def _upstream_failure(timings: Timings, error_code: str, detail: str) -> HTTPException:
    """A 502 for the caller to retry; `error_code` labels the timing line only.

    The body stays `{"detail": ...}` as it has always been: callers branch on
    the status alone for these.
    """
    timings.error_code = error_code
    return HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=detail)


@app.post("/process-entry", response_model=ProcessEntryResponse)
def process_entry(
    request: ProcessEntryRequest,
    http_request: Request,
    x_internal_key: Annotated[str | None, Header()] = None,
) -> ProcessEntryResponse | JSONResponse:
    """Run the full crop cascade on one extracted entry and store the result.

    The same orient → crop → rotate → classify pipeline as POST /process
    (image-only mode, no precropped), applied to the object /extract wrote for
    this ordinal, plus a dHash of the uprighted original computed BEFORE any
    cropping. The rotated winning crop is written once to its derived output
    key; on retry the first write wins and `output_written` comes back False.

    The sizes a saved copy keeps are stored beside that output, made from
    whichever bytes won. Failing to make or store them never fails the entry:
    a save without them asks `/derive-copy-photos` instead.

    Failure codes:
      - `INVALID_IDENTIFIER` (400).
      - `ENTRY_NOT_FOUND` (404, terminal): /extract never wrote this ordinal.
      - `ENTRY_TOO_MANY_PIXELS` (413, terminal): the header names more pixels
        than the service decodes.
      - `ENTRY_UNDECODABLE` (422, terminal, NEO-484): the stored bytes are not
        an image this service can open: no readable image header, or the EXIF
        upright or dHash decode fails. Checked on both roles before any Vision
        call, and a supplied `dhash` does not skip it. The same bytes fail the
        same way every time, so Convex must not retry it.
      - `EXTRACT_NOT_CONFIGURED` (503, retryable).
      - Vision/Anthropic and unexpected storage failures surface as 502, exactly
        like /process, and are retryable.

    Every authenticated request emits exactly one `process_entry_timing` JSON
    line (NEO-315, `app.timing`), whatever its outcome. A failed request's line
    carries its `error_code` (502s get a label of their own there), and every
    line carries the dev cache mode the request ran under.

    NEO-484: the dev cache policy is resolved from the request's Host and bound
    for this request only (`app.devcache.policy.bound`). It is on only on the
    dev base URL with the cache bucket configured; /process, /crop and every
    other route run live. The Host is read from the raw request rather than a
    declared header parameter, so the route's OpenAPI parameters do not change.
    """
    _verify_internal_key(x_internal_key)

    timings = Timings(role=_preprocess_role(), index=request.entry_index)
    timings.baseline_supplied = request.baseline is not None
    policy = _resolve_cache_policy(http_request.headers.get("host"))
    timings.cache_mode = policy.mode
    try:
        with devcache_policy.bound(policy):
            return _process_entry(request, timings)
    except Exception:
        # HTTPExceptions set their own label before raising; anything else
        # escaping is an unhandled 500.
        if timings.error_code is None:
            timings.error_code = "INTERNAL_ERROR"
        raise
    finally:
        timings.emit()


def _store_copy_photo_sizes(
    request: ProcessEntryRequest,
    bucket: str,
    output_ref: ObjectRef,
    fresh_output: bytes | None,
    timings: Timings,
) -> None:
    """Store the two sizes a saved copy keeps beside an entry's output. Never raises.

    `fresh_output` is the output this attempt just wrote. None means an earlier
    attempt's object stands (first write wins), so the sizes are made from that
    object rather than this attempt's crop, which may not be the same pixels.
    That earlier attempt can have died before its sizes landed, or stored only
    one, so a retry fills in whatever is missing.

    Outputs are write-once and nothing replaces one, so sizes made here match the
    output they were made from. The one exception: a retry whose crop comes out in
    another format writes a second output under another extension and leaves the
    sizes as they were, so they show the first attempt's crop of the same scan.
    """
    image_ref = ObjectRef(
        bucket=bucket,
        name=layout.copy_photo_image_object(request.user_id, request.job_id, request.entry_index),
    )
    thumb_ref = ObjectRef(
        bucket=bucket,
        name=layout.copy_photo_thumb_object(request.user_id, request.job_id, request.entry_index),
    )
    try:
        with timings.measure("copy_photos_ms"):
            source = fresh_output
            if source is None:
                if (
                    _object_store.stat(image_ref) is not None
                    and _object_store.stat(thumb_ref) is not None
                ):
                    return
                source = _object_store.download(
                    output_ref, max_bytes=zipsafe.MAX_ENTRY_UNCOMPRESSED_BYTES
                )
            check_raster_size(source)
            derived = derive_copy_photos(source)
            for ref, data in ((image_ref, derived.image), (thumb_ref, derived.thumb)):
                try:
                    _object_store.create(ref, data, content_type=derived.content_type)
                except ObjectAlreadyExistsError:
                    pass
    except Exception:
        logger.exception(
            "process_entry: no copy photo sizes for index %d, a save will derive them",
            request.entry_index,
        )


def _process_entry(
    request: ProcessEntryRequest, timings: Timings
) -> ProcessEntryResponse | JSONResponse:
    """The body of `process_entry`, accumulating into `timings`."""
    try:
        layout.validate_identifiers(request.user_id, request.job_id)
    except InvalidJobIdentifierError as exc:
        timings.error_code = "INVALID_IDENTIFIER"
        return _invalid_identifier_response(exc)

    bucket = os.environ.get(layout.BUCKET_ENV)
    if not bucket:
        timings.error_code = "EXTRACT_NOT_CONFIGURED"
        return _not_configured_response()

    try:
        with timings.measure("gcs_ms"):
            entry_ref: ObjectRef | None = None
            entry_stat = None
            for extension in _EXTRACTED_EXTENSIONS:
                candidate = ObjectRef(
                    bucket=bucket,
                    name=layout.extracted_image_object(
                        request.user_id, request.job_id, request.entry_index, extension
                    ),
                )
                entry_stat = _object_store.stat(candidate)
                if entry_stat is not None:
                    entry_ref = candidate
                    break
            if entry_ref is None:
                timings.error_code = "ENTRY_NOT_FOUND"
                return JSONResponse(
                    status_code=status.HTTP_404_NOT_FOUND,
                    content={
                        "error_code": "ENTRY_NOT_FOUND",
                        "detail": "no extracted image at this index",
                    },
                )
            # Read through the stat's own blob handle: no second HEAD (NEO-315).
            entry_bytes = _object_store.download(
                entry_ref, max_bytes=zipsafe.MAX_ENTRY_UNCOMPRESSED_BYTES, stat=entry_stat
            )
    except Exception:
        logger.exception("process_entry: extracted image read failed")
        raise _upstream_failure(
            timings, "ENTRY_READ_FAILED", "placeholder storage unavailable"
        ) from None

    # Pixels, not bytes — the same guard /extract runs before ITS first
    # full-size decode. The zip path can never deliver an unchecked image
    # here (extract already enforced the ceiling), but streaming intake
    # POSTs directly into extracted/ via a signed policy, and a POST policy
    # can bound bytes and content-type — never pixels. Without this, a
    # ~100KB flat JPEG decoding to hundreds of MB would hit the EXIF
    # transpose / dhash / crop cascade at full size. Terminal 413 on
    # purpose: re-sending the same bytes can never succeed, so it must not
    # land in the retryable-502 bucket and be paid five times.
    try:
        raster_size = check_raster_size(entry_bytes)
    except RasterTooLargeError as exc:
        timings.error_code = "ENTRY_TOO_MANY_PIXELS"
        return JSONResponse(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            content={"error_code": "ENTRY_TOO_MANY_PIXELS", "detail": str(exc)},
        )

    # No readable image header: these bytes are not an image (NEO-484 — the
    # fake scanner's 6-byte `side-1` page labelled image/jpeg, an empty object,
    # any upload that only claimed to be a photo). Terminal 422 before EXIF,
    # dHash or Vision, on both roles, and a supplied dhash does not skip it:
    # the 502 this used to fall into was retried five times by the workpool and
    # paid a Vision call on each attempt.
    if raster_size is None:
        logger.warning("process_entry: index=%d has no readable image header", request.entry_index)
        return _entry_undecodable(timings, "extracted entry is not a readable image")

    # EXIF-upright the entry unconditionally, BEFORE the dhash. Zip-extracted
    # objects are already upright (/extract transposed and re-encoded them,
    # stripping the orientation tag — a no-op here), but direct-upload
    # (streaming) objects land in extracted/ as raw originals that may still
    # carry the tag. Running this always, ahead of compute_dhash, is what
    # keeps the hash contract identical for both ingestion paths.
    try:
        with timings.measure("exif_ms"):
            entry_bytes, _orientation = apply_exif_orientation(entry_bytes)
    except _DECODE_ERRORS as exc:
        logger.warning(
            "process_entry: index=%d EXIF upright could not decode the entry (%s)",
            request.entry_index,
            type(exc).__name__,
        )
        return _entry_undecodable(timings, "extracted entry could not be decoded")
    except Exception:
        logger.exception("process_entry: EXIF upright failed on the extracted image")
        raise _upstream_failure(timings, "EXIF_FAILED", "extracted image undecodable") from None

    # dHash the EXIF-uprighted ORIGINAL before any cropping — the hash must
    # describe the scan, never the crop, so re-scans of the same card match
    # regardless of how each pass got cropped. A supplied dhash (NEO-315: the
    # FAST service's, over these same bytes) is used as-is.
    if request.dhash is not None:
        dhash_hex = request.dhash
    else:
        try:
            with timings.measure("dhash_ms"):
                # 16 lowercase hex chars: a 64-bit int does not survive JSON float64.
                dhash_hex = f"{compute_dhash(entry_bytes):016x}"
        except _DECODE_ERRORS as exc:
            logger.warning(
                "process_entry: index=%d dhash could not decode the entry (%s)",
                request.entry_index,
                type(exc).__name__,
            )
            return _entry_undecodable(timings, "extracted entry could not be decoded")
        except Exception:
            logger.exception("process_entry: dhash failed on the extracted image")
            raise _upstream_failure(
                timings, "DHASH_FAILED", "extracted image undecodable"
            ) from None

    # Same cascade, same upstream-failure translation as POST /process. In the
    # FAST role, `escalate_only` makes crop() run ONLY the classical fast path
    # and return CropDeclined (no model touched) instead of the model-backed
    # cascade; the HEAVY role passes no such flag and behaves exactly as before.
    crop_kwargs: dict[str, object] = {}
    if _preprocess_role() == ROLE_FAST:
        crop_kwargs["escalate_only"] = True
    if request.baseline is not None:
        crop_kwargs["baseline"] = request.baseline.to_result()
        if _preprocess_role() == ROLE_HEAVY:
            # A supplied baseline means FAST already ran the fast-path
            # stages (identity checks and quad crop) on this exact object and
            # declined; they are deterministic, so HEAVY goes straight to the
            # strategy loop.
            crop_kwargs["skip_fast_path"] = True
    try:
        result = cropper.crop(
            image_bytes=entry_bytes,
            precropped_bytes=None,
            crop_quality=request.crop_quality,
            timings=timings,
            **crop_kwargs,
        )
    except ClassifyError:
        logger.exception("process_entry: classify failed to parse after retry")
        raise _upstream_failure(
            timings, "CLASSIFY_UNPARSEABLE", "classify response unparseable"
        ) from None
    except Exception:
        logger.exception("process_entry: cascade failed")
        raise _upstream_failure(
            timings, "PIPELINE_UPSTREAM_FAILURE", "preprocess pipeline upstream failure"
        ) from None

    if isinstance(result, CropDeclined):
        # FAST role declined (see the ProcessEntryResponse contract): the
        # classical fast path did not settle this card and the FAST service
        # must never run the model-backed cascade. No crop, no output write —
        # a 200 with needs_escalation=true so Convex re-enqueues the entry to
        # the HEAVY service. `reason` is logged, never put in the body.
        logger.info(
            "process_entry: index=%d fast role declined (%s) — needs_escalation",
            request.entry_index,
            result.reason,
        )
        timings.escalated = True
        return ProcessEntryResponse(
            needs_escalation=True,
            dhash=dhash_hex,
            baseline=(
                BaselineOrientation.from_result(result.baseline)
                if result.baseline is not None
                else None
            ),
        )

    if isinstance(result, CropRejected):  # pragma: no cover - image_bytes was provided
        raise _upstream_failure(timings, "NO_CROP_RESULT", "cascade returned no result")

    timings.source = result.source
    # Write the winning crop already rotated (the /process contract leaves
    # rotation to the client; here the stored object IS the client-facing
    # artifact, so the rotation is baked in and reported as metadata). The
    # cascade already rotated it to feed classify (NEO-315); reuse those bytes
    # rather than decoding and re-encoding the winner a second time.
    rotated = result.rotated_bytes
    if rotated is None:
        with timings.measure("rotate_ms"):
            rotated = rotate_image_bytes(result.image_bytes, result.orientation.rotation_degrees)
    output_content_type = zipsafe.sniff_image_type(rotated)
    if output_content_type is None:  # pragma: no cover - rotation preserves format
        raise _upstream_failure(
            timings, "OUTPUT_TYPE_UNKNOWN", "processed image has no recognisable type"
        )

    output_ref = ObjectRef(
        bucket=bucket,
        name=layout.output_image_object(
            request.user_id,
            request.job_id,
            request.entry_index,
            zipsafe.EXTENSION_BY_CONTENT_TYPE[output_content_type],
        ),
    )
    output_written = True
    try:
        with timings.measure("write_ms"):
            _object_store.create(output_ref, rotated, content_type=output_content_type)
    except ObjectAlreadyExistsError:
        # A retried entry: the first attempt's object stands (write-once,
        # first-write-wins — documented as acceptable for identical inputs).
        logger.info("process_entry: output already exists for index %d", request.entry_index)
        output_written = False
    except Exception:
        logger.exception("process_entry: output write failed")
        raise _upstream_failure(
            timings, "OUTPUT_WRITE_FAILED", "placeholder storage unavailable"
        ) from None

    _store_copy_photo_sizes(
        request, bucket, output_ref, rotated if output_written else None, timings
    )

    logger.info(
        "process_entry: index=%d source=%s rotation=%d written=%s",
        request.entry_index,
        result.source,
        result.orientation.rotation_degrees,
        output_written,
    )
    return ProcessEntryResponse(
        # A completed crop result — the HEAVY role's only outcome, and the FAST
        # role's when the classical fast path settled the card.
        needs_escalation=False,
        players=list(result.classification.players),
        player=result.classification.player,
        team=result.classification.team,
        card_number=result.classification.card_number,
        side=result.classification.side,
        rotation_degrees=result.orientation.rotation_degrees,
        orient_confidence=result.orientation.confidence,
        text_count=result.orientation.text_count,
        cropped_source=result.source,
        dhash=dhash_hex,
        output_written=output_written,
    )


@app.post("/derive-copy-photos", response_model=DeriveCopyPhotosResponse)
def derive_copy_photos_route(
    request: DeriveCopyPhotosRequest,
    x_internal_key: Annotated[str | None, Header()] = None,
) -> DeriveCopyPhotosResponse | JSONResponse:
    """Make the sizes a saved copy keeps from one entry's processed output.

    The fallback for an entry without stored sizes: one processed before
    /process-entry stored them, or whose sizes could not be made then. Reads the
    object /process-entry wrote for this ordinal and writes nothing, so it is
    safe to repeat. Runs on either role: there is no model involved.

    Failure codes: `INVALID_IDENTIFIER` (400), `OUTPUT_NOT_FOUND` (404,
    terminal: the bucket's lifecycle rule removed the scan, or it was never
    processed), `OUTPUT_TOO_MANY_PIXELS` (413, terminal), `OUTPUT_UNDECODABLE`
    and `PHOTO_TOO_LARGE` (422, terminal: the same bytes fail the same way),
    `EXTRACT_NOT_CONFIGURED` (503, retryable); storage failures surface as 502.
    """
    _verify_internal_key(x_internal_key)

    try:
        layout.validate_identifiers(request.user_id, request.job_id)
    except InvalidJobIdentifierError as exc:
        return _invalid_identifier_response(exc)

    bucket = os.environ.get(layout.BUCKET_ENV)
    if not bucket:
        return _not_configured_response()

    try:
        output_bytes: bytes | None = None
        for extension in _EXTRACTED_EXTENSIONS:
            candidate = ObjectRef(
                bucket=bucket,
                name=layout.output_image_object(
                    request.user_id, request.job_id, request.entry_index, extension
                ),
            )
            output_stat = _object_store.stat(candidate)
            if output_stat is not None:
                output_bytes = _object_store.download(
                    candidate, max_bytes=zipsafe.MAX_ENTRY_UNCOMPRESSED_BYTES, stat=output_stat
                )
                break
    except Exception:
        logger.exception("derive_copy_photos: output read failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="placeholder storage unavailable",
        ) from None

    if output_bytes is None:
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={
                "error_code": "OUTPUT_NOT_FOUND",
                "detail": "no processed image at this index",
            },
        )

    # Written by this service, but from pixels a signed POST policy never
    # bounded; the same guard as every other first full-size decode here.
    try:
        check_raster_size(output_bytes)
    except RasterTooLargeError as exc:
        return JSONResponse(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            content={"error_code": "OUTPUT_TOO_MANY_PIXELS", "detail": str(exc)},
        )

    try:
        derived = derive_copy_photos(output_bytes)
    except CopyPhotoTooLargeError as exc:
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            content={"error_code": "PHOTO_TOO_LARGE", "detail": str(exc)},
        )
    except Exception:
        logger.exception("derive_copy_photos: output undecodable")
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            content={"error_code": "OUTPUT_UNDECODABLE", "detail": "processed image undecodable"},
        )

    logger.info(
        "derive_copy_photos: index=%d image_bytes=%d thumb_bytes=%d",
        request.entry_index,
        len(derived.image),
        len(derived.thumb),
    )
    return DeriveCopyPhotosResponse(
        image=base64.b64encode(derived.image).decode("ascii"),
        thumb=base64.b64encode(derived.thumb).decode("ascii"),
        content_type=derived.content_type,
    )


# Last statement of the module: the `cold_start` line's import share.
_MAIN_MODULE_IMPORT_S = time.perf_counter() - _MODULE_IMPORT_STARTED
