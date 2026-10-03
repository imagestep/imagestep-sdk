"""Webhook signature verification (docs/api-contract.md §6 «Verifying»).

Header `ImageStep-Signature: t=<epoch s>,v1=<hex hmac-sha256>` over `"<t>.<raw body>"`, the same
construction Stripe uses. Verify the raw bytes exactly as received — re-serialising the JSON
changes bytes and breaks the MAC.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any

from .errors import WebhookSignatureError


def parse_signature_header(header: str | None) -> tuple[int | None, str | None]:
    """Split `t=…,v1=…` into (timestamp, signature); either is None when missing."""
    parts: dict[str, str] = {}
    for kv in str(header or "").split(","):
        key, sep, value = kv.strip().partition("=")
        if key and sep and value:
            parts[key] = value
    timestamp = parts.get("t")
    return (int(timestamp) if timestamp and timestamp.isdigit() else None), parts.get("v1")


def _as_bytes(value: bytes | bytearray | memoryview | str) -> bytes:
    return value.encode("utf-8") if isinstance(value, str) else bytes(value)


def verify_webhook_signature(
    raw_body: bytes | str,
    header: str | None,
    secret: str,
    tolerance_seconds: int = 300,
    now: float | None = None,
) -> bool:
    """True when `header` is a valid signature of `raw_body` under `secret` and its `t` is within
    `tolerance_seconds` of `now` (default: the current time).

    Raises `ValueError` when `secret` is empty or missing (#479): an empty key's HMAC is one anybody can compute, so a
    missing environment variable used to make every forgery check out. A configuration error is raised, not answered
    False, so it cannot pass for one bad delivery."""
    if not isinstance(secret, (str, bytes)) or not secret:
        raise ValueError("ImageStep: verify_webhook_signature needs the endpoint's secret - it is empty or missing")
    timestamp, signature = parse_signature_header(header)
    if timestamp is None or not signature:
        return False
    current = time.time() if now is None else now
    if abs(current - timestamp) > tolerance_seconds:
        return False
    signed = str(timestamp).encode("ascii") + b"." + _as_bytes(raw_body)
    expected = hmac.new(_as_bytes(secret), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature.lower())


def construct_webhook_event(
    raw_body: bytes | str,
    header: str | None,
    secret: str,
    tolerance_seconds: int = 300,
    now: float | None = None,
) -> dict[str, Any]:
    """Verify, then parse: the event `{id, type, createdAt, data}`.

    Raises `WebhookSignatureError` when the signature does not check out.
    """
    if not verify_webhook_signature(raw_body, header, secret, tolerance_seconds, now):
        raise WebhookSignatureError("ImageStep webhook signature verification failed")
    return json.loads(_as_bytes(raw_body))
