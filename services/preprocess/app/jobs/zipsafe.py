"""Hostile-archive handling for the placeholder zip ingest.

The input zip is written straight to GCS by a browser holding a signed POST
policy. Convex authenticated the user and GCS capped the byte count, and that
is the whole of what has been checked when this module gets the object. Treat
it as attacker-controlled, because it is: the only thing an attacker needs to
reach this code is an account.

Three distinct attacks, three separate defences.

## 1. Zip bombs

A zip's headers declare how big each entry expands to. Those declarations are
attacker-controlled, so they are used only to *skip* work early — never to
decide that a read was safe. Every ceiling here is additionally enforced
against the bytes actually produced by the decompressor:

- `MAX_ZIP_ENTRIES` and `MAX_CENTRAL_DIRECTORY_BYTES` are checked against the
  end-of-central-directory record **before `zipfile` parses anything**. This
  matters more than it looks: `ZipFile.__init__` seeks to the central
  directory, reads exactly the declared number of bytes into memory and builds
  a `ZipInfo` per entry, so a 500 MB archive claiming eleven million entries
  is an OOM before a single guard in this module would otherwise run. Bounding
  the declared directory size bounds that buffer, and hence the parse.
- `MAX_ENTRY_UNCOMPRESSED_BYTES` is applied by reading at most one byte past
  the cap and rejecting anything that produces it, so a lying header buys the
  attacker one extra byte.
- `MAX_TOTAL_UNCOMPRESSED_BYTES` accumulates actual bytes read across the
  archive, which is what stops a thousand individually-legal entries.
- `MAX_COMPRESSION_RATIO` compares actual bytes read against the declared
  compressed size. This one is a signal rather than a wall — the header it
  divides by is untrusted — and the absolute caps above are the real defence.

## 2. Zip slip / path traversal

Entry names are validated (`_name_rejection`) against absolute paths, `..`
segments, Windows separators and drive letters, control characters including
NUL, and length. But validation is the *second* line: nothing here ever writes
to a filesystem, and output object keys are derived from an entry's zip ordinal
rather than its name (`app.jobs.layout.output_image_object`), so a member
called `../../etc/passwd` has nowhere to go even if the name check were removed.
Symlink and encrypted entries are rejected too — the first because a zip
symlink is only interesting to something that extracts to disk, the second
because we cannot read it and silently pairing an empty slot is worse than
saying so.

## 3. Content type

A zip entry carries no Content-Type header, so `app.main._validate_content_type`
— which reads the multipart header — has nothing to read and is not reused
here. Types are decided by **magic bytes** on the decompressed prefix, checked
against the same three formats the multipart routes accept.

## Fatal vs per-entry

Archive-level violations (entry count, directory size, total expansion,
compression ratio, a structurally unreadable archive) raise `ZipRejectedError` and
fail the whole job: they describe an archive nobody assembled by accident.
Entry-level problems (a bad name, a symlink, a PDF someone dragged in, an
entry over the single-image ceiling) are reported per entry and the batch
carries on, because one unprocessable image must not cost a user their other
199 cards.
"""

from __future__ import annotations

import logging
import re
import struct
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass
from typing import BinaryIO

logger = logging.getLogger(__name__)

# Hard ceiling on the input object itself, checked from object metadata before
# a byte is read. Matches the `content-length-range` condition on the signed
# POST policy that Convex mints (MAX_UPLOAD_BYTES in
# convex/adapters/placeholderUploads.ts) — the policy is the contract, and an
# object bigger than it means the contract was bypassed, not that a user has an
# unusually large batch.
MAX_INPUT_OBJECT_BYTES = 500 * 1024 * 1024

# Most entries we will look at. A 200-card batch is 400 images; 1000 leaves
# room for the biggest plausible scan session plus the junk macOS staples to
# every archive, while capping the job at roughly 1000 x 3s = 50 minutes of SAM.
# An archive above this is not a card batch.
MAX_ZIP_ENTRIES = 1000

# Bound on the declared central-directory size, checked before `zipfile` reads
# it. At MAX_ZIP_ENTRIES entries with maximum-length names a real directory is
# ~400 KB (46-byte header + name + extra field each); 1 MiB is comfortably
# above that and still small enough that the pre-parse allocation is trivial.
MAX_CENTRAL_DIRECTORY_BYTES = 1024 * 1024

# Largest single image we will decompress. Deliberately identical to
# `app.main.MAX_IMAGE_BYTES`: an image the multipart routes would refuse must
# not get in through the zip door instead. Asserted equal in the tests.
MAX_ENTRY_UNCOMPRESSED_BYTES = 32 * 1024 * 1024

# Total expansion across the archive, accumulated from bytes actually read.
# 4x the compressed ceiling: JPEGs are already compressed and deflate to about
# 1.0x, PNG-heavy archives reach maybe 2x, so 4x is slack for the honest cases
# and still 60x tighter than the naive MAX_ZIP_ENTRIES x MAX_ENTRY product.
MAX_TOTAL_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024

# Expansion factor at which an entry is treated as a bomb rather than a photo.
# JPEG, PNG and WebP are all already entropy-coded: re-deflating them yields
# ratios in the 1.0-1.2 range, and even a synthetic flat-colour PNG is tiny
# before compression rather than hugely compressible after it. 100:1 is
# unreachable for real image data and far below the 1000:1+ a zeros-bomb needs.
MAX_COMPRESSION_RATIO = 100

# Entries smaller than this skip the ratio check. Ratios on small entries are
# noise — a 40-byte stored file with a 12-byte compressed size is a ratio of 3
# and means nothing — and no bomb that matters is under a megabyte expanded.
RATIO_CHECK_MIN_BYTES = 1024 * 1024

# Longest entry name we will even consider. GCS keys stop at 1024 bytes and we
# store the name in the manifest, not in a key; 255 is the POSIX filename limit
# and anything longer came from a generator, not a camera.
MAX_ENTRY_NAME_BYTES = 255

# The end-of-central-directory record is 22 bytes plus a comment of up to
# 65535, so it lives somewhere in the last 65557 bytes of the object.
EOCD_SIGNATURE = b"PK\x05\x06"
EOCD_MIN_BYTES = 22
EOCD_MAX_SEARCH_BYTES = EOCD_MIN_BYTES + 0xFFFF

# Sentinels the EOCD uses to say "this field lives in the Zip64 record".
EOCD_ZIP64_ENTRY_SENTINEL = 0xFFFF
EOCD_ZIP64_SIZE_SENTINEL = 0xFFFFFFFF

# Magic-byte prefixes for the three formats the service accepts, mirroring
# `app.main.ALLOWED_CONTENT_TYPES`. WebP is a RIFF container, so its marker
# sits at offset 8 rather than 0 and is handled separately.
IMAGE_MAGIC: tuple[tuple[bytes, str], ...] = (
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
)
WEBP_RIFF_PREFIX = b"RIFF"
WEBP_FORM_TYPE = b"WEBP"
WEBP_HEADER_BYTES = 12

# File extension written for each accepted type, used to name the output object.
EXTENSION_BY_CONTENT_TYPE = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}

# Archive members every macOS and Windows zip carries and no user ever meant to
# upload. Dropped silently rather than reported as failures — a manifest listing
# 200 successes and 200 `__MACOSX` rejections is noise, not diagnostics.
IGNORED_NAME_PREFIXES = ("__MACOSX/",)
IGNORED_BASENAMES = frozenset({".DS_Store", "Thumbs.db", "desktop.ini"})
IGNORED_BASENAME_PREFIXES = ("._",)

_DRIVE_LETTER_RE = re.compile(r"^[A-Za-z]:")
_UNIX_MODE_FORMAT_MASK = 0xF000
_UNIX_MODE_SYMLINK = 0xA000
_ZIP_FLAG_ENCRYPTED = 0x1


class ZipRejectedError(Exception):
    """The archive as a whole is unusable. Carries a stable machine reason."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class DirectoryInfo:
    """What the end-of-central-directory record declares, pre-parse."""

    entry_count: int
    directory_bytes: int


@dataclass(frozen=True)
class ZipMember:
    """One archive member after the guards have run.

    Accepted members carry `data` and `content_type`; rejected ones carry
    `reason` and no bytes. `index` is the member's ordinal among non-ignored
    entries, i.e. **zip order**, which `app.pairing.pair_batch` reads as scan
    order and `app.jobs.layout` uses to name the output object.
    """

    index: int
    name: str
    data: bytes | None = None
    content_type: str | None = None
    reason: str | None = None

    @property
    def accepted(self) -> bool:
        return self.data is not None


def sniff_image_type(data: bytes) -> str | None:
    """Identify an image by magic bytes, or None if it is not one we accept.

    A zip entry has no Content-Type header to consult, and a filename extension
    is a claim rather than evidence. This looks at the bytes.
    """
    for prefix, content_type in IMAGE_MAGIC:
        if data.startswith(prefix):
            return content_type
    if (
        len(data) >= WEBP_HEADER_BYTES
        and data.startswith(WEBP_RIFF_PREFIX)
        and data[8:12] == WEBP_FORM_TYPE
    ):
        return "image/webp"
    return None


def read_central_directory_info(stream: BinaryIO, object_size: int) -> DirectoryInfo:
    """Read the EOCD record and enforce the two pre-parse ceilings.

    Runs before `zipfile.ZipFile` touches the stream. See this module's
    docstring for why that ordering is the point.
    """
    if object_size < EOCD_MIN_BYTES:
        raise ZipRejectedError("not_a_zip")

    window = min(object_size, EOCD_MAX_SEARCH_BYTES)
    stream.seek(object_size - window)
    tail = stream.read(window)

    offset = tail.rfind(EOCD_SIGNATURE)
    if offset < 0:
        raise ZipRejectedError("missing_central_directory")
    if len(tail) - offset < EOCD_MIN_BYTES:
        raise ZipRejectedError("truncated_central_directory")

    entry_count = struct.unpack_from("<H", tail, offset + 10)[0]
    directory_bytes = struct.unpack_from("<I", tail, offset + 12)[0]

    if entry_count == EOCD_ZIP64_ENTRY_SENTINEL or directory_bytes == EOCD_ZIP64_SIZE_SENTINEL:
        # Zip64 is only needed past 65534 entries or a 4 GB directory, and both
        # are far outside what MAX_INPUT_OBJECT_BYTES and MAX_ZIP_ENTRIES
        # permit. A legitimate batch never sets these sentinels; an archive
        # that does is trying to move the ceilings out of this record's reach.
        raise ZipRejectedError("zip64_not_supported")
    if entry_count > MAX_ZIP_ENTRIES:
        raise ZipRejectedError("too_many_entries")
    if directory_bytes > MAX_CENTRAL_DIRECTORY_BYTES:
        raise ZipRejectedError("central_directory_too_large")

    return DirectoryInfo(entry_count=entry_count, directory_bytes=directory_bytes)


def _is_ignorable(info: zipfile.ZipInfo) -> bool:
    """Archive furniture that is neither an image nor worth reporting."""
    if info.is_dir():
        return True
    name = info.filename
    if any(name.startswith(prefix) for prefix in IGNORED_NAME_PREFIXES):
        return True
    basename = name.rsplit("/", 1)[-1]
    if basename in IGNORED_BASENAMES:
        return True
    return any(basename.startswith(prefix) for prefix in IGNORED_BASENAME_PREFIXES)


def _name_rejection(name: str) -> str | None:
    """Reason this entry name is unsafe, or None if it is fine."""
    if not name:
        return "empty_entry_name"
    if len(name.encode("utf-8", errors="replace")) > MAX_ENTRY_NAME_BYTES:
        return "entry_name_too_long"
    if any(char < " " for char in name):
        # Covers NUL specifically, and every other control character with it.
        return "entry_name_control_character"
    if "\\" in name:
        return "entry_name_backslash"
    if name.startswith("/"):
        return "absolute_entry_name"
    if _DRIVE_LETTER_RE.match(name):
        return "drive_letter_entry_name"
    if ".." in name.split("/"):
        return "entry_name_traversal"
    return None


def _metadata_rejection(info: zipfile.ZipInfo) -> str | None:
    """Reason this entry is unusable, judged from its header alone."""
    name_reason = _name_rejection(info.filename)
    if name_reason is not None:
        return name_reason
    if info.external_attr >> 16 & _UNIX_MODE_FORMAT_MASK == _UNIX_MODE_SYMLINK:
        return "symlink_entry"
    if info.flag_bits & _ZIP_FLAG_ENCRYPTED:
        return "encrypted_entry"
    if info.file_size > MAX_ENTRY_UNCOMPRESSED_BYTES:
        # A declared oversize saves us the read. A *lying* header is caught
        # after the fact by the bounded read below.
        return "entry_too_large"
    return None


def _check_ratio(info: zipfile.ZipInfo, actual_bytes: int) -> None:
    if actual_bytes < RATIO_CHECK_MIN_BYTES:
        return
    ratio = actual_bytes / max(info.compress_size, 1)
    if ratio > MAX_COMPRESSION_RATIO:
        logger.warning(
            "zip: entry expanded %.0fx (%d -> %d bytes)",
            ratio,
            info.compress_size,
            actual_bytes,
        )
        raise ZipRejectedError("compression_ratio_exceeded")


def _open_archive(stream: BinaryIO, object_size: int) -> zipfile.ZipFile:
    """Run every pre-parse guard, then hand back an open archive.

    Raises `ZipRejectedError` for anything archive-level, so no caller has to
    remember the ordering: object size, then the end-of-central-directory
    ceilings, then the parse, then the parsed entry count.
    """
    if object_size > MAX_INPUT_OBJECT_BYTES:
        raise ZipRejectedError("object_too_large")

    read_central_directory_info(stream, object_size)
    stream.seek(0)

    try:
        archive = zipfile.ZipFile(stream)
    except (zipfile.BadZipFile, OSError) as exc:
        raise ZipRejectedError("not_a_zip") from exc

    if len(archive.infolist()) > MAX_ZIP_ENTRIES:
        # The EOCD count is a claim like any other header field. This is the
        # same ceiling re-checked against what was actually parsed.
        archive.close()
        raise ZipRejectedError("too_many_entries")

    return archive


def count_candidate_entries(stream: BinaryIO, *, object_size: int) -> int:
    """How many members `iter_zip_members` will yield, without reading any of them.

    Costs one central-directory parse and no decompression. The job needs a
    denominator for its progress counter before it starts spending 2-3s per
    image, and the alternative — buffering every member to count them — is the
    memory blow-up the streaming read exists to avoid.
    """
    with _open_archive(stream, object_size) as archive:
        return sum(1 for info in archive.infolist() if not _is_ignorable(info))


def iter_zip_members(stream: BinaryIO, *, object_size: int) -> Iterator[ZipMember]:
    """Yield every candidate image in the archive, in zip order.

    Args:
        stream: a seekable read stream over the zip object.
        object_size: the object's size from storage metadata, used to locate
            the end-of-central-directory record and checked against
            `MAX_INPUT_OBJECT_BYTES` before anything is parsed.

    Yields:
        `ZipMember` per non-ignored entry — accepted ones carrying decompressed
        bytes and a sniffed content type, rejected ones carrying a reason.

    Raises:
        ZipRejectedError: the archive as a whole is unusable or hostile.
    """
    with _open_archive(stream, object_size) as archive:
        index = 0
        total_bytes = 0

        for info in archive.infolist():
            if _is_ignorable(info):
                continue

            reason = _metadata_rejection(info)
            if reason is not None:
                yield ZipMember(index=index, name=info.filename, reason=reason)
                index += 1
                continue

            try:
                with archive.open(info) as handle:
                    data = handle.read(MAX_ENTRY_UNCOMPRESSED_BYTES + 1)
            except (zipfile.BadZipFile, RuntimeError, OSError, NotImplementedError) as exc:
                logger.warning("zip: entry unreadable (%s): %s", info.filename, exc)
                yield ZipMember(index=index, name=info.filename, reason="entry_unreadable")
                index += 1
                continue

            total_bytes += len(data)
            _check_ratio(info, len(data))
            if total_bytes > MAX_TOTAL_UNCOMPRESSED_BYTES:
                raise ZipRejectedError("total_uncompressed_too_large")

            if len(data) > MAX_ENTRY_UNCOMPRESSED_BYTES:  # pragma: no cover - see below
                # The header understated it. Same ceiling, enforced on bytes.
                #
                # Unreachable with CPython's zipfile as it stands: `ZipExtFile`
                # stops decompressing at the entry's declared `file_size`, so a
                # header that lies *small* truncates the attacker's own payload
                # and one that lies large was already refused by
                # `_metadata_rejection`. Kept because that is an implementation
                # detail of the standard library, not a guarantee, and this is
                # the check that would hold if it changed.
                yield ZipMember(index=index, name=info.filename, reason="entry_too_large")
                index += 1
                continue

            content_type = sniff_image_type(data)
            if content_type is None:
                yield ZipMember(index=index, name=info.filename, reason="unsupported_image_type")
                index += 1
                continue

            yield ZipMember(
                index=index,
                name=info.filename,
                data=data,
                content_type=content_type,
            )
            index += 1
