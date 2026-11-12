"""Unit tests for app.devcache.policy: the G1 to G3 matrix and the binding.

Only (ENVIRONMENT == "dev", bucket set, untagged Host) turns the cache on.
Every other combination is off, with the first failing gate as its mode.
"""

from __future__ import annotations

import itertools
import threading

import pytest

from app.devcache import policy

BUCKET = "some-dev-cache-bucket"
BASE = "neonbinder-preprocess-abc123-uc.a.run.app"

ENVS = {
    "dev": "dev",
    "prod": "prod",
    "upper": "DEV",
    "padded": " dev",
    "development": "development",
    "empty": "",
    "unset": None,
}
BUCKETS = {"set": BUCKET, "empty": "", "blank": "   ", "unset": None}
HOSTS = {
    "base": BASE,
    "base_port": f"{BASE}:443",
    "localhost": "localhost:8080",
    "ipv6": "[::1]:8080",
    "pr": f"pr-12---{BASE}",
    "sha": f"sha-1a2b3c4---{BASE}",
    "pr_upper": f"PR-12---{BASE.upper()}",
    "pr_port": f"pr-12---{BASE}:443",
    "none": None,
    "empty": "",
    "blank": "  ",
}
TAGGED = {"pr", "sha", "pr_upper", "pr_port"}
NO_HOST = {"none", "empty", "blank"}


@pytest.fixture
def env(monkeypatch):
    def _set(environment: str | None, bucket: str | None) -> None:
        for name, value in (
            (policy.ENVIRONMENT_ENV, environment),
            (policy.BUCKET_ENV, bucket),
        ):
            if value is None:
                monkeypatch.delenv(name, raising=False)
            else:
                monkeypatch.setenv(name, value)

    return _set


@pytest.mark.parametrize(
    "env_id,bucket_id,host_id",
    list(itertools.product(ENVS, BUCKETS, HOSTS)),
)
def test_policy_matrix(env, env_id, bucket_id, host_id):
    env(ENVS[env_id], BUCKETS[bucket_id])

    got = policy.resolve(HOSTS[host_id])

    if env_id != "dev":
        expected = policy.CachePolicy(False, policy.MODE_NOT_DEV)
    elif bucket_id != "set":
        expected = policy.CachePolicy(False, policy.MODE_NO_BUCKET)
    elif host_id in NO_HOST:
        expected = policy.CachePolicy(False, policy.MODE_NO_HOST)
    elif host_id in TAGGED:
        expected = policy.CachePolicy(False, policy.MODE_TAGGED_HOST)
    else:
        expected = policy.CachePolicy(True, policy.MODE_ON, BUCKET)
    assert got == expected


def test_only_the_on_mode_carries_a_bucket(env):
    env("dev", BUCKET)
    assert policy.resolve(f"pr-1---{BASE}").bucket is None
    assert policy.resolve(BASE).bucket == BUCKET


def test_bucket_name_is_trimmed(env):
    env("dev", f"  {BUCKET} ")
    assert policy.resolve(BASE).bucket == BUCKET


def test_triple_dash_outside_the_first_label_is_not_a_tag(env):
    env("dev", BUCKET)
    assert policy.resolve("svc.pr-1---x.example").mode == policy.MODE_ON


def test_any_exception_is_off_error(env, monkeypatch):
    env("dev", BUCKET)

    def _boom(_host):
        raise RuntimeError("surprise")

    monkeypatch.setattr(policy, "_resolve", _boom)
    assert policy.resolve(BASE) == policy.CachePolicy(False, policy.MODE_ERROR)


def test_a_non_string_host_is_off_error(env):
    env("dev", BUCKET)
    assert policy.resolve(b"bytes-host").mode == policy.MODE_ERROR  # type: ignore[arg-type]


def test_every_mode_is_on_or_an_off_reason():
    assert policy.MODES[0] == "on"
    assert all(m.startswith("off:") for m in policy.MODES[1:])
    assert policy.MODE_UNBOUND not in policy.MODES


class TestBinding:
    def test_unbound_is_off(self):
        assert policy.current() == policy.UNBOUND
        assert policy.current().enabled is False

    def test_bound_is_visible_inside_and_restored_after(self):
        on = policy.CachePolicy(True, policy.MODE_ON, BUCKET)
        with policy.bound(on) as got:
            assert got is on
            assert policy.current() is on
            off = policy.CachePolicy(False, policy.MODE_TAGGED_HOST)
            with policy.bound(off):
                assert policy.current() is off
            assert policy.current() is on
        assert policy.current() == policy.UNBOUND

    def test_restored_after_an_exception(self):
        with pytest.raises(RuntimeError), policy.bound(policy.CachePolicy(True, "on", BUCKET)):
            raise RuntimeError("request failed")
        assert policy.current() == policy.UNBOUND

    def test_threads_never_see_each_others_policy(self):
        on = policy.CachePolicy(True, policy.MODE_ON, BUCKET)
        seen: list[policy.CachePolicy] = []
        inside = threading.Event()
        done = threading.Event()

        def _other():
            inside.wait(5)
            seen.append(policy.current())
            done.set()

        thread = threading.Thread(target=_other)
        thread.start()
        with policy.bound(on):
            inside.set()
            done.wait(5)
        thread.join(5)
        assert seen == [policy.UNBOUND]
