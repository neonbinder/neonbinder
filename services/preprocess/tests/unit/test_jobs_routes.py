"""Unit tests for the POST /jobs and GET /jobs/{job_id} wire contract.

Covers: auth, the submit happy path (202 + the background task actually being
scheduled), every refusal code and its HTTP status, `Retry-After` on the
retryable ones, the status projection including the read-time-only `stalled`
state, and the two things the request shape deliberately does *not* have — an
object path, and a job-id-to-owner index on this side of the boundary.

`TestSlotLease` covers the admission slot's expiry, including the case that
matters most: a submission whose background task never runs at all.

Storage is the in-memory fake driven through `app.jobs`' injectable store; the
background task itself is stubbed, since `test_jobs_runner` owns the pipeline.
"""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from app import jobs
from app.jobs import layout
from app.jobs.gcs import ObjectStore
from app.jobs.state import STALE_AFTER_MS, JobStatusLog, new_status, now_ms
from app.main import JOB_RETRY_AFTER_SECONDS, app
from tests.unit._fake_gcs import FakeStorageClient

BUCKET = "neonbinder-placeholder-uploads-test"
USER = "user_2abcDEF123"
JOB = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
KEY = "test-internal-key"
HEADERS = {"x-internal-key": KEY}


@pytest.fixture
def client(monkeypatch) -> FakeStorageClient:
    """A fake GCS account wired in as the process-wide store."""
    fake = FakeStorageClient()
    monkeypatch.setenv("INTERNAL_API_KEY", KEY)
    monkeypatch.setenv(layout.BUCKET_ENV, BUCKET)
    monkeypatch.setattr(jobs, "_default_store", ObjectStore(client=fake))
    monkeypatch.setattr(jobs, "_active_slots", {})
    return fake


@pytest.fixture
def api() -> TestClient:
    return TestClient(app)


@pytest.fixture
def no_background(monkeypatch) -> list[tuple]:
    """Capture the background task instead of running the pipeline."""
    started: list[tuple] = []

    def _fake(user_id, job_id, status, *, slot_token=None, **kwargs):
        started.append((user_id, job_id, status))
        jobs._release_slot(slot_token)

    monkeypatch.setattr(jobs, "execute_job", _fake)
    return started


def seed_input(fake: FakeStorageClient, size: int = 1024) -> None:
    fake.seed(BUCKET, layout.input_object(USER, JOB), b"x" * size, "application/zip")


def submit(api: TestClient, **overrides):
    body = {"job_id": JOB, "user_id": USER} | overrides
    return api.post("/jobs", json=body, headers=HEADERS)


class TestAuth:
    def test_submit_requires_the_internal_key(self, client, api):
        assert api.post("/jobs", json={"job_id": JOB, "user_id": USER}).status_code == 401

    def test_status_requires_the_internal_key(self, client, api):
        assert api.get(f"/jobs/{JOB}", params={"user_id": USER}).status_code == 401

    def test_wrong_key_is_refused(self, client, api):
        response = api.post(
            "/jobs", json={"job_id": JOB, "user_id": USER}, headers={"x-internal-key": "nope"}
        )
        assert response.status_code == 401


class TestSubmit:
    def test_accepts_and_schedules_the_work(self, client, api, no_background):
        seed_input(client)

        response = submit(api)

        assert response.status_code == 202
        body = response.json()
        assert body["state"] == "queued"
        assert body["job_id"] == JOB
        assert body["user_id"] == USER
        assert body["input_uri"] == f"gs://{BUCKET}/{layout.input_object(USER, JOB)}"
        assert body["output_prefix"] == f"gs://{BUCKET}/{layout.output_prefix(USER, JOB)}"
        assert [(u, j) for u, j, _ in no_background] == [(USER, JOB)]

    def test_claims_the_job_in_the_durable_log(self, client, api, no_background):
        seed_input(client)
        submit(api)
        assert layout.status_object(USER, JOB, 0) in client.names(BUCKET)

    def test_missing_input_object_is_404(self, client, api, no_background):
        response = submit(api)
        assert response.status_code == 404
        assert response.json()["error_code"] == "INPUT_NOT_FOUND"

    def test_oversized_input_object_is_413(self, client, api, no_background):
        from app.jobs.zipsafe import MAX_INPUT_OBJECT_BYTES

        seed_input(client, size=MAX_INPUT_OBJECT_BYTES + 1)
        response = submit(api)
        assert response.status_code == 413
        assert response.json()["error_code"] == "INPUT_TOO_LARGE"

    def test_duplicate_submission_is_409(self, client, api, no_background):
        seed_input(client)
        assert submit(api).status_code == 202
        response = submit(api)
        assert response.status_code == 409
        assert response.json()["error_code"] == "JOB_ALREADY_SUBMITTED"

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            ("job_id", "not-a-uuid"),
            ("job_id", "../../other"),
            ("user_id", "nope"),
            ("user_id", "user_a/../user_b"),
            ("user_id", "user_abc\n"),
        ],
    )
    def test_bad_identifiers_are_400(self, client, api, no_background, field, value):
        seed_input(client)
        response = submit(api, **{field: value})
        assert response.status_code == 400
        assert response.json()["error_code"] == "INVALID_IDENTIFIER"

    def test_a_bad_identifier_never_reaches_storage(self, client, api, no_background):
        seed_input(client)
        submit(api, user_id="user_a/../user_b")
        # Nothing written, nothing listed: the shape check runs before the
        # service will build a key out of the value at all.
        assert client.names(BUCKET) == [layout.input_object(USER, JOB)]

    def test_unconfigured_bucket_is_a_retryable_503(self, client, api, no_background, monkeypatch):
        monkeypatch.delenv(layout.BUCKET_ENV)
        response = submit(api)
        assert response.status_code == 503
        assert response.json()["error_code"] == "JOBS_NOT_CONFIGURED"
        assert response.headers["retry-after"] == str(JOB_RETRY_AFTER_SECONDS)

    def test_a_busy_instance_is_a_retryable_503(self, client, api, no_background, monkeypatch):
        held = {token: time.monotonic() for token in range(jobs.MAX_ACTIVE_JOBS_PER_INSTANCE)}
        monkeypatch.setattr(jobs, "_active_slots", held)
        seed_input(client)
        response = submit(api)
        assert response.status_code == 503
        assert response.json()["error_code"] == "INSTANCE_BUSY"
        assert response.headers["retry-after"] == str(JOB_RETRY_AFTER_SECONDS)

    def test_a_refusal_releases_the_instance_slot(self, client, api, no_background):
        # Two failed submissions in a row must both be answered with their real
        # reason, not with INSTANCE_BUSY because the first leaked its slot.
        assert submit(api).json()["error_code"] == "INPUT_NOT_FOUND"
        assert submit(api).json()["error_code"] == "INPUT_NOT_FOUND"

    def test_request_body_has_no_object_path_field(self):
        from app.main import JobSubmitRequest

        # The rule from convex/schema.ts, enforced on this side too: no
        # function anywhere may accept an object path as an argument.
        assert set(JobSubmitRequest.model_fields) == {"job_id", "user_id"}


class TestStatus:
    def _write(self, client: FakeStorageClient, **changes):
        log = JobStatusLog(ObjectStore(client=client), bucket=BUCKET, user_id=USER, job_id=JOB)
        status = log.write(new_status(USER, JOB))
        if changes:
            status = log.write(status.advance(**changes))
        return status

    def test_unknown_job_is_404(self, client, api):
        response = api.get(f"/jobs/{JOB}", params={"user_id": USER}, headers=HEADERS)
        assert response.status_code == 404
        assert response.json()["error_code"] == "JOB_NOT_FOUND"

    def test_reports_the_queued_snapshot(self, client, api):
        self._write(client)
        body = api.get(f"/jobs/{JOB}", params={"user_id": USER}, headers=HEADERS).json()
        assert body["state"] == "queued"
        assert body["sequence"] == 0
        assert body["progress"] == {
            "total_images": 0,
            "processed_images": 0,
            "failed_images": 0,
        }
        assert body["result"]["manifest_uri"] is None

    def test_reports_progress_and_the_result(self, client, api):
        self._write(
            client,
            state="succeeded",
            total_images=6,
            processed_images=5,
            failed_images=1,
            pairs=2,
            unmatched=1,
            resolver_calls=1,
            manifest_uri=f"gs://{BUCKET}/{layout.manifest_object(USER, JOB)}",
        )
        body = api.get(f"/jobs/{JOB}", params={"user_id": USER}, headers=HEADERS).json()
        assert body["state"] == "succeeded"
        assert body["progress"]["processed_images"] == 5
        assert body["progress"]["failed_images"] == 1
        assert body["result"]["pairs"] == 2
        assert body["result"]["resolver_calls"] == 1
        assert body["result"]["manifest_uri"].endswith("manifest.json")

    def test_reports_a_failure_code(self, client, api):
        self._write(client, state="failed", error_code="zip_rejected", error_detail="not_a_zip")
        body = api.get(f"/jobs/{JOB}", params={"user_id": USER}, headers=HEADERS).json()
        assert body["state"] == "failed"
        assert body["error_code"] == "zip_rejected"
        assert body["error_detail"] == "not_a_zip"

    def test_a_quiet_running_job_reads_as_stalled(self, client, api):
        self._write(client, state="running", updated_at=now_ms() - STALE_AFTER_MS - 1)
        body = api.get(f"/jobs/{JOB}", params={"user_id": USER}, headers=HEADERS).json()
        # Derived at read time; the log itself still says "running".
        assert body["state"] == "stalled"

    def test_a_finished_job_is_never_stalled(self, client, api):
        self._write(client, state="succeeded", updated_at=0)
        body = api.get(f"/jobs/{JOB}", params={"user_id": USER}, headers=HEADERS).json()
        assert body["state"] == "succeeded"

    def test_user_id_is_required(self, client, api):
        # It is half of the object prefix; there is deliberately no job-id to
        # owner index on this side of the boundary.
        assert api.get(f"/jobs/{JOB}", headers=HEADERS).status_code == 422

    @pytest.mark.parametrize("user_id", ["nope", "user_a/../user_b", "user_abc\n"])
    def test_bad_user_id_is_400(self, client, api, user_id):
        response = api.get(f"/jobs/{JOB}", params={"user_id": user_id}, headers=HEADERS)
        assert response.status_code == 400
        assert response.json()["error_code"] == "INVALID_IDENTIFIER"

    def test_bad_job_id_is_400(self, client, api):
        response = api.get("/jobs/not-a-uuid", params={"user_id": USER}, headers=HEADERS)
        assert response.status_code == 400
        assert response.json()["error_code"] == "INVALID_IDENTIFIER"

    def test_unconfigured_bucket_is_a_retryable_503(self, client, api, monkeypatch):
        monkeypatch.delenv(layout.BUCKET_ENV)
        response = api.get(f"/jobs/{JOB}", params={"user_id": USER}, headers=HEADERS)
        assert response.status_code == 503
        assert response.json()["error_code"] == "JOBS_NOT_CONFIGURED"
        assert response.headers["retry-after"] == str(JOB_RETRY_AFTER_SECONDS)


class TestFacade:
    """`app.jobs`' own seams: the lazy store, and slot ownership."""

    def test_the_store_is_constructed_once_and_only_on_use(self, monkeypatch):
        monkeypatch.setattr(jobs, "_default_store", None)
        built: list[int] = []

        class _Client:
            def __init__(self):
                built.append(1)

        monkeypatch.setattr("app.jobs.gcs.storage.Client", _Client)
        first = jobs.get_store()
        second = jobs.get_store()
        assert first is second
        # Nothing is built until a method actually needs the client.
        assert built == []
        assert first.client is not None
        assert built == [1]

    def test_execute_job_releases_the_slot_even_when_the_run_explodes(self, client, monkeypatch):
        monkeypatch.setattr(jobs, "_active_slots", {7: time.monotonic()})

        def _boom(**kwargs):
            raise RuntimeError("run_job should never raise, but if it did")

        monkeypatch.setattr(jobs.runner, "run_job", _boom)

        with pytest.raises(RuntimeError):
            jobs.execute_job(USER, JOB, new_status(USER, JOB), slot_token=7)

        # Leaking the slot would wedge this instance into answering every
        # later submission with INSTANCE_BUSY until it was restarted.
        assert jobs._active_slots == {}

    def test_execute_job_runs_the_pipeline_and_releases_the_slot(self, client, monkeypatch):
        monkeypatch.setattr(jobs, "_active_slots", {7: time.monotonic()})
        seen: list[dict] = []

        def _run(**kwargs):
            seen.append(kwargs)
            return kwargs["status"]

        monkeypatch.setattr(jobs.runner, "run_job", _run)

        status = new_status(USER, JOB)
        assert jobs.execute_job(USER, JOB, status, slot_token=7) is status
        assert seen[0]["bucket"] == BUCKET
        assert jobs._active_slots == {}

    def test_an_unexpected_submit_failure_is_not_swallowed(self, client, api, monkeypatch):
        # The error table maps the refusals this endpoint knows about. Anything
        # else must surface as a 500, not as a misleading 4xx.
        def _boom(*args, **kwargs):
            raise ValueError("something nobody planned for")

        monkeypatch.setattr(jobs, "submit_job", _boom)
        seed_input(client)

        with pytest.raises(ValueError):
            submit(api)


class TestSlotLease:
    """A batch slot is a lease, not a lock.

    `submit_job` takes a slot and `execute_job` releases it — but Starlette
    only runs background tasks *after* both `send()` calls, so a response that
    never lands (Convex or LB timeout, a disconnect during the two GCS round
    trips) means the task never runs and nothing ever releases. At
    MAX_ACTIVE_JOBS_PER_INSTANCE = 1 with max-instances 3, three of those would
    wedge the feature into permanent 503 INSTANCE_BUSY. An ordinary client
    retry policy is enough to cause it.
    """

    def test_a_never_scheduled_task_does_not_wedge_the_instance(self, client, api, monkeypatch):
        seed_input(client)

        # Submit and then simply never run the background task, exactly as a
        # response that timed out on its way to the client would.
        claim = jobs.submit_job(USER, JOB)
        assert claim.slot_token in jobs._active_slots
        # The slot is genuinely held, so the instance really is refusing work.
        with pytest.raises(jobs.InstanceBusyError):
            jobs.submit_job(USER, JOB)

        # Once the lease is older than its TTL another submission reclaims it.
        stale = time.monotonic() - jobs.JOB_SLOT_TTL_SECONDS - 1
        jobs._active_slots[claim.slot_token] = stale

        reclaimed = jobs._try_acquire_slot()
        assert reclaimed is not None
        assert claim.slot_token not in jobs._active_slots

    def test_a_live_slot_is_not_reclaimed_early(self, client):
        token = jobs._try_acquire_slot()
        assert token is not None
        # Still inside its TTL, so the instance is genuinely busy.
        assert jobs._try_acquire_slot() is None

    def test_a_reclaimed_slot_cannot_free_its_successor(self, client, monkeypatch):
        # Why the token exists. With a bare counter, a late release from a
        # lease that had already been reclaimed would decrement somebody else's
        # slot and let a third batch in behind it.
        first = jobs._try_acquire_slot()
        jobs._active_slots[first] = time.monotonic() - jobs.JOB_SLOT_TTL_SECONDS - 1
        second = jobs._try_acquire_slot()

        jobs._release_slot(first)  # the abandoned task finally wakes up

        assert second in jobs._active_slots
        assert jobs._try_acquire_slot() is None

    def test_the_ttl_covers_a_realistic_batch(self):
        from app.jobs.zipsafe import MAX_ZIP_ENTRIES

        # Long enough for the overwhelming majority of real uploads to finish
        # inside it, and deliberately shorter than the theoretical worst case:
        # over-admitting costs throughput, under-admitting kills the feature.
        typical_batch_images = 300
        assert jobs.JOB_SLOT_TTL_SECONDS >= typical_batch_images * 3
        assert jobs.JOB_SLOT_TTL_SECONDS < MAX_ZIP_ENTRIES * 3

    def test_releasing_a_null_token_is_a_no_op(self, client):
        # `execute_job` defaults `slot_token` to None so it stays directly
        # callable (tests, and any future caller that never took a slot).
        token = jobs._try_acquire_slot()
        jobs._release_slot(None)
        assert token in jobs._active_slots
