"""Unit tests for app.jobs.state — the append-only job status log.

Covers: snapshot immutability and `advance()` sequencing, JSON round-tripping
(including a snapshot written by a future version carrying unknown fields), the
compare-and-swap property that makes a duplicate submission collide on sequence
0, `latest()` picking the numerically newest snapshot out of a lexicographic
listing, an unreadable snapshot degrading to None rather than raising, and the
read-time-only `stalled` derivation.

Driven against the real `ObjectStore` over the in-memory fake in `_fake_gcs`,
so the `if_generation_match=0` precondition is genuinely exercised.
"""

from __future__ import annotations

import json

import pytest

from app.jobs import layout
from app.jobs.gcs import ObjectAlreadyExistsError, ObjectRef, ObjectStore
from app.jobs.state import (
    PROGRESS_CHECKPOINT_IMAGES,
    STALE_AFTER_MS,
    STALLED_STATE,
    TERMINAL_STATES,
    JobStatus,
    JobStatusLog,
    derive_state,
    new_status,
    now_ms,
)
from tests.unit._fake_gcs import FakeStorageClient

BUCKET = "neonbinder-placeholder-uploads-test"
USER = "user_2abcDEF123"
JOB = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"


@pytest.fixture
def client() -> FakeStorageClient:
    return FakeStorageClient()


@pytest.fixture
def log(client: FakeStorageClient) -> JobStatusLog:
    return JobStatusLog(ObjectStore(client=client), bucket=BUCKET, user_id=USER, job_id=JOB)


class TestJobStatus:
    def test_new_status_is_queued_at_sequence_zero(self):
        status = new_status(USER, JOB)
        assert status.state == "queued"
        assert status.sequence == 0
        assert status.created_at == status.updated_at
        assert not status.is_terminal

    def test_is_frozen(self):
        with pytest.raises(AttributeError):
            new_status(USER, JOB).state = "succeeded"  # type: ignore[misc]

    def test_advance_bumps_the_sequence_and_the_clock(self):
        first = JobStatus(job_id=JOB, user_id=USER, state="queued", updated_at=1)
        second = first.advance(state="running", total_images=12)
        assert second.sequence == 1
        assert second.state == "running"
        assert second.total_images == 12
        assert second.updated_at > 1
        # The original is untouched — the whole point of a snapshot log.
        assert first.state == "queued"
        assert first.sequence == 0

    def test_advance_preserves_created_at(self):
        first = new_status(USER, JOB)
        assert first.advance(state="running").created_at == first.created_at

    @pytest.mark.parametrize("state", sorted(TERMINAL_STATES))
    def test_terminal_states(self, state):
        assert JobStatus(job_id=JOB, user_id=USER, state=state).is_terminal

    @pytest.mark.parametrize("state", ["queued", "running"])
    def test_non_terminal_states(self, state):
        assert not JobStatus(job_id=JOB, user_id=USER, state=state).is_terminal

    def test_round_trips_through_json(self):
        original = new_status(USER, JOB).advance(
            state="succeeded",
            total_images=4,
            processed_images=3,
            failed_images=1,
            pairs=1,
            unmatched=1,
            resolver_calls=2,
            manifest_uri=f"gs://{BUCKET}/x/manifest.json",
            error_code=None,
        )
        assert JobStatus.from_dict(json.loads(json.dumps(original.to_dict()))) == original

    def test_unknown_fields_are_ignored(self):
        # A snapshot written by a newer revision must not break an older one
        # reading it — instances of both can be live during a rollout.
        payload = new_status(USER, JOB).to_dict() | {"a_field_from_the_future": 7}
        assert JobStatus.from_dict(payload).job_id == JOB


class TestDeriveState:
    @pytest.mark.parametrize("state", sorted(TERMINAL_STATES))
    def test_terminal_states_are_reported_as_written(self, state):
        status = JobStatus(job_id=JOB, user_id=USER, state=state, updated_at=0)
        assert derive_state(status, at_ms=now_ms()) == state

    @pytest.mark.parametrize("state", ["queued", "running"])
    def test_recent_non_terminal_states_pass_through(self, state):
        status = JobStatus(job_id=JOB, user_id=USER, state=state, updated_at=1_000_000)
        assert derive_state(status, at_ms=1_000_000 + STALE_AFTER_MS) == state

    @pytest.mark.parametrize("state", ["queued", "running"])
    def test_quiet_non_terminal_states_read_as_stalled(self, state):
        status = JobStatus(job_id=JOB, user_id=USER, state=state, updated_at=1_000_000)
        assert derive_state(status, at_ms=1_000_000 + STALE_AFTER_MS + 1) == STALLED_STATE

    def test_defaults_to_the_current_clock(self):
        status = JobStatus(job_id=JOB, user_id=USER, state="running", updated_at=0)
        assert derive_state(status) == STALLED_STATE


class TestJobStatusLog:
    def test_write_lands_at_the_sequence_key(self, client, log):
        log.write(new_status(USER, JOB))
        assert client.names(BUCKET) == [layout.status_object(USER, JOB, 0)]

    def test_a_second_write_at_the_same_sequence_is_refused(self, log):
        status = new_status(USER, JOB)
        log.write(status)
        with pytest.raises(ObjectAlreadyExistsError):
            log.write(status)

    def test_latest_is_none_for_an_unknown_job(self, log):
        assert log.latest() is None

    def test_latest_returns_the_newest_snapshot(self, log):
        status = log.write(new_status(USER, JOB))
        for _ in range(12):
            status = log.write(status.advance(state="running"))
        latest = log.latest()
        assert latest is not None
        assert latest.sequence == 12
        assert latest.state == "running"

    def test_latest_orders_numerically_not_by_string_length(self, log):
        # 10 sorts before 9 lexicographically unless the names are padded to a
        # fixed width, which is exactly why they are.
        status = log.write(new_status(USER, JOB))
        for sequence in range(1, 11):
            status = log.write(status.advance(processed_images=sequence))
        latest = log.latest()
        assert latest is not None
        assert latest.processed_images == 10

    def test_history_is_preserved(self, client, log):
        status = log.write(new_status(USER, JOB))
        log.write(status.advance(state="running"))
        # Append-only: the queued snapshot is still there to audit.
        assert len(client.names(BUCKET)) == 2

    def test_unreadable_snapshot_degrades_to_none(self, client, log):
        client.seed(BUCKET, layout.status_object(USER, JOB, 0), b"{not json", "application/json")
        assert log.latest() is None

    def test_ignores_objects_outside_the_status_prefix(self, client, log):
        log.write(new_status(USER, JOB))
        client.seed(BUCKET, layout.manifest_object(USER, JOB), b"{}", "application/json")
        latest = log.latest()
        assert latest is not None
        assert latest.sequence == 0

    def test_snapshots_are_stored_as_json(self, client, log):
        log.write(new_status(USER, JOB))
        payload = json.loads(client.read(BUCKET, layout.status_object(USER, JOB, 0)))
        assert payload["state"] == "queued"
        assert payload["job_id"] == JOB

    def test_reads_do_not_pull_an_arbitrary_object_into_memory(self, client, log):
        # The status prefix is inside the same bucket every other job writes
        # to, so `latest()` caps what it will download.
        from app.jobs.gcs import ObjectTooLargeError
        from app.jobs.state import MAX_STATUS_OBJECT_BYTES

        client.seed(
            BUCKET,
            layout.status_object(USER, JOB, 0),
            b"x" * (MAX_STATUS_OBJECT_BYTES + 1),
            "application/json",
        )
        with pytest.raises(ObjectTooLargeError):
            log.latest()


class TestCheckpointInterval:
    def test_is_a_useful_fraction_of_a_batch(self):
        # Documented trade-off: each checkpoint is one ~100ms write against
        # 2-3s per image, so the interval has to stay small enough to keep a
        # progress bar honest and large enough not to dominate the job.
        assert 1 < PROGRESS_CHECKPOINT_IMAGES <= 25

    def test_stale_window_clears_a_full_checkpoint_interval(self):
        # A cold start plus a slow checkpoint interval is the worst legitimate
        # gap; the stale window must be comfortably above it or the UI will
        # show "stalled" on a healthy job.
        worst_legitimate_gap_ms = 15_000 + PROGRESS_CHECKPOINT_IMAGES * 5_000
        assert STALE_AFTER_MS > worst_legitimate_gap_ms * 3


class TestRefHelper:
    def test_status_objects_live_under_the_job_prefix(self, client, log):
        log.write(new_status(USER, JOB))
        ref = ObjectRef(bucket=BUCKET, name=client.names(BUCKET)[0])
        assert ref.name.startswith(layout.status_prefix(USER, JOB))
