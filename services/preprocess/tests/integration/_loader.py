"""Fixture discovery + sidecar parsing for integration tests.

Convention: each image in `tests/fixtures/<name>.{jpg,png,webp}` may have an
optional `tests/fixtures/<name>.yaml` sidecar declaring expectations. Every
field is optional — start loose, tighten over time. Add more fixtures
whenever a troubling image turns up; no code changes required.

Sidecar shape:

    orient:
      rotation_degrees: 0          # exact int (deterministic)
      min_confidence: 0.5          # optional floor on winning bucket

    classify:
      side: front                  # exact "front" | "back"
      player:                      # dict form → explicit matcher
        contains: Griffey          # case-insensitive substring
        # or: equals: "Ken Griffey Jr."
        # or: regex: "^Ken"
        # or: is_null: true
      team:
        equals: Mariners
      card_number:
        equals: "24"
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

FIXTURES_DIR = Path(__file__).resolve().parents[1] / "fixtures"
SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
_CONTENT_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}
_MATCHER_FIELDS = {"equals", "contains", "regex", "is_null"}


@dataclass(frozen=True)
class StringMatcher:
    equals: str | None = None
    contains: str | None = None
    regex: str | None = None
    is_null: bool | None = None

    @classmethod
    def from_value(cls, value: Any) -> StringMatcher | None:
        if value is None:
            return None
        if isinstance(value, str):
            return cls(equals=value)
        if isinstance(value, dict):
            unknown = set(value) - _MATCHER_FIELDS
            if unknown:
                raise ValueError(f"unknown matcher keys: {sorted(unknown)}")
            return cls(**value)
        raise ValueError(f"unsupported matcher value: {value!r}")

    def check(self, actual: str | None, label: str) -> None:
        if self.is_null is True:
            assert actual is None, f"{label}: expected null, got {actual!r}"
            return
        if self.is_null is False:
            assert actual is not None, f"{label}: expected non-null, got None"
        if self.equals is not None:
            assert actual == self.equals, f"{label}: expected == {self.equals!r}, got {actual!r}"
        if self.contains is not None:
            needle = self.contains.lower()
            haystack = (actual or "").lower()
            assert (
                needle in haystack
            ), f"{label}: expected to contain {self.contains!r}, got {actual!r}"
        if self.regex is not None:
            assert actual is not None and re.search(
                self.regex, actual
            ), f"{label}: expected to match regex {self.regex!r}, got {actual!r}"


@dataclass(frozen=True)
class FixtureCase:
    name: str
    image_path: Path
    content_type: str
    rotation_degrees: int | None = None
    min_confidence: float | None = None
    side: str | None = None
    player: StringMatcher | None = None
    team: StringMatcher | None = None
    card_number: StringMatcher | None = None

    @property
    def has_expectations(self) -> bool:
        return any(
            v is not None
            for v in (
                self.rotation_degrees,
                self.min_confidence,
                self.side,
                self.player,
                self.team,
                self.card_number,
            )
        )


def _parse_sidecar(data: dict) -> dict[str, Any]:
    orient = data.get("orient") or {}
    classify = data.get("classify") or {}
    return {
        "rotation_degrees": orient.get("rotation_degrees"),
        "min_confidence": orient.get("min_confidence"),
        "side": classify.get("side"),
        "player": StringMatcher.from_value(classify.get("player")),
        "team": StringMatcher.from_value(classify.get("team")),
        "card_number": StringMatcher.from_value(classify.get("card_number")),
    }


def load_fixtures(directory: Path = FIXTURES_DIR) -> list[FixtureCase]:
    if not directory.exists():
        return []
    cases: list[FixtureCase] = []
    for image_path in sorted(directory.iterdir()):
        if image_path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            continue
        sidecar = image_path.with_suffix(".yaml")
        expectations: dict[str, Any] = {}
        if sidecar.exists():
            raw = yaml.safe_load(sidecar.read_text()) or {}
            expectations = _parse_sidecar(raw)
        cases.append(
            FixtureCase(
                name=image_path.stem,
                image_path=image_path,
                content_type=_CONTENT_TYPES[image_path.suffix.lower()],
                **expectations,
            )
        )
    return cases
