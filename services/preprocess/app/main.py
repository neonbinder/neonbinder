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
"""

from __future__ import annotations

import base64
import glob
import hmac
import logging
import os
import sys
import threading
import time
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from typing import Annotated, Literal

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app import cropper
from app.classify import ClassifyError
from app.cropper import (
    CROP_QUALITIES,
    CROP_QUALITY_FAST,
    STRATEGY_NAMES,
    CropDeclined,
    CropRejected,
    UnknownStrategyError,
)
from app.cropper._utils import rotate_image_bytes
from app.dhash import compute_dhash
from app.exif import apply_exif_orientation
from app.imaging import RasterTooLargeError, check_raster_size
from app.jobs import layout, zipsafe
from app.jobs.gcs import ObjectAlreadyExistsError, ObjectRef, ObjectStore
from app.jobs.layout import InvalidJobIdentifierError

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
# of image data in RAM on a 4 GiB instance — exactly the OOM class the
# streaming zip read exists to prevent. The bound has to be a BYTE budget, not
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
# `zipsafe.EXTENSION_BY_CONTENT_TYPE`.
_EXTRACTED_EXTENSIONS = ("jpg", "png", "webp")

# Storage client for the batch routes. Construction is credential-free (the
# real google client is built lazily on first use — see app.jobs.gcs), so this
# is safe at import; tests monkeypatch this attribute with a fake-backed store.
_object_store = ObjectStore()


def _warm_birefnet_in_background() -> None:
    """Body of the warm thread. Never raises — a failed warm is not a dead container.

    Anything that escapes here would die inside a daemon thread and leave the
    container *healthy but silently unwarmed*, which is strictly worse than a
    slow first request: `_get_session()` is lazy, so a failure here degrades to
    the pre-warm behaviour rather than breaking anything.
    """
    from app.cropper import tiered

    started = time.monotonic()
    try:
        tiered.warm_up()
    except Exception:
        logger.exception(
            "startup: background BiRefNet warm failed after %.1fs — the first "
            "request will load the model lazily instead",
            time.monotonic() - started,
        )
        return
    logger.info("BiRefNet session warmed in %.1fs", time.monotonic() - started)


@app.on_event("startup")
def _verify_baked_weights() -> None:
    """Fail loudly at boot if the baked model weights are missing.

    Only enforced when REQUIRE_BAKED_WEIGHTS=1 (set in the Dockerfile). A
    missing cache would otherwise trigger rembg's silent runtime re-download:
    a ~930MB write into Cloud Run's in-memory filesystem plus an
    unauthenticated outbound fetch — a slow success where we want a loud
    failure. Unit tests don't set the var and are unaffected.

    NEO-175: only the HEAVY role loads a local model. The FAST role
    (`PREPROCESS_ROLE=fast`) runs classical-only and must cold-start in
    seconds, so it skips BOTH the baked-weight check and the ~191s warm-up —
    even if REQUIRE_BAKED_WEIGHTS is still set on the shared image. This is the
    clean seam: the model is loaded at startup only when role == HEAVY.
    """
    if _preprocess_role() != ROLE_HEAVY:
        logger.info(
            "startup: %s=%s — skipping baked-weight check and model warm-up",
            PREPROCESS_ROLE_ENV,
            _preprocess_role(),
        )
        return
    if os.environ.get("REQUIRE_BAKED_WEIGHTS") != "1":
        return
    u2net_home = os.environ.get("U2NET_HOME", "")
    if not u2net_home or not glob.glob(os.path.join(u2net_home, "*.onnx")):
        raise RuntimeError(
            f"REQUIRE_BAKED_WEIGHTS=1 but no .onnx weights under U2NET_HOME={u2net_home!r}"
        )
    # ── Warm OFF the critical path (NEO-194) ────────────────────────────
    # This warm used to run inline, here. FastAPI completes every `startup`
    # handler BEFORE uvicorn accepts connections, so the container did not
    # listen on $PORT until BiRefNet was resident — and Cloud Run allows 240s
    # from "checking container health" before it destroys the revision.
    #
    # Measured warm times on dev (2026-08-27, visible only once NEO-191 added
    # a logging config): 116, 130, 154, 162, 165, 166, 187, 190s. Against a
    # 240s ceiling, with torch/transformers/rembg/onnxruntime imports still to
    # pay first, that spent ~80% of the budget before the port opened and left
    # ~50s of margin at the observed tail. It lost that race 7 times in prod
    # and 100+ times on dev over 14 days, and took down the NEO-191 release.
    #
    # A thread fixes it outright rather than widening the window: uvicorn
    # listens in seconds, the probe passes, and the model loads concurrently
    # while the container is already healthy. Nothing downstream changes —
    # `_get_session()` is lazy behind double-checked locking, so a request
    # arriving mid-warm blocks on the same load it would have paid anyway, and
    # `/warmup` racing this thread is safe for the same reason. `/warmup`
    # remains the "actually ready" signal callers wait on (Convex already fans
    # it out at session start), and it now does what its name says instead of
    # being redundant with a boot that had already blocked on the model.
    #
    # daemon=True so a warm still in flight never holds up interpreter exit;
    # Cloud Run gives ~10s to drain on shutdown and an unfinished warm has
    # nothing worth saving.
    threading.Thread(
        target=_warm_birefnet_in_background,
        name="birefnet-warm",
        daemon=True,
    ).start()
    logger.info("startup: BiRefNet warm started in the background; serving now")


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
    side: str
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


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


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
    """Force the BiRefNet crop model resident on this instance, then report warm.

    A scale-to-zero container pays the ~930MB BiRefNet load plus ORT's first-run
    allocations on its first inference; cold, that latency lands on the first real
    /process-entry call (minutes of effective wait). Convex calls this at
    session-start to pre-spin the model so the real calls hit a warm instance.

    Synchronous "load then return": the load runs the SAME path a real crop uses
    (`tiered.warm_up` → `_get_session` + one tiny in-memory 64x64 inference), needs
    no GCS object or real image, does NO GCS / Vision / Anthropic I/O, and writes
    nothing — pure model residency. Cloud Run holds the request while a cold
    instance loads, so a 200 tells the caller the instance is actually ready.

    Idempotent and cheap when already warm: `is_session_loaded()` short-circuits so
    a repeat call returns immediately with no reload and no inference, and reports
    `was_cold=False` so the caller knows the instance was already ready.

    Concurrency: the service runs container_concurrency=1, so one /warmup warms the
    ONE instance that happens to handle it. Warming all N instances of a scaled-out
    revision needs N concurrent /warmup calls (Convex fans out N = capacity); this
    endpoint only ever warms its own instance.

    NEO-175: the FAST role has no local model to make resident, so it must not
    reach the loader at all (the whole point of the role is that it never
    constructs a model session). It short-circuits to `was_cold=False` without
    importing or touching the tiered session helpers.
    """
    _verify_internal_key(x_internal_key)

    if _preprocess_role() != ROLE_HEAVY:
        logger.info(
            "warmup: %s=%s — no model to warm, reporting ready", PREPROCESS_ROLE_ENV, ROLE_FAST
        )
        return WarmupResponse(status="warm", was_cold=False)

    # Same inline import as the startup warm hook: reach the tiered module's
    # session helpers by name without widening main.py's top-level imports.
    from app.cropper import tiered

    was_cold = not tiered.is_session_loaded()
    if was_cold:
        tiered.warm_up()
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
    """One archive member's outcome, in zip order.

    `index` is the member's ordinal among non-ignored zip members and
    preserves zip order — downstream pairing in Convex reads it as scan
    order, so it is load-bearing, not cosmetic. Callers only ever hold
    `{job_id, user_id, index}`; there is deliberately no object key or path
    here (the service derives keys — see `ExtractRequest`).

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

    `entries` has one row per non-ignored zip member, in zip order.
    `accepted_count + rejected_count == len(entries)`.
    """

    entries: list[ExtractEntry]
    accepted_count: int
    rejected_count: int


class ProcessEntryRequest(BaseModel):
    """Body for POST /process-entry. Same no-path rule as `ExtractRequest`."""

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
          empty `players`, null identity/dhash, `output_written=false`) and
          nothing was written to the output key. Convex re-enqueues this entry
          to the HEAVY service. The body carries no crop, no image bytes, and
          no secrets — only this flag and the machine-default placeholders.

    A consumer decides purely on `needs_escalation`; it is always present. The
    crop-result fields are documented per (a)/(b) above.

    The processed image (case a) lives at its derived output key; Convex
    re-derives that key from `{user_id, job_id, entry_index}` when it needs the
    object.

    `dhash` is the 64-bit perceptual hash of the extracted, EXIF-uprighted
    ORIGINAL — computed before any cropping, matching cardlister's "hash the
    original scan, never the crop" rule — serialized as 16 lowercase hex
    characters because a 64-bit integer does not survive JSON's float64. Null
    only in the escalation case (b).

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
    """
    try:
        store.create(ref, data, content_type=content_type)
    except ObjectAlreadyExistsError:
        logger.info("extract: %s already exists, treating as idempotent success", ref.name)


def _extract_entries(
    store: ObjectStore, input_ref: ObjectRef, object_size: int, *, user_id: str, job_id: str
) -> list[ExtractEntry]:
    """Stream the archive through zipsafe's guards and upload accepted entries.

    The zip is read sequentially (one seekable stream); only the GCS uploads
    are overlapped, on a small pool, and the producer is throttled so the bytes
    retained by not-yet-finished uploads never exceed
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


@app.post("/process-entry", response_model=ProcessEntryResponse)
def process_entry(
    request: ProcessEntryRequest,
    x_internal_key: Annotated[str | None, Header()] = None,
) -> ProcessEntryResponse | JSONResponse:
    """Run the full crop cascade on one extracted entry and store the result.

    The same orient → crop → rotate → classify pipeline as POST /process
    (image-only mode, no precropped), applied to the object /extract wrote for
    this ordinal, plus a dHash of the uprighted original computed BEFORE any
    cropping. The rotated winning crop is written once to its derived output
    key; on retry the first write wins and `output_written` comes back False.

    Failure codes: `INVALID_IDENTIFIER` (400), `ENTRY_NOT_FOUND` (404,
    terminal — /extract never wrote this ordinal), `EXTRACT_NOT_CONFIGURED`
    (503, retryable); Vision/Anthropic and unexpected storage failures surface
    as 502, exactly like /process.
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
        entry_ref: ObjectRef | None = None
        for extension in _EXTRACTED_EXTENSIONS:
            candidate = ObjectRef(
                bucket=bucket,
                name=layout.extracted_image_object(
                    request.user_id, request.job_id, request.entry_index, extension
                ),
            )
            if _object_store.stat(candidate) is not None:
                entry_ref = candidate
                break
        if entry_ref is None:
            return JSONResponse(
                status_code=status.HTTP_404_NOT_FOUND,
                content={
                    "error_code": "ENTRY_NOT_FOUND",
                    "detail": "no extracted image at this index",
                },
            )
        entry_bytes = _object_store.download(
            entry_ref, max_bytes=zipsafe.MAX_ENTRY_UNCOMPRESSED_BYTES
        )
    except Exception:
        logger.exception("process_entry: extracted image read failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="placeholder storage unavailable",
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
        check_raster_size(entry_bytes)
    except RasterTooLargeError as exc:
        return JSONResponse(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            content={"error_code": "ENTRY_TOO_MANY_PIXELS", "detail": str(exc)},
        )

    # EXIF-upright the entry unconditionally, BEFORE the dhash. Zip-extracted
    # objects are already upright (/extract transposed and re-encoded them,
    # stripping the orientation tag — a no-op here), but direct-upload
    # (streaming) objects land in extracted/ as raw originals that may still
    # carry the tag. Running this always, ahead of compute_dhash, is what
    # keeps the hash contract identical for both ingestion paths.
    try:
        entry_bytes, _orientation = apply_exif_orientation(entry_bytes)
    except Exception:
        logger.exception("process_entry: EXIF upright failed on the extracted image")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="extracted image undecodable",
        ) from None

    # dHash the EXIF-uprighted ORIGINAL before any cropping — the hash must
    # describe the scan, never the crop, so re-scans of the same card match
    # regardless of how each pass got cropped.
    try:
        dhash_value = compute_dhash(entry_bytes)
    except Exception:
        logger.exception("process_entry: dhash failed on the extracted image")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="extracted image undecodable",
        ) from None

    # Same cascade, same upstream-failure translation as POST /process. In the
    # FAST role, `escalate_only` makes crop() run ONLY the classical fast path
    # and return CropDeclined (no model touched) instead of the model-backed
    # cascade; the HEAVY role passes no such flag and behaves exactly as before.
    crop_kwargs: dict[str, object] = {}
    if _preprocess_role() == ROLE_FAST:
        crop_kwargs["escalate_only"] = True
    try:
        result = cropper.crop(
            image_bytes=entry_bytes,
            precropped_bytes=None,
            crop_quality=request.crop_quality,
            **crop_kwargs,
        )
    except ClassifyError:
        logger.exception("process_entry: classify failed to parse after retry")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="classify response unparseable",
        ) from None
    except Exception:
        logger.exception("process_entry: cascade failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="preprocess pipeline upstream failure",
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
        return ProcessEntryResponse(needs_escalation=True)

    if isinstance(result, CropRejected):  # pragma: no cover - image_bytes was provided
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="cascade returned no result",
        )

    # Write the winning crop already rotated (the /process contract leaves
    # rotation to the client; here the stored object IS the client-facing
    # artifact, so the rotation is baked in and reported as metadata).
    rotated = rotate_image_bytes(result.image_bytes, result.orientation.rotation_degrees)
    output_content_type = zipsafe.sniff_image_type(rotated)
    if output_content_type is None:  # pragma: no cover - rotation preserves format
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="processed image has no recognisable type",
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
        _object_store.create(output_ref, rotated, content_type=output_content_type)
    except ObjectAlreadyExistsError:
        # A retried entry: the first attempt's object stands (write-once,
        # first-write-wins — documented as acceptable for identical inputs).
        logger.info("process_entry: output already exists for index %d", request.entry_index)
        output_written = False
    except Exception:
        logger.exception("process_entry: output write failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="placeholder storage unavailable",
        ) from None

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
        # 16 lowercase hex chars: a 64-bit int does not survive JSON float64.
        dhash=f"{dhash_value:016x}",
        output_written=output_written,
    )
