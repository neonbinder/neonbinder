"""Object-key layout for placeholder zip jobs, and the identifier rules behind it.

Every object a job reads or writes lives under one prefix:

    placeholders/{clerk_user_id}/{job_id}/
        input.zip                 written by the browser via a signed POST policy
        status/{seq:08d}.json     append-only job-state log (see app.jobs.state)
        output/manifest.json      the batch result, written once at the end
        output/images/{n:04d}.ext one normalised, cropped, rotated image per input

**No caller ever supplies an object path.** The service takes `user_id` and
`job_id` and derives every key here. That is the same rule Convex enforces on
its side (see the `placeholderJobs` comment in `apps/web/convex/schema.ts`):
both the `neonbinder-convex` SA and the preprocess runtime SA hold *bucket-wide*
`objectViewer` on this bucket, so an attacker-supplied path would turn either
service into a cross-user read oracle. `job_id` — opaque, unguessable, and
checked against its owner's row before Convex ever calls us — is the only thing
standing between that grant and a read oracle, and it only works if the path is
never an argument.

Both identifiers are shape-checked before they are interpolated. That is what
makes traversal (`..`, a leading `/`, a `%2e%2e`) structurally unrepresentable
rather than merely rejected: neither pattern admits a `.` or a `/` at all.
"""

from __future__ import annotations

import re

# Names the destination bucket. Deliberately the same variable name Convex
# uses (`convex/adapters/placeholderUploads.ts`) so both halves of the feature
# are configured from the one Terraform output, `placeholder_uploads_bucket_name`.
# It is a bucket name, not a secret.
BUCKET_ENV = "GCS_PLACEHOLDER_BUCKET"

# Clerk subject IDs are `user_` plus a base62 body.
#
# Modelled on CLERK_USER_ID_RE in convex/adapters/placeholderUploads.ts but
# deliberately **not identical** to it: that one is `/^user_[A-Za-z0-9]+$/`,
# with no upper bound on the body. This is the stricter of the two, so the
# asymmetry fails closed — an id Convex would happily mint a policy for can
# still be refused here, never the reverse. The bound exists because the value
# becomes a literal object-path segment, and an unbounded one is a way to push
# a key past GCS's 1024-byte name limit and get back an error we would have to
# guess at.
#
# Anchored with \A..\Z, NOT ^..$. In Python `$` also matches immediately before
# a trailing newline, so `^user_abc$` happily accepts "user_abc\n" — and a
# newline in an object key is exactly the kind of thing that survives one
# encoder and confuses the next. \Z is the end of the string and nothing else.
CLERK_USER_ID_PATTERN = re.compile(r"\Auser_[A-Za-z0-9]{1,64}\Z")

# Job IDs are `crypto.randomUUID()` from the Convex action that mints the
# upload policy. Pinning the format (rather than accepting any opaque string)
# keeps the unguessability property the whole ownership model rests on: a
# caller cannot substitute a short, enumerable handle.
JOB_ID_PATTERN = re.compile(
    r"\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\Z"
)

ROOT_PREFIX = "placeholders"
INPUT_OBJECT = "input.zip"
STATUS_DIR = "status"
OUTPUT_DIR = "output"
MANIFEST_OBJECT = "manifest.json"

# Zero-padding widths. Status objects are read back by listing the prefix and
# taking the lexicographically largest name, which only equals the numerically
# largest while every name is the same width — so the padding is load-bearing,
# not cosmetic. 8 digits covers far more checkpoints than any job can produce;
# 4 covers the MAX_ZIP_ENTRIES ceiling in app.jobs.zipsafe with room to spare.
STATUS_SEQUENCE_DIGITS = 8
IMAGE_INDEX_DIGITS = 4


class InvalidJobIdentifierError(ValueError):
    """Raised when a user id or job id does not match its required shape."""


def validate_identifiers(user_id: str, job_id: str) -> None:
    """Reject anything that could not have come from the upload-policy mint.

    Raises `InvalidJobIdentifierError` naming the offending field. The message
    deliberately does not echo the value back — it goes into a log line and an
    HTTP body, and reflecting caller-controlled text into either is a habit
    worth not having.
    """
    if not CLERK_USER_ID_PATTERN.match(user_id):
        raise InvalidJobIdentifierError("user_id is not a valid Clerk subject id")
    if not JOB_ID_PATTERN.match(job_id):
        raise InvalidJobIdentifierError("job_id is not a valid UUID")


def job_prefix(user_id: str, job_id: str) -> str:
    """The single prefix every object for this job lives under."""
    validate_identifiers(user_id, job_id)
    return f"{ROOT_PREFIX}/{user_id}/{job_id}/"


def input_object(user_id: str, job_id: str) -> str:
    return f"{job_prefix(user_id, job_id)}{INPUT_OBJECT}"


def status_prefix(user_id: str, job_id: str) -> str:
    return f"{job_prefix(user_id, job_id)}{STATUS_DIR}/"


def status_object(user_id: str, job_id: str, sequence: int) -> str:
    if sequence < 0:
        raise InvalidJobIdentifierError("status sequence must be non-negative")
    return f"{status_prefix(user_id, job_id)}{sequence:0{STATUS_SEQUENCE_DIGITS}d}.json"


def output_prefix(user_id: str, job_id: str) -> str:
    return f"{job_prefix(user_id, job_id)}{OUTPUT_DIR}/"


def manifest_object(user_id: str, job_id: str) -> str:
    return f"{output_prefix(user_id, job_id)}{MANIFEST_OBJECT}"


def output_image_object(user_id: str, job_id: str, index: int, extension: str) -> str:
    """Key for one processed image.

    The key is derived from the image's **zip ordinal**, never from its entry
    name. That is the structural half of the zip-slip defence: even a member
    called `../../etc/passwd` can only ever be written to
    `output/images/0007.jpg`. `app.jobs.zipsafe` still rejects such names, but
    it is not what keeps this safe.
    """
    if index < 0:
        raise InvalidJobIdentifierError("image index must be non-negative")
    safe_extension = extension.lower().lstrip(".")
    if not safe_extension.isalnum():
        raise InvalidJobIdentifierError("image extension must be alphanumeric")
    return f"{output_prefix(user_id, job_id)}images/{index:0{IMAGE_INDEX_DIGITS}d}.{safe_extension}"
