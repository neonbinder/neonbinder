"""Unit tests for app.vision_card_number (NEO-327).

Synthetic Vision responses only. The rule under test answers ONLY when the
read is definitive; every ambiguous shape must come back None so Haiku's
number stands.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from google.cloud import vision

from app.classify import ClassifyResult
from app.cropper import resolve_card_number
from app.orient import OrientationResult, detect_orientation
from app.vision_card_number import (
    MIN_SYMBOL_CONFIDENCE,
    OcrWord,
    card_number_from_words,
    vision_card_number,
    words_from_response,
)

# A card-sized text extent: a word at each extreme pins it to 0..1000 x 0..1400.
H = 40


def _box(x: float, y: float, w: float, h: float = H, rotate_180: bool = False):
    tl, tr, br, bl = (x, y), (x + w, y), (x + w, y + h), (x, y + h)
    if rotate_180:
        # Upside-down text: text-local TL is the image's bottom-right corner.
        return (br, bl, tl, tr)
    return (tl, tr, br, bl)


def _w(text, x, y, w=None, conf=0.99, rotate_180=False) -> OcrWord:
    width = w if w is not None else 20 * len(text)
    return OcrWord(text, _box(x, y, width, rotate_180=rotate_180), conf)


def _frame_words() -> list[OcrWord]:
    """Text a back carries away from its number: name, bio, stats, copyright."""
    return [
        _w("BEN", 60, 20),
        _w("TATE", 140, 20),
        _w("Tate", 100, 600),
        _w("joined", 200, 600),
        _w("the", 340, 600),
        _w("Browns", 420, 600),
        _w("2014", 60, 1340),
        _w("Panini", 900, 1340, w=100),
    ]


def _card(*number_words: OcrWord) -> list[OcrWord]:
    return [*_frame_words(), *number_words]


class TestDefinitive:
    def test_prefix_then_number_in_the_corner(self):
        assert card_number_from_words(_card(_w("No.", 800, 20), _w("20", 870, 20))) == "20"

    def test_joined_token(self):
        assert card_number_from_words(_card(_w("No.20", 800, 20))) == "20"

    def test_no_and_dot_as_separate_words(self):
        words = _card(_w("No", 800, 20), _w(".", 840, 20, w=8), _w("20", 860, 20))
        assert card_number_from_words(words) == "20"

    def test_hash_prefix_with_letter_number(self):
        assert card_number_from_words(_card(_w("#", 780, 1340, w=20), _w("rc-12", 810, 1340))) == (
            "RC-12"
        )

    def test_upside_down_text(self):
        # Orient reads the raw (un-rotated) image: the number runs right to left
        # along the bottom edge. Adjacency is measured in the text's own frame.
        words = _card(
            _w("No.", 140, 1360, rotate_180=True),
            _w("20", 80, 1360, w=40, rotate_180=True),
        )
        assert card_number_from_words(words) == "20"

    def test_confidence_absent_relies_on_geometry(self):
        words = _card(_w("No.", 800, 20, conf=None), _w("20", 870, 20, conf=None))
        assert card_number_from_words(words) == "20"

    def test_bare_english_no_elsewhere_does_not_count(self):
        words = _card(
            _w("No.", 800, 20),
            _w("20", 870, 20),
            _w("No", 100, 700),
            _w("one", 160, 700),
        )
        assert card_number_from_words(words) == "20"


class TestNotDefinitive:
    def test_two_candidates(self):
        # The bio's "the No. 1 pick" beside the real number: ambiguous.
        words = _card(
            _w("No.", 800, 20),
            _w("20", 870, 20),
            _w("No.", 30, 650),
            _w("1", 100, 650),
        )
        assert card_number_from_words(words) is None

    def test_low_confidence_number(self):
        words = _card(_w("No.", 800, 20), _w("20", 870, 20, conf=MIN_SYMBOL_CONFIDENCE - 0.01))
        assert card_number_from_words(words) is None

    def test_low_confidence_prefix(self):
        words = _card(_w("No.", 800, 20, conf=0.5), _w("20", 870, 20))
        assert card_number_from_words(words) is None

    def test_no_prefix(self):
        assert card_number_from_words(_card(_w("20", 870, 20))) is None

    def test_prefix_followed_by_a_word(self):
        assert card_number_from_words(_card(_w("No.", 800, 20), _w("pick", 870, 20))) is None

    def test_number_too_far_from_prefix(self):
        # Gap of 3 line heights: not the prefix's own number.
        assert card_number_from_words(_card(_w("No.", 700, 20), _w("20", 880, 20))) is None

    def test_word_between_prefix_and_number(self):
        words = _card(_w("No.", 760, 20), _w("x", 830, 20), _w("20", 860, 20))
        assert card_number_from_words(words) is None

    def test_number_on_the_next_line(self):
        assert card_number_from_words(_card(_w("No.", 800, 20), _w("20", 870, 80))) is None

    def test_prefix_mid_paragraph(self):
        # Only "No." pair on the card, but in the middle of the text: a bio
        # mention, not the card number.
        assert card_number_from_words(_card(_w("No.", 450, 700), _w("1", 520, 700))) is None

    def test_explicit_prefix_with_nothing_after_it_is_ambiguous(self):
        words = _card(_w("No.", 800, 20), _w("20", 870, 20), _w("#", 980, 700, w=20))
        assert card_number_from_words(words) is None

    def test_decimal_is_not_a_card_number(self):
        assert card_number_from_words(_card(_w("No.", 800, 20), _w("6.5", 870, 20))) is None

    def test_empty(self):
        assert card_number_from_words([]) is None


def _symbols(text: str, conf: float):
    return [SimpleNamespace(text=c, confidence=conf) for c in text]


def _poly(x, y, w, h=H):
    return SimpleNamespace(
        vertices=[SimpleNamespace(x=px, y=py) for px, py in _box(x, y, w, h)],
    )


def _full_response(words: list[tuple[str, float, float, float, float]]):
    """A response carrying `full_text_annotation` words with symbol confidences."""
    vision_words = [
        SimpleNamespace(bounding_box=_poly(x, y, w), symbols=_symbols(text, conf))
        for text, x, y, w, conf in words
    ]
    page = SimpleNamespace(
        blocks=[SimpleNamespace(paragraphs=[SimpleNamespace(words=vision_words)])]
    )
    return SimpleNamespace(
        full_text_annotation=SimpleNamespace(pages=[page]),
        text_annotations=[],
    )


class TestResponseShapes:
    def test_full_text_annotation_with_confidence(self):
        response = _full_response(
            [
                ("TATE", 60, 20, 80, 0.99),
                ("Panini", 900, 1340, 100, 0.99),
                ("No.", 800, 20, 60, 0.98),
                ("20", 870, 20, 40, 0.97),
            ]
        )
        assert vision_card_number(response) == "20"

    def test_one_weak_symbol_rejects_the_word(self):
        response = _full_response(
            [
                ("TATE", 60, 20, 80, 0.99),
                ("Panini", 900, 1340, 100, 0.99),
                ("No.", 800, 20, 60, 0.98),
            ]
        )
        number = SimpleNamespace(
            bounding_box=_poly(870, 20, 40),
            symbols=[
                SimpleNamespace(text="2", confidence=0.99),
                SimpleNamespace(text="0", confidence=0.4),
            ],
        )
        response.full_text_annotation.pages[0].blocks[0].paragraphs[0].words.append(number)
        assert vision_card_number(response) is None

    def test_all_zero_confidences_mean_unreported(self):
        response = _full_response(
            [
                ("TATE", 60, 20, 80, 0.0),
                ("Panini", 900, 1340, 100, 0.0),
                ("No.", 800, 20, 60, 0.0),
                ("20", 870, 20, 40, 0.0),
            ]
        )
        assert vision_card_number(response) == "20"

    def test_text_annotations_fallback(self):
        def ann(text, x, y, w):
            return SimpleNamespace(description=text, bounding_poly=_poly(x, y, w))

        response = SimpleNamespace(
            full_text_annotation=SimpleNamespace(pages=[]),
            text_annotations=[
                ann("whole document", 0, 0, 1000),
                ann("TATE", 60, 20, 80),
                ann("Panini", 900, 1340, 100),
                ann("No.", 800, 20, 60),
                ann("20", 870, 20, 40),
            ],
        )
        assert [w.text for w in words_from_response(response)] == ["TATE", "Panini", "No.", "20"]
        assert vision_card_number(response) == "20"

    def test_real_proto_types(self):
        def vword(text, x, y, w):
            return vision.Word(
                bounding_box=vision.BoundingPoly(
                    vertices=[vision.Vertex(x=int(px), y=int(py)) for px, py in _box(x, y, w)]
                ),
                symbols=[vision.Symbol(text=c, confidence=0.99) for c in text],
            )

        response = vision.AnnotateImageResponse(
            full_text_annotation=vision.TextAnnotation(
                pages=[
                    vision.Page(
                        blocks=[
                            vision.Block(
                                paragraphs=[
                                    vision.Paragraph(
                                        words=[
                                            vword("TATE", 60, 20, 80),
                                            vword("Panini", 900, 1340, 100),
                                            vword("No.", 800, 20, 60),
                                            vword("20", 870, 20, 40),
                                        ]
                                    )
                                ]
                            )
                        ]
                    )
                ]
            )
        )
        assert vision_card_number(response) == "20"

    def test_empty_response(self):
        assert vision_card_number(vision.AnnotateImageResponse()) is None


class TestDetectOrientationCarriesIt:
    def _annotation(self, text, x, y, w):
        return SimpleNamespace(description=text, bounding_poly=_poly(x, y, w))

    def test_definitive_read_rides_on_the_orient_result(self):
        anns = [
            self._annotation("doc", 0, 0, 1000),
            self._annotation("TATE", 60, 20, 80),
            self._annotation("Panini", 900, 1340, 100),
            self._annotation("No.", 800, 20, 60),
            self._annotation("20", 870, 20, 40),
        ]
        response = SimpleNamespace(
            error=SimpleNamespace(message=""),
            text_annotations=anns,
            full_text_annotation=SimpleNamespace(pages=[]),
        )
        client = SimpleNamespace(text_detection=lambda image: response)

        result = detect_orientation(b"img", client=client)

        assert result.vision_card_number == "20"
        assert result.text_count == 4

    def test_a_read_failure_never_fails_orient(self, monkeypatch):
        import app.orient as orient

        def boom(_response):
            raise RuntimeError("unexpected shape")

        monkeypatch.setattr(orient, "vision_card_number", boom)
        anns = [self._annotation("doc", 0, 0, 1000), self._annotation("TATE", 60, 20, 80)]
        response = SimpleNamespace(error=SimpleNamespace(message=""), text_annotations=anns)
        client = SimpleNamespace(text_detection=lambda image: response)

        result = detect_orientation(b"img", client=client)

        assert result.vision_card_number is None
        assert result.text_count == 1


def _classification(side, card_number):
    return ClassifyResult(players=[], team=None, card_number=card_number, side=side, raw_text="{}")


def _orient(vision_number):
    return OrientationResult(
        rotation_degrees=0, confidence=1.0, text_count=100, vision_card_number=vision_number
    )


class TestResolveCardNumber:
    def test_vision_wins_on_a_back(self):
        result, source = resolve_card_number(_orient("20"), _classification("back", "90"))
        assert (result.card_number, source) == ("20", "vision")
        assert result.side == "back"

    def test_vision_wins_when_side_unknown(self):
        result, source = resolve_card_number(_orient("20"), _classification(None, None))
        assert (result.card_number, source) == ("20", "vision")

    def test_never_on_a_front(self):
        result, source = resolve_card_number(_orient("24"), _classification("front", None))
        assert (result.card_number, source) == (None, None)

    def test_front_keeps_haiku_number(self):
        result, source = resolve_card_number(_orient("24"), _classification("front", "7"))
        assert (result.card_number, source) == ("7", "haiku")

    @pytest.mark.parametrize("haiku", ["90", None])
    def test_haiku_when_vision_not_definitive(self, haiku):
        result, source = resolve_card_number(_orient(None), _classification("back", haiku))
        assert result.card_number == haiku
        assert source == ("haiku" if haiku else None)
