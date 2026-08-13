"""Unit tests for app.jobs.runner — the zip batch pipeline.

Covers, in rough order of how much they matter:

- **The identity spend.** The cascade must never classify (a `classify_card`
  bound into `app.cropper` that raises proves it), and `pair_batch`'s resolver
  must be called lazily and only for images adjacency could not claim. A
  fully-alternating batch costs zero Haiku calls; an ambiguous one costs one
  per unclaimed image, never one per image.
- **Partial failure.** A rejected member, an image that blows up mid-cascade
  and an unreadable one are each recorded and the rest of the batch completes.
- Output objects, the manifest's shape, the status log's progression, EXIF
  normalisation running before the cascade, rotation being applied to the bytes
  written, and the archive-level rejection path.

Everything external is stubbed: storage is the in-memory fake, Vision is a
lookup keyed on the exact image bytes, and Anthropic is a counter.
"""

from __future__ import annotations

import io
import json
import os
import zipfile

import pytest
from PIL import Image

from app import cropper
from app.classify import ClassifyResult
from app.jobs import layout, runner
from app.jobs.gcs import ObjectStore
from app.jobs.state import JobStatusLog, new_status
from app.orient import OrientationResult
from app.pairing import ADJACENCY_CONFIDENCE_MARGIN, TEXT_COUNT_BACK_THRESHOLD
from tests.unit._fake_gcs import FakeStorageClient

BUCKET = "neonbinder-placeholder-uploads-test"
USER = "user_2abcDEF123"
JOB = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"

# Text counts clear of the adjacency pre-pass's ambiguous band in either
# direction, and one sitting inside it. Derived from the production constants
# so a change to either moves these with it.
FRONT_WORDS = TEXT_COUNT_BACK_THRESHOLD - 1 - ADJACENCY_CONFIDENCE_MARGIN
BACK_WORDS = TEXT_COUNT_BACK_THRESHOLD + ADJACENCY_CONFIDENCE_MARGIN
AMBIGUOUS_WORDS = TEXT_COUNT_BACK_THRESHOLD


def card_jpeg(seed: int, size: tuple[int, int] = (500, 700)) -> bytes:
    """A card-shaped, high-variance JPEG the validator will accept."""
    img = Image.frombytes("RGB", size, os.urandom(size[0] * size[1] * 3))
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=85)
    return out.getvalue()


def build_zip(entries: list[tuple[str, bytes]]) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, payload in entries:
            archive.writestr(name, payload)
    return out.getvalue()


class Batch:
    """A zip's worth of synthesized images plus their intended text counts."""

    def __init__(self) -> None:
        self.entries: list[tuple[str, bytes]] = []
        self.text_counts: dict[bytes, int] = {}

    def add_image(self, name: str, text_count: int) -> bytes:
        payload = card_jpeg(len(self.entries))
        self.entries.append((name, payload))
        self.text_counts[payload] = text_count
        return payload

    def add_raw(self, name: str, payload: bytes) -> None:
        self.entries.append((name, payload))

    def zip_bytes(self) -> bytes:
        return build_zip(self.entries)


@pytest.fixture
def client() -> FakeStorageClient:
    return FakeStorageClient()


@pytest.fixture
def store(client: FakeStorageClient) -> ObjectStore:
    return ObjectStore(client=client)


@pytest.fixture
def no_server_strategies(monkeypatch):
    """Every server-side cropper declines, so stage 1 decides every image."""
    monkeypatch.setattr("app.cropper.pil_trim.trim_dark", lambda _b: None)
    monkeypatch.setattr("app.cropper.pil_trim.trim_light", lambda _b: None)
    monkeypatch.setattr("app.cropper.sam.sam_crop", lambda _b: None)
    monkeypatch.setattr("app.cropper.haiku_bbox.haiku_bbox_crop", lambda _b: None)


@pytest.fixture
def classify_must_not_be_called(monkeypatch):
    """Bind a landmine where the cascade's Haiku call would be.

    This is the test that keeps the whole cost model honest: if anyone ever
    drops `classify=cropper.skip_classify` from the pipeline, every runner test
    fails loudly rather than quietly costing 400 Haiku calls a batch.
    """

    def _boom(_image_bytes):
        raise AssertionError("the cascade must not classify inside a zip job")

    monkeypatch.setattr(cropper, "classify_card", _boom)


@pytest.fixture
def stub_vision(monkeypatch):
    """Vision, as a lookup keyed on the exact image bytes."""

    def _install(batch: Batch, *, default: int = 1) -> list[bytes]:
        seen: list[bytes] = []

        def _fake(image_bytes: bytes) -> OrientationResult:
            seen.append(image_bytes)
            return OrientationResult(
                rotation_degrees=0,
                confidence=1.0,
                text_count=batch.text_counts.get(image_bytes, default),
            )

        monkeypatch.setattr(cropper, "detect_orientation", _fake)
        return seen

    return _install


@pytest.fixture
def stub_resolver_classify(monkeypatch):
    """Anthropic, as a counter — this is what `resolver_calls` is measuring."""

    def _install(result: ClassifyResult | None = None) -> list[bytes]:
        calls: list[bytes] = []

        def _fake(image_bytes: bytes) -> ClassifyResult:
            calls.append(image_bytes)
            return result or ClassifyResult(
                players=[], team=None, card_number=None, side="front", raw_text="{}"
            )

        monkeypatch.setattr(runner, "classify_card", _fake)
        return calls

    return _install


def run(store: ObjectStore, client: FakeStorageClient, batch: Batch):
    client.seed(BUCKET, layout.input_object(USER, JOB), batch.zip_bytes())
    status = new_status(USER, JOB)
    JobStatusLog(store, bucket=BUCKET, user_id=USER, job_id=JOB).write(status)
    return runner.run_job(user_id=USER, job_id=JOB, bucket=BUCKET, store=store, status=status)


def manifest_of(client: FakeStorageClient) -> dict:
    return json.loads(client.read(BUCKET, layout.manifest_object(USER, JOB)))


class TestIdentitySpend:
    def test_a_fully_alternating_batch_costs_no_identity_calls(
        self,
        client,
        store,
        no_server_strategies,
        classify_must_not_be_called,
        stub_vision,
        monkeypatch,
    ):
        batch = Batch()
        for index in range(8):
            batch.add_image(f"IMG_{index}.jpg", FRONT_WORDS if index % 2 == 0 else BACK_WORDS)
        stub_vision(batch)

        def _resolver_boom(_image_bytes):
            raise AssertionError("adjacency should have paired every image for free")

        monkeypatch.setattr(runner, "classify_card", _resolver_boom)

        status = run(store, client, batch)

        # The headline property: a scanner's alternating output pairs entirely
        # from the Vision text counts the cascade had already paid for.
        assert status.state == "succeeded"
        assert status.pairs == 4
        assert status.resolver_calls == 0

    def test_ambiguous_images_cost_one_call_each_not_one_per_image(
        self,
        client,
        store,
        no_server_strategies,
        classify_must_not_be_called,
        stub_vision,
        stub_resolver_classify,
    ):
        batch = Batch()
        # Six images: two confident pairs plus two the pre-pass cannot judge.
        for text_count in (
            FRONT_WORDS,
            BACK_WORDS,
            AMBIGUOUS_WORDS,
            AMBIGUOUS_WORDS,
            FRONT_WORDS,
            BACK_WORDS,
        ):
            batch.add_image(f"IMG_{len(batch.entries)}.jpg", text_count)
        stub_vision(batch)
        calls = stub_resolver_classify()

        status = run(store, client, batch)

        assert status.state == "succeeded"
        assert status.processed_images == 6
        # Only the two ambiguous images were ever sent to Haiku. Eager
        # classification would have been six calls.
        assert status.resolver_calls == 2
        assert len(calls) == 2

    def test_the_resolver_reads_the_written_output_object(
        self,
        client,
        store,
        no_server_strategies,
        classify_must_not_be_called,
        stub_vision,
        stub_resolver_classify,
    ):
        batch = Batch()
        payload = batch.add_image("only.jpg", AMBIGUOUS_WORDS)
        stub_vision(batch)
        calls = stub_resolver_classify()

        run(store, client, batch)

        # Lazily fetched from storage rather than held in memory for the whole
        # batch — the difference between a few MB and a gigabyte on a 4Gi box.
        assert calls == [payload]

    def test_a_failing_resolver_degrades_rather_than_failing_the_batch(
        self,
        client,
        store,
        no_server_strategies,
        classify_must_not_be_called,
        stub_vision,
        monkeypatch,
    ):
        batch = Batch()
        for _ in range(2):
            batch.add_image(f"IMG_{len(batch.entries)}.jpg", AMBIGUOUS_WORDS)
        stub_vision(batch)

        def _boom(_image_bytes):
            raise RuntimeError("anthropic is down")

        monkeypatch.setattr(runner, "classify_card", _boom)

        status = run(store, client, batch)

        assert status.state == "succeeded"
        assert status.processed_images == 2
        assert status.resolver_calls == 2


class TestPartialFailure:
    def test_a_rejected_member_does_not_fail_the_batch(
        self, client, store, no_server_strategies, classify_must_not_be_called, stub_vision
    ):
        batch = Batch()
        batch.add_image("good_0.jpg", FRONT_WORDS)
        batch.add_raw("notes.pdf", b"%PDF-1.7 nope")
        batch.add_image("good_1.jpg", BACK_WORDS)
        stub_vision(batch)

        status = run(store, client, batch)

        assert status.state == "succeeded"
        assert status.processed_images == 2
        assert status.failed_images == 1
        failures = manifest_of(client)["failures"]
        assert [f["reason"] for f in failures] == ["unsupported_image_type"]
        assert failures[0]["entry_name"] == "notes.pdf"

    def test_an_image_that_blows_up_mid_pipeline_is_recorded(
        self,
        client,
        store,
        no_server_strategies,
        classify_must_not_be_called,
        stub_vision,
        monkeypatch,
    ):
        batch = Batch()
        poison = batch.add_image("poison.jpg", FRONT_WORDS)
        batch.add_image("fine.jpg", BACK_WORDS)
        stub_vision(batch)

        def _explode_on_one(data: bytes):
            if data == poison:
                raise RuntimeError("decoder gave up")
            return data, 1

        monkeypatch.setattr(runner, "apply_exif_orientation", _explode_on_one)

        status = run(store, client, batch)

        assert status.state == "succeeded"
        assert status.processed_images == 1
        assert status.failed_images == 1
        failures = manifest_of(client)["failures"]
        assert failures[0]["entry_name"] == "poison.jpg"
        assert failures[0]["reason"] == "crop_failed"

    def test_a_batch_where_nothing_survives_is_a_failure(
        self, client, store, no_server_strategies, classify_must_not_be_called, stub_vision
    ):
        batch = Batch()
        batch.add_raw("a.pdf", b"%PDF-1.7")
        batch.add_raw("b.pdf", b"%PDF-1.7")
        stub_vision(batch)

        status = run(store, client, batch)

        assert status.state == "failed"
        assert status.error_code == "no_processable_images"
        # The manifest is still written so the caller can see why.
        assert len(manifest_of(client)["failures"]) == 2

    def test_a_rejected_archive_fails_the_job_with_its_reason(self, client, store):
        client.seed(BUCKET, layout.input_object(USER, JOB), b"this is not a zip file at all")
        status = new_status(USER, JOB)
        JobStatusLog(store, bucket=BUCKET, user_id=USER, job_id=JOB).write(status)

        final = runner.run_job(user_id=USER, job_id=JOB, bucket=BUCKET, store=store, status=status)

        assert final.state == "failed"
        assert final.error_code == "zip_rejected"
        assert final.error_detail == "missing_central_directory"

    def test_a_missing_input_object_fails_the_job(self, client, store):
        status = new_status(USER, JOB)
        JobStatusLog(store, bucket=BUCKET, user_id=USER, job_id=JOB).write(status)

        final = runner.run_job(user_id=USER, job_id=JOB, bucket=BUCKET, store=store, status=status)

        assert final.state == "failed"
        assert final.error_code == "input_missing"

    def test_an_unexpected_failure_still_reaches_a_terminal_status(
        self, client, store, monkeypatch
    ):
        batch = Batch()
        batch.add_image("a.jpg", FRONT_WORDS)
        monkeypatch.setattr(
            runner,
            "count_candidate_entries",
            lambda *a, **k: (_ for _ in ()).throw(RuntimeError("unexpected")),
        )

        status = run(store, client, batch)

        assert status.state == "failed"
        assert status.error_code == "internal_error"


class TestOutputsAndManifest:
    @pytest.fixture(autouse=True)
    def _stubs(self, no_server_strategies, classify_must_not_be_called):
        return None

    def test_writes_one_output_object_per_processed_image(self, client, store, stub_vision):
        batch = Batch()
        batch.add_image("a.jpg", FRONT_WORDS)
        batch.add_image("b.jpg", BACK_WORDS)
        stub_vision(batch)

        run(store, client, batch)

        assert layout.output_image_object(USER, JOB, 0, "jpg") in client.names(BUCKET)
        assert layout.output_image_object(USER, JOB, 1, "jpg") in client.names(BUCKET)

    def test_output_keys_come_from_the_zip_ordinal_not_the_name(self, client, store, stub_vision):
        batch = Batch()
        batch.add_raw("../escape.jpg", card_jpeg(0))
        batch.add_image("ordinary.jpg", FRONT_WORDS)
        stub_vision(batch)

        run(store, client, batch)

        # The hostile member was refused, and the one that was written landed
        # at its ordinal — nothing anywhere near the name it asked for.
        assert layout.output_image_object(USER, JOB, 1, "jpg") in client.names(BUCKET)
        assert not any("escape" in name for name in client.names(BUCKET))

    def test_manifest_records_the_batch(self, client, store, stub_vision):
        batch = Batch()
        batch.add_image("front.jpg", FRONT_WORDS)
        batch.add_image("back.jpg", BACK_WORDS)
        stub_vision(batch)

        status = run(store, client, batch)
        manifest = manifest_of(client)

        assert manifest["manifest_version"] == runner.MANIFEST_VERSION
        assert manifest["job_id"] == JOB
        assert manifest["user_id"] == USER
        assert manifest["counts"] == {
            "images": 2,
            "processed": 2,
            "failed": 0,
            "pairs": 1,
            "unpaired": 0,
            "resolver_calls": 0,
        }
        assert status.manifest_uri.endswith(layout.manifest_object(USER, JOB))

    def test_manifest_states_the_rotation_convention(self, client, store, stub_vision):
        batch = Batch()
        batch.add_image("a.jpg", FRONT_WORDS)
        stub_vision(batch)

        run(store, client, batch)
        manifest = manifest_of(client)

        # The service reports CCW and sharp.rotate is CW, so the convention is
        # stated rather than left to a reader to infer.
        assert manifest["rotation_convention"] == "ccw"
        assert manifest["images"][0]["rotation_applied"] is True

    def test_manifest_pairs_point_at_output_keys(self, client, store, stub_vision):
        batch = Batch()
        batch.add_image("front.jpg", FRONT_WORDS)
        batch.add_image("back.jpg", BACK_WORDS)
        stub_vision(batch)

        run(store, client, batch)
        [pair] = manifest_of(client)["pairs"]

        assert pair["mechanism"] == "adjacency"
        assert pair["front"]["output_key"] == layout.output_image_object(USER, JOB, 0, "jpg")
        assert pair["back"]["output_key"] == layout.output_image_object(USER, JOB, 1, "jpg")
        assert pair["front"]["entry_name"] == "front.jpg"
        assert pair["front"]["identity_resolved"] is False

    def test_manifest_lists_unpaired_images(self, client, store, stub_vision):
        batch = Batch()
        batch.add_image("lonely.jpg", FRONT_WORDS)
        stub_vision(batch)

        run(store, client, batch)
        manifest = manifest_of(client)

        assert manifest["counts"]["pairs"] == 0
        assert [card["entry_name"] for card in manifest["unpaired"]] == ["lonely.jpg"]

    def test_rotation_is_applied_to_the_written_bytes(self, client, store, monkeypatch):
        batch = Batch()
        payload = batch.add_image("sideways.jpg", FRONT_WORDS)

        def _fake(image_bytes: bytes) -> OrientationResult:
            return OrientationResult(rotation_degrees=90, confidence=1.0, text_count=FRONT_WORDS)

        monkeypatch.setattr(cropper, "detect_orientation", _fake)

        run(store, client, batch)

        written = client.read(BUCKET, layout.output_image_object(USER, JOB, 0, "jpg"))
        with Image.open(io.BytesIO(payload)) as before, Image.open(io.BytesIO(written)) as after:
            assert after.size == (before.size[1], before.size[0])

    def test_exif_orientation_is_applied_before_the_cascade(self, client, store, stub_vision):
        batch = Batch()
        source = Image.frombytes("RGB", (700, 500), os.urandom(700 * 500 * 3))
        exif = source.getexif()
        exif[0x0112] = 6  # rotate 90 for display
        out = io.BytesIO()
        source.save(out, format="JPEG", quality=85, exif=exif)
        batch.add_raw("phone.jpg", out.getvalue())
        stub_vision(batch, default=FRONT_WORDS)

        run(store, client, batch)
        manifest = manifest_of(client)

        assert manifest["images"][0]["exif_orientation"] == 6
        written = client.read(BUCKET, layout.output_image_object(USER, JOB, 0, "jpg"))
        with Image.open(io.BytesIO(written)) as img:
            # Landscape-stored, portrait once the EXIF tag is honoured.
            assert img.size == (500, 700)


class TestStatusProgression:
    def test_the_log_walks_queued_running_succeeded(
        self, client, store, no_server_strategies, classify_must_not_be_called, stub_vision
    ):
        batch = Batch()
        for index in range(2):
            batch.add_image(f"{index}.jpg", FRONT_WORDS if index % 2 == 0 else BACK_WORDS)
        stub_vision(batch)

        run(store, client, batch)

        states = [
            json.loads(client.read(BUCKET, name))["state"]
            for name in sorted(client.names(BUCKET))
            if name.startswith(layout.status_prefix(USER, JOB))
        ]
        assert states[0] == "queued"
        assert states[1] == "running"
        assert states[-1] == "succeeded"

    def test_total_images_is_known_before_any_image_is_processed(
        self, client, store, no_server_strategies, classify_must_not_be_called, stub_vision
    ):
        batch = Batch()
        for index in range(3):
            batch.add_image(f"{index}.jpg", FRONT_WORDS)
        stub_vision(batch)

        run(store, client, batch)

        running = json.loads(client.read(BUCKET, layout.status_object(USER, JOB, 1)))
        assert running["state"] == "running"
        assert running["total_images"] == 3
        assert running["processed_images"] == 0


class TestBuildManifest:
    def test_is_json_serialisable_with_no_records(self):
        from app.pairing import BatchResult

        manifest = runner.build_manifest(
            user_id=USER,
            job_id=JOB,
            records=[],
            failures=[],
            batch=BatchResult(),
            started_at=1,
            completed_at=2,
        )
        assert json.loads(json.dumps(manifest))["counts"]["images"] == 0


class TestDegradedWrites:
    def test_an_output_the_service_cannot_identify_is_recorded(
        self,
        client,
        store,
        no_server_strategies,
        classify_must_not_be_called,
        stub_vision,
        monkeypatch,
    ):
        batch = Batch()
        batch.add_image("a.jpg", FRONT_WORDS)
        stub_vision(batch)
        monkeypatch.setattr(runner, "sniff_image_type", lambda _b: None)

        status = run(store, client, batch)

        assert status.state == "failed"
        assert manifest_of(client)["failures"][0]["reason"] == "unsupported_output_type"

    def test_a_failure_status_that_cannot_be_written_leaves_the_log_quiet(self, client, store):
        # The last-resort path: the job has failed AND the failure snapshot's
        # sequence is already taken. Nothing is raised at the caller — the log
        # simply stops advancing, and derive_state reports it stalled.
        status = new_status(USER, JOB)
        log = JobStatusLog(store, bucket=BUCKET, user_id=USER, job_id=JOB)
        log.write(status)
        log.write(status.advance(state="running"))

        final = runner.run_job(user_id=USER, job_id=JOB, bucket=BUCKET, store=store, status=status)

        assert final is status
        assert final.state == "queued"
