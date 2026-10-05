#!/usr/bin/env python3
"""Score the classify prompt's side and card-number reads against labelled images.

Usage (from services/preprocess/):
    python scripts/eval_classify.py                          # fixtures + sidecars, new prompt
    python scripts/eval_classify.py --prompt both --runs 2
    python scripts/eval_classify.py --dir /path/to/scans --labels /path/to/labels.yaml

Each image goes through the production path: `detect_orientation` (Vision),
rotate upright, then `classify_card` under the chosen prompt(s). `old` is the
prompt as it stood before NEO-327, frozen below as `LEGACY_PROMPT`; `new` is
`app.classify.PROMPT`. The output is a markdown table per image, side and
card-number accuracy per prompt, and Vision's text_count split by true side
(the input the pairing pool uses to decide which image of a pair is the back).

Labels:
    Default: the `tests/fixtures/*.yaml` sidecars (classify.side,
    classify.card_number, orient.rotation_degrees).
    --labels FILE: a YAML mapping of image filename to
        {side: front|back, card_number: "20" | ["91TF-41", "41"] | null,
         rotation_degrees: 180}
    `card_number` may list every accepted spelling. On a front it is
    normally null: a front that prints no card number must classify as null.

--no-vision skips Vision (no text_count) and rotates by the label's
`rotation_degrees` instead. Use it only when ADC is unavailable; it is not the
production path.

Requires ANTHROPIC_API_KEY (environment or .env.local) and, unless
--no-vision, Vision ADC (`gcloud auth application-default login`).
Images and label files for real card scans stay out of the repo.
"""

from __future__ import annotations

import argparse
import re
import statistics
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
load_dotenv(REPO_ROOT / ".env.local", override=False)

from label_fixtures import _rotate  # noqa: E402

from app.classify import PROMPT, classify_card  # noqa: E402
from app.orient import detect_orientation  # noqa: E402

FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures"
SUPPORTED = {".jpg", ".jpeg", ".png", ".webp"}

# The prompt as shipped before NEO-327. Frozen so an eval can always compare
# the current wording against it. Do not edit.
LEGACY_PROMPT = """You are analyzing a trading card photo. Return a SINGLE JSON OBJECT
(not an array) with these keys:
- "players": a JSON ARRAY of every player/subject name visible on the card.
    Single-player cards: ["Ken Griffey Jr."]
    Multi-player cards (leaders, combo, dual-rookie, team sets):
      ["Salvador Perez", "Adam Duvall"]
    No identifiable players: []
- "team": the team name if visible on the card, else null. For multi-player
    cards where players are on different teams, return null.
- "card_number": the card number as printed (e.g. "25", "RC-12"), string
    or null if not visible.
- "side": either "front" or "back". Front has the player photo and name;
    back has stats, copyright, career info, or team logos as tables.

Respond with ONLY the JSON object. No array wrapper, no preamble, no code
fences, no trailing text."""

PROMPTS = {"old": LEGACY_PROMPT, "new": PROMPT}


@dataclass
class Label:
    side: str | None
    # Accepted spellings; empty means the truth is null (no card number).
    card_numbers: list[str]
    rotation_degrees: int | None = None


@dataclass
class Row:
    name: str
    label: Label
    text_count: int | None = None
    sides: dict[str, list[str | None]] = field(default_factory=dict)
    numbers: dict[str, list[str | None]] = field(default_factory=dict)


def _norm_number(value: str | None) -> str | None:
    """Compare card numbers on their printed token: drop a `No.`/`#` prefix,
    whitespace and case. `91TF-41` stays `91TF-41`."""
    if value is None:
        return None
    text = re.sub(r"^\s*(no\.?|#)\s*", "", value.strip(), flags=re.IGNORECASE)
    return re.sub(r"\s+", "", text).upper() or None


def _number_ok(label: Label, got: str | None) -> bool:
    accepted = {_norm_number(n) for n in label.card_numbers}
    if not accepted:
        return got is None
    return _norm_number(got) in accepted


def _labels_from_file(path: Path) -> dict[str, Label]:
    raw = yaml.safe_load(path.read_text()) or {}
    labels: dict[str, Label] = {}
    for name, entry in raw.items():
        entry = entry or {}
        number = entry.get("card_number")
        if number is None:
            numbers: list[str] = []
        elif isinstance(number, list):
            numbers = [str(n) for n in number]
        else:
            numbers = [str(number)]
        labels[name] = Label(
            side=entry.get("side"),
            card_numbers=numbers,
            rotation_degrees=entry.get("rotation_degrees"),
        )
    return labels


def _labels_from_sidecars(directory: Path) -> dict[str, Label]:
    sys.path.insert(0, str(REPO_ROOT / "tests" / "integration"))
    from _loader import load_fixtures  # noqa: PLC0415

    labels: dict[str, Label] = {}
    for case in load_fixtures(directory):
        if case.side is None and case.card_number is None:
            continue
        numbers: list[str] = []
        if case.card_number is not None and case.card_number.equals is not None:
            numbers = [case.card_number.equals]
        labels[case.image_path.name] = Label(
            side=case.side,
            card_numbers=numbers,
            rotation_degrees=case.rotation_degrees,
        )
    return labels


def _evaluate(path: Path, label: Label, prompts: list[str], runs: int, use_vision: bool) -> Row:
    image = path.read_bytes()
    row = Row(name=path.name, label=label)
    if use_vision:
        orient = detect_orientation(image)
        row.text_count = orient.text_count
        rotation = orient.rotation_degrees
    else:
        rotation = label.rotation_degrees or 0
    upright = _rotate(image, rotation)
    for key in prompts:
        row.sides[key] = []
        row.numbers[key] = []
        for _ in range(runs):
            try:
                result = classify_card(upright, prompt=PROMPTS[key])
                row.sides[key].append(result.side)
                row.numbers[key].append(result.card_number)
            except Exception as exc:  # noqa: BLE001
                row.sides[key].append(f"ERR:{type(exc).__name__}")
                row.numbers[key].append(None)
    return row


def _fmt(values: list[Any]) -> str:
    shown = ["null" if v is None else str(v) for v in values]
    return shown[0] if len(set(shown)) == 1 else "/".join(shown)


def _percentiles(values: list[int]) -> str:
    if not values:
        return "n/a"
    ordered = sorted(values)
    if len(ordered) == 1:
        return f"n=1 value={ordered[0]}"
    q = statistics.quantiles(ordered, n=20, method="inclusive")
    return (
        f"n={len(ordered)} min={ordered[0]} p5={q[0]:.0f} "
        f"median={statistics.median(ordered):.0f} p95={q[-1]:.0f} max={ordered[-1]}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("--dir", type=Path, default=FIXTURES_DIR, help="image directory")
    parser.add_argument("--labels", type=Path, help="labels YAML (default: fixture sidecars)")
    parser.add_argument("--runs", type=int, default=1, help="classify calls per image per prompt")
    parser.add_argument("--prompt", choices=["old", "new", "both"], default="new")
    parser.add_argument("--no-vision", action="store_true", help="skip Vision (see module doc)")
    parser.add_argument("--workers", type=int, default=6, help="images evaluated concurrently")
    args = parser.parse_args()

    labels = _labels_from_file(args.labels) if args.labels else _labels_from_sidecars(args.dir)
    paths = [
        p for p in sorted(args.dir.iterdir()) if p.suffix.lower() in SUPPORTED and p.name in labels
    ]
    if not paths:
        print(f"no labelled images found in {args.dir}")
        return 1
    prompts = ["old", "new"] if args.prompt == "both" else [args.prompt]

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        rows = list(
            pool.map(
                lambda p: _evaluate(p, labels[p.name], prompts, args.runs, not args.no_vision),
                paths,
            )
        )

    header = ["file", "text_count", "truth side"]
    header += [f"{k} side" for k in prompts]
    header += ["truth number"]
    header += [f"{k} number" for k in prompts]
    print("| " + " | ".join(header) + " |")
    print("|" + "---|" * len(header))
    for row in rows:
        truth_number = "/".join(row.label.card_numbers) or "null"
        cells = [row.name, "-" if row.text_count is None else str(row.text_count)]
        cells.append(row.label.side or "?")
        cells += [_fmt(row.sides[k]) for k in prompts]
        cells.append(truth_number)
        cells += [_fmt(row.numbers[k]) for k in prompts]
        print("| " + " | ".join(cells) + " |")

    print()
    for key in prompts:
        side_hits = side_total = num_hits = num_total = back_hits = back_total = 0
        front_nulls = front_total = 0
        for row in rows:
            for side, number in zip(row.sides[key], row.numbers[key], strict=True):
                if row.label.side is not None:
                    side_total += 1
                    side_hits += side == row.label.side
                num_total += 1
                ok = _number_ok(row.label, number)
                num_hits += ok
                if row.label.side == "back":
                    back_total += 1
                    back_hits += ok
                elif row.label.side == "front":
                    front_total += 1
                    front_nulls += number is None
        print(
            f"**{key}**: side {side_hits}/{side_total}"
            f" ({100 * side_hits / max(side_total, 1):.0f}%),"
            f" card number {num_hits}/{num_total} ({100 * num_hits / max(num_total, 1):.0f}%)"
            f" [backs {back_hits}/{back_total}, fronts null {front_nulls}/{front_total}]"
        )

    if not args.no_vision:
        print()
        for side in ("front", "back"):
            counts = [
                r.text_count for r in rows if r.label.side == side and r.text_count is not None
            ]
            print(f"text_count {side}s: {_percentiles(counts)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
