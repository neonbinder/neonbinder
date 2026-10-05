#!/usr/bin/env python3
"""
Generate the synthetic card scans the placeholder-pipeline E2E gates upload.

    # CORNERED cards (the HEAVY-escalation flow):
    services/preprocess/.venv/bin/python3 apps/web/scripts/generate-placeholder-fixtures.py --corner
    # INSET cards (the FAST quad-crop flow) — the default:
    services/preprocess/.venv/bin/python3 apps/web/scripts/generate-placeholder-fixtures.py
    # FULL-BLEED cards (the FAST identity flows):
    services/preprocess/.venv/bin/python3 apps/web/scripts/generate-placeholder-fixtures.py --full-bleed

Run from the repo root. Pillow lives in the preprocess service's venv on
purpose — apps/web deliberately gains no image dependency for a test-only
concern, so this script is NOT wired into any npm script. Its OUTPUT is
committed; you only re-run this to regenerate.

--------------------------------------------------------------------------
THREE FIXTURE MODES — one per way the FAST service can route a scan
--------------------------------------------------------------------------
The preprocess service runs as two Cloud Run roles (NEO-175). Images hit a FAST
service first, which settles a scan without loading a model in one of two ways:
a frame that already IS the card is accepted as a "frame" identity, and since
NEO-320 a single card on a background is perspective-cropped by the quad stage
(`services/preprocess/app/cropper/quad.py`). Anything neither settles is
DECLINED and re-enqueued to the HEAVY BiRefNet service, which cold-loads the
model (~191s the first time).

Each mode below exercises exactly one of those routes. Every mode draws the
SAME three cards (same players, numbers, text and per-file seeds); only where
the card sits in the frame differs:

  * DEFAULT (inset)  -> public/placeholder-fixtures/           -> every card is
    CENTRED on a scanner bed with a wide margin all round, which the quad stage
    crops on the FAST service (no escalation). Drives
    placeholders/pipeline-fast-crops-inset-scans.yaml. Before NEO-320 these
    escalated, and the escalation flow used them; the quad stage made them a
    fast crop, which is why the cornered set exists.
  * --corner         -> public/placeholder-fixtures-corner/    -> every card is
    pushed into the top-left REGISTRATION CORNER of the scanner bed, a thin
    strip of bed (CORNER_GAP) from two frame edges — how a flatbed scan
    actually comes out when the card is laid against the glass's corner guide.
    The quad stage declines it by design (`frame_edge`: a side that close to
    the frame edge leaves no room to rule out a thin background-coloured
    border cut off by the frame), and the identity check declines it (the card
    does not fill the frame), so every card ESCALATES to BiRefNet, which
    segments it like any card on a bed. Drives
    placeholders/pipeline-escalation-cold-start.yaml, which uploads all six
    (more escalations than a PR preview's heavy cap, NEO-299) and asserts the
    "A few of these need a closer look…" cold-start notice, "All 6 photos
    read." and "3 pairs ready to print.".
  * --full-bleed     -> public/placeholder-fixtures-fullbleed/ -> every card
    FILLS the frame and STAYS on the fast path as a "frame" identity. Drives
    placeholders/pipeline-pairs-uploaded-scans.yaml and
    placeholders/flip-edge-mirrors-the-backs.yaml.

All three modes are VALIDATED against the real FAST decision without a network,
from services/preprocess with its venv:
`app.cropper.tiered.fast_tiered_crop(bytes)` returns the input untouched for an
identity accept and `None` otherwise; `app.cropper.quad.quad_crop(bytes).reason`
is "ok" for a quad crop and names the check that declined otherwise. Expected:
inset -> tiered None, quad "ok"; corner -> tiered None, quad "frame_edge";
full-bleed -> tiered accept (quad never runs). Re-run both over every output
directory after any change here, AND after any change to quad.py or tiered.py's
fast path: a FAST stage that starts settling the cornered set silently stops
the escalation flow from escalating (NEO-320 did exactly that to the inset set).
Do not regenerate a set to "improve" it — each flow depends on those bytes.

--------------------------------------------------------------------------
WHY SYNTHETIC
--------------------------------------------------------------------------
This repo is public. Real card scans are someone else's copyrighted artwork,
and real player/team names carry trademarks. Every name, team and statistic
below is invented, so the fixtures are ours to publish.

--------------------------------------------------------------------------
WHY BOTH SIDES PRINT THE SAME FULL PLAYER NAME  (the load-bearing constraint)
--------------------------------------------------------------------------
Pairing is IDENTITY-FIRST (`placeholderPairing.ts` calls `pairBatch` with
`useAdjacency: false` — NEO-170's precedence rework). Every image goes through
the identity pool, so the resolver runs once per done image, and a front pairs
to a back ONLY when the
two share an extractable identity: `lib/pairing/pool.ts` scores a candidate on
player name (`names.ts` — a surname-only fuzzy rung, "BUEHLER" front ↔ "Walker
Buehler" back) or team, and a FRONT's card number is discarded, so it never
contributes. A pool match renders "… · by image pool" (which pairs landed by
which mechanism is left to the pairing unit tests, not asserted by the flows).
Anything the pool cannot place drops to the guarded adjacency
fallback and renders "… · by scan order" — a regression signal on these clean,
name-matching fixtures.

So each card must carry a player name the model reads the SAME way on both
sides. The earlier revision printed only the surname on the front (and named
only the *given* name in the back's blurb): the model extracted nothing usable
from a lone-surname front and read the given name off the back, the two never
matched, and every pair fell to "by scan order". The fix is here, in the
fixtures: each FRONT and each BACK prints the SAME full name ("Given Surname"),
so both extractions agree and the pool matches → "by image pool".

Side detection still rides on `textCount` — the Google Vision word-annotation
count `services/preprocess/app/orient.py` produces for free — plus the
service's own front/back classifier. A front carries just the two-word name
over a photo block (textCount ~2); a back carries ~40 words (a dense blurb),
far above the >=5 "confidently a back" floor. The old "exactly one word /
textCount<=2 / zero resolver calls" rule is gone: it existed only to feed an
adjacency PRE-pass that no longer runs.

Each BACK also prints a distinct card number (#17 / #42 / #83) large and
high-contrast, so it OCRs reliably and the three finished pairs can be told
apart on screen.

--------------------------------------------------------------------------
WHY THE CARD IS INSET ON A NOISY BACKGROUND
--------------------------------------------------------------------------
The HEAVY crop stage is BiRefNet (via rembg) — *salient-object segmentation*, not
contour or quad detection. A full-bleed card image gives it no background to
separate and produces a degenerate mask. So each fixture is a card-shaped
rectangle inset on a contrasting, grainy "scanner bed", and the card itself is
grainy rather than flat: segmentation models are trained on photographs and
behave unpredictably on flat synthetic colour. The grain also puts the files in
a realistic ~100-300KB range instead of compressing to a few KB.

The noise CHARACTER here is what was validated end-to-end (croppedSource=tiered,
clean crops). Keep it if you edit this file. Seeds are derived per-image from
the filename so regenerating is byte-reproducible while each scan still differs.
"""

from __future__ import annotations

import json
import random
import sys
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# --full-bleed / --corner select the fixture set (see the header). Read once at
# module load; they steer the output directory and how each card is composed.
FULL_BLEED = "--full-bleed" in sys.argv
CORNER = "--corner" in sys.argv
if FULL_BLEED and CORNER:
    sys.exit("--full-bleed and --corner are separate sets; pass one")

# Scan canvas. ~1000x1400 matches a real flatbed scan of a standard 2.5x3.5in
# card at moderate DPI — and its 1000:1400 aspect IS the 2.5:3.5 card aspect, so
# the whole frame reads as card-aspect (what the fast path's "frame" check needs).
SCAN_W, SCAN_H = 1000, 1400

# INSET (default) and CORNER: a 720x1010 card on the bed — centred with a wide
# uniform margin (inset: the quad stage crops it on the fast path), or pushed
# into the top-left corner (corner: the quad stage declines, so it escalates to
# BiRefNet).
# FULL-BLEED: the card FILLS the frame, so the fast path's classical pass sees an
# object covering the whole frame and returns the "frame" identity verdict — the
# image stays on the fast path and never loads the model.
CARD_W, CARD_H = (SCAN_W, SCAN_H) if FULL_BLEED else (720, 1010)

# Full-bleed cards fill the frame apart from a thin, distinct border RING. The
# fast path estimates the background colour from that outer ring, then measures
# how much of the frame the enclosed interior fills: the "frame" verdict needs
# >=92%. At 18px the interior is (1000-36)x(1400-36) ~= 94% of the frame — over
# the bar — while the ring stays thicker than the detector's 3%-of-short-edge
# background sampling band, so interior pixels do not dilute the estimate.
BLEED_BORDER = 18

# CORNER: the strip of scanner bed left between the card and the TOP and LEFT
# frame edges. 14px of a 1000x1400 scan is 12px at the detector's 1200px work
# resolution, ~0.02 of the card's short side — under half the quad stage's
# FRAME_EDGE_MIN (0.048), so it declines `frame_edge` with room to spare, while
# the card is still wholly on the bed (never cut off by the frame), which is what
# lets BiRefNet segment it whole and the heavy crop keep every edge.
CORNER_GAP = 14

SCAN_BASE = (52, 58, 66)  # dark scanner bed (inset) / border ring (full-bleed)
JPEG_QUALITY = 88

OUT_DIR = (
    Path(__file__).resolve().parent.parent
    / "public"
    / (
        "placeholder-fixtures-fullbleed"
        if FULL_BLEED
        else "placeholder-fixtures-corner"
        if CORNER
        else "placeholder-fixtures"
    )
)

# Invented players, invented teams, invented statistics.
PLAYERS = [
    {
        "surname": "VORKLE",
        "given": "Grebble",
        "number": "17",
        "team": "Portstone Ironbacks",
        "card_fill": (206, 198, 180),
        "photo_fill": (74, 96, 128),
    },
    {
        "surname": "QUILLDEN",
        "given": "Marcus",
        "number": "42",
        "team": "Askew Valley Tanagers",
        "card_fill": (198, 206, 192),
        "photo_fill": (118, 82, 74),
    },
    {
        "surname": "MOSSBAUM",
        "given": "Teodor",
        "number": "83",
        "team": "Riven Harbor Cormorants",
        "card_fill": (210, 194, 196),
        "photo_fill": (86, 108, 86),
    },
]

# ~40 words. Deliberately dense: stat line, career blurb, copyright line — the
# same shape of text a real card back carries, which is why the word count lands
# far above the >=5 "confidently a back" floor. It LEADS with the full name so
# the back's identity extraction agrees with the front's (both "Given Surname"),
# which is what lets the identity pool pair them — see the header.
BACK_BLURB = (
    "{given} {surname} joined the {team} in his rookie season and posted a .311 "
    "average with 24 home runs and 88 runs batted in across 142 games. He led "
    "the league in doubles twice and was named to three consecutive all-star "
    "selections. Bats right, throws right."
)
BACK_FOOTER = "(c) Neon Binder test fixture - not a real trading card"


def seeded_noise(width: int, height: int, base: tuple[int, int, int],
                 spread: int, seed: int) -> Image.Image:
    """A flat colour with per-pixel grain. Deterministic for a given seed."""
    img = Image.new("RGB", (width, height))
    px = img.load()
    rnd = random.Random(seed)
    for y in range(height):
        for x in range(width):
            n = rnd.randint(-spread, spread)
            px[x, y] = tuple(max(0, min(255, c + n)) for c in base)
    return img


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in (
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def new_card(fill: tuple[int, int, int], seed: int) -> Image.Image:
    if FULL_BLEED:
        # A distinct dark border RING around a large card-colour interior. The
        # fast classical pass reads the background from the ring, sees the
        # interior as one object filling >=92% of the frame, and returns the
        # "frame" identity verdict — the image stays on the fast path, no model.
        card = seeded_noise(CARD_W, CARD_H, SCAN_BASE, spread=10, seed=seed)
        interior = seeded_noise(
            CARD_W - 2 * BLEED_BORDER,
            CARD_H - 2 * BLEED_BORDER,
            fill,
            spread=8,
            seed=seed + 3,
        )
        card.paste(interior, (BLEED_BORDER, BLEED_BORDER))
        return card
    card = seeded_noise(CARD_W, CARD_H, fill, spread=8, seed=seed)
    ImageDraw.Draw(card).rectangle(
        [0, 0, CARD_W - 1, CARD_H - 1], outline=(30, 30, 30), width=6
    )
    return card


def compose(card: Image.Image, seed: int) -> Image.Image:
    """Lay the card on a grainy scanner bed — centred (inset) or in the top-left
    registration corner (corner) — or, full-bleed, return it as-is.

    Full-bleed cards already fill the frame (that is the whole point: no
    background for the fast path to crop out), so there is no bed to inset on.
    """
    if FULL_BLEED:
        return card
    scan = seeded_noise(SCAN_W, SCAN_H, SCAN_BASE, spread=14, seed=seed)
    if CORNER:
        scan.paste(card, (CORNER_GAP, CORNER_GAP))
    else:
        scan.paste(card, ((SCAN_W - CARD_W) // 2, (SCAN_H - CARD_H) // 2))
    return scan


def draw_front(player: dict, seed: int) -> Image.Image:
    """The full player name over the card. The front carries the WHOLE name
    ("Given Surname"), not a lone surname, so the identity pool can match it to
    its back — see the header.

    INSET fronts add a "photo" block for realism. FULL-BLEED fronts deliberately
    OMIT it: a large contrasting block inside a frame-filling card can read as a
    smaller card-aspect object and tip the fast path into the "crop it out"
    (escalate) verdict instead of "frame" identity. Without it the whole
    interior is one object filling the frame — exactly the fast-accept case. The
    lone two-word name keeps the word count low either way, so the side still
    reads "front"."""
    card = new_card(player["card_fill"], seed)
    draw = ImageDraw.Draw(card)

    if not FULL_BLEED:
        # A "photo" region. Purely geometric: the only text on the front is the
        # nameplate below, so the word count stays low and the side reads "front".
        draw.rectangle([44, 44, CARD_W - 44, 700], fill=player["photo_fill"])
        draw.rectangle([44, 44, CARD_W - 44, 700], outline=(38, 38, 38), width=4)
        # A suggestion of a subject, so the frame is not a flat rectangle.
        draw.ellipse([CARD_W // 2 - 96, 210, CARD_W // 2 + 96, 402],
                     fill=(round(player["photo_fill"][0] * 1.35) % 256,
                           round(player["photo_fill"][1] * 1.35) % 256,
                           round(player["photo_fill"][2] * 1.35) % 256))
        draw.rectangle([CARD_W // 2 - 150, 430, CARD_W // 2 + 150, 690],
                       fill=(round(player["photo_fill"][0] * 1.15) % 256,
                             round(player["photo_fill"][1] * 1.15) % 256,
                             round(player["photo_fill"][2] * 1.15) % 256))

    # font sized so the widest name ("Teodor Mossbaum") clears the card margins.
    font = load_font(58)
    text = f"{player['given']} {player['surname']}"
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    # Inset: below the photo block (y=800). Full-bleed: centred, since there is
    # no photo above and the card is the full 1400px tall.
    name_y = CARD_H // 2 if FULL_BLEED else 800
    draw.text(
        ((CARD_W - (right - left)) / 2 - left, name_y - top),
        text,
        font=font,
        fill=(24, 24, 24),
    )
    return compose(card, seed + 1)


def draw_back(player: dict, seed: int) -> Image.Image:
    """Full name + number + a dense paragraph — ~40 words. The name heading
    matches the front's ("Given Surname") so both sides resolve the same
    identity and the pool pairs them — see the header."""
    card = new_card(player["card_fill"], seed)
    draw = ImageDraw.Draw(card)

    # 52, not 58: the full name is longer than the old lone surname and must
    # still clear the right margin.
    name_font = load_font(52)
    num_font = load_font(46)
    body_font = load_font(30)

    full_name = f"{player['given']} {player['surname']}"
    draw.text((52, 56), full_name, font=name_font, fill=(24, 24, 24))
    draw.text((52, 130), f"#{player['number']}", font=num_font, fill=(24, 24, 24))
    draw.line([52, 196, CARD_W - 52, 196], fill=(60, 60, 60), width=3)

    blurb = BACK_BLURB.format(
        given=player["given"], surname=player["surname"], team=player["team"]
    )
    y = 232
    for line in textwrap.wrap(blurb, width=34):
        draw.text((52, y), line, font=body_font, fill=(30, 30, 30))
        y += 42

    draw.text((52, CARD_H - 96), BACK_FOOTER, font=load_font(22),
              fill=(70, 70, 70))
    return compose(card, seed + 1)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest: list[dict] = []

    # Upload order is front/back alternation — realistic scan order, and the
    # order the guarded adjacency FALLBACK would read if identity ever failed to
    # place a card. Identity-first pairing does not depend on it.
    for index, player in enumerate(PLAYERS):
        for side in ("front", "back"):
            position = index * 2 + (0 if side == "front" else 1)
            filename = f"{position + 1:02d}-{player['surname'].lower()}-{side}.jpg"
            # Derived from the filename, NOT hash() — Python salts hash() per
            # process, which would make regeneration produce different bytes.
            seed = sum(filename.encode()) * 7919

            image = (draw_front if side == "front" else draw_back)(player, seed)
            path = OUT_DIR / filename
            image.save(path, "JPEG", quality=JPEG_QUALITY)

            manifest.append({
                "file": filename,
                "side": side,
                "player": f"{player['given']} {player['surname']}",
                "cardNumber": player["number"] if side == "back" else None,
                "bytes": path.stat().st_size,
            })
            print(f"  {filename}  {path.stat().st_size // 1024} KB")

    routing = (
        "FULL-BLEED cards that FILL the frame, so the NEO-175 fast path accepts "
        "them as 'frame' identity and they never escalate to the heavy service."
        if FULL_BLEED
        else "CORNERED cards laid in the scanner bed's top-left corner, which the "
        "NEO-320 quad stage declines (frame_edge) and the identity check declines, "
        "so every one escalates to the heavy BiRefNet service."
        if CORNER
        else "INSET cards centred on a scanner bed, which the NEO-320 quad stage "
        "crops on the fast path, so none escalates to the heavy service."
    )
    (OUT_DIR / "manifest.json").write_text(
        json.dumps(
            {
                "description": (
                    "Synthetic card scans for the placeholder-pipeline E2E gate. "
                    "Generated by apps/web/scripts/generate-placeholder-fixtures.py"
                    + (" --full-bleed" if FULL_BLEED else " --corner" if CORNER else "")
                    + ". "
                    + routing
                    + " Both lists are in UPLOAD ORDER — front/back alternation. "
                    "Each front and back print the SAME full player name so the "
                    "identity pool pairs them. `files` is the "
                    "contract the seed page reads; `images` is the same order with "
                    "the metadata a human (or a flow author picking assertions) needs."
                ),
                "pairCount": len(PLAYERS),
                "files": [entry["file"] for entry in manifest],
                "images": manifest,
            },
            indent=2,
        )
        + "\n"
    )
    print(f"\n{len(manifest)} images + manifest.json -> {OUT_DIR}")


if __name__ == "__main__":
    main()
