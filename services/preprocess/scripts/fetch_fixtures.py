#!/usr/bin/env python3
"""Download fixture images from GCS.

Fixture images (real card photos, 22–26 MB each) are too large to commit
to git. Only the YAML expectation sidecars live in the repo; the images
sit in `gs://neonbinder-dev-preprocess-fixtures` (provisioned by the
infrastructure repo, dev project only).

Run from `services/preprocess/`.

Usage:
    python scripts/fetch_fixtures.py        # download every missing image
    python scripts/fetch_fixtures.py --force  # re-download even if present
    python scripts/fetch_fixtures.py --dry-run  # list what would be fetched

Uses `gcloud storage cp`. Requires ADC (`gcloud auth application-default
login`) from a user with `roles/storage.objectViewer` on the bucket —
any of the configured `developer_emails` in terraform has this via
`roles/storage.objectAdmin`, and the preprocess runtime SA has it via
`roles/storage.objectViewer` (for future CI integration-test jobs).

What counts as "a fixture"?
    Every `.yaml` sidecar in `tests/fixtures/` implies a matching image
    with the same stem. Supported extensions: .jpg, .jpeg, .png, .webp.
    The script tries each extension in order and downloads the first
    one that exists in the bucket.

Companion upload:
    gcloud storage cp tests/fixtures/NAME.EXT gs://neonbinder-dev-preprocess-fixtures/NAME.EXT

See `tests/fixtures/README.md` for the full add-a-new-fixture workflow.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

FIXTURES_BUCKET = "gs://neonbinder-dev-preprocess-fixtures"
FIXTURES_DIR = Path(__file__).resolve().parent.parent / "tests" / "fixtures"
SUPPORTED_EXTS = (".jpg", ".jpeg", ".png", ".webp")


def _sidecar_stems() -> list[str]:
    """All `.yaml` sidecar stems in tests/fixtures/."""
    return sorted(p.stem for p in FIXTURES_DIR.iterdir() if p.is_file() and p.suffix == ".yaml")


def _local_image_for(stem: str) -> Path | None:
    """Return the existing local image for a given stem, or None."""
    for ext in SUPPORTED_EXTS:
        p = FIXTURES_DIR / f"{stem}{ext}"
        if p.exists():
            return p
    return None


def _remote_object_for(stem: str) -> str | None:
    """Find the first extension that exists in the bucket. None if nothing found."""
    for ext in SUPPORTED_EXTS:
        uri = f"{FIXTURES_BUCKET}/{stem}{ext}"
        result = subprocess.run(
            ["gcloud", "storage", "ls", uri],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0 and result.stdout.strip():
            return uri
    return None


def _download(uri: str, dest: Path) -> bool:
    """Run `gcloud storage cp URI DEST`. Returns True on success."""
    result = subprocess.run(
        ["gcloud", "storage", "cp", uri, str(dest)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"  ERROR: {result.stderr.strip() or result.stdout.strip()}", file=sys.stderr)
        return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--force",
        action="store_true",
        help="re-download even when the local image already exists",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print what would be fetched without downloading",
    )
    args = parser.parse_args()

    stems = _sidecar_stems()
    if not stems:
        print(f"No .yaml sidecars in {FIXTURES_DIR} — nothing to fetch.")
        return 0

    print(f"{len(stems)} sidecar(s) under {FIXTURES_DIR}")
    downloaded = 0
    missing = 0
    skipped = 0

    for stem in stems:
        local = _local_image_for(stem)
        if local is not None and not args.force:
            print(f"  {stem}: already present ({local.name})")
            skipped += 1
            continue

        remote = _remote_object_for(stem)
        if remote is None:
            print(f"  {stem}: no image found in {FIXTURES_BUCKET}", file=sys.stderr)
            missing += 1
            continue

        ext = Path(remote).suffix
        dest = FIXTURES_DIR / f"{stem}{ext}"
        print(f"  {stem}: fetch {remote} → {dest.name}")
        if args.dry_run:
            continue
        if _download(remote, dest):
            downloaded += 1

    print(
        f"\nsummary: {downloaded} downloaded, {skipped} already present, "
        f"{missing} missing from bucket"
    )
    return 1 if missing > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
