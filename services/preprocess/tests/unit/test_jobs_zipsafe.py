"""Unit tests for app.jobs.zipsafe — the hostile-archive guards.

Covers the three attack classes the module is built against:

- **Zip bombs**: the pre-parse end-of-central-directory ceilings (declared
  entry count, declared directory size, Zip64 sentinels), the post-parse entry
  count re-check against a *lying* EOCD, the running total of actual
  decompressed bytes, and the compression-ratio check against a real deflate
  bomb rather than a mocked one.
- **Zip slip**: every traversal, separator, drive-letter, control-character and
  length payload, plus symlink and encrypted entries.
- **Content sniffing**: JPEG/PNG/WebP by magic bytes, and the rejection of
  anything that merely *claims* to be an image via its extension.

Plus the archive furniture (`__MACOSX/`, `.DS_Store`, AppleDouble, directory
entries) that is dropped silently, the zip-order indexing `app.pairing` depends
on, and the boundary the module shares with `app.main.MAX_IMAGE_BYTES`.

Archives are built in-test with `zipfile`; the hostile headers are produced by
rewriting the bytes of a real archive.
"""

from __future__ import annotations

import io
import os
import struct
import tracemalloc
import zipfile

import pytest
from PIL import Image

from app.jobs import zipsafe
from app.jobs.zipsafe import (
    EOCD_SIGNATURE,
    MAX_ENTRY_UNCOMPRESSED_BYTES,
    ZipRejectedError,
    count_candidate_entries,
    iter_zip_members,
    read_central_directory_info,
    sniff_image_type,
)
from app.main import MAX_IMAGE_BYTES

# Names that must never be accepted, paired with the reason each should draw.
HOSTILE_NAMES = [
    ("", "empty_entry_name"),
    ("../escape.jpg", "entry_name_traversal"),
    ("a/../../escape.jpg", "entry_name_traversal"),
    ("/absolute.jpg", "absolute_entry_name"),
    ("C:/windows/system32/x.jpg", "drive_letter_entry_name"),
    ("dir\\sub\\photo.jpg", "entry_name_backslash"),
    ("photo\x00.jpg", "entry_name_control_character"),
    ("photo\n.jpg", "entry_name_control_character"),
    ("photo\r.jpg", "entry_name_control_character"),
    ("photo\u007f.jpg", "entry_name_control_character"),
    ("photo\u0085.jpg", "entry_name_control_character"),
    ("photo\u2028.jpg", "entry_name_control_character"),
    ("photo\u2029.jpg", "entry_name_control_character"),
    # Bidi overrides: these render as something other than what they are, which
    # is how "photo\u202egpj.jpg" is shown to a reviewer as "photo.jpg.jpg".
    ("photo\u202a.jpg", "entry_name_control_character"),
    ("photo\u202b.jpg", "entry_name_control_character"),
    ("photo\u202c.jpg", "entry_name_control_character"),
    ("photo\u202d.jpg", "entry_name_control_character"),
    ("photo\u202egpj.jpg", "entry_name_control_character"),
    ("photo\u2066.jpg", "entry_name_control_character"),
    ("photo\u2067.jpg", "entry_name_control_character"),
    ("photo\u2068.jpg", "entry_name_control_character"),
    ("photo\u2069.jpg", "entry_name_control_character"),
    ("x" * 300 + ".jpg", "entry_name_too_long"),
    ("é" * 200 + ".jpg", "entry_name_too_long"),
]

# The subset `zipfile.writestr` will actually store verbatim — it truncates a
# name at a NUL and refuses an empty one, so those two are only reachable
# through `_name_rejection` directly.
ARCHIVABLE_HOSTILE_NAMES = [
    (name, reason) for name, reason in HOSTILE_NAMES if name and "\x00" not in name
]

# Members every macOS or Windows zip carries. Dropped without a word.
FURNITURE_NAMES = [
    "__MACOSX/._photo.jpg",
    ".DS_Store",
    "scan/.DS_Store",
    "scan/._photo.jpg",
    "Thumbs.db",
    "desktop.ini",
]


def jpeg_bytes(size: tuple[int, int] = (40, 56)) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, (120, 40, 40)).save(out, format="JPEG")
    return out.getvalue()


def png_bytes() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (40, 56), (10, 90, 10)).save(out, format="PNG")
    return out.getvalue()


def webp_bytes() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (40, 56), (10, 10, 90)).save(out, format="WEBP")
    return out.getvalue()


def build_zip(
    entries: list[tuple[str, bytes]], *, compression: int = zipfile.ZIP_DEFLATED
) -> bytes:
    """A plain archive of (name, payload) pairs, deflated unless told otherwise."""
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression) as archive:
        for name, payload in entries:
            archive.writestr(name, payload)
    return out.getvalue()


def members(data: bytes, *, object_size: int | None = None) -> list:
    stream = io.BytesIO(data)
    return list(iter_zip_members(stream, object_size=object_size or len(data)))


def zip64_bomb(entry_count: int, *, honest_eocd: bool = False) -> bytes:
    """An archive whose Zip64 record and 32-bit EOCD deliberately disagree.

    Reproduces the finding that made `MAX_CENTRAL_DIRECTORY_BYTES` inert. The
    32-bit EOCD declares one entry and a 46-byte directory — well inside every
    ceiling — while a Zip64 record twenty bytes earlier declares `entry_count`
    entries and the real directory size. CPython's `_EndRecData64` prefers the
    Zip64 record whenever the locator signature is present, with **no sentinel
    required in the 32-bit record**, so a guard reading only the 32-bit fields
    validates a number the parser never uses.
    """
    header = struct.pack(
        "<4s4B4HL2L5H2L",
        b"PK\x01\x02",
        20,
        0,
        20,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
    )
    directory = header * entry_count
    directory_bytes = len(directory)

    zip64_eocd = struct.pack(
        "<4sQ2H2L4Q",
        b"PK\x06\x06",
        44,
        45,
        45,
        0,
        0,
        entry_count,
        entry_count,
        directory_bytes,
        0,
    )
    zip64_locator = struct.pack("<4sLQL", b"PK\x06\x07", 0, directory_bytes, 1)
    declared = (entry_count, directory_bytes) if honest_eocd else (1, 46)
    eocd = struct.pack("<4s4H2LH", b"PK\x05\x06", 0, 0, declared[0], declared[0], declared[1], 0, 0)
    return directory + zip64_eocd + zip64_locator + eocd


def rewrite_eocd(
    data: bytes, *, entry_count: int | None = None, directory_bytes: int | None = None
):
    """Forge the end-of-central-directory record of a real archive.

    The EOCD is a claim like every other zip header. Rewriting it is how a
    bomb hides its size, so the guards have to be tested against a forged one
    rather than only against archives `zipfile` wrote honestly.
    """
    buffer = bytearray(data)
    offset = buffer.rfind(EOCD_SIGNATURE)
    assert offset >= 0
    if entry_count is not None:
        struct.pack_into("<H", buffer, offset + 8, entry_count)
        struct.pack_into("<H", buffer, offset + 10, entry_count)
    if directory_bytes is not None:
        struct.pack_into("<I", buffer, offset + 12, directory_bytes)
    return bytes(buffer)


class TestSniffImageType:
    @pytest.mark.parametrize(
        ("payload", "expected"),
        [
            (jpeg_bytes(), "image/jpeg"),
            (png_bytes(), "image/png"),
            (webp_bytes(), "image/webp"),
        ],
    )
    def test_recognises_the_accepted_formats(self, payload, expected):
        assert sniff_image_type(payload) == expected

    @pytest.mark.parametrize(
        "payload",
        [
            b"",
            b"RIFF",
            b"RIFF\x00\x00\x00\x00NOPE",
            b"%PDF-1.7 ...",
            b"GIF89a",
            b"#!/bin/sh\nrm -rf /\n",
            b"\xff\xd8",
        ],
    )
    def test_rejects_everything_else(self, payload):
        assert sniff_image_type(payload) is None

    def test_extension_is_not_evidence(self):
        # A zip entry has no Content-Type header and its name is a claim, so
        # the only thing that decides the type is the leading bytes.
        [member] = members(build_zip([("looks_like.jpg", b"%PDF-1.7 not a jpeg")]))
        assert member.reason == "unsupported_image_type"


class TestCentralDirectoryGuards:
    def test_reads_a_real_archive(self):
        data = build_zip([("a.jpg", jpeg_bytes()), ("b.jpg", jpeg_bytes())])
        info = read_central_directory_info(io.BytesIO(data), len(data))
        assert info.entry_count == 2
        assert 0 < info.directory_bytes <= zipsafe.MAX_CENTRAL_DIRECTORY_BYTES

    def test_object_too_small_to_be_a_zip(self):
        with pytest.raises(ZipRejectedError, match="not_a_zip"):
            read_central_directory_info(io.BytesIO(b"PK"), 2)

    def test_no_end_record(self):
        payload = b"x" * 4096
        with pytest.raises(ZipRejectedError, match="missing_central_directory"):
            read_central_directory_info(io.BytesIO(payload), len(payload))

    def test_truncated_end_record(self):
        payload = b"x" * 100 + EOCD_SIGNATURE + b"\x00" * 4
        with pytest.raises(ZipRejectedError, match="truncated_central_directory"):
            read_central_directory_info(io.BytesIO(payload), len(payload))

    def test_declared_entry_count_over_the_cap(self):
        data = rewrite_eocd(
            build_zip([("a.jpg", jpeg_bytes())]),
            entry_count=zipsafe.MAX_ZIP_ENTRIES + 1,
        )
        with pytest.raises(ZipRejectedError, match="too_many_entries"):
            read_central_directory_info(io.BytesIO(data), len(data))

    def test_declared_directory_size_over_the_cap(self):
        # This is the guard that actually bounds zipfile's allocation:
        # ZipFile.__init__ reads exactly size_cd bytes into memory.
        data = rewrite_eocd(
            build_zip([("a.jpg", jpeg_bytes())]),
            directory_bytes=zipsafe.MAX_CENTRAL_DIRECTORY_BYTES + 1,
        )
        with pytest.raises(ZipRejectedError, match="central_directory_too_large"):
            read_central_directory_info(io.BytesIO(data), len(data))

    @pytest.mark.parametrize(
        ("field", "sentinel"),
        [
            ("entry_count", zipsafe.EOCD_ZIP64_ENTRY_SENTINEL),
            ("directory_bytes", zipsafe.EOCD_ZIP64_SIZE_SENTINEL),
        ],
    )
    def test_zip64_sentinels_refused(self, field, sentinel):
        data = rewrite_eocd(build_zip([("a.jpg", jpeg_bytes())]), **{field: sentinel})
        with pytest.raises(ZipRejectedError, match="zip64_not_supported"):
            read_central_directory_info(io.BytesIO(data), len(data))

    def test_object_over_the_input_ceiling(self):
        data = build_zip([("a.jpg", jpeg_bytes())])
        with pytest.raises(ZipRejectedError, match="object_too_large"):
            members(data, object_size=zipsafe.MAX_INPUT_OBJECT_BYTES + 1)

    def test_not_a_zip_at_all(self):
        # A well-formed EOCD claiming one entry and a 46-byte directory at
        # offset 0 — which is zeros. Gets past the pre-parse ceilings and has
        # to be caught by the parse itself.
        payload = b"\x00" * 64 + EOCD_SIGNATURE + struct.pack("<HHHHIIH", 0, 0, 1, 1, 46, 0, 0)
        with pytest.raises(ZipRejectedError, match="not_a_zip"):
            members(payload)

    def test_zip64_locator_override_is_refused(self):
        # The regression that made the directory ceiling inert. The 32-bit
        # record this guard used to read declares 1 entry / 46 bytes; the Zip64
        # record CPython actually prefers declares 200000 / 9.2 MB. Without the
        # override resolution this call returns DirectoryInfo(1, 46) and
        # ZipFile then allocates ~75 MiB.
        data = zip64_bomb(200_000)
        with pytest.raises(ZipRejectedError, match="too_many_entries"):
            read_central_directory_info(io.BytesIO(data), len(data))

    def test_zip64_bomb_is_refused_before_the_allocation(self):
        # The post-parse `len(infolist())` re-check rejected this archive even
        # before the fix — but only after ZipFile had already built 200000
        # ZipInfos, which is the entire attack. So the assertion here is on
        # peak heap, not on the exception: the rejection has to happen in front
        # of the allocation, not behind it.
        data = zip64_bomb(200_000)

        tracemalloc.start()
        try:
            with pytest.raises(ZipRejectedError, match="too_many_entries"):
                members(data)
            _current, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()

        # Reading the archive at all costs one copy of it. Anything approaching
        # a multiple of that means the directory was parsed.
        assert peak < 4 * len(data)

    def test_zip64_override_directory_size_ceiling(self, monkeypatch):
        # Same override path, tripping the *size* ceiling rather than the count
        # ceiling — the one that actually bounds ZipFile's buffer.
        monkeypatch.setattr(zipsafe, "MAX_ZIP_ENTRIES", 1_000_000)
        data = zip64_bomb(100_000)
        with pytest.raises(ZipRejectedError, match="central_directory_too_large"):
            read_central_directory_info(io.BytesIO(data), len(data))

    def test_zip64_override_within_the_ceilings_is_allowed(self):
        # Not every Zip64 record is an attack. One declaring a small directory
        # must pass, or writers that emit Zip64 unconditionally break.
        data = zip64_bomb(3, honest_eocd=True)
        info = read_central_directory_info(io.BytesIO(data), len(data))
        assert info.entry_count == 3
        assert info.directory_bytes == 3 * 46

    def test_a_locator_with_no_record_falls_back_to_the_32_bit_fields(self):
        # CPython falls back when the record signature is missing, so rejecting
        # here would refuse archives it happily opens.
        data = bytearray(zip64_bomb(3, honest_eocd=True))
        at = data.find(b"PK\x06\x06")
        data[at : at + 4] = b"XXXX"
        info = read_central_directory_info(io.BytesIO(bytes(data)), len(data))
        assert info.entry_count == 3

    def test_capped_reader_bounds_the_parse_even_if_every_ceiling_is_wrong(self, monkeypatch):
        # Belt and braces. Neuter the metadata guard completely *and* raise the
        # post-parse entry ceiling out of the way, so the byte cap on the read
        # is the only thing left standing. A short read makes CPython parse
        # fewer entries or raise BadZipFile; neither can allocate past the cap,
        # whatever field this module misread to get there.
        monkeypatch.setattr(zipsafe, "read_central_directory_info", lambda *a, **k: None)
        monkeypatch.setattr(zipsafe, "MAX_ZIP_ENTRIES", 10_000_000)
        monkeypatch.setattr(zipsafe, "MAX_CENTRAL_DIRECTORY_BYTES", 4096)
        data = zip64_bomb(200_000)

        try:
            found = members(data)
        except ZipRejectedError:
            return  # BadZipFile from the truncated buffer is an acceptable outcome
        # 4096 bytes of directory holds 89 headers, not 200000.
        assert len(found) <= 4096 // 46

    def test_lying_entry_count_caught_after_the_parse(self, monkeypatch):
        # A forged EOCD that understates its entry count slips the pre-parse
        # ceiling; the same ceiling re-checked against what zipfile actually
        # parsed is what catches it.
        monkeypatch.setattr(zipsafe, "MAX_ZIP_ENTRIES", 2)
        honest = build_zip([(f"{i}.jpg", jpeg_bytes()) for i in range(3)])
        data = rewrite_eocd(honest, entry_count=1)
        with pytest.raises(ZipRejectedError, match="too_many_entries"):
            members(data)


class TestBombGuards:
    def test_compression_ratio_exceeded(self):
        # 4 MiB of zeros deflates to a couple of kilobytes: a ~2000:1 ratio,
        # which no real photo can produce.
        data = build_zip([("bomb.bin", b"\x00" * (4 * 1024 * 1024))])
        with pytest.raises(ZipRejectedError, match="compression_ratio_exceeded"):
            members(data)

    def test_small_entries_skip_the_ratio_check(self):
        # Well under RATIO_CHECK_MIN_BYTES, and highly compressible. Rejected
        # for not being an image, not treated as a bomb.
        [member] = members(build_zip([("small.bin", b"\x00" * 4096)]))
        assert member.reason == "unsupported_image_type"

    def test_large_incompressible_entry_passes_the_ratio_check(self):
        # Over RATIO_CHECK_MIN_BYTES, so the check runs — and a real photo's
        # ratio is about 1, which is the case that must not be a false positive.
        payload = b"\xff\xd8\xff" + os.urandom(2 * 1024 * 1024)
        data = build_zip([("big.jpg", payload)], compression=zipfile.ZIP_STORED)
        [member] = members(data)
        assert member.accepted
        assert member.content_type == "image/jpeg"

    def test_total_uncompressed_ceiling(self, monkeypatch):
        monkeypatch.setattr(zipsafe, "MAX_TOTAL_UNCOMPRESSED_BYTES", 10)
        data = build_zip([("a.jpg", jpeg_bytes()), ("b.jpg", jpeg_bytes())])
        with pytest.raises(ZipRejectedError, match="total_uncompressed_too_large"):
            members(data)

    def test_declared_oversize_entry_rejected_without_reading(self, monkeypatch):
        monkeypatch.setattr(zipsafe, "MAX_ENTRY_UNCOMPRESSED_BYTES", 16)
        [member] = members(build_zip([("big.jpg", jpeg_bytes())]))
        assert member.reason == "entry_too_large"
        assert member.data is None

    def test_entry_ceiling_matches_the_multipart_route(self):
        # An image /process would refuse at 32 MB must not get in through the
        # zip door instead.
        assert MAX_ENTRY_UNCOMPRESSED_BYTES == MAX_IMAGE_BYTES


class TestZipSlipGuards:
    @pytest.mark.parametrize(("name", "reason"), HOSTILE_NAMES)
    def test_name_rule_rejects_every_payload(self, name, reason):
        assert zipsafe._name_rejection(name) == reason

    @pytest.mark.parametrize("name", ["photo.jpg", "scan/front.jpg", "a b/c-d_1.JPEG", "é.jpg"])
    def test_name_rule_accepts_ordinary_names(self, name):
        assert zipsafe._name_rejection(name) is None

    @pytest.mark.parametrize(("name", "reason"), ARCHIVABLE_HOSTILE_NAMES)
    def test_hostile_names_rejected_with_a_reason(self, name, reason):
        [member] = members(build_zip([(name, jpeg_bytes())]))
        assert member.data is None
        assert member.reason == reason

    def test_a_hostile_name_does_not_fail_the_batch(self):
        # Per-entry, not fatal: one poisoned name must not cost the user their
        # other cards.
        found = members(build_zip([("../escape.jpg", jpeg_bytes()), ("ok.jpg", jpeg_bytes())]))
        assert [m.reason for m in found] == ["entry_name_traversal", None]
        assert found[1].accepted

    def test_symlink_entry_rejected(self):
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w") as archive:
            info = zipfile.ZipInfo("link.jpg")
            # 0xA1FF: S_IFLNK | 0777, the mode a zip symlink carries.
            info.external_attr = 0xA1FF << 16
            info.create_system = 3
            archive.writestr(info, "/etc/passwd")
        [member] = members(out.getvalue())
        assert member.reason == "symlink_entry"

    def test_encrypted_entry_rejected(self):
        data = bytearray(build_zip([("secret.jpg", jpeg_bytes())]))
        # Set the encrypted bit in both the local header and the central
        # directory entry; zipfile will not write one for us.
        for signature, flag_offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
            at = data.find(signature)
            assert at >= 0
            struct.pack_into("<H", data, at + flag_offset, 0x1)
        [member] = members(bytes(data))
        assert member.reason == "encrypted_entry"

    def test_unreadable_entry_is_per_entry(self):
        # An entry whose compression method zipfile cannot handle. The archive
        # is otherwise fine, so the batch carries on.
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w") as archive:
            archive.writestr("ok.jpg", jpeg_bytes())
        data = bytearray(out.getvalue())
        for signature, method_offset in ((b"PK\x03\x04", 8), (b"PK\x01\x02", 10)):
            at = data.find(signature)
            struct.pack_into("<H", data, at + method_offset, 99)
        [member] = members(bytes(data))
        assert member.reason == "entry_unreadable"


class TestMemberIteration:
    def test_accepted_members_carry_bytes_and_a_type(self):
        payload = jpeg_bytes()
        [member] = members(build_zip([("scan/front.jpg", payload)]))
        assert member.accepted
        assert member.data == payload
        assert member.content_type == "image/jpeg"
        assert member.name == "scan/front.jpg"
        assert member.reason is None

    @pytest.mark.parametrize(
        ("payload", "expected"),
        [(jpeg_bytes(), "image/jpeg"), (png_bytes(), "image/png"), (webp_bytes(), "image/webp")],
    )
    def test_every_accepted_format_round_trips(self, payload, expected):
        [member] = members(build_zip([("card.bin", payload)]))
        assert member.content_type == expected

    def test_index_is_zip_order_and_counts_rejections(self):
        # app.pairing reads the index as scan order, so a rejected member still
        # consumes its ordinal — dropping it would silently re-pair the
        # neighbours around it.
        found = members(
            build_zip(
                [
                    ("0.jpg", jpeg_bytes()),
                    ("1.pdf", b"%PDF-1.7"),
                    ("2.jpg", jpeg_bytes()),
                ]
            )
        )
        assert [m.index for m in found] == [0, 1, 2]
        assert [m.accepted for m in found] == [True, False, True]

    @pytest.mark.parametrize("name", FURNITURE_NAMES)
    def test_archive_furniture_is_dropped_silently(self, name):
        found = members(build_zip([(name, b"junk"), ("photo.jpg", jpeg_bytes())]))
        assert [m.name for m in found] == ["photo.jpg"]
        assert found[0].index == 0

    def test_directory_entries_are_dropped(self):
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w") as archive:
            archive.writestr(zipfile.ZipInfo("scan/"), b"")
            archive.writestr("scan/a.jpg", jpeg_bytes())
        found = members(out.getvalue())
        assert [m.name for m in found] == ["scan/a.jpg"]

    def test_empty_archive_yields_nothing(self):
        assert members(build_zip([])) == []


class TestCountCandidateEntries:
    def test_counts_without_decompressing(self):
        data = build_zip(
            [
                ("__MACOSX/._a.jpg", b"junk"),
                ("a.jpg", jpeg_bytes()),
                ("b.jpg", jpeg_bytes()),
                (".DS_Store", b"junk"),
            ]
        )
        assert count_candidate_entries(io.BytesIO(data), object_size=len(data)) == 2

    def test_counts_entries_that_will_be_rejected(self):
        # The progress denominator has to include images that fail, or the
        # counter never reaches its total.
        data = build_zip([("a.jpg", jpeg_bytes()), ("../escape.jpg", jpeg_bytes())])
        assert count_candidate_entries(io.BytesIO(data), object_size=len(data)) == 2

    def test_matches_what_iteration_yields(self):
        data = build_zip(
            [("a.jpg", jpeg_bytes()), ("b.pdf", b"%PDF"), ("__MACOSX/x", b"j")],
        )
        assert count_candidate_entries(io.BytesIO(data), object_size=len(data)) == len(
            members(data)
        )

    def test_applies_the_same_archive_guards(self):
        data = build_zip([("a.jpg", jpeg_bytes())])
        with pytest.raises(ZipRejectedError, match="object_too_large"):
            count_candidate_entries(
                io.BytesIO(data), object_size=zipsafe.MAX_INPUT_OBJECT_BYTES + 1
            )


class TestZip64OverrideEdges:
    def test_a_locator_with_no_room_for_its_record_is_ignored(self):
        # A locator signature can sit where a Zip64 record could not physically
        # precede it. CPython's seek fails there and it falls back to the
        # 32-bit fields, so this must too rather than reading whatever bytes
        # happen to be in front of the locator.
        locator = zipsafe.ZIP64_LOCATOR_SIGNATURE + b"\x00" * 16
        eocd = struct.pack("<4s4H2LH", b"PK\x05\x06", 0, 0, 1, 1, 46, 0, 0)
        blob = locator + eocd
        assert len(locator) < zipsafe.ZIP64_EOCD_BYTES

        info = read_central_directory_info(io.BytesIO(blob), len(blob))

        assert info.entry_count == 1
        assert info.directory_bytes == 46

    def test_bare_read_on_the_capped_stream_is_bounded(self):
        # `zipfile._EndRecData` calls `fp.read()` with no argument, which means
        # "to EOF" — the one call shape that would sail past a naive cap.
        stream = zipsafe._ReadCappedStream(io.BytesIO(b"x" * 5000), max_read_bytes=64)
        assert len(stream.read()) == 64
        stream.uncap()
        stream.seek(0)
        assert len(stream.read()) == 5000
