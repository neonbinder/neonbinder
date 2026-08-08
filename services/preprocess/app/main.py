"""FastAPI entrypoint for the neonbinder-preprocess service.

Slice 1: `/health` + `/process` with orient→rotate→classify pipeline.
Slice 2a: optional `precropped` multipart field, crop cascade.
Slice 2b: SAM added to the cascade; text-count + classify-error gates
          applied uniformly across every crop strategy via the wrapper
          in `app.cropper`. Main.py is now a thin layer: auth + upload
          validation → cropper.crop() → response packaging.
"""

from __future__ import annotations

import base64
import hmac
import logging
import os
from typing import Annotated

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app import cropper
from app.classify import ClassifyError
from app.cropper import STRATEGY_NAMES, CropRejected, UnknownStrategyError

logger = logging.getLogger(__name__)

app = FastAPI(title="neonbinder-preprocess", version="0.3.0")

INTERNAL_API_KEY_ENV = "INTERNAL_API_KEY"
MAX_IMAGE_BYTES = 32 * 1024 * 1024
ALLOWED_CONTENT_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})


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
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"{field} exceeds max size of {MAX_IMAGE_BYTES} bytes",
        )
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
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
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
