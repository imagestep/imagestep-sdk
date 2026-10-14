"""ImageStep SDK — the image step for your automations.

    from imagestep import ImageStep
    client = ImageStep(api_key="is_sk_…")
    asset = client.assets.upload("./product.jpg")
    job = client.ops.remove_bg(asset["id"], wait=True)
"""

__version__ = "0.2.0"

# `client` reads `__version__` for its User-Agent, so the version is defined above this import.
from .client import AsyncImageStep, BinaryResult, ImageStep, Page, RequestResult  # noqa: E402
from .errors import ImageStepError, JobFailedError, WebhookSignatureError  # noqa: E402
from .webhooks import WebhookEvent, construct_webhook_event, verify_webhook_signature  # noqa: E402

# The resource types, generated from the API's OpenAPI document — the same names the JS SDK exports (`Usage` is
# `UsageSummary` there and here, since `client.usage` is a resource).
from ._generated import (  # noqa: E402
    Asset,
    AssetSummary,
    ImageMetadata,
    Job,
    JobEstimate,
    JobItem,
    JobSummary,
    PresetData,
    SyncUrlResult,
    TemplateData,
    WebhookEndpoint,
)
from ._generated import Usage as UsageSummary  # noqa: E402

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
    "WebhookEvent",
    "Asset",
    "AssetSummary",
    "ImageMetadata",
    "Job",
    "JobEstimate",
    "JobItem",
    "JobSummary",
    "PresetData",
    "SyncUrlResult",
    "TemplateData",
    "WebhookEndpoint",
    "UsageSummary",
    "__version__",
]
