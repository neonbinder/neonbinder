"""FastAPI entrypoint for the neonbinder-preprocess service.

Slice 1: `/health` + `/process` with orient→rotate→classify pipeline.
Slice 2a: optional `precropped` multipart field, crop cascade.
Slice 2b: SAM added to the cascade; text-count + classify-error gates
          applied uniformly across every crop strategy via the wrapper
          in `app.cropper`. Main.py is now a thin layer: auth + upload
          validation → cropper.crop() → response packaging.
NEO-149:  `/jobs` — asynchronous zip batches read from and written back to
          GCS. Same thin-layer rule: this file does auth, request shape and
          error-code mapping; everything else is `app.jobs`.
"""

from __future__ import annotations

import base64
import hmac
import logging
import os
from typing import Annotated

from fastapi import (
    BackgroundTasks,
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app import cropper, imaging, jobs
from app.classify import ClassifyError
from app.cropper import STRATEGY_NAMES, CropRejected, UnknownStrategyError
from app.jobs import layout
from app.jobs.layout import InvalidJobIdentifierError

logger = logging.getLogger(__name__)

app = FastAPI(title="neonbinder-preprocess", version="0.3.0")

INTERNAL_API_KEY_ENV = "INTERNAL_API_KEY"
MAX_IMAGE_BYTES = 32 * 1024 * 1024
ALLOWED_CONTENT_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})

# Retry-After sent with both of the job endpoints' 503s. A busy instance is
# busy for the length of a batch (minutes), but with max-instances 3 a retry
# 30s later can land on a different, idle instance — so this is sized to "try
# somewhere else soon", not "wait for this batch to finish".
JOB_RETRY_AFTER_SECONDS = 30


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
    won. When it is `"precropped"` the client's upload was used as-is and
    `cropped_image_b64` will be null (the client already has the bytes
    on disk). For every other source, the server produced new bytes and
    returns them base64-encoded in `cropped_image_b64`.
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


class JobSubmitRequest(BaseModel):
    """Body for POST /jobs.

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


class JobSubmitResponse(BaseModel):
    """202 body for POST /jobs.

    `state` is always `queued`: the work has been claimed, not started. Poll
    `GET /jobs/{job_id}` for everything after that.
    """

    job_id: str
    user_id: str
    state: str
    input_uri: str
    output_prefix: str


class JobProgress(BaseModel):
    """Per-image counters. `processed + failed` is the work done so far."""

    total_images: int
    processed_images: int
    failed_images: int


class JobResult(BaseModel):
    """Batch outcome. Populated once the job reaches a terminal state.

    `manifest_uri` points at the full document — per-image records, pairs with
    their merged identity, unpaired images and per-image failure reasons. It is
    read directly from GCS rather than proxied through this service.
    """

    manifest_uri: str | None
    pairs: int
    unmatched: int
    resolver_calls: int


class JobStatusResponse(BaseModel):
    """Body for GET /jobs/{job_id}.

    `state` is one of `queued`, `running`, `succeeded`, `failed` — or
    `stalled`, which is never *stored*: it is what a caller is told when a
    non-terminal job's status log has gone quiet for longer than
    `app.jobs.state.STALE_AFTER_MS`, meaning the instance running it died. A
    stalled job cannot be resumed; resubmit under a fresh job id.

    Timestamps are epoch milliseconds, matching what Convex stores.
    """

    job_id: str
    user_id: str
    state: str
    sequence: int
    created_at: int
    updated_at: int
    progress: JobProgress
    result: JobResult
    error_code: str | None
    error_detail: str | None


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
    # Byte size says very little about decode cost: a 506 KB PNG can expand to
    # 484 MB of raster, and the cascade decodes each image several times over
    # with copies live at once. `check_raster_size` reads the header only, and
    # stays silent about images whose header it cannot parse — those still fail
    # further down the cascade exactly as they did before, with the same 502.
    try:
        imaging.check_raster_size(data)
    except imaging.RasterTooLargeError as exc:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"{field} exceeds max size of {imaging.MAX_IMAGE_PIXELS} pixels",
        ) from exc
    return data


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/process", response_model=ProcessResponse)
async def process(
    image: Annotated[UploadFile | None, File()] = None,
    precropped: Annotated[UploadFile | None, File()] = None,
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
    """
    _verify_internal_key(x_internal_key)

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
        result = cropper.crop(image_bytes=image_bytes, precropped_bytes=precropped_bytes)
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

    # `/process` never passes `classify=`, so the cascade always classified.
    # Only the zip job (`app.jobs`) opts out, and it doesn't come through here.
    classification = result.classification
    if classification is None:  # pragma: no cover - unreachable on this path
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="cascade returned no classification",
        )

    return ProcessResponse(
        players=list(classification.players),
        player=classification.player,
        team=classification.team,
        card_number=classification.card_number,
        side=classification.side,
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


# HTTP status + machine error code for each way a submission can be refused.
# Kept as one table so the wire contract is readable in a single place — the
# NEO-151 Convex adapter branches on `error_code`, never on the prose detail.
_SUBMIT_ERRORS: tuple[tuple[type[Exception], int, str], ...] = (
    (InvalidJobIdentifierError, status.HTTP_400_BAD_REQUEST, "INVALID_IDENTIFIER"),
    (jobs.JobsNotConfiguredError, status.HTTP_503_SERVICE_UNAVAILABLE, "JOBS_NOT_CONFIGURED"),
    (jobs.InstanceBusyError, status.HTTP_503_SERVICE_UNAVAILABLE, "INSTANCE_BUSY"),
    (jobs.InputNotFoundError, status.HTTP_404_NOT_FOUND, "INPUT_NOT_FOUND"),
    (jobs.InputTooLargeError, status.HTTP_413_CONTENT_TOO_LARGE, "INPUT_TOO_LARGE"),
    (jobs.JobAlreadySubmittedError, status.HTTP_409_CONFLICT, "JOB_ALREADY_SUBMITTED"),
)


def _submit_error_response(exc: Exception) -> JSONResponse:
    for exc_type, http_status, code in _SUBMIT_ERRORS:
        if isinstance(exc, exc_type):
            return JSONResponse(
                status_code=http_status,
                content={"error_code": code, "detail": str(exc)},
                # Both 503s are transient: no bucket configured is a deploy in
                # progress, a busy instance frees up when its batch finishes.
                headers=(
                    {"Retry-After": str(JOB_RETRY_AFTER_SECONDS)}
                    if http_status == status.HTTP_503_SERVICE_UNAVAILABLE
                    else None
                ),
            )
    raise exc


@app.post("/jobs", response_model=JobSubmitResponse, status_code=status.HTTP_202_ACCEPTED)
def submit_job(
    request: JobSubmitRequest,
    background_tasks: BackgroundTasks,
    x_internal_key: Annotated[str | None, Header()] = None,
) -> JobSubmitResponse | JSONResponse:
    """Claim a zip batch and start it in the background.

    Returns 202 as soon as the job is claimed — the batch itself is minutes of
    SAM inference and cannot be a request. Everything after this point is
    observed through `GET /jobs/{job_id}`, which reads the durable status log
    rather than any in-process state, so a poll landing on a different instance
    (or on a cold one) answers correctly. See `app.jobs` for the reasoning.

    Failure codes: `INVALID_IDENTIFIER` (400), `INPUT_NOT_FOUND` (404),
    `JOB_ALREADY_SUBMITTED` (409), `INPUT_TOO_LARGE` (413),
    `JOBS_NOT_CONFIGURED` / `INSTANCE_BUSY` (503, both retryable).
    """
    _verify_internal_key(x_internal_key)

    try:
        bucket = jobs.resolve_bucket()
        claim = jobs.submit_job(request.user_id, request.job_id)
    except Exception as exc:
        logger.info("jobs: submit refused (%s)", type(exc).__name__)
        return _submit_error_response(exc)

    # Starlette runs background tasks only after the response has been sent, so
    # this may never run at all — a timeout or a disconnect is enough. The slot
    # it would release is a lease that expires on its own for exactly that
    # reason; see `app.jobs.JOB_SLOT_TTL_SECONDS`.
    background_tasks.add_task(
        jobs.execute_job,
        request.user_id,
        request.job_id,
        claim.status,
        slot_token=claim.slot_token,
    )
    job_status = claim.status

    return JobSubmitResponse(
        job_id=job_status.job_id,
        user_id=job_status.user_id,
        state=job_status.state,
        input_uri=f"gs://{bucket}/{layout.input_object(request.user_id, request.job_id)}",
        output_prefix=f"gs://{bucket}/{layout.output_prefix(request.user_id, request.job_id)}",
    )


@app.get("/jobs/{job_id}", response_model=JobStatusResponse)
def get_job_status(
    job_id: str,
    user_id: Annotated[str, Query(description="The Clerk subject id that owns the job.")],
    x_internal_key: Annotated[str | None, Header()] = None,
) -> JobStatusResponse | JSONResponse:
    """Read a job's latest durable status snapshot.

    `user_id` is required because it is half of the object prefix the status
    log lives under — the service does not maintain an index from job id to
    owner, deliberately: that index is the `placeholderJobs` row in Convex, and
    duplicating it here would be a second place for an ownership check to be
    wrong.
    """
    _verify_internal_key(x_internal_key)

    try:
        job_status = jobs.load_status(user_id, job_id)
    except InvalidJobIdentifierError as exc:
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={"error_code": "INVALID_IDENTIFIER", "detail": str(exc)},
        )
    except jobs.JobsNotConfiguredError as exc:
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"error_code": "JOBS_NOT_CONFIGURED", "detail": str(exc)},
            headers={"Retry-After": str(JOB_RETRY_AFTER_SECONDS)},
        )

    if job_status is None:
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={"error_code": "JOB_NOT_FOUND", "detail": "no status log for this job"},
        )

    return JobStatusResponse(
        job_id=job_status.job_id,
        user_id=job_status.user_id,
        state=jobs.derive_state(job_status),
        sequence=job_status.sequence,
        created_at=job_status.created_at,
        updated_at=job_status.updated_at,
        progress=JobProgress(
            total_images=job_status.total_images,
            processed_images=job_status.processed_images,
            failed_images=job_status.failed_images,
        ),
        result=JobResult(
            manifest_uri=job_status.manifest_uri,
            pairs=job_status.pairs,
            unmatched=job_status.unmatched,
            resolver_calls=job_status.resolver_calls,
        ),
        error_code=job_status.error_code,
        error_detail=job_status.error_detail,
    )
