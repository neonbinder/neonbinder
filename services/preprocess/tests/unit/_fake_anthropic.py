"""A REAL `anthropic.Anthropic` client wired to an in-memory HTTP transport.

The classify and haiku_bbox tests mostly drive a `MagicMock` client, which
accepts any keyword at all. That is exactly how anthropic 1.0 slipped past
them: 1.0 removed `temperature` from `messages.create()` (a direct kwarg is a
TypeError), and every MagicMock test stayed green. Tests built on this helper
run the SDK's own argument handling and request building, then read the JSON
body that would have gone over the wire, so an SDK change that rejects or
drops one of our parameters fails the unit suite instead of production.

A canned answer is either plain text (one `text` block, or no content for "")
or a `Canned` carrying explicit content blocks and a stop reason, for the
Haiku 5.5 shapes: thinking before the text, and a refusal with no text.

anthropic>=1.0 speaks `httpx2` (the maintained httpx fork), so the transport
comes from `httpx2`, which the SDK installs; an `httpx` transport would be
refused at client construction.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

import anthropic
import httpx2


@dataclass(frozen=True)
class Canned:
    """A full canned response: raw content blocks plus a stop reason."""

    content: list[dict]
    stop_reason: str = "end_turn"


def thinking_then_text(text: str) -> Canned:
    """Haiku 5.5's default shape: an (empty, display-omitted) thinking block
    ahead of the answer."""
    return Canned(
        content=[
            {"type": "thinking", "thinking": "", "signature": "sig_test"},
            {"type": "text", "text": text},
        ]
    )


def refusal() -> Canned:
    """A safety refusal: no text block at all."""
    return Canned(content=[], stop_reason="refusal")


class RecordingTransport:
    """Answers each `/v1/messages` POST with the next canned assistant reply."""

    def __init__(self, *texts: str | Canned) -> None:
        self._texts = list(texts)
        self.requests: list[httpx2.Request] = []

    @property
    def bodies(self) -> list[dict]:
        return [json.loads(req.content) for req in self.requests]

    def handler(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        reply = self._texts.pop(0)
        if isinstance(reply, Canned):
            content, stop_reason = reply.content, reply.stop_reason
        else:
            content = [] if reply == "" else [{"type": "text", "text": reply}]
            stop_reason = "end_turn"
        return httpx2.Response(
            200,
            json={
                "id": f"msg_test_{len(self.requests)}",
                "type": "message",
                "role": "assistant",
                "model": json.loads(request.content)["model"],
                "content": content,
                "stop_reason": stop_reason,
                "stop_sequence": None,
                "usage": {"input_tokens": 1, "output_tokens": 1},
            },
        )


def real_client(*texts: str | Canned) -> tuple[anthropic.Anthropic, RecordingTransport]:
    """A real SDK client whose HTTP traffic is answered by `RecordingTransport`."""
    transport = RecordingTransport(*texts)
    client = anthropic.Anthropic(
        api_key="test-key",
        max_retries=0,
        http_client=httpx2.Client(transport=httpx2.MockTransport(transport.handler)),
    )
    return client, transport
