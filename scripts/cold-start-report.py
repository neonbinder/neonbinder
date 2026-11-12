#!/usr/bin/env python3
"""Per-instance cold-start phases for a preprocess Cloud Run service (NEO-484).

Joins five kinds of log line by Cloud Run instance id (`labels.instanceId`):

  start      the system "Starting new instance" line
  ready      the first "STARTUP ... probe succeeded" line
  cold_start the app's one JSON line per process (role, exec_env, isa,
             cpu_model, nproc, main_module_import_s, session_load_s,
             startup_hook_s, process_age_at_ready_s, prewarm)
  first      the first `process_entry_timing` line the instance wrote
  birefnet   every `birefnet_run` line (n, pre_ms, ort_ms, post_ms)

and prints each instance's phases, then p50/p95 per phase. The measurements
these feed are M1 (start -> ready), M2 (start -> first timing line) and M3
(first vs later BiRefNet inference) in the NEO-484 plan.

Read-only: one `gcloud logging read`. Nothing is hard-coded; the project,
service and window are arguments.

Usage:
  scripts/cold-start-report.py --project P --service S --revision R [--revision R2]
  scripts/cold-start-report.py --project P --service S --since 2026-11-10T14:00:00Z [--until ...]
  scripts/cold-start-report.py --project P --service S --freshness 6h
  scripts/cold-start-report.py --input saved.json      # a saved `gcloud logging read --format=json`
  ... --json                                            # machine-readable output

An instance with no start line inside the window (it started earlier) is
listed but left out of the start-relative percentiles.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import statistics
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from typing import Any

PROBE_RE = re.compile(r"STARTUP .*probe succeeded", re.IGNORECASE)
START_TEXT = "Starting new instance"
APP_MSGS = ("cold_start", "process_entry_timing", "birefnet_run")
COLD_FIELDS = (
    "main_module_import_s",
    "session_load_s",
    "startup_hook_s",
    "process_age_at_ready_s",
)
COLD_ATTRS = ("role", "exec_env", "isa", "cpu_model", "nproc", "prewarm")


def parse_ts(ts: str) -> datetime:
    # Cloud Logging gives nanoseconds; fromisoformat takes at most microseconds.
    ts = ts.replace("Z", "+00:00")
    m = re.match(r"^(.*\.\d{6})\d*(\+.*)$", ts)
    if m:
        ts = m.group(1) + m.group(2)
    return datetime.fromisoformat(ts)


def since_from_freshness(freshness: str) -> str:
    """`6h`/`2d`/`30m` -> an RFC 3339 lower bound.

    gcloud's own --freshness only applies to descending reads, and this one
    reads ascending, so the window has to be a timestamp in the filter.
    """
    m = re.fullmatch(r"(\d+)([smhd])", freshness)
    if not m:
        raise SystemExit(f"--freshness must look like 30m, 6h or 2d, not {freshness!r}")
    unit = {"s": "seconds", "m": "minutes", "h": "hours", "d": "days"}[m.group(2)]
    start = datetime.now(UTC) - timedelta(**{unit: int(m.group(1))})
    return start.strftime("%Y-%m-%dT%H:%M:%SZ")


def build_filter(args: argparse.Namespace) -> str:
    parts = [
        'resource.type="cloud_run_revision"',
        f'resource.labels.service_name="{args.service}"',
    ]
    if args.revision:
        revs = " OR ".join(f'"{r}"' for r in args.revision)
        parts.append(f"resource.labels.revision_name=({revs})")
    if args.since:
        parts.append(f'timestamp>="{args.since}"')
    if args.until:
        parts.append(f'timestamp<="{args.until}"')
    kinds = [
        f'textPayload:"{START_TEXT}"',
        'textPayload:"probe succeeded"',
        *(f'jsonPayload.msg="{m}"' for m in APP_MSGS),
    ]
    parts.append("(" + " OR ".join(kinds) + ")")
    return " AND ".join(parts)


def fetch(args: argparse.Namespace) -> list[dict[str, Any]]:
    if args.input:
        with open(args.input) as f:
            return json.load(f)
    cmd = [
        "gcloud",
        "logging",
        "read",
        build_filter(args),
        f"--project={args.project}",
        f"--limit={args.limit}",
        "--order=asc",
        "--format=json",
    ]
    out = subprocess.run(cmd, check=True, capture_output=True, text=True).stdout
    entries = json.loads(out or "[]")
    if len(entries) >= args.limit:
        print(
            f"warning: hit --limit {args.limit}; narrow the window or raise it",
            file=sys.stderr,
        )
    return entries


def classify(entry: dict[str, Any]) -> tuple[str | None, dict[str, Any] | None]:
    text = entry.get("textPayload")
    if isinstance(text, str):
        if START_TEXT in text:
            return "start", None
        if PROBE_RE.search(text):
            return "ready", None
        # An app line that reached Cloud Logging as text (not parsed as JSON).
        if text.lstrip().startswith("{"):
            try:
                payload = json.loads(text)
            except ValueError:
                return None, None
            if payload.get("msg") in APP_MSGS:
                return payload["msg"], payload
        return None, None
    payload = entry.get("jsonPayload") or {}
    if payload.get("msg") in APP_MSGS:
        return payload["msg"], payload
    return None, None


def join(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    inst: dict[str, dict[str, Any]] = {}
    for e in sorted(entries, key=lambda e: e.get("timestamp", "")):
        iid = (e.get("labels") or {}).get("instanceId")
        if not iid:
            continue
        kind, payload = classify(e)
        if kind is None:
            continue
        ts = parse_ts(e["timestamp"])
        rev = ((e.get("resource") or {}).get("labels") or {}).get("revision_name", "?")
        d = inst.setdefault(iid, {"instance": iid, "revision": rev, "birefnet": []})
        if kind == "start":
            d.setdefault("start", ts)
        elif kind == "ready":
            d.setdefault("ready", ts)
        elif kind == "cold_start":
            d.setdefault("cold_start", payload)
            d.setdefault("cold_start_at", ts)
        elif kind == "process_entry_timing":
            if "first" not in d:
                d["first"] = ts
                d["first_total_ms"] = payload.get("total_ms")
                d["first_birefnet_ms"] = payload.get("birefnet_ms")
                d["first_role"] = payload.get("role")
        elif kind == "birefnet_run":
            d["birefnet"].append(payload)
    far = parse_ts("9999-01-01T00:00:00Z")
    return sorted(
        inst.values(), key=lambda d: d.get("start") or d.get("ready") or d.get("first") or far
    )


def secs(a: datetime | None, b: datetime | None) -> float | None:
    if a is None or b is None:
        return None
    return round((b - a).total_seconds(), 1)


def phases(d: dict[str, Any]) -> dict[str, Any]:
    cs = d.get("cold_start") or {}
    runs = d["birefnet"]
    ort = [r.get("ort_ms") for r in runs if isinstance(r.get("ort_ms"), (int, float))]
    row: dict[str, Any] = {
        "revision": d["revision"],
        "instance": d["instance"][:12],
        "start_to_ready_s": secs(d.get("start"), d.get("ready")),
        "start_to_first_timing_s": secs(d.get("start"), d.get("first")),
        "ready_to_first_timing_s": secs(d.get("ready"), d.get("first")),
        "first_total_ms": d.get("first_total_ms"),
        "first_birefnet_ms": d.get("first_birefnet_ms"),
        "birefnet_runs": len(runs),
        "first_ort_ms": ort[0] if ort else None,
        "later_ort_ms_median": statistics.median(ort[1:]) if len(ort) > 1 else None,
    }
    first_run = runs[0] if runs else {}
    row["first_pre_ms"] = first_run.get("pre_ms")
    row["first_post_ms"] = first_run.get("post_ms")
    for k in COLD_FIELDS:
        row[k] = cs.get(k)
    for k in COLD_ATTRS:
        row[k] = cs.get(k)
    row["has_start"] = "start" in d
    return row


NUMERIC = (
    "start_to_ready_s",
    "start_to_first_timing_s",
    "ready_to_first_timing_s",
    *COLD_FIELDS,
    "first_total_ms",
    "first_birefnet_ms",
    "first_ort_ms",
    "later_ort_ms_median",
    "first_pre_ms",
    "first_post_ms",
)
START_RELATIVE = {"start_to_ready_s", "start_to_first_timing_s"}


def pct(values: list[float], p: float) -> float:
    # Nearest rank: always a value that was actually observed.
    s = sorted(values)
    return s[max(0, math.ceil(p / 100 * len(s)) - 1)]


def summarise(rows: list[dict[str, Any]]) -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {}
    for k in NUMERIC:
        vals = [
            r[k]
            for r in rows
            if isinstance(r.get(k), (int, float)) and (k not in START_RELATIVE or r["has_start"])
        ]
        if vals:
            out[k] = {"n": len(vals), "p50": pct(vals, 50), "p95": pct(vals, 95)}
    return out


def fmt(v: Any) -> str:
    if v is None:
        return "-"
    if isinstance(v, float):
        return f"{v:.1f}"
    return str(v)


def print_text(rows: list[dict[str, Any]], summary: dict[str, dict[str, float]]) -> None:
    cols = [
        ("revision", "revision"),
        ("instance", "instance"),
        ("exec_env", "env"),
        ("isa", "isa"),
        ("start_to_ready_s", "start>ready"),
        ("main_module_import_s", "import"),
        ("session_load_s", "session"),
        ("startup_hook_s", "hook"),
        ("process_age_at_ready_s", "age@ready"),
        ("start_to_first_timing_s", "start>1st"),
        ("first_ort_ms", "1st_ort_ms"),
        ("later_ort_ms_median", "later_ort_ms"),
        ("birefnet_runs", "runs"),
    ]
    table = [[h for _, h in cols]] + [[fmt(r.get(k)) for k, _ in cols] for r in rows]
    widths = [max(len(row[i]) for row in table) for i in range(len(cols))]
    for row in table:
        print("  ".join(c.ljust(w) for c, w in zip(row, widths, strict=True)))
    print()
    with_start = sum(r["has_start"] for r in rows)
    print(f"instances: {len(rows)} ({with_start} with a start line in the window)")
    for k, v in summary.items():
        print(f"  {k:<26} n={v['n']:<3} p50={fmt(float(v['p50']))}  p95={fmt(float(v['p95']))}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--project")
    ap.add_argument("--service")
    ap.add_argument("--revision", action="append", help="repeatable")
    ap.add_argument("--since", help="RFC 3339 start of the window")
    ap.add_argument("--until", help="RFC 3339 end of the window")
    ap.add_argument(
        "--freshness", default="1d", help="window ending now, when --since is absent (default 1d)"
    )
    ap.add_argument("--limit", type=int, default=20000)
    ap.add_argument("--input", help="saved `gcloud logging read --format=json` output")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    if not args.input and not (args.project and args.service):
        ap.error("--project and --service are required unless --input is given")

    if not args.input and not args.since:
        # Always bounded: without it an ascending read scans all retention.
        args.since = since_from_freshness(args.freshness)
    rows = [phases(d) for d in join(fetch(args))]
    summary = summarise(rows)
    if args.json:
        json.dump({"instances": rows, "summary": summary}, sys.stdout, indent=2, default=str)
        print()
    else:
        print_text(rows, summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
