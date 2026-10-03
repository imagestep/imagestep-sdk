"""The failures the SDK raises. Mirrors docs/api-contract.md §2 and the JS SDK's errors.js."""
from __future__ import annotations

from typing import Any


class ImageStepError(Exception):
    """Every failure the API answered with.

    `code` is from the contract's closed set, `retryable` is the field an automation branches
    on (the status code cannot tell it apart), `param` names the offending request parameter
    when the error is about one, `details` is optional machine-readable context and
    `retry_after` is the seconds the service asked you to wait (429) and `request_id` is the
    service's id for the request, the handle to quote when reporting a failure.

    An answer with no error envelope — a proxy's HTML 502, a bare 429 — carries no `retryable`
    of its own; then a 429 or a 5xx is retryable and anything else is not, as in the JS SDK (#568).
    """

    def __init__(
        self,
        status: int,
        code: str | None = None,
        message: str | None = None,
        retryable: bool | None = None,
        param: str | None = None,
        details: dict[str, Any] | None = None,
        retry_after: float | None = None,
        request_url: str | None = None,
        request_id: str | None = None,
    ):
        super().__init__(message or f"ImageStep request failed ({status})")
        self.status = status
        self.code = code or ("internal_error" if status >= 500 else "unknown_error")
        self.message = str(self)
        self.retryable = (status == 429 or status >= 500) if retryable is None else bool(retryable)
        self.param = param
        self.details = details
        self.retry_after = retry_after
        self.request_url = request_url
        # `error.requestId`, else the `X-Request-Id` header: the id to quote when reporting a
        # failure (contract §11). None for errors raised before a response.
        self.request_id = request_id

    def __repr__(self) -> str:
        return (
            f"ImageStepError(status={self.status}, code={self.code!r}, "
            f"message={self.message!r}, retryable={self.retryable})"
        )


class JobFailedError(Exception):
    """A job that finished in a state other than COMPLETED, or did not finish in time.

    `job` is the last job (or asset, for `assets.wait_ready`) the poller saw.
    """

    def __init__(self, job: dict[str, Any] | None, reason: str | None = None):
        job = job or {}
        super().__init__(reason or f"Job {job.get('id')} ended as {job.get('status')}")
        self.job = job
        self.retryable = False


class WebhookSignatureError(ValueError):
    """`construct_webhook_event` could not verify the `ImageStep-Signature` header."""
