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
import time
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from typing import Annotated

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app import cropper
from app.classify import ClassifyError
from app.cropper import STRATEGY_NAMES, CropRejected, UnknownStrategyError
from app.cropper._utils import rotate_image_bytes
from app.dhash import compute_dhash
from app.exif import apply_exif_orientation
from app.imaging import RasterTooLargeError, check_raster_size
from app.jobs import layout, zipsafe
from app.jobs.gcs import ObjectAlreadyExistsError, ObjectRef, ObjectStore
from app.jobs.layout import InvalidJobIdentifierError

logger = logging.getLogger(__name__)

app = FastAPI(title="neonbinder-preprocess", version="0.3.0")

INTERNAL_API_KEY_ENV = "INTERNAL_API_KEY"
MAX_IMAGE_BYTES = 32 * 1024 * 1024
ALLOWED_CONTENT_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})

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


@app.on_event("startup")
def _verify_baked_weights() -> None:
    """Fail loudly at boot if the baked model weights are missing.

    Only enforced when REQUIRE_BAKED_WEIGHTS=1 (set in the Dockerfile). A
    missing cache would otherwise trigger rembg's silent runtime re-download:
    a ~930MB write into Cloud Run's in-memory filesystem plus an
    unauthenticated outbound fetch — a slow success where we want a loud
    failure. Unit tests don't set the var and are unaffected.
    """
    if os.environ.get("REQUIRE_BAKED_WEIGHTS") != "1":
        return
    u2net_home = os.environ.get("U2NET_HOME", "")
    if not u2net_home or not glob.glob(os.path.join(u2net_home, "*.onnx")):
        raise RuntimeError(
            f"REQUIRE_BAKED_WEIGHTS=1 but no .onnx weights under U2NET_HOME={u2net_home!r}"
        )
    # Warm the BiRefNet session now, while Cloud Run still allocates full
    # startup CPU and no request is waiting on it. Cold, the load + first
    # inference exceeded the smoke test's timeout.
    from app.cropper import tiered

    started = time.monotonic()
    tiered.warm_up()
    logger.info("BiRefNet session warmed in %.1fs", time.monotonic() - started)


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


class ProcessEntryResponse(BaseModel):
    """Response body for POST /process-entry. Metadata only — never image bytes.

    The processed image lives at its derived output key; Convex re-derives
    that key from `{user_id, job_id, entry_index}` when it needs the object.

    `dhash` is the 64-bit perceptual hash of the extracted, EXIF-uprighted
    ORIGINAL — computed before any cropping, matching cardlister's "hash the
    original scan, never the crop" rule — serialized as 16 lowercase hex
    characters because a 64-bit integer does not survive JSON's float64.

    `output_written` is False when the output object already existed (a
    retried entry): the write is once-only (`if_generation_match=0`) and
    first-write-wins on retry is the documented, accepted behaviour.
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
    dhash: str
    output_written: bool


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

    # Same cascade, same upstream-failure translation as POST /process.
    try:
        result = cropper.crop(image_bytes=entry_bytes, precropped_bytes=None)
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
