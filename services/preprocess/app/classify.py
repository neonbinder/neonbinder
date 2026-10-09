"""Card classification via Anthropic Claude Haiku.

Sends the card image to Haiku with a strict-JSON prompt, parses the response,
and returns structured fields. Retries once on parse failure with a firmer
reminder to emit raw JSON.
"""

from __future__ import annotations

import base64
import json
import logging
import threading
from dataclasses import dataclass, replace
from io import BytesIO

import anthropic
from PIL import Image

logger = logging.getLogger(__name__)

# NEO-328: Haiku 5.5 read the card number on 106/106 labelled 2014 Score
# backs where Haiku 4.5 managed 82/106 (it invented digits and read jersey
# numbers off fronts), for ~+0.1 s and far fewer tokens.
DEFAULT_MODEL = "claude-haiku-5-5"
# Haiku 5.5 thinks by default (adaptive), and thinking counts toward
# `max_tokens`. At effort low the eval averaged ~44 output tokens per card, so
# this is a runaway ceiling, not a budget: billing is on tokens used, and a cap
# near the old 512 would risk a `max_tokens` stop before any text block.
MAX_TOKENS = 4096
# Haiku 5.5 rejects non-default sampling parameters (`temperature` is a 400),
# so none is sent. Effort is set explicitly instead of taking the default
# (medium): low read every labelled back correctly and was stable across runs.
EFFORT = "low"

# Anthropic rejects base64 image payloads over 5 MB. Base64 expands raw bytes
# by ~33%, so we target a raw-byte ceiling of ~3.5 MB with comfortable margin.
# Images above this are re-encoded as JPEG with longest edge capped at
# `DOWNSCALE_MAX_EDGE_PX`, which preserves enough detail for card-text reads.
ANTHROPIC_MAX_RAW_BYTES = 3_500_000
DOWNSCALE_MAX_EDGE_PX = 1600
DOWNSCALE_JPEG_QUALITY = 85

PROMPT = """You are analyzing one side of a trading card. Return a SINGLE JSON
OBJECT (not an array) with these keys:
- "players": a JSON ARRAY of every player/subject name visible on the card.
    Single-player cards: ["Ken Griffey Jr."]
    Multi-player cards (leaders, combo, dual-rookie, team sets):
      ["Salvador Perez", "Adam Duvall"]
    No identifiable players: []
- "team": the team name if visible on the card, else null. For multi-player
    cards where players are on different teams, return null.
- "card_number": the number printed as the card's number, usually on the
    back, often with a "No." or "#" prefix near a corner or beside the
    copyright line (e.g. "25", "RC-12"). Copy it exactly as printed. A number
    on a jersey, helmet or uniform is NEVER the card number, and neither is a
    statistic, height, weight, date, or a year inside a set or anniversary
    logo. On a front return null unless a card number is clearly printed as
    one.
- "side": "back" if the image shows the card number, a biography, a
    statistics table, a copyright line or other fine print; a back may ALSO
    show a photo and the player's name. "front" if it is mostly the photo
    with little text beyond a name, team or position. null if you cannot
    tell.

Respond with ONLY the JSON object. No array wrapper, no preamble, no code
fences, no trailing text."""

RETRY_PROMPT_SUFFIX = (
    "\n\nYour previous response could not be parsed as JSON. "
    "Return ONLY a raw JSON object with the four keys above — "
    "no markdown, no code fences, no explanation."
)

# One Anthropic client per process (NEO-315), shared by classify and the
# haiku_bbox crop strategy. `anthropic.Anthropic()` builds an httpx client and
# its connection pool; constructing one per call threw both away every time.
# The SDK client is thread-safe, so a single lazily built instance serves every
# concurrent request; the lock only guards construction.
_anthropic_client: anthropic.Anthropic | None = None
_anthropic_client_lock = threading.Lock()


def get_anthropic_client() -> anthropic.Anthropic:
    """Return the process-wide Anthropic client, building it on first use."""
    global _anthropic_client
    if _anthropic_client is None:
        with _anthropic_client_lock:
            if _anthropic_client is None:
                _anthropic_client = anthropic.Anthropic()
    return _anthropic_client


_MEDIA_TYPE_BY_PIL_FORMAT = {
    "JPEG": "image/jpeg",
    "PNG": "image/png",
    "WEBP": "image/webp",
    "GIF": "image/gif",
}


@dataclass(frozen=True)
class ClassifyResult:
    """Extracted card fields plus the model's raw response for debugging.

    `players` is the canonical list; `player` is a back-compat single-name
    alias (first entry or None). `retried` is True when the first response
    failed to parse and this result came from the retry call — a frequency
    signal for the NEO-315 timing line, never part of any response body.
    `side` is None when the model could not tell or answered outside
    {"front", "back"} (NEO-327); it is never guessed.
    """

    players: list[str]
    team: str | None
    card_number: str | None
    side: str | None
    raw_text: str
    retried: bool = False

    @property
    def player(self) -> str | None:
        return self.players[0] if self.players else None


class ClassifyError(RuntimeError):
    """Raised when the model's response cannot be parsed after retries."""


def _detect_media_type(image_bytes: bytes) -> str:
    try:
        with Image.open(BytesIO(image_bytes)) as img:
            return _MEDIA_TYPE_BY_PIL_FORMAT.get(img.format or "", "image/jpeg")
    except Exception:
        return "image/jpeg"


def _prepare_for_anthropic(image_bytes: bytes) -> tuple[bytes, str]:
    """Return (bytes, media_type) fitting Anthropic's 5 MB base64 ceiling.

    Images already under the raw-byte budget pass through unchanged. Oversized
    images are re-encoded as JPEG with the longest edge capped; if that still
    overshoots, the edge cap is halved progressively until the result fits.
    """
    if len(image_bytes) <= ANTHROPIC_MAX_RAW_BYTES:
        return image_bytes, _detect_media_type(image_bytes)

    with Image.open(BytesIO(image_bytes)) as img:
        rgb = img.convert("RGB")

    max_edge = DOWNSCALE_MAX_EDGE_PX
    while True:
        working = rgb.copy()
        working.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
        out = BytesIO()
        working.save(out, format="JPEG", quality=DOWNSCALE_JPEG_QUALITY)
        payload = out.getvalue()
        if len(payload) <= ANTHROPIC_MAX_RAW_BYTES or max_edge <= 256:
            return payload, "image/jpeg"
        max_edge //= 2


def _strip_code_fences(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        # Drop the opening fence (possibly ```json) and the closing ```.
        stripped = stripped.split("\n", 1)[1] if "\n" in stripped else stripped[3:]
        if stripped.rstrip().endswith("```"):
            stripped = stripped.rstrip()[:-3]
    return stripped.strip()


def _parse_response(text: str) -> object:
    # Returns whatever json.loads produces: usually a dict, but Haiku
    # occasionally wraps per-player objects in a top-level list. `_normalize`
    # handles both shapes.
    return json.loads(_strip_code_fences(text))


def _merge_list_response(entries: list) -> dict:
    """Collapse a list of per-entry dicts into our single-object shape.

    Haiku's multi-player responses sometimes arrive as
        [{"player": "A", ...}, {"player": "B", ...}]
    one entry per person. We union the player names and take the first
    non-null value seen for team/card_number/side.
    """
    players: list[str] = []
    team: str | None = None
    card_number: str | None = None
    side: str | None = None

    for entry in entries:
        if not isinstance(entry, dict):
            continue
        # Accept either "players" (new canonical) or "player" (legacy).
        p = entry.get("players", entry.get("player"))
        if isinstance(p, list):
            players.extend(_nullable_str(x) or "" for x in p if _nullable_str(x))
        else:
            single = _nullable_str(p)
            if single:
                players.append(single)
        if team is None:
            team = _nullable_str(entry.get("team"))
        if card_number is None:
            card_number = _nullable_str(entry.get("card_number"))
        if side is None:
            side = _side_or_none(entry.get("side"))

    return {
        "players": players,
        "team": team,
        "card_number": card_number,
        "side": side,
    }


def _normalize(raw: object, raw_text: str) -> ClassifyResult:
    if isinstance(raw, list):
        raw = _merge_list_response(raw)
    if not isinstance(raw, dict):
        # A string/number at the top level; treat as unparseable — the
        # retry path will ask the model for a stricter shape.
        raise TypeError(f"expected JSON object, got {type(raw).__name__}")

    players_raw = raw.get("players", raw.get("player"))
    if isinstance(players_raw, list):
        players = [p for p in (_nullable_str(x) for x in players_raw) if p]
    else:
        single = _nullable_str(players_raw)
        players = [single] if single else []

    side = _side_or_none(raw.get("side"))

    return ClassifyResult(
        players=players,
        team=_nullable_str(raw.get("team")),
        card_number=_nullable_str(raw.get("card_number")),
        side=side,
        raw_text=raw_text,
    )


def _side_or_none(value: object) -> str | None:
    """`"front"` or `"back"`, else None (NEO-327).

    An unreadable side used to default to "front", which presented a guess
    as a classification. The pairing pool decides sides from Vision's text
    count first, so an honest None costs nothing and a fake "front" can
    outvote the evidence.
    """
    if not isinstance(value, str):
        return None
    side = value.strip().lower()
    return side if side in {"front", "back"} else None


def _nullable_str(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def response_text(response: object) -> str:
    """The text of the first `text` block in a Messages response, or "".

    Shared with the haiku_bbox crop strategy. Haiku 5.5 thinks by default, so
    `content` can open with `thinking` blocks (their text empty unless asked
    for); `content[0]` is no longer the answer. A response with no text block
    at all (`stop_reason` "refusal", or "max_tokens" spent on thinking) yields
    "" and is logged, so each caller's existing unparseable-response path
    handles it rather than an IndexError or AttributeError.
    """
    for block in getattr(response, "content", None) or []:
        if getattr(block, "type", None) == "text":
            return getattr(block, "text", "") or ""
    logger.warning(
        "anthropic: response has no text block (stop_reason=%s)",
        getattr(response, "stop_reason", None),
    )
    return ""


def _call_model(
    client: anthropic.Anthropic,
    *,
    model: str,
    image_b64: str,
    media_type: str,
    prompt: str,
) -> str:
    response = client.messages.create(
        model=model,
        max_tokens=MAX_TOKENS,
        output_config={"effort": EFFORT},
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": image_b64,
                        },
                    },
                    {"type": "text", "text": prompt},
                ],
            }
        ],
    )
    return response_text(response)


def classify_card(
    image_bytes: bytes,
    *,
    client: anthropic.Anthropic | None = None,
    model: str = DEFAULT_MODEL,
    prompt: str | None = None,
) -> ClassifyResult:
    """Classify a card image.

    Makes up to two Anthropic calls: an initial attempt, and one retry if the
    first response fails to parse as JSON (including a response with no text
    block, e.g. a refusal). Raises `ClassifyError` if both attempts fail.
    `prompt` overrides `PROMPT` and exists for
    `scripts/eval_classify.py`, which scores prompt wordings side by side;
    production always uses the default.
    """
    base_prompt = PROMPT if prompt is None else prompt
    if not image_bytes:
        raise ValueError("image_bytes is empty")

    ai_client = client or get_anthropic_client()
    payload, media_type = _prepare_for_anthropic(image_bytes)
    image_b64 = base64.b64encode(payload).decode("ascii")

    first_text = _call_model(
        ai_client,
        model=model,
        image_b64=image_b64,
        media_type=media_type,
        prompt=base_prompt,
    )
    try:
        return _normalize(_parse_response(first_text), first_text)
    except (json.JSONDecodeError, TypeError, AttributeError) as first_err:
        logger.warning("classify: first response parse failed, retrying: %s", first_err)

    retry_text = _call_model(
        ai_client,
        model=model,
        image_b64=image_b64,
        media_type=media_type,
        prompt=base_prompt + RETRY_PROMPT_SUFFIX,
    )
    try:
        return replace(_normalize(_parse_response(retry_text), retry_text), retried=True)
    except (json.JSONDecodeError, TypeError, AttributeError) as retry_err:
        raise ClassifyError(
            f"model response could not be parsed as JSON after retry: {retry_err}"
        ) from retry_err
