"""Asynchronous zip-batch jobs — the public surface `app.main` routes onto.

A 200-card upload is 400 images. Each one is 2-3s of SAM after a 5-15s cold
model load, so the batch is minutes of work against a 7-second UI budget.
It cannot be a request. Hence: submit returns immediately with a job id, the
work runs in the background, and the client polls a status endpoint.

## Where job state lives, and why it is not in this process

In a dict on the heap, job state would be wrong three different ways on Cloud
Run: scale-to-zero deletes it between polls, max-instances 3 with no session
affinity means two polls out of three reach an instance that never heard of the
job, and a cold start has nothing to answer from. `app.jobs.state` puts it in
GCS instead — an append-only log of numbered snapshots under the job's own
prefix, which the runtime service account can already write and which needs no
new infrastructure in a Terraform repo that lives outside this monorepo. That
module's docstring has the full argument, including why append-only rather than
a mutable `status.json` and what falls out of it (duplicate submissions caught
for free, every write a compare-and-swap).

## How the work actually runs

`submit_job` claims the job and returns; the caller hands `execute_job` to
FastAPI's `BackgroundTasks`, which runs it after the response has been sent.

**This needs CPU-always-on to be worth anything.** Cloud Run's default
allocates CPU only during request processing, and throttles an instance to a
few percent once the response is out — which would turn a three-minute batch
into an hour. The service must be deployed with `--no-cpu-throttling`. That is
a deployment change (the workflow and Terraform both live outside
`services/preprocess/`), so it is called out in the README as a prerequisite
rather than shipped here. Until it is set, jobs still complete correctly; they
complete slowly.

The failure mode if an instance is killed mid-batch is covered rather than
prevented: the log stops advancing, and `app.jobs.state.derive_state` reports
the job as `stalled` once it has been quiet for `STALE_AFTER_MS`, so the client
resubmits under a fresh job id instead of polling forever. Resuming a partial
job would need per-image state and a write-once-safe way to re-enter a prefix
that already has objects in it; that is deliberately not attempted.

## Admission

One batch saturates an instance, so a second concurrent batch on the same
instance halves both jobs' throughput and doubles peak memory for nothing. The
per-instance concurrency of 3 is sized for short `/process` calls, not for
minute-long batches, so jobs get their own much smaller limit and a busy
instance answers a submission with 503 rather than accepting work it will not
do well.
"""

from __future__ import annotations

import logging
import os
import threading

from app.jobs import layout, runner
from app.jobs.gcs import ObjectAlreadyExistsError, ObjectRef, ObjectStore
from app.jobs.state import JobStatus, JobStatusLog, derive_state, new_status
from app.jobs.zipsafe import MAX_INPUT_OBJECT_BYTES

logger = logging.getLogger(__name__)

__all__ = [
    "MAX_ACTIVE_JOBS_PER_INSTANCE",
    "InputNotFoundError",
    "InputTooLargeError",
    "InstanceBusyError",
    "JobAlreadySubmittedError",
    "JobStatus",
    "JobsNotConfiguredError",
    "derive_state",
    "execute_job",
    "load_status",
    "resolve_bucket",
    "submit_job",
]

# Batch jobs a single instance will run at once. 1, because SAM inference on
# 4 vCPU is already the bottleneck: a second concurrent batch does not add
# throughput, it splits it, while doubling the peak of decompressed image plus
# model tensors on a 4Gi instance. With max-instances 3 a 503 here is a useful
# signal — the retry can land somewhere else.
MAX_ACTIVE_JOBS_PER_INSTANCE = 1

_slot_lock = threading.Lock()
_active_jobs = 0

_default_store: ObjectStore | None = None


class JobsNotConfiguredError(RuntimeError):
    """The destination bucket is not configured on this deployment."""


class JobAlreadySubmittedError(RuntimeError):
    """This job id already has a status log; it must not be started twice."""


class InputNotFoundError(RuntimeError):
    """No input.zip has been uploaded for this job yet."""


class InputTooLargeError(RuntimeError):
    """The uploaded object is larger than the upload policy should have allowed."""


class InstanceBusyError(RuntimeError):
    """This instance is already running its allowance of batch jobs."""


def get_store() -> ObjectStore:
    """The process-wide storage client, constructed on first use.

    Lazy so that importing `app.main` — and therefore serving `/process` and
    `/crop` — never requires GCS credentials.
    """
    global _default_store
    if _default_store is None:
        _default_store = ObjectStore()
    return _default_store


def resolve_bucket() -> str:
    bucket = os.environ.get(layout.BUCKET_ENV)
    if not bucket:
        raise JobsNotConfiguredError(f"{layout.BUCKET_ENV} is not set")
    return bucket


def _try_acquire_slot() -> bool:
    global _active_jobs
    with _slot_lock:
        if _active_jobs >= MAX_ACTIVE_JOBS_PER_INSTANCE:
            return False
        _active_jobs += 1
        return True


def _release_slot() -> None:
    global _active_jobs
    with _slot_lock:
        _active_jobs = max(0, _active_jobs - 1)


def submit_job(user_id: str, job_id: str, *, store: ObjectStore | None = None) -> JobStatus:
    """Claim a job and return its initial `queued` snapshot.

    On success the caller **must** arrange for `execute_job` to run with the
    returned status: it owns the instance slot this acquired, and releases it.

    Raises, in the order checked: `InvalidJobIdentifierError` (bad id shape),
    `JobsNotConfiguredError`, `InstanceBusyError`, `InputNotFoundError`, `InputTooLargeError`,
    `JobAlreadySubmittedError`.
    """
    layout.validate_identifiers(user_id, job_id)
    bucket = resolve_bucket()
    active_store = store or get_store()

    if not _try_acquire_slot():
        raise InstanceBusyError("instance is already running a batch job")

    try:
        input_ref = ObjectRef(bucket=bucket, name=layout.input_object(user_id, job_id))
        stat = active_store.stat(input_ref)
        if stat is None:
            raise InputNotFoundError("no input.zip for this job")
        if stat.size > MAX_INPUT_OBJECT_BYTES:
            # The signed POST policy caps this at the same number. An object
            # over it means the policy was bypassed, so treat the upload as
            # hostile and refuse before opening it.
            raise InputTooLargeError(f"input object is {stat.size} bytes")

        status = new_status(user_id, job_id)
        log = JobStatusLog(active_store, bucket=bucket, user_id=user_id, job_id=job_id)
        try:
            log.write(status)
        except ObjectAlreadyExistsError as exc:
            raise JobAlreadySubmittedError(f"job {job_id} has already been submitted") from exc
    except Exception:
        _release_slot()
        raise

    logger.info("job %s: submitted (%d bytes of input)", job_id, stat.size)
    return status


def execute_job(
    user_id: str,
    job_id: str,
    status: JobStatus,
    *,
    store: ObjectStore | None = None,
    bucket: str | None = None,
) -> JobStatus:
    """Run a submitted job to completion, then release the instance slot.

    Handed to `BackgroundTasks` by the submit route. Never raises: `run_job`
    turns every failure into a terminal status snapshot, and the slot is
    released either way.
    """
    try:
        return runner.run_job(
            user_id=user_id,
            job_id=job_id,
            bucket=bucket or resolve_bucket(),
            store=store or get_store(),
            status=status,
        )
    finally:
        _release_slot()


def load_status(user_id: str, job_id: str, *, store: ObjectStore | None = None) -> JobStatus | None:
    """The most recent snapshot for a job, or None if there is no log for it."""
    layout.validate_identifiers(user_id, job_id)
    bucket = resolve_bucket()
    log = JobStatusLog(store or get_store(), bucket=bucket, user_id=user_id, job_id=job_id)
    return log.latest()
