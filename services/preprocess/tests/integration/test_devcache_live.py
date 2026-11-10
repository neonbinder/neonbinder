"""Live proof of the dev cache against the real dev cache bucket (NEO-484).

Previews can never hit the cache (gate G3), so this is the pre-merge proof that
a cached answer is served, is byte-identical to the live one, and is really
read from the bucket. For each fixture image in `tests/fixtures/`:

  A  `detect_orientation` against real Vision: the first run misses and stores,
     the second hits and answers the same; then the stored entry is replaced
     with a valid entry of a different answer and the output must follow it.
  B  `tiered_crop` twice: the second run never reaches inference and returns
     the same JPEG bytes; then every stored alpha plane is replaced with an
     empty one and `birefnet_mask` must follow it.

Everything is written under a fresh `itest/<run>/` prefix, passed to the
store's constructor, and the prefix is deleted at the end.

Run it from `services/preprocess`, with ADC for a developer account that can
read and write the dev cache bucket and call Vision, and the fixture images
fetched (`python scripts/fetch_fixtures.py`):

    RUN_INTEGRATION_TESTS=1 DEVCACHE_ITEST_BUCKET=<dev cache bucket> \\
        pytest tests/integration/test_devcache_live.py -v

BiRefNet runs a deterministic stand-in by default, because the real model only
exists in the built image. To run the real model locally, bake it with
`scripts/bake_birefnet.py`, point `BIREFNET_HOME` at the output and add
`DEVCACHE_ITEST_REAL_BIREFNET=1`.

Never in CI: `tests/integration` is outside the unit job's path, its conftest
skips everything without `RUN_INTEGRATION_TESTS=1`, and this module also skips
without `DEVCACHE_ITEST_BUCKET`.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator

import numpy as np
import pytest

from app.cropper import birefnet, tiered
from app.devcache import birefnet as devcache_birefnet
from app.devcache import policy, store
from app.devcache import vision as devcache_vision
from app.orient import _shrink_for_vision, detect_orientation
from app.timing import Timings, bound

from ._loader import FixtureCase, load_fixtures

pytestmark = pytest.mark.integration

BUCKET = (os.environ.get("DEVCACHE_ITEST_BUCKET") or "").strip()
REAL_BIREFNET = os.environ.get("DEVCACHE_ITEST_REAL_BIREFNET") == "1"
RUN_PREFIX = f"itest/{uuid.uuid4().hex[:12]}/"

if not BUCKET:
    pytest.skip(
        "set DEVCACHE_ITEST_BUCKET to the dev cache bucket to run the live cache test",
        allow_module_level=True,
    )

_FIXTURES = load_fixtures()
if not _FIXTURES:
    pytest.skip(
        "no images in tests/fixtures/; run scripts/fetch_fixtures.py",
        allow_module_level=True,
    )

ON = policy.CachePolicy(enabled=True, mode=policy.MODE_ON, bucket=BUCKET)


@pytest.fixture(scope="module")
def gcs_client():
    from google.cloud import storage

    return storage.Client()


@pytest.fixture(scope="module", autouse=True)
def _cleanup_prefix(gcs_client) -> Iterator[None]:
    """Delete everything this run wrote, then check nothing is left."""
    yield
    bucket = gcs_client.bucket(BUCKET)
    for blob in gcs_client.list_blobs(BUCKET, prefix=RUN_PREFIX):
        bucket.blob(blob.name).delete()
    assert list(gcs_client.list_blobs(BUCKET, prefix=RUN_PREFIX)) == []


@pytest.fixture
def live_store(monkeypatch, gcs_client) -> store.CacheStore:
    """Route the cache to the real bucket under this run's prefix."""
    s = store.CacheStore(BUCKET, prefix=RUN_PREFIX, client=gcs_client)
    monkeypatch.setattr(store, "_stores", {BUCKET: s})
    return s


@pytest.fixture
def stand_in_birefnet(monkeypatch, tmp_path) -> list[int]:
    """Count inference calls; unless the real model is asked for, stand in for it.

    The stand-in is deterministic in its input (alpha 255 wherever a pixel
    differs from the padding colour), and its keys name a fake weights hash, so
    they can never collide with a real model's entries.
    """
    calls: list[int] = []
    real_predict = birefnet.predict_alpha

    def _stand_in(rgb: np.ndarray) -> np.ndarray:
        corner = rgb[0, 0]
        return (np.any(rgb != corner, axis=2) * 255).astype(np.uint8)

    inner = real_predict if REAL_BIREFNET else _stand_in
    if not REAL_BIREFNET:
        monkeypatch.setenv(birefnet.HOME_ENV, str(tmp_path))
        (tmp_path / f"{birefnet.model_name()}.onnx.sha256").write_text("0" * 64)
    assert birefnet.weights_sha256() is not None, "cache B is off: no weights hash"

    def _counting(rgb: np.ndarray) -> np.ndarray:
        calls.append(1)
        return inner(rgb)

    monkeypatch.setattr(birefnet, "predict_alpha", _counting)
    return calls


def _object(gcs_client, name: str) -> tuple[bytes, int]:
    blob = gcs_client.bucket(BUCKET).get_blob(name)
    assert blob is not None, "expected a cached object"
    return blob.download_as_bytes(), int(blob.generation)


def _overwrite(gcs_client, name: str, payload: bytes) -> None:
    gcs_client.bucket(BUCKET).blob(name).upload_from_string(
        store.encode(payload), content_type=store.CONTENT_TYPE
    )


def _poison_vision_answer(rotation: int, words: int = 5):
    """A valid Vision answer whose words all read `rotation` degrees."""
    from google.cloud import vision

    edge = {0: (10, 0), 90: (0, 10), 180: (-10, 0), 270: (0, -10)}[rotation]
    poly = vision.BoundingPoly(
        vertices=[vision.Vertex(x=0, y=0), vision.Vertex(x=edge[0], y=edge[1])]
    )
    full = vision.EntityAnnotation(description="doc", bounding_poly=poly)
    anns = [vision.EntityAnnotation(description="w", bounding_poly=poly) for _ in range(words)]
    return vision.AnnotateImageResponse(text_annotations=[full, *anns])


@pytest.mark.parametrize("case", _FIXTURES, ids=[c.name for c in _FIXTURES])
def test_vision_cache_is_served_identical_and_read_from_the_bucket(
    case: FixtureCase, live_store, gcs_client
):
    image = case.image_path.read_bytes()

    first_t, second_t, poisoned_t = Timings(), Timings(), Timings()
    with policy.bound(ON), bound(first_t):
        first = detect_orientation(image)
    assert first_t.vision_cache_misses == 1, "first run must be a miss (fresh prefix)"
    assert first_t.cache_write_failures == 0

    sent = _shrink_for_vision(image)
    name = live_store.object_name("vision", devcache_vision.cache_key(sent))
    stored, generation = _object(gcs_client, name)

    with policy.bound(ON), bound(second_t):
        second = detect_orientation(image)
    assert second_t.vision_cache_hits == 1
    assert second == first
    # A hit rewrites nothing: the object is byte-identical, same generation.
    assert _object(gcs_client, name) == (stored, generation)

    poison_rotation = (first.rotation_degrees + 180) % 360
    _overwrite(gcs_client, name, devcache_vision.serialize(_poison_vision_answer(poison_rotation)))
    with policy.bound(ON), bound(poisoned_t):
        poisoned = detect_orientation(image)
    assert poisoned_t.vision_cache_hits == 1
    assert poisoned.rotation_degrees == poison_rotation
    assert poisoned != first


@pytest.mark.parametrize("case", _FIXTURES, ids=[c.name for c in _FIXTURES])
def test_birefnet_cache_is_served_identical_and_read_from_the_bucket(
    case: FixtureCase, live_store, gcs_client, stand_in_birefnet
):
    image = case.image_path.read_bytes()

    first_t, second_t = Timings(), Timings()
    with policy.bound(ON), bound(first_t):
        first = tiered.tiered_crop(image)
    if not stand_in_birefnet:
        pytest.skip(f"{case.name}: tiered never reached BiRefNet")
    assert first_t.birefnet_cache_misses >= 1
    assert first_t.cache_write_failures == 0

    calls_before = len(stand_in_birefnet)
    with policy.bound(ON), bound(second_t):
        second = tiered.tiered_crop(image)
    assert len(stand_in_birefnet) == calls_before, "second run reached inference"
    assert second_t.birefnet_cache_hits >= 1
    assert second_t.birefnet_cache_misses == 0
    assert second == first  # the same JPEG bytes (or both None)

    # Poison every stored plane with an empty one: the mask must follow.
    _full, work, _scale = tiered._load(image)
    padded, _p = tiered.pad_for_birefnet(work)
    name = live_store.object_name("birefnet", devcache_birefnet.cache_key(padded))
    payload, _gen = _object(gcs_client, name)
    live_alpha = devcache_birefnet.decode_alpha(store.decode(payload), padded.shape[:2])
    with policy.bound(ON):
        live_mask = tiered.birefnet_mask(work)
    if not live_alpha.any():
        pytest.skip(f"{case.name}: the live alpha is already empty; poison cannot show")
    _overwrite(gcs_client, name, devcache_birefnet.encode_alpha(np.zeros_like(live_alpha)))
    with policy.bound(ON):
        poisoned_mask = tiered.birefnet_mask(work)
    assert len(stand_in_birefnet) == calls_before
    assert not poisoned_mask.any()
    assert not np.array_equal(poisoned_mask, live_mask)
