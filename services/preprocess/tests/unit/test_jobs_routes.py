"""Unit tests for the POST /jobs and GET /jobs/{job_id} wire contract.

Covers: auth, the submit happy path (202 + the background task actually being
scheduled), every refusal code and its HTTP status, `Retry-After` on the
retryable ones, the status projection including the read-time-only `stalled`
state, and the two things the request shape deliberately does *not* have — an
object path, and a job-id-to-owner index on this side of the boundary.

Storage is the in-memory fake driven through `app.jobs`' injectable store; the
background task itself is stubbed, since `test_jobs_runner` owns the pipeline.
"""

from __future__ import annotations

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
    monkeypatch.setattr(jobs, "_active_jobs", 0)
    return fake


@pytest.fixture
def api() -> TestClient:
    return TestClient(app)


@pytest.fixture
def no_background(monkeypatch) -> list[tuple]:
    """Capture the background task instead of running the pipeline."""
    started: list[tuple] = []

    def _fake(user_id, job_id, status, **kwargs):
        started.append((user_id, job_id, status))
        jobs._release_slot()

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
        monkeypatch.setattr(jobs, "_active_jobs", jobs.MAX_ACTIVE_JOBS_PER_INSTANCE)
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
        monkeypatch.setattr(jobs, "_active_jobs", 1)

        def _boom(**kwargs):
            raise RuntimeError("run_job should never raise, but if it did")

        monkeypatch.setattr(jobs.runner, "run_job", _boom)

        with pytest.raises(RuntimeError):
            jobs.execute_job(USER, JOB, new_status(USER, JOB))

        # Leaking the slot would wedge this instance into answering every
        # later submission with INSTANCE_BUSY until it was restarted.
        assert jobs._active_jobs == 0

    def test_execute_job_runs_the_pipeline_and_releases_the_slot(self, client, monkeypatch):
        monkeypatch.setattr(jobs, "_active_jobs", 1)
        seen: list[dict] = []

        def _run(**kwargs):
            seen.append(kwargs)
            return kwargs["status"]

        monkeypatch.setattr(jobs.runner, "run_job", _run)

        status = new_status(USER, JOB)
        assert jobs.execute_job(USER, JOB, status) is status
        assert seen[0]["bucket"] == BUCKET
        assert jobs._active_jobs == 0

    def test_an_unexpected_submit_failure_is_not_swallowed(self, client, api, monkeypatch):
        # The error table maps the refusals this endpoint knows about. Anything
        # else must surface as a 500, not as a misleading 4xx.
        def _boom(*args, **kwargs):
            raise ValueError("something nobody planned for")

        monkeypatch.setattr(jobs, "submit_job", _boom)
        seed_input(client)

        with pytest.raises(ValueError):
            submit(api)
