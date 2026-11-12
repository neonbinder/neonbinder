"""Whether the dev cache is on for one request (NEO-484 gates G1 to G3).

The cache is on only when all three gates pass:

  G1  `ENVIRONMENT` is exactly "dev".
  G2  `PREPROCESS_DEV_CACHE_BUCKET` is set and not blank. Terraform sets it on
      the dev services only; the dev deploy lanes set it and the preview and
      prod lanes remove it.
  G3  The request's `Host` is not a tagged revision URL. Cloud Run tags render
      as `<tag>---<service>-<hash>.a.run.app`, so a `---` in the first DNS
      label means a `pr-N` preview or a `sha-*` blue/green candidate. Those
      run code that is not yet the dev base, and must never read or write
      what the base stored.

No env var can mark a preview: `deploy-cloudrun` merges env vars, so a
preview revision inherits whatever the base carried. That is why the request's
Host is a gate. Anything unexpected while deciding (an exception of any kind)
means off.

Only `/process-entry` binds a policy (`bound`). `/process`, `/crop`, the smoke
tests and the crop matrix never bind one, so `current()` answers off for them
and every model call they make is live.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Final

logger = logging.getLogger(__name__)

ENVIRONMENT_ENV: Final[str] = "ENVIRONMENT"
BUCKET_ENV: Final[str] = "PREPROCESS_DEV_CACHE_BUCKET"
DEV_ENVIRONMENT: Final[str] = "dev"
TAG_SEPARATOR: Final[str] = "---"

MODE_ON: Final[str] = "on"
MODE_NOT_DEV: Final[str] = "off:not_dev"
MODE_NO_BUCKET: Final[str] = "off:no_bucket"
MODE_TAGGED_HOST: Final[str] = "off:tagged_host"
MODE_NO_HOST: Final[str] = "off:no_host"
MODE_ERROR: Final[str] = "off:error"
# What `current()` answers when no request bound a policy (`/process`, `/crop`,
# tests). Never returned by `resolve`.
MODE_UNBOUND: Final[str] = "off:unbound"

MODES: Final[tuple[str, ...]] = (
    MODE_ON,
    MODE_NOT_DEV,
    MODE_NO_BUCKET,
    MODE_TAGGED_HOST,
    MODE_NO_HOST,
    MODE_ERROR,
)


@dataclass(frozen=True)
class CachePolicy:
    """The cache decision for one request.

    `bucket` is set only when `enabled` is True. `mode` is a short machine label
    for the timing line and `/health`: "on", or "off:<reason>".
    """

    enabled: bool
    mode: str
    bucket: str | None = None


UNBOUND: Final[CachePolicy] = CachePolicy(enabled=False, mode=MODE_UNBOUND)


def _off(mode: str) -> CachePolicy:
    return CachePolicy(enabled=False, mode=mode)


def is_tagged_host(host: str) -> bool:
    """True when the first DNS label of `host` carries a Cloud Run tag (`---`).

    A port is ignored. An IPv6 literal has no DNS labels and is never tagged.
    """
    h = host.strip().lower()
    if h.startswith("["):
        return False
    h = h.split(":", 1)[0]
    return TAG_SEPARATOR in h.split(".", 1)[0]


def _resolve(host: str | None) -> CachePolicy:
    if os.environ.get(ENVIRONMENT_ENV) != DEV_ENVIRONMENT:
        return _off(MODE_NOT_DEV)
    bucket = (os.environ.get(BUCKET_ENV) or "").strip()
    if not bucket:
        return _off(MODE_NO_BUCKET)
    if host is None or not host.strip():
        return _off(MODE_NO_HOST)
    if is_tagged_host(host):
        return _off(MODE_TAGGED_HOST)
    return CachePolicy(enabled=True, mode=MODE_ON, bucket=bucket)


def resolve(host: str | None) -> CachePolicy:
    """Decide the policy for a request with this `Host` header value.

    Never raises: anything unexpected is `off:error`.
    """
    try:
        return _resolve(host)
    except Exception as exc:  # noqa: BLE001 - any doubt means live
        logger.warning("devcache: policy failed (%s); cache off", type(exc).__name__)
        return _off(MODE_ERROR)


_current: ContextVar[CachePolicy] = ContextVar("preprocess_devcache_policy", default=UNBOUND)


@contextmanager
def bound(policy: CachePolicy) -> Iterator[CachePolicy]:
    """Make `policy` what `current()` returns for the `with` body.

    A ContextVar, like `app.timing.bound`: concurrent requests on the FAST role
    each run in their own copied context and never see each other's policy.
    """
    token = _current.set(policy)
    try:
        yield policy
    finally:
        _current.reset(token)


def current() -> CachePolicy:
    """The policy bound for this request, or `UNBOUND` (off) when none is."""
    return _current.get()
