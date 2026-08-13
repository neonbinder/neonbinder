"""Unit tests for app.jobs.layout — object keys and the identifier rules.

Covers: the Clerk-subject and UUID shape checks (including every traversal
payload someone would try to smuggle through an id), each derived key, the
fixed-width zero padding the status log's ordering depends on, and the
image-key derivation that makes zip slip structurally impossible.
"""

from __future__ import annotations

import pytest

from app.jobs import layout
from app.jobs.layout import InvalidJobIdentifierError

USER = "user_2abcDEF123"
JOB = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"

# Payloads that would escape the job's prefix if either identifier were
# interpolated without a shape check. Every one must be refused.
TRAVERSAL_PAYLOADS = [
    "..",
    "../..",
    "user_../../other",
    "/etc/passwd",
    "user_a/../user_b",
    "user_a%2f..%2fuser_b",
    "user_a\x00",
    "user_a\n",
    "user_a/b",
    "user_a\\b",
]


class TestValidateIdentifiers:
    def test_accepts_a_real_pair(self):
        layout.validate_identifiers(USER, JOB)

    @pytest.mark.parametrize("payload", TRAVERSAL_PAYLOADS)
    def test_rejects_traversal_in_user_id(self, payload):
        with pytest.raises(InvalidJobIdentifierError, match="user_id"):
            layout.validate_identifiers(payload, JOB)

    @pytest.mark.parametrize("payload", TRAVERSAL_PAYLOADS)
    def test_rejects_traversal_in_job_id(self, payload):
        with pytest.raises(InvalidJobIdentifierError, match="job_id"):
            layout.validate_identifiers(USER, payload)

    @pytest.mark.parametrize(
        "user_id",
        ["", "user_", "usr_abc", "User_abc", "abc", "user_" + "a" * 65],
    )
    def test_rejects_non_clerk_shapes(self, user_id):
        with pytest.raises(InvalidJobIdentifierError):
            layout.validate_identifiers(user_id, JOB)

    @pytest.mark.parametrize(
        "job_id",
        [
            "",
            "1",
            "3f2504e04f8911d39a0c0305e82c3301",
            "3f2504e0-4f89-11d3-9a0c-0305e82c330",
            "3f2504e0-4f89-11d3-9a0c-0305e82c3301x",
            "zzzzzzzz-4f89-11d3-9a0c-0305e82c3301",
        ],
    )
    def test_rejects_non_uuid_shapes(self, job_id):
        with pytest.raises(InvalidJobIdentifierError):
            layout.validate_identifiers(USER, job_id)

    def test_error_does_not_echo_the_offending_value(self):
        with pytest.raises(InvalidJobIdentifierError) as excinfo:
            layout.validate_identifiers("<script>alert(1)</script>", JOB)
        assert "script" not in str(excinfo.value)


class TestKeys:
    def test_every_key_sits_under_the_job_prefix(self):
        prefix = layout.job_prefix(USER, JOB)
        assert prefix == f"placeholders/{USER}/{JOB}/"
        for key in (
            layout.input_object(USER, JOB),
            layout.status_object(USER, JOB, 0),
            layout.status_prefix(USER, JOB),
            layout.output_prefix(USER, JOB),
            layout.manifest_object(USER, JOB),
            layout.output_image_object(USER, JOB, 0, "jpg"),
        ):
            assert key.startswith(prefix)

    def test_input_object_matches_the_upload_policy_path(self):
        # convex/adapters/placeholderUploads.ts builds exactly this path when
        # it mints the signed POST policy. If these two ever disagree, the
        # service reads an object that will never exist.
        assert layout.input_object(USER, JOB) == f"placeholders/{USER}/{JOB}/input.zip"

    @pytest.mark.parametrize("sequence", [0, 1, 42, 99_999_999])
    def test_status_keys_are_fixed_width(self, sequence):
        name = layout.status_object(USER, JOB, sequence).rsplit("/", 1)[-1]
        assert name == f"{sequence:0{layout.STATUS_SEQUENCE_DIGITS}d}.json"

    def test_status_keys_sort_numerically(self):
        # The status log finds its latest snapshot with max() over a
        # lexicographic listing; that only works while the padding holds.
        names = [layout.status_object(USER, JOB, n) for n in (0, 2, 9, 10, 11, 100)]
        assert names == sorted(names)
        assert max(names) == layout.status_object(USER, JOB, 100)

    def test_negative_status_sequence_rejected(self):
        with pytest.raises(InvalidJobIdentifierError):
            layout.status_object(USER, JOB, -1)


class TestOutputImageObject:
    @pytest.mark.parametrize("extension", ["jpg", ".JPG", "PNG", "webp"])
    def test_extension_is_normalised(self, extension):
        key = layout.output_image_object(USER, JOB, 7, extension)
        assert key.endswith(f"0007.{extension.lower().lstrip('.')}")

    def test_index_is_zero_padded(self):
        assert layout.output_image_object(USER, JOB, 3, "jpg").endswith("0003.jpg")

    def test_negative_index_rejected(self):
        with pytest.raises(InvalidJobIdentifierError):
            layout.output_image_object(USER, JOB, -1, "jpg")

    @pytest.mark.parametrize("extension", ["../../etc/passwd", "jpg/../..", "j g", ""])
    def test_non_alphanumeric_extension_rejected(self, extension):
        with pytest.raises(InvalidJobIdentifierError):
            layout.output_image_object(USER, JOB, 0, extension)

    def test_key_ignores_the_entry_name_entirely(self):
        # The structural half of the zip-slip defence: the key is a function of
        # the zip ordinal, so a hostile member name has nowhere to go.
        assert layout.output_image_object(USER, JOB, 7, "jpg") == (
            f"placeholders/{USER}/{JOB}/output/images/0007.jpg"
        )


class TestTrailingNewlineAnchoring:
    """The regression the `\\A..\\Z` anchors exist to prevent.

    Python's `$` also matches immediately *before* a trailing newline, so
    `^user_abc$` accepts `"user_abc\\n"`. A newline inside an object-path
    segment is exactly the kind of thing that survives one encoder and confuses
    the next, so both patterns anchor with `\\Z`, which means end-of-string and
    nothing else. These assert the property directly on the patterns rather
    than only through `validate_identifiers`, so the anchors cannot be loosened
    back to `$` without a failure that names the reason.
    """

    @pytest.mark.parametrize("user_id", ["user_abc\n", "user_2abcDEF123\n"])
    def test_user_pattern_rejects_a_trailing_newline(self, user_id):
        assert layout.CLERK_USER_ID_PATTERN.match(user_id) is None
        with pytest.raises(InvalidJobIdentifierError, match="user_id"):
            layout.validate_identifiers(user_id, JOB)

    def test_job_pattern_rejects_a_trailing_newline(self):
        assert layout.JOB_ID_PATTERN.match(f"{JOB}\n") is None
        with pytest.raises(InvalidJobIdentifierError, match="job_id"):
            layout.validate_identifiers(USER, f"{JOB}\n")

    def test_the_valid_forms_still_match(self):
        assert layout.CLERK_USER_ID_PATTERN.match(USER) is not None
        assert layout.JOB_ID_PATTERN.match(JOB) is not None


class TestConvexMirror:
    def test_this_side_is_the_stricter_of_the_two(self):
        # The Convex regex (convex/adapters/placeholderUploads.ts) is
        # /^user_[A-Za-z0-9]+$/ with no length bound. The asymmetry is
        # documented rather than assumed away, and it fails closed: an id
        # Convex would mint a policy for can be refused here, never the
        # reverse. This pins the direction.
        long_body = "user_" + "a" * 200
        assert layout.CLERK_USER_ID_PATTERN.match(long_body) is None
