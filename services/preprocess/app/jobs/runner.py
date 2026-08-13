"""The zip batch pipeline: read an archive, crop every image, pair the results.

One pass over the archive, one output object per image, one manifest, and a
status checkpoint every few images. Nothing here is new machinery — the crop
cascade, the validator gates and the pairing port are all reused as they are —
but two seams are worth reading before changing anything.

## The identity spend

`app.pairing.pair_batch` exists to *not* call Haiku. Its adjacency pre-pass
pairs consecutive images from `text_count` alone, which the Vision orient
inside the crop cascade has already paid for, and it invokes the identity
resolver only for the images that pre-pass could not confidently claim.

That saving is only real if the pipeline honours it, which means two rules:

1. The cascade runs with `cropper.skip_classify`, so no image is classified on
   the way past. A 200-card zip that classified eagerly would spend 400 Haiku
   calls before pairing had a say.
2. The resolver passed to `pair_batch` is **lazy** — it is a closure that
   fetches one already-written output object and classifies it, called by the
   pool at the moment it needs identity for one specific image.

`_CountingResolver.calls` is what gets reported as `resolver_calls`, and the
test suite asserts it stays a fraction of the image count.

Fetching the image back from GCS rather than keeping it in a dict is
deliberate: 400 photos at 2-5 MB each is a gigabyte of heap on a 4Gi instance
that is also holding SAM, and only a handful of them are ever wanted.

## `returned_bytes_differ` does not apply here

`CropResult.returned_bytes_differ` means "the caller already has these bytes,
don't send them back" — true for a multipart upload where the client posted the
image. For a zip member the client never sent us anything, so the flag would be
answering a question nobody asked. This pipeline ignores it and writes every
processed image unconditionally.

## Rotation

Output objects are written **already rotated**. `app.orient` reports rotation
counter-clockwise (see `app.exif` for the full convention note and why
`sharp.rotate` needs the sign flipped), and rather than push that subtlety onto
every client of the manifest, the job applies it and records
`rotation_applied: true`. `rotation_degrees` in the manifest is then a
description of what was done, not an instruction to do it.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

from app import cropper
from app.classify import ClassifyResult, classify_card
from app.cropper._utils import rotate_image_bytes
from app.exif import apply_exif_orientation
from app.imaging import RasterTooLargeError, check_raster_size
from app.jobs import layout
from app.jobs.gcs import ObjectRef, ObjectStore
from app.jobs.state import PROGRESS_CHECKPOINT_IMAGES, JobStatus, JobStatusLog, now_ms
from app.jobs.zipsafe import (
    EXTENSION_BY_CONTENT_TYPE,
    MAX_ENTRY_UNCOMPRESSED_BYTES,
    ZipMember,
    ZipRejectedError,
    count_candidate_entries,
    iter_zip_members,
    sniff_image_type,
)
from app.pairing import BatchImage, BatchResult, MatchResult, PoolCard, pair_batch

logger = logging.getLogger(__name__)

# Bumped when the manifest's shape changes in a way a consumer must notice.
# NEO-151's Convex adapter reads this before anything else in the document.
MANIFEST_VERSION = 1

# Recorded on every manifest so a reader never has to infer the sign of
# `rotation_degrees` from context. "ccw" matches PIL's Image.rotate and this
# service's long-standing /process contract; sharp.rotate is clockwise.
ROTATION_CONVENTION = "ccw"

MANIFEST_CONTENT_TYPE = "application/json"


@dataclass(frozen=True)
class ImageRecord:
    """One successfully processed image."""

    index: int
    entry_name: str
    output_key: str
    content_type: str
    text_count: int
    rotation_degrees: int
    exif_orientation: int
    crop_source: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "entry_name": self.entry_name,
            "output_key": self.output_key,
            "content_type": self.content_type,
            "text_count": self.text_count,
            "rotation_degrees": self.rotation_degrees,
            "rotation_applied": True,
            "exif_orientation": self.exif_orientation,
            "crop_source": self.crop_source,
        }


@dataclass(frozen=True)
class FailureRecord:
    """One image the batch could not use, and why. Never fails the batch."""

    index: int
    entry_name: str
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return {"index": self.index, "entry_name": self.entry_name, "reason": self.reason}


class _CountingResolver:
    """Lazy identity resolution, with the spend counted.

    Reads the processed image back from storage and classifies it. Called only
    by `pair_batch`, only for images the adjacency pre-pass declined, and at
    most once per image.
    """

    def __init__(self, store: ObjectStore, bucket: str) -> None:
        self._store = store
        self._bucket = bucket
        self.calls: list[str] = []

    def __call__(self, key: str) -> ClassifyResult | None:
        self.calls.append(key)
        data = self._store.download(
            ObjectRef(bucket=self._bucket, name=key),
            max_bytes=MAX_ENTRY_UNCOMPRESSED_BYTES,
        )
        return classify_card(data)


class ImageUnprocessableError(Exception):
    """One image could not be turned into an output object.

    Carries a stable machine reason for the manifest. Raised, caught and
    recorded inside the per-image loop — it never escapes to the job.
    """

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def process_member(
    member: ZipMember,
    *,
    store: ObjectStore,
    bucket: str,
    user_id: str,
    job_id: str,
) -> ImageRecord:
    """Normalise, crop, rotate and store one archive member.

    Raises `ImageUnprocessableError` for anything that makes this one image
    unusable; the caller records it and moves to the next.
    """
    if member.data is None:  # pragma: no cover - callers filter rejected members
        raise ImageUnprocessableError(member.reason or "no_data")

    # Pixels, not bytes. A 506 KB PNG can decode to 484 MB, which clears every
    # ceiling in `app.jobs.zipsafe` — see `app.imaging` for why bytes are the
    # wrong unit. Read from the lazy header here, before the EXIF transpose
    # becomes the first of several full-size decodes, so a raster bomb costs
    # one failure record rather than the instance.
    try:
        check_raster_size(member.data)
    except RasterTooLargeError as exc:
        raise ImageUnprocessableError("image_too_many_pixels") from exc

    normalised, exif_orientation = apply_exif_orientation(member.data)

    result = cropper.crop(
        image_bytes=normalised,
        precropped_bytes=None,
        classify=cropper.skip_classify,
    )
    if not isinstance(result, cropper.CropResult):  # pragma: no cover - image_bytes is set
        raise ImageUnprocessableError("crop_rejected")

    rotated = rotate_image_bytes(result.image_bytes, result.orientation.rotation_degrees)

    # Re-sniff rather than reusing the member's type: EXIF normalisation can
    # re-encode into a different format (see app.exif), and the manifest must
    # describe the bytes we actually wrote.
    content_type = sniff_image_type(rotated)
    if content_type is None:
        raise ImageUnprocessableError("unsupported_output_type")

    output_key = layout.output_image_object(
        user_id, job_id, member.index, EXTENSION_BY_CONTENT_TYPE[content_type]
    )
    store.create(ObjectRef(bucket=bucket, name=output_key), rotated, content_type=content_type)

    return ImageRecord(
        index=member.index,
        entry_name=member.name,
        output_key=output_key,
        content_type=content_type,
        text_count=result.orientation.text_count,
        rotation_degrees=result.orientation.rotation_degrees,
        exif_orientation=exif_orientation,
        crop_source=result.source,
    )


def _pool_card_dict(card: PoolCard, index_by_key: dict[str, int]) -> dict[str, Any]:
    return {
        "index": index_by_key.get(card.key, -1),
        "output_key": card.key,
        "entry_name": card.original_filename,
        "side": card.side,
        "player": card.player,
        "team": card.team,
        "card_number": card.card_number,
        "text_count": card.text_count,
        "identity_resolved": card.identity_resolved,
    }


def _match_dict(match: MatchResult, index_by_key: dict[str, int]) -> dict[str, Any]:
    return {
        "front": _pool_card_dict(match.front, index_by_key),
        "back": _pool_card_dict(match.back, index_by_key),
        "confidence": match.confidence,
        "mechanism": match.mechanism,
        "score": match.score,
        "player": match.player,
        "team": match.team,
        "card_number": match.card_number,
    }


def build_manifest(
    *,
    user_id: str,
    job_id: str,
    records: list[ImageRecord],
    failures: list[FailureRecord],
    batch: BatchResult,
    started_at: int,
    completed_at: int,
) -> dict[str, Any]:
    """The document NEO-151's Convex adapter reads.

    Everything a caller needs to render the batch is here: the per-image
    outputs, the pairs with their merged identity, the images that could not be
    paired, and the ones that could not be processed at all.
    """
    index_by_key = {record.output_key: record.index for record in records}
    return {
        "manifest_version": MANIFEST_VERSION,
        "job_id": job_id,
        "user_id": user_id,
        "started_at": started_at,
        "completed_at": completed_at,
        "rotation_convention": ROTATION_CONVENTION,
        "counts": {
            "images": len(records) + len(failures),
            "processed": len(records),
            "failed": len(failures),
            "pairs": len(batch.matches),
            "unpaired": len(batch.unmatched),
            "resolver_calls": batch.resolver_calls,
        },
        "images": [record.to_dict() for record in records],
        "failures": [failure.to_dict() for failure in failures],
        "pairs": [_match_dict(match, index_by_key) for match in batch.matches],
        "unpaired": [_pool_card_dict(card, index_by_key) for card in batch.unmatched],
    }


def _checkpoint(log: JobStatusLog, status: JobStatus, **changes: Any) -> JobStatus:
    return log.write(status.advance(**changes))


def run_job(
    *,
    user_id: str,
    job_id: str,
    bucket: str,
    store: ObjectStore,
    status: JobStatus,
) -> JobStatus:
    """Run one zip job to completion and return its terminal status.

    Never raises: every failure path ends in a `failed` status snapshot, since
    a caller polling the status log is the only way anyone finds out what
    happened. `status` is the sequence-0 `queued` snapshot the submission
    already wrote.
    """
    log = JobStatusLog(store, bucket=bucket, user_id=user_id, job_id=job_id)
    started_at = status.created_at

    try:
        input_ref = ObjectRef(bucket=bucket, name=layout.input_object(user_id, job_id))
        stat = store.stat(input_ref)
        if stat is None:
            return _checkpoint(log, status, state="failed", error_code="input_missing")

        with store.open_stream(input_ref) as stream:
            total = count_candidate_entries(stream, object_size=stat.size)

        status = _checkpoint(log, status, state="running", total_images=total)

        records: list[ImageRecord] = []
        failures: list[FailureRecord] = []
        images: list[BatchImage] = []

        with store.open_stream(input_ref) as stream:
            for member in iter_zip_members(stream, object_size=stat.size):
                if not member.accepted:
                    failures.append(
                        FailureRecord(
                            index=member.index,
                            entry_name=member.name,
                            reason=member.reason or "rejected",
                        )
                    )
                else:
                    try:
                        record = process_member(
                            member,
                            store=store,
                            bucket=bucket,
                            user_id=user_id,
                            job_id=job_id,
                        )
                    except Exception as exc:  # noqa: BLE001 - one image must not fail the batch
                        reason = (
                            exc.reason
                            if isinstance(exc, ImageUnprocessableError)
                            else "crop_failed"
                        )
                        logger.warning(
                            "job %s: image %d (%s) failed: %s",
                            job_id,
                            member.index,
                            member.name,
                            reason,
                            exc_info=not isinstance(exc, ImageUnprocessableError),
                        )
                        failures.append(
                            FailureRecord(index=member.index, entry_name=member.name, reason=reason)
                        )
                    else:
                        records.append(record)
                        images.append(
                            BatchImage(
                                key=record.output_key,
                                text_count=record.text_count,
                                original_filename=record.entry_name,
                            )
                        )

                done = len(records) + len(failures)
                if done % PROGRESS_CHECKPOINT_IMAGES == 0:
                    status = _checkpoint(
                        log,
                        status,
                        processed_images=len(records),
                        failed_images=len(failures),
                    )

        resolver = _CountingResolver(store, bucket)
        batch = pair_batch(images, resolve_identity=resolver)

        completed_at = now_ms()
        manifest = build_manifest(
            user_id=user_id,
            job_id=job_id,
            records=records,
            failures=failures,
            batch=batch,
            started_at=started_at,
            completed_at=completed_at,
        )
        manifest_key = layout.manifest_object(user_id, job_id)
        manifest_ref = ObjectRef(bucket=bucket, name=manifest_key)
        store.create(
            manifest_ref,
            json.dumps(manifest, sort_keys=True).encode("utf-8"),
            content_type=MANIFEST_CONTENT_TYPE,
        )

        logger.info(
            "job %s: %d processed, %d failed, %d pairs, %d resolver call(s)",
            job_id,
            len(records),
            len(failures),
            len(batch.matches),
            batch.resolver_calls,
        )

        # A batch where nothing at all survived is a failure, not a success
        # with an empty manifest — the manifest is still written so the caller
        # can see which reason hit every image.
        final_state = "failed" if not records else "succeeded"
        return _checkpoint(
            log,
            status,
            state=final_state,
            processed_images=len(records),
            failed_images=len(failures),
            pairs=len(batch.matches),
            unmatched=len(batch.unmatched),
            resolver_calls=batch.resolver_calls,
            manifest_uri=manifest_ref.uri,
            error_code=None if records else "no_processable_images",
        )

    except ZipRejectedError as exc:
        logger.warning("job %s: archive rejected (%s)", job_id, exc.reason)
        return _fail(log, status, "zip_rejected", exc.reason)
    except Exception:  # noqa: BLE001 - the status log is the only channel out
        logger.exception("job %s: unhandled failure", job_id)
        return _fail(log, status, "internal_error", None)


def _fail(log: JobStatusLog, status: JobStatus, code: str, detail: str | None) -> JobStatus:
    """Best-effort terminal failure write.

    If even this write fails — the sequence was taken, storage is down — the
    log simply stops advancing, and `app.jobs.state.derive_state` reports the
    job as stalled once it goes quiet. That is the designed fallback, not a
    gap.
    """
    try:
        return _checkpoint(log, status, state="failed", error_code=code, error_detail=detail)
    except Exception:  # noqa: BLE001
        logger.exception("job %s: could not write the failure status", status.job_id)
        return status
