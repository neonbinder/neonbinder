"""Durable job state — an append-only status log in GCS.

## Why not an in-process dict

preprocess runs on Cloud Run at concurrency 3, max-instances 3, scale-to-zero.
Three consequences, each fatal to in-memory state on its own:

1. **Scale-to-zero.** A job takes minutes; the UI polls for status. Between two
   polls the instance can be gone, and with it every dict on the heap.
2. **No routing control.** With up to three instances behind one URL and no
   session affinity, the poll that asks "how is job X doing?" lands on an
   instance chosen by the load balancer, not on the one running the job. Two
   instances out of three would answer "never heard of it".
3. **Cold starts.** The first request after idle pays a 5-15s model load. A
   status endpoint that has to reconstruct state cannot answer during it.

## Why GCS, and why append-only

The runtime service account already holds `objectViewer` + `objectCreator` on
exactly this bucket, so the job's own prefix is storage we can use with no new
infrastructure, no new IAM and no change to a Terraform repo that lives outside
this monorepo. Firestore, Redis or Cloud Tasks would each be a better *database*
and all three would be a worse *dependency* for what is, in the end, a few
hundred bytes of counters per job.

It has no delete and no overwrite, which is a deliberate property of the bucket
rather than a gap (see `app.jobs.gcs`). So state is not a mutable
`status.json`; it is a numbered sequence of immutable snapshots, and the
current state is the highest-numbered one. Three things fall out of that:

- **Every write is a compare-and-swap.** `if_generation_match=0` means two
  instances cannot both claim sequence N. The loser gets `ObjectAlreadyExistsError`.
- **Submitting the same job twice is caught for free.** The second submit
  collides on sequence 0 and is refused, rather than starting a second run that
  interleaves output objects with the first.
- **The history is the audit trail.** Every checkpoint the job ever wrote is
  still there, which is the difference between "the job is stuck" and "the job
  has not moved since 14:02".

The cost is one list + one get per status poll, and one small write per
checkpoint — negligible against a batch that is minutes of SAM inference.

## Stalls

A killed instance cannot write a `failed` snapshot; the log simply stops. So
`derive_state` reports a non-terminal job whose last checkpoint is older than
`STALE_AFTER_MS` as `stalled`. The stored state is never rewritten to say that
— it is a reading of the log, not a fact in it.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, replace
from typing import Any, Literal

from app.jobs import layout
from app.jobs.gcs import ObjectRef, ObjectStore

logger = logging.getLogger(__name__)

#: States a job can actually be written in. `stalled` is deliberately absent:
#: it is derived at read time by `derive_state`, never stored.
JobState = Literal["queued", "running", "succeeded", "failed"]

TERMINAL_STATES: frozenset[str] = frozenset({"succeeded", "failed"})

#: The read-time-only state. See the module docstring.
STALLED_STATE = "stalled"

# How many images may be processed between checkpoint writes. Each checkpoint
# is one small GCS write (~100ms), and each image is 2-3s of SAM, so 5 costs
# under 1% of runtime while keeping the UI's progress bar within ~15s of the
# truth. Dropping to 1 would triple the object count for no visible gain.
PROGRESS_CHECKPOINT_IMAGES = 5

# How long a non-terminal job may go without a checkpoint before a reader calls
# it stalled. The worst legitimate gap is a cold start (up to 15s of model
# load) plus a checkpoint interval of slow images (5 x ~5s), so ~40s; 5 minutes
# is an order of magnitude above that, which keeps a false "stalled" off the
# UI while still catching an instance that was shot mid-batch long before a
# user would think to complain.
STALE_AFTER_MS = 5 * 60 * 1000

# A status snapshot is a flat object of counters and two short strings. 64 KiB
# is thousands of times what it needs and still refuses to pull an arbitrary
# object into memory if something else ever lands under the status prefix.
MAX_STATUS_OBJECT_BYTES = 64 * 1024

CONTENT_TYPE = "application/json"


def now_ms() -> int:
    """Wall-clock epoch milliseconds — the unit Convex stores timestamps in."""
    return int(time.time() * 1000)


@dataclass(frozen=True)
class JobStatus:
    """One immutable snapshot of a job's progress.

    Frozen, and advanced with `dataclasses.replace`, so a snapshot that has
    been written can never be edited in place — which is exactly the guarantee
    the append-only log is providing at the storage layer.
    """

    job_id: str
    user_id: str
    state: JobState
    sequence: int = 0
    created_at: int = 0
    updated_at: int = 0
    total_images: int = 0
    processed_images: int = 0
    failed_images: int = 0
    pairs: int = 0
    unmatched: int = 0
    resolver_calls: int = 0
    manifest_uri: str | None = None
    error_code: str | None = None
    error_detail: str | None = None

    @property
    def is_terminal(self) -> bool:
        return self.state in TERMINAL_STATES

    def advance(self, **changes: Any) -> JobStatus:
        """Next snapshot: same job, one higher sequence, refreshed timestamp."""
        changes.setdefault("updated_at", now_ms())
        return replace(self, sequence=self.sequence + 1, **changes)

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "user_id": self.user_id,
            "state": self.state,
            "sequence": self.sequence,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "total_images": self.total_images,
            "processed_images": self.processed_images,
            "failed_images": self.failed_images,
            "pairs": self.pairs,
            "unmatched": self.unmatched,
            "resolver_calls": self.resolver_calls,
            "manifest_uri": self.manifest_uri,
            "error_code": self.error_code,
            "error_detail": self.error_detail,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> JobStatus:
        known = {field: raw[field] for field in cls.__dataclass_fields__ if field in raw}
        return cls(**known)


def new_status(user_id: str, job_id: str) -> JobStatus:
    """The sequence-0 snapshot a submission writes to claim the job."""
    stamp = now_ms()
    return JobStatus(
        job_id=job_id,
        user_id=user_id,
        state="queued",
        sequence=0,
        created_at=stamp,
        updated_at=stamp,
    )


def derive_state(status: JobStatus, *, at_ms: int | None = None) -> str:
    """The state to report to a caller, which may be `stalled`.

    Never mutates the log. A terminal job is reported as it was written; a
    `queued` or `running` one whose last checkpoint has gone quiet for longer
    than `STALE_AFTER_MS` is reported as stalled so the caller can resubmit
    under a fresh job id rather than poll forever.
    """
    if status.is_terminal:
        return status.state
    reference = now_ms() if at_ms is None else at_ms
    if reference - status.updated_at > STALE_AFTER_MS:
        return STALLED_STATE
    return status.state


class JobStatusLog:
    """The append-only sequence of snapshots for one job."""

    def __init__(self, store: ObjectStore, *, bucket: str, user_id: str, job_id: str) -> None:
        self._store = store
        self._bucket = bucket
        self._user_id = user_id
        self._job_id = job_id

    def _ref(self, sequence: int) -> ObjectRef:
        return ObjectRef(
            bucket=self._bucket,
            name=layout.status_object(self._user_id, self._job_id, sequence),
        )

    def write(self, status: JobStatus) -> JobStatus:
        """Write a snapshot at its own sequence number.

        Raises `app.jobs.gcs.ObjectAlreadyExistsError` when that sequence is taken —
        at sequence 0 that means the job was already submitted, and later it
        means two workers are running the same job, which is equally a
        condition to stop on rather than to paper over.
        """
        self._store.create(
            self._ref(status.sequence),
            json.dumps(status.to_dict(), sort_keys=True).encode("utf-8"),
            content_type=CONTENT_TYPE,
        )
        return status

    def latest(self) -> JobStatus | None:
        """The highest-numbered snapshot, or None when the job is unknown.

        Relies on GCS listing lexicographically and on the fixed-width
        zero-padded names from `app.jobs.layout` making that the same order as
        numeric.
        """
        names = self._store.list_names(
            self._bucket, layout.status_prefix(self._user_id, self._job_id)
        )
        if not names:
            return None
        latest_name = max(names)
        payload = self._store.download(
            ObjectRef(bucket=self._bucket, name=latest_name),
            max_bytes=MAX_STATUS_OBJECT_BYTES,
        )
        try:
            return JobStatus.from_dict(json.loads(payload))
        except (ValueError, TypeError):
            logger.exception("job status object %s is unreadable", latest_name)
            return None
