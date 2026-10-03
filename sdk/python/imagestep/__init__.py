"""ImageStep SDK — the image step for your automations.

    from imagestep import ImageStep
    client = ImageStep(api_key="is_sk_…")
    asset = client.assets.upload("./product.jpg")
    job = client.ops.remove_bg(asset["id"], wait=True)
"""

__version__ = "0.1.1"

# `client` reads `__version__` for its User-Agent, so the version is defined above this import.
from .client import AsyncImageStep, BinaryResult, ImageStep, Page, RequestResult  # noqa: E402
from .errors import ImageStepError, JobFailedError, WebhookSignatureError  # noqa: E402
from .webhooks import construct_webhook_event, verify_webhook_signature  # noqa: E402

__all__ = [
    "ImageStep",
    "AsyncImageStep",
    "BinaryResult",
    "Page",
    "RequestResult",
    "ImageStepError",
    "JobFailedError",
    "WebhookSignatureError",
    "verify_webhook_signature",
    "construct_webhook_event",
    "__version__",
]
