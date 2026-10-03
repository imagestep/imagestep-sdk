"""ImageStep API client — `ImageStep` (sync) and `AsyncImageStep` (async) over httpx.

Both clients share one request core (`_RequestCore`): headers, envelope unwrapping, error mapping,
the auto `Idempotency-Key` and the retry policy are decided there once. The two clients differ
only in how they wait (`time.sleep` vs `asyncio.sleep`) and which httpx client they drive, and
each resource group exists in a sync and an async flavour with the same method names.

Every method talks to the public REST API (`/api/v1/...`) exactly as a customer would — the same
vocabulary as the JS SDK (`sdk/js`), in snake_case.
"""
from __future__ import annotations

import asyncio
import functools
import hashlib
import inspect
import json
import math
import mimetypes
import os
import time
import uuid
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable, Iterator, NamedTuple

import httpx

from . import __version__
from ._generated import (
    Asset,
    CollectionRenamed,
    Job,
    JobEstimate,
    ModelDTO,
    OpDefinition,
    PageMeta,
    PresetData,
    TemplateData,
    TemplateSummary,
    WebhookDeliverySummary,
    WebhookEndpoint,
)
from .errors import ImageStepError, JobFailedError
from .webhooks import construct_webhook_event, verify_webhook_signature

DEFAULT_BASE_URL = "https://api.imagestep.dev"
TERMINAL_JOB_STATUSES = frozenset({"COMPLETED", "FAILED", "CANCELLED"})
# URLs per `POST /api/v1/assets/from-url`: the service's `IngestController.MAX_URLS`; more is refused whole (#525).
_URLS_PER_INGEST = 20
# Ids per `POST /api/v1/assets/status`: the service's `AssetController.MAX_PREVIEW_IDS`.
_IDS_PER_STATUS = 100
# Files per stage-upload / finish-upload: the service's `UploadController.MAX_STAGE_UPLOAD_ITEMS` (ledger C73).
_FILES_PER_STAGE = 500
_ASSET_PENDING_STATUSES = frozenset({"PROCESSING"})

# Extensions the platform's mimetypes table does not know (RAW formats), plus the common ones so
# the answer does not depend on the host's /etc/mime.types.
_MIME_BY_EXT = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "webp": "image/webp",
    "gif": "image/gif",
    "avif": "image/avif",
    "heic": "image/heic",
    "heif": "image/heif",
    "tif": "image/tiff",
    "tiff": "image/tiff",
    "bmp": "image/bmp",
    "jxl": "image/jxl",
    "jp2": "image/jp2",
    "j2k": "image/jp2",
    "psd": "image/vnd.adobe.photoshop",
    "ico": "image/vnd.microsoft.icon",
    "svg": "image/svg+xml",
    "dng": "image/x-adobe-dng",
    "cr2": "image/x-canon-cr2",
    "arw": "image/x-sony-arw",
    "nef": "image/x-nikon-nef",
    "raf": "image/x-fuji-raf",
}


def _mime_from_name(name: str, fallback: str = "application/octet-stream") -> str:
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext in _MIME_BY_EXT:
        return _MIME_BY_EXT[ext]
    guessed, _ = mimetypes.guess_type(name)
    return guessed or fallback


def _read_source(source: Any, name: str | None, mime_type: str | None) -> tuple[bytes, str, str]:
    """Normalise every accepted upload input to (bytes, file name, mime type)."""
    if isinstance(source, (str, os.PathLike)):
        path = os.fspath(source)
        with open(path, "rb") as f:
            data = f.read()
        name = name or os.path.basename(path)
    elif isinstance(source, (bytes, bytearray, memoryview)):
        data = bytes(source)
    elif hasattr(source, "read"):
        data = source.read()
        if isinstance(data, str):
            raise TypeError("upload() needs a file opened in binary mode ('rb')")
        source_name = getattr(source, "name", None)
        if not name and isinstance(source_name, str):
            name = os.path.basename(source_name)
    else:
        raise TypeError("upload() accepts a file path, bytes, or a binary file object")
    name = name or "upload.bin"
    return data, name, mime_type or _mime_from_name(name)


def _camel(key: str) -> str:
    """`per_page` → `perPage`; a key that is already camelCase is left alone."""
    head, *rest = key.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


def _query(params: dict[str, Any] | None) -> str:
    """Build `?a=b&c=d` from kwargs: None is skipped, lists are comma-joined, bools lower-cased."""
    pairs = []
    for key, value in (params or {}).items():
        if value is None:
            continue
        if isinstance(value, bool):
            value = "true" if value else "false"
        elif isinstance(value, (list, tuple)):
            value = ",".join(str(v) for v in value)
        pairs.append((_camel(key), str(value)))
    return f"?{httpx.QueryParams(pairs)}" if pairs else ""


def _compact(body: dict[str, Any]) -> dict[str, Any]:
    """Drop None values so an omitted option is omitted on the wire too."""
    return {k: v for k, v in body.items() if v is not None}


def _ids(ids: str | list[str] | tuple[str, ...]) -> list[str]:
    return [ids] if isinstance(ids, str) else list(ids)


def _retry_after_seconds(headers: httpx.Headers) -> float | None:
    value = headers.get("Retry-After")
    try:
        return float(value) if value is not None else None
    except ValueError:  # an HTTP-date; the backoff schedule takes over
        return None


def _header_int(headers: httpx.Headers, name: str) -> int | None:
    """A measurement header as an int — absent, blank and unparseable all mean "not measured"."""
    try:
        return int(headers[name])
    except (KeyError, TypeError, ValueError):
        return None


def _parse_json(text: str) -> Any:
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def _run_body(op: str, asset_ids: str | list[str] | None, collection: str | None, rest: dict[str, Any]) -> dict[str, Any]:
    body: dict[str, Any] = {"op": op, **_compact(rest)}
    if asset_ids is not None:
        body["assetIds"] = _ids(asset_ids)
    if collection is not None:
        body["collection"] = collection
    return body


def _jobs_path(dry_run: bool) -> str:
    return "/api/v1/jobs?dryRun=true" if dry_run else "/api/v1/jobs"


def _wait_kwargs(wait: bool | dict[str, Any]) -> dict[str, Any]:
    return dict(wait) if isinstance(wait, dict) else {}


# The longest the service holds a request open for a job (contract §5, imagestep#355). It clamps to this too; the SDK asks
# for no more, so that its own request timeout — this plus the grace — is never the thing that ends the wait.
MAX_SERVER_WAIT_SECONDS = 60
WAIT_GRACE_SECONDS = 15.0


def _server_wait_seconds(seconds: float | None) -> int:
    """How long to ask the service to hold one request: what is left of the caller's patience, within 1–60 s."""
    if seconds is None:
        return MAX_SERVER_WAIT_SECONDS
    return max(1, min(MAX_SERVER_WAIT_SECONDS, math.ceil(seconds)))


def _job_path(job_id: str, wait: float | None) -> str:
    return f"/api/v1/jobs/{job_id}" + (f"?wait={_server_wait_seconds(wait)}" if wait else "")


def _wait_pause(error: ImageStepError, interval: float, deadline: float) -> float:
    """How long `jobs.wait` holds off before asking again after a read turned away for now: the `Retry-After`, else
    the interval — never past the deadline."""
    pause = error.retry_after if error.retry_after is not None else interval
    return min(pause, max(0.0, deadline - time.monotonic()))


def _settled(job: Job, job_id: str, throw_on_failure: bool) -> bool:
    """True when the job is terminal — raising, by default, when it ended other than COMPLETED."""
    if job.get("status") not in TERMINAL_JOB_STATUSES:
        return False
    if throw_on_failure and job.get("status") != "COMPLETED":
        raise JobFailedError(job)
    return True


def _chunks(items: list[Any], size: int) -> list[list[Any]]:
    return [items[at : at + size] for at in range(0, len(items), size)]


def _describe_upload(source: Any, name: str | None = None, mime_type: str | None = None) -> dict[str, Any]:
    """What an upload needs before staging — name, type, size, SHA-1 — without holding every file's bytes at once:
    a path is read to be hashed and read again to be sent; bytes and a read file object are kept, they are already
    in memory."""
    data, name, mime = _read_source(source, name, mime_type)
    keep = None if isinstance(source, (str, os.PathLike)) else data
    return {"source": source, "name": name, "mime": mime, "size": len(data), "sha1": hashlib.sha1(data).hexdigest(), "data": keep}


def _error_dict(error: ImageStepError) -> dict[str, Any]:
    """An error as a result entry, the shape `from_url` answers per URL."""
    return _compact({"code": error.code, "message": error.message, "retryable": error.retryable, "param": error.param})


def _still_processing(items: list[dict[str, Any]], batch: list[str]) -> list[dict[str, Any]]:
    """The status items of `batch` still ingesting; an id the service did not answer for is not the caller's."""
    seen = {item["id"]: item for item in items}
    for asset_id in batch:
        if asset_id not in seen:
            raise ImageStepError(404, "asset_not_found", f"Asset {asset_id} was not found", False, "id")
    return [seen[asset_id] for asset_id in batch if seen[asset_id].get("status") in _ASSET_PENDING_STATUSES]


def _still_error(still: list[dict[str, Any]], timeout: float) -> JobFailedError:
    if len(still) == 1:
        return JobFailedError(still[0], f"Asset {still[0]['id']} still {still[0].get('status')} after {timeout} s")
    return JobFailedError(still[0], f"{len(still)} assets still PROCESSING after {timeout} s")


def _finish_item(
    stage: dict[str, Any], name: str, collection: str | None, tags: list[str] | None = None, retention_days: int | None = None
) -> dict[str, Any]:
    """Which staged object, its name, the label, the tags (#232, #334) and how long to keep it (#591): type, size and SHA-1
    are the service's to know."""
    return _compact(
        {"objectId": stage["objectId"], "name": name, "collection": collection, "tags": tags, "retentionDays": retention_days}
    )


def _stage_error(stage: dict[str, Any]) -> ImageStepError | None:
    if stage.get("error"):
        return ImageStepError(400, "invalid_param", stage["error"], False, "file")
    return None


def _put_error(response: httpx.Response, url: str) -> ImageStepError | None:
    if response.is_success:
        return None
    return ImageStepError(
        response.status_code, "internal_error", f"Upload to storage failed ({response.status_code})", True, request_url=url
    )


def _result_ids(job: dict[str, Any]) -> list[str]:
    return [item["resultAssetId"] for item in job.get("items") or [] if item.get("resultAssetId")]


def _in_item_order(assets: list[Any], job: dict[str, Any] | None) -> list[Any]:
    """The run's products in the order its items name them (imagestep#441).

    The listing they come from is newest-first, which for a batch is neither item order nor settle order; an item,
    though, knows its own output. Rows no item names — a job whose items the caller did not fetch — keep the
    listing's order, after the rest.
    """
    order = {asset_id: index for index, asset_id in enumerate(_result_ids(job or {}))}
    if not order:
        return assets
    return sorted(assets, key=lambda asset: order.get(asset.get("id"), len(order)))


def _metadata_view(asset: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": asset.get("id"),
        "name": asset.get("name"),
        "image": asset.get("image"),
        "metadata": asset.get("metadata"),
        "expiresAt": asset.get("expiresAt"),
    }


class Page(NamedTuple):
    """One page of a listing: `items` plus the `meta` (`perPage`, `hasMore`, `nextCursor`, and on a page-number
    request `total` and `page`)."""

    items: list[Any]
    meta: PageMeta | None


def _next(params: dict[str, Any], meta: PageMeta) -> dict[str, Any] | None:
    """The request after a page, or None at the end: the same filters, and the cursor the answer carried."""
    if not meta.get("hasMore"):
        return None
    cursor = meta.get("nextCursor")
    if not cursor:
        # Never a silent stop halfway: a listing that says there is more must say where.
        raise RuntimeError("the listing said hasMore but sent no meta.nextCursor")
    rest = {k: v for k, v in params.items() if k != "page"}
    return {**rest, "cursor": cursor}


def _walk(read_page: Callable[..., Page], params: dict[str, Any]) -> Iterator[Any]:
    """Walk a listing to its end, a row at a time (imagestep#437, #493).

    A page is 100 rows and the answer says whether there is another (`meta["hasMore"]`) and where it starts
    (`meta["nextCursor"]`), so walking one is four lines — and four lines every caller would write slightly
    differently, one of them off by one. The first request is an ordinary one (`page=` if given); every later one
    sends the cursor back instead of a page number, so page 1 000 costs the service what page 1 did and nothing is
    counted — a walk by page number re-reads every earlier row and re-counts the filter on every page. `cursor=`
    resumes a walk where an earlier one stopped.
    """
    request: dict[str, Any] | None = params
    while request is not None:
        page = read_page(**request)
        yield from page.items or []
        request = _next(params, page.meta or {})


async def _awalk(read_page: Callable[..., Any], params: dict[str, Any]) -> AsyncIterator[Any]:
    """`_walk` for the async client."""
    request: dict[str, Any] | None = params
    while request is not None:
        page = await read_page(**request)
        for item in page.items or []:
            yield item
        request = _next(params, page.meta or {})


@dataclass
class RequestResult:
    """What `client.request()` returns: the unwrapped `data`, the list `meta` when there is one,
    whether the response was an idempotent replay, and the raw headers (rate-limit budget…)."""

    data: Any
    meta: PageMeta | None
    replayed: bool
    headers: httpx.Headers


@dataclass
class BinaryResult:
    """What a `/api/v1/images/*` call returned: the bytes (or the parsed JSON, for
    ``response="url"`` and metadata) plus what the service said about them — the content type and
    the width / height it measured. :meth:`ImageStep.request_binary` hands back just the payload;
    reach for this when you have to NAME the result (an extension, a reported size) instead of
    deriving it from the bytes again (#95)."""

    content: bytes | None
    json: Any
    content_type: str
    width: int | None
    height: int | None


class _RequestCore:
    """Everything about a request that is not I/O — shared by the sync and the async client."""

    def __init__(self, api_key: str, base_url: str, user_agent: str):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.user_agent = user_agent

    def prepare(
        self,
        method: str,
        path: str,
        body: Any,
        headers: dict[str, str] | None,
        idempotency_key: str | None,
    ) -> tuple[str, dict[str, str], bytes | None]:
        """The URL, headers and serialised body of one request. A write gets an `Idempotency-Key`
        (a fresh uuid4 unless the caller supplied one) that every retry re-sends unchanged."""
        url = self.base_url + path
        h = {
            "Authorization": f"ApiKey {self.api_key}",
            "Accept": "application/json",
            "User-Agent": self.user_agent,
            **(headers or {}),
        }
        content = None
        if body is not None:
            h["Content-Type"] = "application/json"
            content = json.dumps(body).encode("utf-8")
        if method not in ("GET", "HEAD"):
            h["Idempotency-Key"] = idempotency_key or str(uuid.uuid4())
        return url, h, content

    def interpret(self, response: httpx.Response, url: str) -> RequestResult:
        """Unwrap the `{success, data, error, meta}` envelope; raise ImageStepError on a failure."""
        if response.status_code == 204:
            return RequestResult(None, None, False, response.headers)
        text = response.text
        payload = _parse_json(text)
        if response.is_success:
            # Public endpoints answer bare JSON; everything under /api/v1 uses the envelope.
            enveloped = isinstance(payload, dict) and ("success" in payload or "data" in payload or "error" in payload)
            return RequestResult(
                data=payload.get("data") if enveloped else payload,
                meta=payload.get("meta") if enveloped else None,
                replayed=response.headers.get("Idempotency-Replayed") == "true",
                headers=response.headers,
            )
        error = (payload.get("error") if isinstance(payload, dict) else None) or {}
        fallback_message = payload.get("message") if isinstance(payload, dict) else None
        raise ImageStepError(
            status=response.status_code,
            code=error.get("code"),
            message=error.get("message") or fallback_message or text[:200] or response.reason_phrase,
            retryable=error.get("retryable"),
            param=error.get("param"),
            details=error.get("details"),
            retry_after=_retry_after_seconds(response.headers),
            request_url=url,
            request_id=error.get("requestId") or response.headers.get("X-Request-Id"),
        )

    def prepare_binary(
        self,
        path: str,
        content: bytes | None,
        json_body: dict[str, Any] | None,
        content_type: str | None,
        accept: str,
    ) -> tuple[str, dict[str, str], bytes]:
        """The URL, headers and body of one BYTES call — the synchronous image face.

        No ``Idempotency-Key``: the synchronous endpoints are the documented exception (contract
        §9). They create nothing that survives the response, so there is no outcome to replay.
        """
        headers = {
            "Authorization": f"ApiKey {self.api_key}",
            "Accept": accept,
            "User-Agent": self.user_agent,
        }
        if json_body is not None:
            headers["Content-Type"] = "application/json"
            return self.base_url + path, headers, json.dumps(json_body).encode()
        if content_type:
            headers["Content-Type"] = content_type
        return self.base_url + path, headers, content or b""

    def interpret_binary(self, response: httpx.Response, url: str) -> BinaryResult:
        """The bytes, or the parsed object when the answer is JSON (``response="url"``, metadata),
        plus the content type and the dimensions the service measured."""
        media = response.headers.get("content-type", "application/octet-stream")
        width = _header_int(response.headers, "x-imagestep-width")
        height = _header_int(response.headers, "x-imagestep-height")
        if response.is_success and not media.startswith("application/json"):
            return BinaryResult(response.content, None, media, width, height)
        parsed = _parse_json(response.text)
        if response.is_success:
            data = parsed.get("data", parsed) if isinstance(parsed, dict) else parsed
            return BinaryResult(None, data, media, width, height)
        error = parsed.get("error", {}) if isinstance(parsed, dict) else {}
        raise ImageStepError(
            response.status_code,
            error.get("code"),
            error.get("message") or response.text[:200] or response.reason_phrase,
            # Absent is not false (#568): a proxy's 502 carries no envelope, and the status decides.
            error.get("retryable"),
            param=error.get("param"),
            details=error.get("details"),
            retry_after=_retry_after_seconds(response.headers),
            request_url=url,
            request_id=error.get("requestId") or response.headers.get("X-Request-Id"),
        )

    @staticmethod
    def transport_backoff(attempt: int) -> float:
        return 0.25 * 2 ** (attempt - 1)

    @staticmethod
    def worth_retrying(error: ImageStepError) -> bool:
        """The contract's `retryable`: the one field a client branches on (contract §2)."""
        return error.retryable

    @staticmethod
    def error_backoff(attempt: int, error: ImageStepError) -> float:
        return error.retry_after if error.retry_after is not None else 0.5 * 2 ** (attempt - 1)

    @staticmethod
    def raw_backoff(attempt: int, response: httpx.Response) -> float | None:
        """How long before a call whose answer the caller reads itself — the download's redirect, a storage PUT or GET —
        is sent again, or None when this answer is the one to keep. Storage speaks no error envelope, so what
        `retryable` defaults to without one decides (#567)."""
        error = ImageStepError(response.status_code, retry_after=_retry_after_seconds(response.headers))
        return _RequestCore.error_backoff(attempt, error) if error.retryable else None


def _client_settings(api_key: str | None, base_url: str | None, user_agent: str | None) -> tuple[str, str, str]:
    key = api_key or os.environ.get("IMAGESTEP_API_KEY")
    if not key:
        raise TypeError("ImageStep: api_key is required (or set IMAGESTEP_API_KEY)")
    url = base_url or os.environ.get("IMAGESTEP_BASE_URL") or DEFAULT_BASE_URL
    return key, url, user_agent or f"imagestep-python/{__version__}"


# ───────────────────────────────────────── sync ─────────────────────────────────────────


class ImageStep:
    """The synchronous client.

    Args:
        api_key: an API key from the console (`is_sk_…`); falls back to `IMAGESTEP_API_KEY`.
        base_url: defaults to `IMAGESTEP_BASE_URL`, then https://api.imagestep.dev.
        timeout: per-request timeout in seconds (default 60).
        max_retries: retries on `retryable` errors and transport failures (default 2).
        user_agent: overrides `imagestep-python/<version>`.
        transport: an `httpx.BaseTransport` (tests, proxies).
        http_client: bring your own `httpx.Client` instead.
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        timeout: float = 60.0,
        max_retries: int = 2,
        user_agent: str | None = None,
        transport: httpx.BaseTransport | None = None,
        http_client: httpx.Client | None = None,
    ):
        key, url, agent = _client_settings(api_key, base_url, user_agent)
        self._core = _RequestCore(key, url, agent)
        self.base_url = self._core.base_url
        self.timeout = timeout
        self.max_retries = max_retries
        self._http = http_client or httpx.Client(transport=transport, timeout=timeout)

        self.ops = Ops(self)
        self.images = Images(self)
        self.assets = Assets(self)
        self.jobs = Jobs(self)
        self.presets = Presets(self)
        self.templates = Templates(self)
        self.models = Models(self)
        self.agent = Agent(self)
        self.webhooks = Webhooks(self)
        self.usage = Usage(self)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> ImageStep:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def request(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        headers: dict[str, str] | None = None,
        idempotency_key: str | None = None,
        retries: int | None = None,
        timeout: float | None = None,
    ) -> RequestResult:
        """One HTTP call against the API: envelope unwrapped, errors raised as ImageStepError,
        an Idempotency-Key on every write, and `retryable` failures retried with backoff
        (honouring `Retry-After`). Transport errors that outlive the retries propagate as httpx
        exceptions."""
        url, h, content = self._core.prepare(method, path, body, headers, idempotency_key)
        attempts = max(1, (self.max_retries if retries is None else retries) + 1)
        for attempt in range(1, attempts + 1):
            try:
                response = self._http.request(method, url, headers=h, content=content, timeout=timeout or self.timeout)
            except httpx.TransportError:
                if attempt == attempts:
                    raise
                time.sleep(self._core.transport_backoff(attempt))
                continue
            try:
                return self._core.interpret(response, url)
            except ImageStepError as error:
                if not self._core.worth_retrying(error) or attempt == attempts:
                    raise
                time.sleep(self._core.error_backoff(attempt, error))

    def get(self, path: str, **opts: Any) -> RequestResult:
        return self.request("GET", path, **opts)

    def post(self, path: str, body: Any = None, **opts: Any) -> RequestResult:
        return self.request("POST", path, body=body, **opts)

    def put(self, path: str, body: Any = None, **opts: Any) -> RequestResult:
        return self.request("PUT", path, body=body, **opts)

    def delete(self, path: str, **opts: Any) -> RequestResult:
        return self.request("DELETE", path, **opts)

    def request_binary(
        self,
        path: str,
        *,
        content: bytes | None = None,
        json_body: dict[str, Any] | None = None,
        content_type: str | None = None,
        accept: str = "*/*",
        timeout: float | None = None,
        retries: int | None = None,
    ) -> bytes | dict[str, Any]:
        """A call whose body and/or response are BYTES — the synchronous image face.

        Separate from :meth:`request` on purpose rather than bolted onto it: that one JSON-encodes
        every body and parses every response, and three of the four things this has to do (send a
        raw body, read a raw body, send no Idempotency-Key) are exactly the opposite.

        It does share the retry loop (#98), and for the reason contract §9 gives: the endpoints
        create nothing that survives the response and the body is already bytes in memory, so
        re-sending is free and cannot duplicate anything. `Retry-After` is honoured when the answer
        carries one.
        """
        result = self.request_binary_result(
            path, content=content, json_body=json_body, content_type=content_type,
            accept=accept, timeout=timeout, retries=retries,
        )
        return result.content if result.json is None else result.json

    def request_binary_result(
        self,
        path: str,
        *,
        content: bytes | None = None,
        json_body: dict[str, Any] | None = None,
        content_type: str | None = None,
        accept: str = "*/*",
        timeout: float | None = None,
        retries: int | None = None,
    ) -> BinaryResult:
        """:meth:`request_binary`, keeping what the service said about the result (:class:`BinaryResult`)."""
        url, headers, body = self._core.prepare_binary(path, content, json_body, content_type, accept)
        attempts = max(1, (self.max_retries if retries is None else retries) + 1)
        for attempt in range(1, attempts + 1):
            try:
                response = self._http.request("POST", url, headers=headers, content=body, timeout=timeout or self.timeout)
            except httpx.TransportError:
                if attempt == attempts:
                    raise
                time.sleep(self._core.transport_backoff(attempt))
                continue
            try:
                return self._core.interpret_binary(response, url)
            except ImageStepError as error:
                if not self._core.worth_retrying(error) or attempt == attempts:
                    raise
                time.sleep(self._core.error_backoff(attempt, error))

    def put_object(self, url: str, data: bytes, content_type: str, timeout: float | None = None) -> httpx.Response:
        """PUT raw bytes to a presigned storage URL (no API headers — the URL carries the auth).

        `content_type` must be the value stage-upload signed the URL for (#48); the service derives
        it from the file name, and the object store rejects anything else. Retried like a request
        (#567): the same bytes to the same URL cannot make a second object."""
        return self._request_raw("PUT", url, content=data, headers={"Content-Type": content_type}, timeout=timeout)

    def _request_raw(self, method: str, url: str, *, timeout: float | None = None, **kwargs: Any) -> httpx.Response:
        """One call whose answer the caller reads itself — the download's redirect, a storage PUT or GET — on the
        retry schedule of `request` (#567): a transport failure, and an answer `raw_backoff` counts as retryable,
        are sent again. The last answer is returned whatever it is; a redirect is never followed."""
        attempts = max(1, self.max_retries + 1)
        for attempt in range(1, attempts + 1):
            try:
                response = self._http.request(method, url, follow_redirects=False, timeout=timeout or self.timeout, **kwargs)
            except httpx.TransportError:
                if attempt == attempts:
                    raise
                time.sleep(self._core.transport_backoff(attempt))
                continue
            pause = self._core.raw_backoff(attempt, response)
            if pause is None or attempt == attempts:
                return response
            time.sleep(pause)



class _ImagesCore:
    """The synchronous face's shapes, with no I/O in them — shared by :class:`Images` and
    :class:`AsyncImages` exactly the way :class:`_RequestCore` is shared by the two clients.

    The reason this is not two independent copies: what an op is called, where its parameters go
    and what "this op has no synchronous form" says are contract, and a contract that exists twice
    is a contract that will say two things.
    """

    # The keys the endpoint reads for itself; every other query key is an op parameter (contract §9).
    _QUERY_KEYS = ("op", "preset", "response")

    @classmethod
    def _transform_path(
        cls, op: str | None, preset: str | None, response: str | None, parameters: dict[str, Any] | None
    ) -> str:
        # Parameters always live in the query string; the image is always the body (contract §9). They arrive as their
        # own dict, never as keywords beside `file` (#470): `transform(op, **bag)` over a bag the caller did not write
        # could name a local file for this process to read.
        clash = next((k for k in (parameters or {}) if k in cls._QUERY_KEYS), None)
        if clash:
            raise ImageStepError(0, "invalid_param", f"'{clash}' is not an op parameter", False, param=f"parameters.{clash}")
        return "/api/v1/images/transform" + _query({"op": op, "preset": preset, "response": response, **(parameters or {})})

    @staticmethod
    def _not_synchronous(op: str) -> ImageStepError:
        return ImageStepError(
            0,
            "invalid_param",
            f"'{op}' has no synchronous form - submit it as a job with client.ops.run(\"{op}\", ...)",
            False,
            param="op",
        )


class Images(_ImagesCore):
    """The synchronous face: bytes in, bytes out, nothing stored (contract §9).

    Reach for this when you are holding an image and only want the result back. Do NOT reach for
    it for AI ops, batches, or anything you want an ``asset_id`` for — those are jobs, because a
    job is what pays for the retry, settlement and cancellation they need.
    """

    def __init__(self, client: ImageStep):
        self._client = client
        self._sync_endpoints: dict[str, str | None] | None = None

    def sync_endpoints(self) -> dict[str, str | None]:
        """op -> syncEndpoint, straight from ``GET /api/v1/ops``.

        Read, never hard-coded: a deterministic op added to the catalogue is supported here
        without this file changing.
        """
        if self._sync_endpoints is None:
            self._sync_endpoints = {o["op"]: o.get("syncEndpoint") for o in self._client.ops.list()}
        return self._sync_endpoints

    def supports(self, op: str) -> bool:
        return bool(self.sync_endpoints().get(op))

    def transform(
        self,
        op: str | None = None,
        *,
        file: Any = None,
        url: str | None = None,
        asset_id: str | None = None,
        preset: str | None = None,
        response: str | None = None,
        parameters: dict[str, Any] | None = None,
    ) -> bytes | dict[str, Any]:
        """Run one deterministic op, or a deterministic preset, on one image.

        ``file`` takes a path, ``bytes``, or anything with ``.read()``; the op's own parameters go in
        ``parameters``, e.g. ``{"width": 1200}``. Returns the result bytes, or the JSON object when
        ``response="url"``.
        """
        result = self.transform_result(op, file=file, url=url, asset_id=asset_id, preset=preset,
                                       response=response, parameters=parameters)
        return result.content if result.json is None else result.json

    def transform_result(
        self,
        op: str | None = None,
        *,
        file: Any = None,
        url: str | None = None,
        asset_id: str | None = None,
        preset: str | None = None,
        response: str | None = None,
        parameters: dict[str, Any] | None = None,
    ) -> BinaryResult:
        """:meth:`transform`, keeping the content type and the dimensions the service measured (#95)."""
        if op and not self.supports(op):
            raise self._not_synchronous(op)
        path = self._transform_path(op, preset, response, parameters)
        if url or asset_id:
            return self._client.request_binary_result(path, json_body=_compact({"url": url, "assetId": asset_id}))
        data, _, mime = _read_source(file, None, None)
        return self._client.request_binary_result(path, content=data, content_type=mime)

    def render(self, template_id: str, data: dict[str, Any] | None = None) -> bytes | dict[str, Any]:
        """One template row -> one PNG. A batch is a job."""
        return self._client.request_binary(
            "/api/v1/images/render", json_body={"templateId": template_id, "data": data or {}}
        )

    def metadata(self, file: Any) -> dict[str, Any]:
        """EXIF, GPS, dimensions, format and SHA-1. Free, and it stores nothing."""
        data, _, mime = _read_source(file, None, None)
        result = self._client.request_binary(
            "/api/v1/images/metadata", content=data, content_type=mime, accept="application/json"
        )
        return result if isinstance(result, dict) else {}


class Ops:
    """The atomic-op catalogue and the one-call way to run an op."""

    def __init__(self, client: ImageStep):
        self._client = client

    def list(self) -> list[OpDefinition]:
        """Every op with its parameter contract — the catalogue the MCP server and n8n node read."""
        return self._client.get("/api/v1/ops").data

    def get(self, op: str) -> OpDefinition:
        return self._client.get(f"/api/v1/ops/{op}").data

    def run(
        self,
        op: str,
        *,
        asset_ids: str | list[str] | None = None,
        prompt: str | None = None,
        count: int | None = None,
        model: str | None = None,
        parameters: dict[str, Any] | None = None,
        variants: list[dict[str, Any]] | None = None,
        template_id: str | None = None,
        items: list[dict[str, Any]] | None = None,
        collection: str | None = None,
        retention_days: int | None = None,
        dry_run: bool = False,
        image_count: int | None = None,
        wait: bool | dict[str, Any] = False,
        idempotency_key: str | None = None,
    ) -> Job | JobEstimate:
        """Submit an op as a job. `asset_ids` may be one id or many; `wait=True` (or a dict of
        `jobs.wait` options) polls to completion and returns the finished job — raising
        JobFailedError if it did not complete. `dry_run=True` returns the cost estimate, and `image_count` with it prices
        images not stored yet as that many more `asset_ids` (imagestep#586). Every output is a new
        asset: a job never overwrites the one it read (imagestep#331). `render_template` takes no assets: `template_id`
        (an id, or `id@version`) and `items`, one dict of variables per image (imagestep#391)."""
        rest = {"prompt": prompt, "count": count, "model": model, "parameters": parameters, "variants": variants, "templateId": template_id, "items": items, "imageCount": image_count, "retentionDays": retention_days}
        body = _run_body(op, asset_ids, collection, rest)
        if dry_run:
            return self._client.post(_jobs_path(True), body, idempotency_key=idempotency_key).data
        return self._client.jobs._submit_and_wait(body, wait, idempotency_key=idempotency_key)

    def estimate(self, op: str, **opts: Any) -> JobEstimate:
        """Price an op without creating anything (`POST /api/v1/jobs?dryRun=true`). A preset of several
        segments is a `chain`, and its estimate breaks the price down in `steps` (contract §5)."""
        return self.run(op, dry_run=True, **opts)

    def remove_bg(self, asset_ids: str | list[str], **opts: Any):
        return self.run("remove_bg", asset_ids=asset_ids, **opts)

    def upscale(self, asset_ids: str | list[str], **opts: Any):
        return self.run("upscale", asset_ids=asset_ids, **opts)

    def restore_face(self, asset_ids: str | list[str], **opts: Any):
        return self.run("restore_face", asset_ids=asset_ids, **opts)

    def colorize(self, asset_ids: str | list[str], **opts: Any):
        return self.run("colorize", asset_ids=asset_ids, **opts)

    def analyze(self, asset_ids: str | list[str], **opts: Any):
        """Structured JSON about each image: each job item's `output` (imagestep#338); the default answer's tags also join the asset's `tags`."""
        return self.run("analyze", asset_ids=asset_ids, **opts)

    def generate(self, prompt: str, **opts: Any):
        return self.run("generate", prompt=prompt, **opts)

    def edit(self, asset_ids: str | list[str], prompt: str, **opts: Any):
        return self.run("edit", asset_ids=asset_ids, prompt=prompt, **opts)

    def resize(self, asset_ids: str | list[str], parameters: dict[str, Any], **opts: Any):
        return self.run("resize", asset_ids=asset_ids, parameters=parameters, **opts)

    def convert(self, asset_ids: str | list[str], parameters: dict[str, Any], **opts: Any):
        return self.run("convert", asset_ids=asset_ids, parameters=parameters, **opts)

    def compress(self, asset_ids: str | list[str], parameters: dict[str, Any], **opts: Any):
        return self.run("compress", asset_ids=asset_ids, parameters=parameters, **opts)

    def crop(self, asset_ids: str | list[str], parameters: dict[str, Any], **opts: Any):
        return self.run("crop", asset_ids=asset_ids, parameters=parameters, **opts)

    def pad(self, asset_ids: str | list[str], parameters: dict[str, Any], **opts: Any):
        return self.run("pad", asset_ids=asset_ids, parameters=parameters, **opts)

    def grayscale(self, asset_ids: str | list[str], **opts: Any):
        return self.run("grayscale", asset_ids=asset_ids, **opts)

    def rotate(self, asset_ids: str | list[str], parameters: dict[str, Any], **opts: Any):
        return self.run("rotate", asset_ids=asset_ids, parameters=parameters, **opts)

    def flip(self, asset_ids: str | list[str], **opts: Any):
        return self.run("flip", asset_ids=asset_ids, **opts)

    def flop(self, asset_ids: str | list[str], **opts: Any):
        return self.run("flop", asset_ids=asset_ids, **opts)

    def trim(self, asset_ids: str | list[str], parameters: dict[str, Any] | None = None, **opts: Any):
        return self.run("trim", asset_ids=asset_ids, parameters=parameters or {}, **opts)

    def flatten(self, asset_ids: str | list[str], parameters: dict[str, Any] | None = None, **opts: Any):
        return self.run("flatten", asset_ids=asset_ids, parameters=parameters or {}, **opts)

    def adjust(self, asset_ids: str | list[str], parameters: dict[str, Any], **opts: Any):
        return self.run("adjust", asset_ids=asset_ids, parameters=parameters, **opts)

    def mask(self, asset_ids: str | list[str], parameters: dict[str, Any] | None = None, **opts: Any):
        return self.run("mask", asset_ids=asset_ids, parameters=parameters or {}, **opts)

    def blur_region(self, asset_ids: str | list[str], parameters: dict[str, Any], **opts: Any):
        return self.run("blur_region", asset_ids=asset_ids, parameters=parameters, **opts)

    def overlay(self, asset_ids: str | list[str], parameters: dict[str, Any], **opts: Any):
        return self.run("overlay", asset_ids=asset_ids, parameters=parameters, **opts)

    def caption(self, asset_ids: str | list[str], parameters: dict[str, Any], **opts: Any):
        return self.run("caption", asset_ids=asset_ids, parameters=parameters, **opts)

    def read_metadata(self, asset_id: str) -> dict[str, Any]:
        """`read_metadata` is synchronous: the asset already carries EXIF / GPS / dimensions / hash."""
        return _metadata_view(self._client.assets.get(asset_id))


class Assets:
    def __init__(self, client: ImageStep):
        self._client = client

    def upload(
        self,
        source: Any,
        *,
        name: str | None = None,
        mime_type: str | None = None,
        collection: str | None = None,
        tags: list[str] | None = None,
        retention_days: int | None = None,
        wait: bool = True,
        reuse_existing: bool = True,
        timeout: float | None = None,
    ) -> Asset:
        """Upload one file: stage (presigned PUT) → PUT the bytes → finish → wait until the ingest
        pipeline has written dimensions/metadata (status DONE). `source` is a path, bytes, or a
        binary file object; bytes you already ingested come back as the existing asset, with its own tags
        (`reuse_existing=False` uploads a fresh copy). `tags` are your own labels, matched exactly by `list(tag=)` (#334)."""
        [result] = self._upload(
            [source],
            name=name,
            mime_type=mime_type,
            concurrency=1,
            collection=collection,
            tags=tags,
            retention_days=retention_days,
            wait=wait,
            reuse_existing=reuse_existing,
            timeout=timeout,
        )
        if "error" in result:
            raise result["error"]
        return result["asset"]

    def from_url(
        self,
        urls: list[str],
        *,
        collection: str | None = None,
        tags: list[str] | None = None,
        retention_days: int | None = None,
        wait: bool = True,
    ) -> list[dict[str, Any]]:
        """Ingest images by URL: the SERVICE fetches each one (imagestep#219), nothing is downloaded here.
        One result per URL, in order — `{"url", "asset"}` or `{"url", "error"}` — so one bad link costs only itself.
        `wait` (default True) polls each created asset until ingest is done."""
        results: list[dict[str, Any]] = []
        # Twenty to a request (#525): the service refuses a longer list whole.
        for batch in _chunks(list(urls), _URLS_PER_INGEST):
            body: dict[str, Any] = {"urls": batch}
            if collection is not None:
                body["collection"] = collection
            if tags:
                body["tags"] = list(tags)
            if retention_days is not None:
                body["retentionDays"] = retention_days
            results.extend(self._client.post("/api/v1/assets/from-url", body).data)
        created = [r["id"] for r in results if not r.get("error")]
        ready = self._wait_all(created) if wait and created else {}
        return [
            {"url": r["url"], "error": r["error"]} if r.get("error") else {"url": r["url"], "asset": ready.get(r["id"], r)}
            for r in results
        ]

    def upload_many(
        self,
        sources: list[Any],
        *,
        concurrency: int = 4,
        collection: str | None = None,
        tags: list[str] | None = None,
        retention_days: int | None = None,
        wait: bool = True,
        reuse_existing: bool = True,
        timeout: float | None = None,
    ) -> list[dict[str, Any]]:
        """Upload many files at once (#525): one stage and one finish call per 500, `concurrency` PUTs at a time, one
        status call per tick while they ingest — `upload()` in a loop was five round trips and a 1.5 s poll per file,
        one file after another. One result per source, in order — `{"name", "asset"}` or `{"name", "error"}` — so a
        file the service refuses costs only itself."""
        results = self._upload(
            sources,
            concurrency=concurrency,
            collection=collection,
            tags=tags,
            retention_days=retention_days,
            wait=wait,
            reuse_existing=reuse_existing,
            timeout=timeout,
        )
        return [{"name": r["name"], "error": _error_dict(r["error"])} if "error" in r else r for r in results]

    def _upload(
        self,
        sources: list[Any],
        *,
        name: str | None = None,
        mime_type: str | None = None,
        concurrency: int,
        collection: str | None,
        tags: list[str] | None,
        retention_days: int | None,
        wait: bool,
        reuse_existing: bool,
        timeout: float | None,
    ) -> list[dict[str, Any]]:
        """The flow behind `upload` and `upload_many`: `{"name", "asset"}` or `{"name", "error"}` per source, the error
        an ImageStepError that `upload` raises and `upload_many` answers as a dict. `name` / `mime_type` apply to every
        source, so only `upload` passes them."""
        from concurrent.futures import ThreadPoolExecutor

        results: list[dict[str, Any]] = []
        for batch in _chunks(list(sources), _FILES_PER_STAGE):
            files = [_describe_upload(source, name, mime_type) for source in batch]
            staged = self._client.post(
                "/api/v1/assets/stage-upload", [{"fileName": f["name"], "fileSize": f["size"], "sha1Hash": f["sha1"]} for f in files]
            ).data
            outcome: list[dict[str, Any] | None] = [None] * len(files)

            def put_one(n: int) -> bool:
                file, stage = files[n], staged[n]
                if error := _stage_error(stage):
                    outcome[n] = {"name": file["name"], "error": error}
                    return False
                # Same bytes already ingested → reuse that asset. The presigned slot is a fresh, EMPTY object either way,
                # so anything that goes on to finish-upload must PUT first.
                if stage.get("exists") and stage.get("existingAssetId") and reuse_existing:
                    try:
                        existing = self.get(stage["existingAssetId"])
                    except ImageStepError:
                        existing = {}
                    if existing.get("status") == "DONE":
                        outcome[n] = {"name": file["name"], "asset": existing}
                        return False
                data = file["data"] if file["data"] is not None else _read_source(file["source"], None, None)[0]
                # The presigned URL is signed for the type the SERVICE picked from the file name (#48); the file's own
                # type is only the fallback when stage-upload named no type.
                response = self._client.put_object(stage["url"], data, stage.get("contentType") or file["mime"], timeout)
                if error := _put_error(response, stage["url"]):
                    outcome[n] = {"name": file["name"], "error": error}
                    return False
                return True

            with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
                to_finish = [n for n, put in enumerate(pool.map(put_one, range(len(files)))) if put]
            if to_finish:
                body = [_finish_item(staged[n], files[n]["name"], collection, tags, retention_days) for n in to_finish]
                for n, asset in zip(to_finish, self._client.post("/api/v1/assets/finish-upload", body).data):
                    outcome[n] = {"name": files[n]["name"], "asset": asset}
            results.extend(r for r in outcome if r is not None)
        made = [r["asset"]["id"] for r in results if r.get("asset", {}).get("status") in _ASSET_PENDING_STATUSES]
        if not wait or not made:
            return results
        ready = self._wait_all(made)
        return [{"name": r["name"], "asset": ready[r["asset"]["id"]]} if r.get("asset", {}).get("id") in ready else r for r in results]

    def wait_ready(self, asset_id: str, *, interval: float = 1.5, timeout: float = 120.0) -> Asset:
        """Poll until the asset leaves PROCESSING — one batch-status call per tick (#233) — then read it once."""
        return self._wait_all([asset_id], interval=interval, timeout=timeout)[asset_id]

    def _wait_all(self, ids: list[str], *, interval: float = 1.5, timeout: float = 120.0) -> dict[str, Asset]:
        """Wait until none of `ids` is PROCESSING — one status call per tick for all of them, ≤ 100 ids a call (#525:
        twenty URLs ingesting for three ticks were sixty calls) — then read each once."""
        deadline = time.monotonic() + timeout
        pending = list(dict.fromkeys(ids))
        while True:
            still = [item for batch in _chunks(pending, _IDS_PER_STATUS) for item in _still_processing(self.status(batch), batch)]
            if not still:
                break
            if time.monotonic() > deadline:
                raise _still_error(still, timeout)
            pending = [item["id"] for item in still]
            time.sleep(interval)
        return {asset_id: self.get(asset_id) for asset_id in dict.fromkeys(ids)}

    def status(self, ids: str | list[str]) -> list[dict[str, Any]]:
        """Ingest state of up to 100 of your assets in one call (#233): `{id, status, width?, height?}` in request
        order; ids that are not yours are absent. Nothing is signed and no audit row is written."""
        return self._client.post("/api/v1/assets/status", {"ids": _ids(ids)}).data["items"]

    def download(self, asset_id: str, *, variant: str = "readable") -> bytes:
        """The asset's private bytes (#233). `GET /assets/{id}/content` answers a redirect to a short-lived signed
        URL; it is followed here WITHOUT the API key — the URL carries its own signature. `variant` is readable
        (full size, in a type a browser shows), original (the bytes as uploaded or produced) or preview (a 400 px
        wide WebP). Both requests are retried like any other (#567)."""
        core = self._client._core
        url, headers, _ = core.prepare("GET", f"/api/v1/assets/{asset_id}/content{_query({'variant': variant})}", None, None, None)
        response = self._client._request_raw("GET", url, headers=headers)
        location = response.headers.get("location")
        if response.is_redirect and location:
            stored = self._client._request_raw("GET", location)
            if not stored.is_success:
                raise ImageStepError(stored.status_code, "internal_error", f"Download from storage failed ({stored.status_code})", True, request_url=location)
            return stored.content
        core.interpret(response, url)
        raise ImageStepError(response.status_code, "internal_error", "content answered without a redirect", True, request_url=url)

    def get(self, asset_id: str) -> Asset:
        return self._client.get(f"/api/v1/assets/{asset_id}").data

    def list(self, **params: Any) -> Page:
        """`page` or `cursor` (the `meta["nextCursor"]` of the previous page, imagestep#493), `per_page`,
        `collection`, `tag`, `mime`, `source`, `view` (ALL ·
        PUBLISHED), `min_width` … `max_height`, `taken_from` / `taken_to` (the EXIF capture
        date) and `created_from` / `created_to` (when the service made it) — each epoch millis or an
        ISO-8601 date in UTC, a bare date as an upper bound covering the whole day,
        `status` (PROCESSING · DONE · FAILED — the ingest state, imagestep#428),
        `include_intermediate` (a chain's scratch images, out of the library by default),
        `has_collection` (False is everything you have not filed; not with `collection`),
        `job_id` / `op` (what one run, or one op, produced — an upload has neither),
        `q` (free text over the name and camera make/model). Each item is a list row (`AssetSummary`,
        imagestep#339): id, name, status, mimeType, width, height, size, labels and dates — `get()` has the
        image facts, metadata and lineage."""
        result = self._client.get(f"/api/v1/assets{_query(params)}")
        return Page(result.data, result.meta)

    def iterate(self, **params: Any) -> Iterator[AssetSummary]:
        """Every asset the filters match, a row at a time, paging as it goes (imagestep#437):
        `for asset in client.assets.iterate(collection="shoot-01"): ...`. Same parameters as `list()`;
        `page=` or `cursor=` is where to start."""
        return _walk(self.list, params)

    def collections(self, **params: Any) -> Page:
        """Your collections, most recently added to first, each with `count` and `lastCreatedAt` (imagestep#349).
        `q` narrows to names containing it, case-insensitively; `page` or `cursor`, `per_page`. A misspelt collection is simply a
        new one — this is how to check."""
        result = self._client.get(f"/api/v1/assets/collections{_query(params)}")
        return Page(result.data, result.meta)

    def iterate_collections(self, **params: Any) -> Iterator[dict[str, Any]]:
        """Every collection, one at a time, paging as it goes (imagestep#437). Same parameters as `collections()`."""
        return _walk(self.collections, params)

    def rename_collection(self, from_: str, to: str | None, *, idempotency_key: str | None = None) -> CollectionRenamed:
        """Move every asset in collection `from_` to `to` — a rename, a merge, or with `None` / `""` taking them out."""
        body = {"from": from_, "to": to or ""}
        return self._client.post("/api/v1/assets/collections/rename", body, idempotency_key=idempotency_key).data

    def publish(self, ids: str | list[str], published: bool = True) -> list[Asset]:
        """Publish → each asset gets a stable `publicUrl` on the CDN: the asset itself at full size, not a thumbnail."""
        return self._client.post("/api/v1/assets/update", {"ids": _ids(ids), "published": published}).data

    def unpublish(self, ids: str | list[str]) -> list[Asset]:
        return self.publish(ids, False)

    def set_collection(self, ids: str | list[str], collection: str | None) -> list[Asset]:
        """Put assets in a collection; `None` or `""` takes them out of theirs (imagestep#348). At most 200
        characters; names starting with `job:` are reserved."""
        return self._client.post("/api/v1/assets/update", {"ids": _ids(ids), "collection": collection or ""}).data

    def tag(self, ids: str | list[str], tags: list[str]) -> list[Asset]:
        """Replace the tags on assets (`[]` clears them); `list(tag=)` finds them again (imagestep#334)."""
        return self._client.post("/api/v1/assets/update", {"ids": _ids(ids), "tags": list(tags)}).data

    def delete(self, ids: str | list[str]) -> dict[str, Any]:
        items = _ids(ids)
        if len(items) == 1:
            self._client.delete(f"/api/v1/assets/{items[0]}")
            return {"deleted": 1}
        return self._client.post("/api/v1/assets/delete", {"ids": items}).data


class Jobs:
    def __init__(self, client: ImageStep):
        self._client = client

    def submit(self, request: dict[str, Any], **opts: Any) -> Job:
        """Submit a raw job request (`type` + `presetId` …) — `ops.run()` is the usual entry point."""
        return self._client.post("/api/v1/jobs", request, **opts).data

    def estimate(self, request: dict[str, Any], **opts: Any) -> JobEstimate:
        return self._client.post("/api/v1/jobs?dryRun=true", request, **opts).data

    def get(self, job_id: str, *, wait: float | None = None) -> Job:
        """One job. `wait` (seconds, at most 60) long-polls: the service holds the response until the job is
        terminal or the window closes, and answers with the job as it stands either way (imagestep#355)."""
        # The request has to outlive the window it asked for, or the client's own timeout is what ends the wait.
        timeout = max(self._client.timeout, _server_wait_seconds(wait) + WAIT_GRACE_SECONDS) if wait else None
        return self._client.get(_job_path(job_id, wait), timeout=timeout).data

    def _submit_and_wait(self, body: dict[str, Any], wait: bool | dict[str, Any], *, idempotency_key: str | None = None) -> Job:
        """Submit and — when `wait` is given — hold on for the result. The first leg of the wait rides on the submit
        (`wait` in the body: a job of one item that settles inside the window comes back finished, in one round
        trip); what is left is `wait()`. `ops.run` and `presets.run` both end here."""
        if not wait:
            return self._client.post("/api/v1/jobs", body, idempotency_key=idempotency_key).data
        opts = _wait_kwargs(wait)
        seconds = _server_wait_seconds(opts.get("timeout"))
        started = time.monotonic()
        job = self._client.post(
            "/api/v1/jobs", {**body, "wait": seconds}, idempotency_key=idempotency_key,
            timeout=max(self._client.timeout, seconds + WAIT_GRACE_SECONDS),
        ).data
        if "timeout" in opts:
            opts["timeout"] = max(0.0, opts["timeout"] - (time.monotonic() - started))
        return self.wait(job["id"], **opts, _known=job)

    def items(self, job_id: str, **params: Any) -> Page:
        """One page of a job's items (imagestep#440).

        A job document carries the first 100 inline and sets `itemsTruncated` when there are more; this is how to
        read the rest, and `status="FAILED"` is how to read just the ones a resume would run again. Each row
        carries the `index` the rest of the API names it by. `page` or `cursor`, `per_page`."""
        result = self._client.get(f"/api/v1/jobs/{job_id}/items{_query(params)}")
        return Page(result.data, result.meta)

    def iterate_items(self, job_id: str, **params: Any) -> Iterator[JobItem]:
        """Every item of a job, one at a time, paging as it goes (imagestep#437). Same parameters as `items()`."""
        return _walk(lambda **page_params: self.items(job_id, **page_params), params)

    def list(self, **params: Any) -> Page:
        """Your jobs, newest first. `status` and `type` narrow them; `preset` narrows to the jobs that ran one
        preset — a slug or id for every version of it, `slug@version` for the version that was pinned; `op` is what
        a job was submitted as; `root_job_id` is every attempt of one logical job; `created_from` / `created_to`
        are the window it was submitted in — epoch millis or an ISO-8601 date read as UTC, a bare date as an upper
        bound covering the whole of that day (imagestep#442). `page`, or `cursor` — the `meta["nextCursor"]` of the
        previous page (imagestep#493), which a walk follows so that jobs submitted meanwhile cannot shift it."""
        result = self._client.get(f"/api/v1/jobs{_query(params)}")
        return Page(result.data, result.meta)

    def iterate(self, **params: Any) -> Iterator[JobSummary]:
        """Every job the filters match, a row at a time, paging as it goes (imagestep#437). Same parameters as `list()`."""
        return _walk(self.list, params)

    def cancel(self, job_id: str) -> Job:
        return self._client.post(f"/api/v1/jobs/{job_id}/cancel").data

    def resume(self, job_id: str) -> Job:
        return self._client.post(f"/api/v1/jobs/{job_id}/resume").data

    def wait(
        self,
        job_id: str,
        *,
        interval: float = 1.0,
        timeout: float = 600.0,
        on_progress: Callable[[Job], Any] | None = None,
        throw_on_failure: bool = True,
        _known: Job | None = None,
    ) -> Job:
        """Wait until the job is terminal. The service does the waiting (imagestep#355): each read is
        `GET /jobs/{id}?wait=<up to 60 s>`, which answers the moment the job settles, so a five-second job costs one
        request, not three. `interval` is only a floor between reads, for a service that answers early. Prefer a
        webhook (`job.completed`) for anything long-running. Raises JobFailedError when the job ends other than
        COMPLETED (unless `throw_on_failure=False`) or `timeout` passes.

        A read turned away for now — `429 rate_limited` when the account already holds its share of open waits
        (contract §5.1), a 503 — is asked again after its `Retry-After` (else `interval`) for as long as the wait has
        left, once `request` has spent its own retries on it (#568); anything not `retryable` ends the wait."""
        deadline = time.monotonic() + timeout
        job = _known
        while True:
            asked = time.monotonic()
            if job is None:
                try:
                    job = self.get(job_id, wait=max(1.0, deadline - asked))
                except ImageStepError as error:
                    if not self._client._core.worth_retrying(error) or time.monotonic() >= deadline:
                        raise
                    time.sleep(_wait_pause(error, interval, deadline))
                    continue
            if on_progress:
                on_progress(job)
            if _settled(job, job_id, throw_on_failure):
                return job
            if time.monotonic() >= deadline:
                raise JobFailedError(job, f"Job {job_id} still {job.get('status')} after {timeout} s")
            if _known is None:
                time.sleep(max(0.0, min(interval - (time.monotonic() - asked), deadline - time.monotonic())))
            job = _known = None

    def outputs(self, job: Job | dict[str, Any]) -> list[AssetSummary]:
        """What a finished job produced, as list rows — ONE paged listing of the run (imagestep#441), not one GET
        per item.

        `GET /assets?job_id=` is the same set by construction (imagestep#430): a chain's scratch images are out of
        it, and an output since deleted is simply absent instead of failing the whole call with a 404. A 500-item
        render used to be 500 round trips, in a row; it is five. Rows are `AssetSummary` — `assets.get(id)` still
        has the image facts, metadata and lineage. In item order when the job document names them."""
        rows = list(self._client.assets.iterate(job_id=job.get("id")))
        return _in_item_order(rows, job)


class Agent:
    """The agent contract face (imagestep#127): the rules, and somewhere to say what is missing.

    On the client rather than left to a raw request because §7 of the contract asks an agent to
    report a gap instead of routing around it, and a rule whose only implementation is "build your
    own HTTP call" loses to the workaround every time.
    """

    def __init__(self, client: ImageStep):
        self._client = client

    def guidelines(self) -> dict[str, Any]:
        """The operating contract: discovery, pricing, retries, consistency, reporting a gap.

        Public — this works before an API key exists.
        """
        return self._client.get("/api/v1/agent-guidelines").data

    def feedback(
        self,
        *,
        kind: str,
        message: str,
        op: str | None = None,
        context: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Report something ImageStep could not do. Free: no credit, no job."""
        body = {"kind": kind, "message": message}
        if op is not None:
            body["op"] = op
        if context is not None:
            body["context"] = context
        return self._client.post("/api/v1/feedback", body, idempotency_key=idempotency_key).data

    def reports(self, **params: Any) -> Page:
        """What this account has reported, newest first."""
        result = self._client.get(f"/api/v1/feedback{_query(params)}")
        return Page(result.data, result.meta)

    def iterate_reports(self, **params: Any) -> Iterator[Feedback]:
        """Every report this account has filed, one at a time, paging as it goes (imagestep#437)."""
        return _walk(self.reports, params)


class Usage:
    """What this key has spent (contract §11, imagestep#125).

    Credits charged, jobs created and items settled over a window, grouped by ``op``, ``key`` or
    ``day``. The credit ledger answers "what moved"; this answers "what have I spent, and on what",
    which is the question an agent holding a budget actually has.
    """

    def __init__(self, client: ImageStep):
        self._client = client

    def get(
        self,
        *,
        from_: str | None = None,
        to: str | None = None,
        group_by: str = "op",
    ) -> dict[str, Any]:
        """``from_``/``to`` are ``YYYY-MM-DD`` or ISO-8601 instants; default window is 30 days."""
        return self._client.get(
            f"/api/v1/usage{_query({'from': from_, 'to': to, 'groupBy': group_by})}"
        ).data


class Presets:
    def __init__(self, client: ImageStep):
        self._client = client

    def list(self, filter: str | None = None, *, include_versions: bool = False) -> list[PresetData]:
        """Each row is the current version; `versions` is left off and `version_count` says how many there are.

        Pass ``include_versions=True`` for the export shape ``import_`` takes back. One preset's history is
        ``get`` and costs less.
        """
        return self._client.get(
            f"/api/v1/presets{_query({'filter': filter, 'includeVersions': include_versions or None})}"
        ).data

    def get(self, slug: str) -> PresetData:
        """The export shape: the current steps and subjects, and every superseded version."""
        return self._client.get(f"/api/v1/presets/{slug}").data

    def create(self, preset: dict[str, Any], *, idempotency_key: str | None = None) -> PresetData:
        """Save a preset. Pass `idempotency_key` to make your own retry the same create, not a second preset."""
        return self._client.post("/api/v1/presets", preset, idempotency_key=idempotency_key).data

    def update(self, slug: str, preset: dict[str, Any]) -> PresetData:
        """Only what changes: the service merges the body over the current preset. New steps or subjects are a new version."""
        return self._client.put(f"/api/v1/presets/{slug}", preset).data

    def delete(self, slug: str) -> None:
        self._client.delete(f"/api/v1/presets/{slug}")

    def delete_version(self, slug: str, version: int) -> None:
        """Drop one superseded version (imagestep#445).

        ``slug@version`` is ``404 preset_not_found`` from then on and the number is never reissued, so this is for
        versions nothing pins. It is also the way past the ceiling: at 50 versions on record an ``update`` that would
        save another is ``422 resource_limit_exceeded``. The current version cannot be deleted.
        """
        self._client.delete(f"/api/v1/presets/{slug}/versions/{version}")

    def import_(self, presets: list[dict[str, Any]]) -> dict[str, Any]:
        """Bulk import (`import` is a Python keyword, hence the trailing underscore)."""
        return self._client.post("/api/v1/presets/import", presets).data

    def run(
        self,
        preset_id: str,
        asset_ids: str | list[str],
        *,
        collection: str | None = None,
        retention_days: int | None = None,
        prompt: str | None = None,
        count: int | None = None,
        dry_run: bool = False,
        image_count: int | None = None,
        wait: bool | dict[str, Any] = False,
        idempotency_key: str | None = None,
    ) -> Job | JobEstimate:
        """Run a saved preset over assets as a job. `preset_id` is a slug or id, or `slug@version` to pin one
        version; the preset decides the job type (imagestep#245). `collection` is where the outputs go (default: each
        input's). `prompt` replaces the prompt of the preset's one AI step for this run — a new scene for the same
        subjects, named as `{{subject.<name>}}` — and `count` is how many images a preset that starts from a prompt
        makes (default 1; pass `[]` as `asset_ids`). A preset with several steps, or no AI step, refuses `prompt`
        (imagestep#461). `image_count` goes with `dry_run`: images not stored yet, priced as that many more `asset_ids`
        (imagestep#586)."""
        body: dict[str, Any] = {"presetId": preset_id, "assetIds": _ids(asset_ids)}
        if collection is not None:
            body["collection"] = collection
        if retention_days is not None:
            body["retentionDays"] = retention_days
        if prompt is not None:
            body["prompt"] = prompt
        if count is not None:
            body["count"] = count
        if image_count is not None:
            body["imageCount"] = image_count
        if dry_run:
            return self._client.post(_jobs_path(True), body, idempotency_key=idempotency_key).data
        return self._client.jobs._submit_and_wait(body, wait, idempotency_key=idempotency_key)


class Templates:
    """Render templates (imagestep#24 / #234): HTML/CSS with `{{ var }}` placeholders that `images.render(template_id, data)`
    and the `render_template` op turn into PNGs. Versioned — `update` saves `version + 1` and keeps the previous one
    readable (and renderable) as `{id}@{version}`."""

    def __init__(self, client: ImageStep):
        self._client = client

    def list(self, filter: str | None = None, **params: Any) -> Page:
        """One page of templates, built-ins first, then yours; `filter` is "builtin" or "user". Rows carry no `html` /
        `css` (imagestep#497) — `get(template_id)` returns the whole document, which is what `import_` takes back."""
        result = self._client.get(f"/api/v1/templates{_query({'filter': filter, **params})}")
        return Page(result.data, result.meta)

    def iterate(self, filter: str | None = None) -> Iterator[TemplateSummary]:
        """Every template, a row at a time, paging as it goes. Same `filter` as `list()`."""
        return _walk(lambda **p: self.list(filter, **p), {})

    def get(self, template_id: str) -> TemplateData:
        """A template id, your own slug, or `id@version` for one frozen version."""
        return self._client.get(f"/api/v1/templates/{template_id}").data

    def versions(self, template_id: str) -> list[TemplateData]:
        """Every version ever saved, newest first."""
        return self._client.get(f"/api/v1/templates/{template_id}/versions").data

    def create(self, template: dict[str, Any]) -> TemplateData:
        """Creates version 1 from `{name, html, css?, width, height, variables?}`."""
        return self._client.post("/api/v1/templates", template).data

    def update(self, template_id: str, template: dict[str, Any]) -> TemplateData:
        """Saves a new version from only what changes — the service merges the body over the current one. The previous
        version stays readable as `{id}@{version}`."""
        return self._client.put(f"/api/v1/templates/{template_id}", template).data

    def delete(self, template_id: str) -> None:
        """Deletes the template and every version of it."""
        self._client.delete(f"/api/v1/templates/{template_id}")

    def import_(self, templates: list[dict[str, Any]]) -> dict[str, Any]:
        """Takes template documents — what `get()` returns — and creates each as version 1 (`import` is a Python
        keyword)."""
        return self._client.post("/api/v1/templates/import", templates).data


class Models:
    """The model catalogue with prices: `mode` is "ai_image" (the default) or "analyze"."""

    def __init__(self, client: ImageStep):
        self._client = client

    def list(self, mode: str = "ai_image") -> list[ModelDTO]:
        return self._client.get(f"/api/v1/ai-models{_query({'mode': mode})}").data


class Webhooks:
    def __init__(self, client: ImageStep):
        self._client = client

    def list(self) -> list[WebhookEndpoint]:
        return self._client.get("/api/v1/webhook-endpoints").data

    def get(self, endpoint_id: str) -> WebhookEndpoint:
        return self._client.get(f"/api/v1/webhook-endpoints/{endpoint_id}").data

    def create(
        self,
        url: str,
        events: list[str] | None = None,
        description: str | None = None,
        enabled: bool | None = None,
    ) -> WebhookEndpoint:
        """Register an https:// endpoint. The `secret` in the response is shown once."""
        body = _compact({"url": url, "events": events, "description": description, "enabled": enabled})
        return self._client.post("/api/v1/webhook-endpoints", body).data

    def update(self, endpoint_id: str, patch: dict[str, Any]) -> WebhookEndpoint:
        return self._client.put(f"/api/v1/webhook-endpoints/{endpoint_id}", patch).data

    def delete(self, endpoint_id: str) -> None:
        self._client.delete(f"/api/v1/webhook-endpoints/{endpoint_id}")

    def rotate_secret(self, endpoint_id: str) -> WebhookEndpoint:
        return self._client.post(f"/api/v1/webhook-endpoints/{endpoint_id}/rotate-secret").data

    def test(self, endpoint_id: str) -> WebhookDeliverySummary:
        return self._client.post(f"/api/v1/webhook-endpoints/{endpoint_id}/test").data

    def deliveries(self, endpoint_id: str, **params: Any) -> Page:
        result = self._client.get(f"/api/v1/webhook-endpoints/{endpoint_id}/deliveries{_query(params)}")
        return Page(result.data, result.meta)

    def iterate_deliveries(self, endpoint_id: str, **params: Any) -> Iterator[WebhookDeliverySummary]:
        """Every delivery to one endpoint, newest first, one at a time, paging as it goes (imagestep#437)."""
        return _walk(functools.partial(self.deliveries, endpoint_id), params)

    @staticmethod
    def verify(raw_body: bytes | str, header: str | None, secret: str, tolerance_seconds: int = 300, now: float | None = None) -> bool:
        return verify_webhook_signature(raw_body, header, secret, tolerance_seconds, now)

    @staticmethod
    def construct_event(
        raw_body: bytes | str, header: str | None, secret: str, tolerance_seconds: int = 300, now: float | None = None
    ) -> dict[str, Any]:
        return construct_webhook_event(raw_body, header, secret, tolerance_seconds, now)


# ───────────────────────────────────────── async ─────────────────────────────────────────


class AsyncImageStep:
    """The asyncio client — same surface as `ImageStep`, every method awaitable.

    Accepts the same arguments; `transport` is an `httpx.AsyncBaseTransport` (or a
    `httpx.MockTransport`), `http_client` an `httpx.AsyncClient`.
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        timeout: float = 60.0,
        max_retries: int = 2,
        user_agent: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        http_client: httpx.AsyncClient | None = None,
    ):
        key, url, agent = _client_settings(api_key, base_url, user_agent)
        self._core = _RequestCore(key, url, agent)
        self.base_url = self._core.base_url
        self.timeout = timeout
        self.max_retries = max_retries
        self._http = http_client or httpx.AsyncClient(transport=transport, timeout=timeout)

        self.ops = AsyncOps(self)
        self.images = AsyncImages(self)
        self.assets = AsyncAssets(self)
        self.jobs = AsyncJobs(self)
        self.presets = AsyncPresets(self)
        self.templates = AsyncTemplates(self)
        self.models = AsyncModels(self)
        self.agent = AsyncAgent(self)
        self.webhooks = AsyncWebhooks(self)
        self.usage = AsyncUsage(self)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> AsyncImageStep:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def request(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        headers: dict[str, str] | None = None,
        idempotency_key: str | None = None,
        retries: int | None = None,
        timeout: float | None = None,
    ) -> RequestResult:
        """See `ImageStep.request` — identical semantics, `asyncio.sleep` between retries."""
        url, h, content = self._core.prepare(method, path, body, headers, idempotency_key)
        attempts = max(1, (self.max_retries if retries is None else retries) + 1)
        for attempt in range(1, attempts + 1):
            try:
                response = await self._http.request(method, url, headers=h, content=content, timeout=timeout or self.timeout)
            except httpx.TransportError:
                if attempt == attempts:
                    raise
                await asyncio.sleep(self._core.transport_backoff(attempt))
                continue
            try:
                return self._core.interpret(response, url)
            except ImageStepError as error:
                if not self._core.worth_retrying(error) or attempt == attempts:
                    raise
                await asyncio.sleep(self._core.error_backoff(attempt, error))

    async def get(self, path: str, **opts: Any) -> RequestResult:
        return await self.request("GET", path, **opts)

    async def post(self, path: str, body: Any = None, **opts: Any) -> RequestResult:
        return await self.request("POST", path, body=body, **opts)

    async def put(self, path: str, body: Any = None, **opts: Any) -> RequestResult:
        return await self.request("PUT", path, body=body, **opts)

    async def delete(self, path: str, **opts: Any) -> RequestResult:
        return await self.request("DELETE", path, **opts)

    async def request_binary(
        self,
        path: str,
        *,
        content: bytes | None = None,
        json_body: dict[str, Any] | None = None,
        content_type: str | None = None,
        accept: str = "*/*",
        timeout: float | None = None,
        retries: int | None = None,
    ) -> bytes | dict[str, Any]:
        """See `ImageStep.request_binary` — identical semantics, `asyncio.sleep` between retries."""
        result = await self.request_binary_result(
            path, content=content, json_body=json_body, content_type=content_type,
            accept=accept, timeout=timeout, retries=retries,
        )
        return result.content if result.json is None else result.json

    async def request_binary_result(
        self,
        path: str,
        *,
        content: bytes | None = None,
        json_body: dict[str, Any] | None = None,
        content_type: str | None = None,
        accept: str = "*/*",
        timeout: float | None = None,
        retries: int | None = None,
    ) -> BinaryResult:
        """See `ImageStep.request_binary_result` — identical semantics, awaited."""
        url, headers, body = self._core.prepare_binary(path, content, json_body, content_type, accept)
        attempts = max(1, (self.max_retries if retries is None else retries) + 1)
        for attempt in range(1, attempts + 1):
            try:
                response = await self._http.request(
                    "POST", url, headers=headers, content=body, timeout=timeout or self.timeout
                )
            except httpx.TransportError:
                if attempt == attempts:
                    raise
                await asyncio.sleep(self._core.transport_backoff(attempt))
                continue
            try:
                return self._core.interpret_binary(response, url)
            except ImageStepError as error:
                if not self._core.worth_retrying(error) or attempt == attempts:
                    raise
                await asyncio.sleep(self._core.error_backoff(attempt, error))

    async def put_object(self, url: str, data: bytes, content_type: str, timeout: float | None = None) -> httpx.Response:
        """See `ImageStep.put_object`."""
        return await self._request_raw("PUT", url, content=data, headers={"Content-Type": content_type}, timeout=timeout)

    async def _request_raw(self, method: str, url: str, *, timeout: float | None = None, **kwargs: Any) -> httpx.Response:
        """See `ImageStep._request_raw` — identical semantics, `asyncio.sleep` between retries."""
        attempts = max(1, self.max_retries + 1)
        for attempt in range(1, attempts + 1):
            try:
                response = await self._http.request(method, url, follow_redirects=False, timeout=timeout or self.timeout, **kwargs)
            except httpx.TransportError:
                if attempt == attempts:
                    raise
                await asyncio.sleep(self._core.transport_backoff(attempt))
                continue
            pause = self._core.raw_backoff(attempt, response)
            if pause is None or attempt == attempts:
                return response
            await asyncio.sleep(pause)


async def _notify(on_progress: Callable[[Job], Any] | None, job: Job) -> None:
    """Call a progress callback that may be sync or async."""
    if on_progress:
        outcome = on_progress(job)
        if inspect.isawaitable(outcome):
            await outcome


class AsyncImages(_ImagesCore):
    """The synchronous face, awaited — the same four methods as :class:`Images`.

    "Synchronous" here is about the API (bytes in, bytes out, nothing stored — contract §9), not
    about Python: the whole point of this class is that an asyncio program can use that face
    without a thread. It was missing, so ``images.*`` was the one namespace where the two clients
    did not match (#97).
    """

    def __init__(self, client: AsyncImageStep):
        self._client = client
        self._sync_endpoints: dict[str, str | None] | None = None

    async def sync_endpoints(self) -> dict[str, str | None]:
        """op -> syncEndpoint, straight from ``GET /api/v1/ops``. Read, never hard-coded."""
        if self._sync_endpoints is None:
            self._sync_endpoints = {o["op"]: o.get("syncEndpoint") for o in await self._client.ops.list()}
        return self._sync_endpoints

    async def supports(self, op: str) -> bool:
        return bool((await self.sync_endpoints()).get(op))

    async def transform(
        self,
        op: str | None = None,
        *,
        file: Any = None,
        url: str | None = None,
        asset_id: str | None = None,
        preset: str | None = None,
        response: str | None = None,
        parameters: dict[str, Any] | None = None,
    ) -> bytes | dict[str, Any]:
        """Run one deterministic op, or a deterministic preset, on one image."""
        result = await self.transform_result(op, file=file, url=url, asset_id=asset_id, preset=preset,
                                             response=response, parameters=parameters)
        return result.content if result.json is None else result.json

    async def transform_result(
        self,
        op: str | None = None,
        *,
        file: Any = None,
        url: str | None = None,
        asset_id: str | None = None,
        preset: str | None = None,
        response: str | None = None,
        parameters: dict[str, Any] | None = None,
    ) -> BinaryResult:
        """:meth:`Images.transform_result`, awaited."""
        if op and not await self.supports(op):
            raise self._not_synchronous(op)
        path = self._transform_path(op, preset, response, parameters)
        if url or asset_id:
            return await self._client.request_binary_result(path, json_body=_compact({"url": url, "assetId": asset_id}))
        data, _, mime = _read_source(file, None, None)
        return await self._client.request_binary_result(path, content=data, content_type=mime)

    async def render(self, template_id: str, data: dict[str, Any] | None = None) -> bytes | dict[str, Any]:
        """One template row -> one PNG. A batch is a job."""
        return await self._client.request_binary(
            "/api/v1/images/render", json_body={"templateId": template_id, "data": data or {}}
        )

    async def metadata(self, file: Any) -> dict[str, Any]:
        """EXIF, GPS, dimensions, format and SHA-1. Free, and it stores nothing."""
        data, _, mime = _read_source(file, None, None)
        result = await self._client.request_binary(
            "/api/v1/images/metadata", content=data, content_type=mime, accept="application/json"
        )
        return result if isinstance(result, dict) else {}


class AsyncOps:
    def __init__(self, client: AsyncImageStep):
        self._client = client

    async def list(self) -> list[OpDefinition]:
        return (await self._client.get("/api/v1/ops")).data

    async def get(self, op: str) -> OpDefinition:
        return (await self._client.get(f"/api/v1/ops/{op}")).data

    async def run(
        self,
        op: str,
        *,
        asset_ids: str | list[str] | None = None,
        prompt: str | None = None,
        count: int | None = None,
        model: str | None = None,
        parameters: dict[str, Any] | None = None,
        variants: list[dict[str, Any]] | None = None,
        template_id: str | None = None,
        items: list[dict[str, Any]] | None = None,
        collection: str | None = None,
        retention_days: int | None = None,
        dry_run: bool = False,
        image_count: int | None = None,
        wait: bool | dict[str, Any] = False,
        idempotency_key: str | None = None,
    ) -> Job | JobEstimate:
        """See `Ops.run`."""
        rest = {"prompt": prompt, "count": count, "model": model, "parameters": parameters, "variants": variants, "templateId": template_id, "items": items, "imageCount": image_count, "retentionDays": retention_days}
        body = _run_body(op, asset_ids, collection, rest)
        if dry_run:
            return (await self._client.post(_jobs_path(True), body, idempotency_key=idempotency_key)).data
        return await self._client.jobs._submit_and_wait(body, wait, idempotency_key=idempotency_key)

    async def estimate(self, op: str, **opts: Any) -> JobEstimate:
        return await self.run(op, dry_run=True, **opts)

    async def remove_bg(self, asset_ids: str | list[str], **opts: Any):
        return await self.run("remove_bg", asset_ids=asset_ids, **opts)

    async def upscale(self, asset_ids: str | list[str], **opts: Any):
        return await self.run("upscale", asset_ids=asset_ids, **opts)

    async def restore_face(self, asset_ids: str | list[str], **opts: Any):
        return await self.run("restore_face", asset_ids=asset_ids, **opts)

    async def colorize(self, asset_ids: str | list[str], **opts: Any):
        return await self.run("colorize", asset_ids=asset_ids, **opts)

    async def analyze(self, asset_ids: str | list[str], **opts: Any):
        """Structured JSON about each image: each job item's `output` (imagestep#338); the default answer's tags also join the asset's `tags`."""
        return await self.run("analyze", asset_ids=asset_ids, **opts)

    async def generate(self, prompt: str, **opts: Any):
        return await self.run("generate", prompt=prompt, **opts)

    async def edit(self, asset_ids: str | list[str], prompt: str, **opts: Any):
        return await self.run("edit", asset_ids=asset_ids, prompt=prompt, **opts)

    async def resize(self, asset_ids: str | list[str], parameters: dict[str, Any], **opts: Any):
        return await self.run("resize", asset_ids=asset_ids, parameters=parameters, **opts)

    async def convert(self, asset_ids: str | list[str], parameters: dict[str, Any], **opts: Any):
        return await self.run("convert", asset_ids=asset_ids, parameters=parameters, **opts)

    async def compress(self, asset_ids: str | list[str], parameters: dict[str, Any], **opts: Any):
        return await self.run("compress", asset_ids=asset_ids, parameters=parameters, **opts)

    async def crop(self, asset_ids: str | list[str], parameters: dict[str, Any], **opts: Any):
        return await self.run("crop", asset_ids=asset_ids, parameters=parameters, **opts)

    async def pad(self, asset_ids: str | list[str], parameters: dict[str, Any], **opts: Any):
        return await self.run("pad", asset_ids=asset_ids, parameters=parameters, **opts)

    async def rotate(self, asset_ids: str | list[str], parameters: dict[str, Any], **opts: Any):
        return await self.run("rotate", asset_ids=asset_ids, parameters=parameters, **opts)

    async def flip(self, asset_ids: str | list[str], **opts: Any):
        return await self.run("flip", asset_ids=asset_ids, **opts)

    async def flop(self, asset_ids: str | list[str], **opts: Any):
        return await self.run("flop", asset_ids=asset_ids, **opts)

    async def trim(self, asset_ids: str | list[str], parameters: dict[str, Any] | None = None, **opts: Any):
        return await self.run("trim", asset_ids=asset_ids, parameters=parameters or {}, **opts)

    async def flatten(self, asset_ids: str | list[str], parameters: dict[str, Any] | None = None, **opts: Any):
        return await self.run("flatten", asset_ids=asset_ids, parameters=parameters or {}, **opts)

    async def adjust(self, asset_ids: str | list[str], parameters: dict[str, Any], **opts: Any):
        return await self.run("adjust", asset_ids=asset_ids, parameters=parameters, **opts)

    async def mask(self, asset_ids: str | list[str], parameters: dict[str, Any] | None = None, **opts: Any):
        return await self.run("mask", asset_ids=asset_ids, parameters=parameters or {}, **opts)

    async def blur_region(self, asset_ids: str | list[str], parameters: dict[str, Any], **opts: Any):
        return await self.run("blur_region", asset_ids=asset_ids, parameters=parameters, **opts)

    async def overlay(self, asset_ids: str | list[str], parameters: dict[str, Any], **opts: Any):
        return await self.run("overlay", asset_ids=asset_ids, parameters=parameters, **opts)

    async def caption(self, asset_ids: str | list[str], parameters: dict[str, Any], **opts: Any):
        return await self.run("caption", asset_ids=asset_ids, parameters=parameters, **opts)

    async def grayscale(self, asset_ids: str | list[str], **opts: Any):
        return await self.run("grayscale", asset_ids=asset_ids, **opts)

    async def read_metadata(self, asset_id: str) -> dict[str, Any]:
        return _metadata_view(await self._client.assets.get(asset_id))


class AsyncAssets:
    def __init__(self, client: AsyncImageStep):
        self._client = client

    async def upload(
        self,
        source: Any,
        *,
        name: str | None = None,
        mime_type: str | None = None,
        collection: str | None = None,
        tags: list[str] | None = None,
        retention_days: int | None = None,
        wait: bool = True,
        reuse_existing: bool = True,
        timeout: float | None = None,
    ) -> Asset:
        """See `Assets.upload`. Reading a path or file object is done synchronously."""
        [result] = await self._upload(
            [source],
            name=name,
            mime_type=mime_type,
            concurrency=1,
            collection=collection,
            tags=tags,
            retention_days=retention_days,
            wait=wait,
            reuse_existing=reuse_existing,
            timeout=timeout,
        )
        if "error" in result:
            raise result["error"]
        return result["asset"]

    async def from_url(
        self,
        urls: list[str],
        *,
        collection: str | None = None,
        tags: list[str] | None = None,
        retention_days: int | None = None,
        wait: bool = True,
    ) -> list[dict[str, Any]]:
        """Ingest images by URL: the SERVICE fetches each one (imagestep#219), twenty to a request (#525). One result
        per URL, in order."""
        results: list[dict[str, Any]] = []
        for batch in _chunks(list(urls), _URLS_PER_INGEST):
            body: dict[str, Any] = {"urls": batch}
            if collection is not None:
                body["collection"] = collection
            if tags:
                body["tags"] = list(tags)
            if retention_days is not None:
                body["retentionDays"] = retention_days
            results.extend((await self._client.post("/api/v1/assets/from-url", body)).data)
        created = [r["id"] for r in results if not r.get("error")]
        ready = (await self._wait_all(created)) if wait and created else {}
        return [
            {"url": r["url"], "error": r["error"]} if r.get("error") else {"url": r["url"], "asset": ready.get(r["id"], r)}
            for r in results
        ]

    async def upload_many(
        self,
        sources: list[Any],
        *,
        concurrency: int = 4,
        collection: str | None = None,
        tags: list[str] | None = None,
        retention_days: int | None = None,
        wait: bool = True,
        reuse_existing: bool = True,
        timeout: float | None = None,
    ) -> list[dict[str, Any]]:
        """See `Assets.upload_many`. Reading and hashing the files is done synchronously."""
        results = await self._upload(
            sources,
            concurrency=concurrency,
            collection=collection,
            tags=tags,
            retention_days=retention_days,
            wait=wait,
            reuse_existing=reuse_existing,
            timeout=timeout,
        )
        return [{"name": r["name"], "error": _error_dict(r["error"])} if "error" in r else r for r in results]

    async def _upload(
        self,
        sources: list[Any],
        *,
        name: str | None = None,
        mime_type: str | None = None,
        concurrency: int,
        collection: str | None,
        tags: list[str] | None,
        retention_days: int | None,
        wait: bool,
        reuse_existing: bool,
        timeout: float | None,
    ) -> list[dict[str, Any]]:
        """See `Assets._upload`."""
        gate = asyncio.Semaphore(max(1, concurrency))
        results: list[dict[str, Any]] = []
        for batch in _chunks(list(sources), _FILES_PER_STAGE):
            files = [_describe_upload(source, name, mime_type) for source in batch]
            staged = (
                await self._client.post(
                    "/api/v1/assets/stage-upload", [{"fileName": f["name"], "fileSize": f["size"], "sha1Hash": f["sha1"]} for f in files]
                )
            ).data
            outcome: list[dict[str, Any] | None] = [None] * len(files)

            async def put_one(n: int) -> bool:
                file, stage = files[n], staged[n]
                if error := _stage_error(stage):
                    outcome[n] = {"name": file["name"], "error": error}
                    return False
                async with gate:
                    if stage.get("exists") and stage.get("existingAssetId") and reuse_existing:
                        try:
                            existing = await self.get(stage["existingAssetId"])
                        except ImageStepError:
                            existing = {}
                        if existing.get("status") == "DONE":
                            outcome[n] = {"name": file["name"], "asset": existing}
                            return False
                    data = file["data"] if file["data"] is not None else _read_source(file["source"], None, None)[0]
                    response = await self._client.put_object(stage["url"], data, stage.get("contentType") or file["mime"], timeout)
                if error := _put_error(response, stage["url"]):
                    outcome[n] = {"name": file["name"], "error": error}
                    return False
                return True

            put = await asyncio.gather(*(put_one(n) for n in range(len(files))))
            to_finish = [n for n, ok in enumerate(put) if ok]
            if to_finish:
                body = [_finish_item(staged[n], files[n]["name"], collection, tags, retention_days) for n in to_finish]
                for n, asset in zip(to_finish, (await self._client.post("/api/v1/assets/finish-upload", body)).data):
                    outcome[n] = {"name": files[n]["name"], "asset": asset}
            results.extend(r for r in outcome if r is not None)
        made = [r["asset"]["id"] for r in results if r.get("asset", {}).get("status") in _ASSET_PENDING_STATUSES]
        if not wait or not made:
            return results
        ready = await self._wait_all(made)
        return [{"name": r["name"], "asset": ready[r["asset"]["id"]]} if r.get("asset", {}).get("id") in ready else r for r in results]

    async def wait_ready(self, asset_id: str, *, interval: float = 1.5, timeout: float = 120.0) -> Asset:
        """See `Assets.wait_ready`: one batch-status call per tick (#233), then one read."""
        return (await self._wait_all([asset_id], interval=interval, timeout=timeout))[asset_id]

    async def _wait_all(self, ids: list[str], *, interval: float = 1.5, timeout: float = 120.0) -> dict[str, Asset]:
        """See `Assets._wait_all`."""
        deadline = time.monotonic() + timeout
        pending = list(dict.fromkeys(ids))
        while True:
            still = [item for batch in _chunks(pending, _IDS_PER_STATUS) for item in _still_processing(await self.status(batch), batch)]
            if not still:
                break
            if time.monotonic() > deadline:
                raise _still_error(still, timeout)
            pending = [item["id"] for item in still]
            await asyncio.sleep(interval)
        unique = list(dict.fromkeys(ids))
        gate = asyncio.Semaphore(8)

        async def read(asset_id: str) -> Asset:
            async with gate:
                return await self.get(asset_id)

        return dict(zip(unique, await asyncio.gather(*(read(asset_id) for asset_id in unique))))

    async def status(self, ids: str | list[str]) -> list[dict[str, Any]]:
        """See `Assets.status`."""
        return (await self._client.post("/api/v1/assets/status", {"ids": _ids(ids)})).data["items"]

    async def download(self, asset_id: str, *, variant: str = "readable") -> bytes:
        """See `Assets.download`: the signed redirect is followed without the API key."""
        core = self._client._core
        url, headers, _ = core.prepare("GET", f"/api/v1/assets/{asset_id}/content{_query({'variant': variant})}", None, None, None)
        response = await self._client._request_raw("GET", url, headers=headers)
        location = response.headers.get("location")
        if response.is_redirect and location:
            stored = await self._client._request_raw("GET", location)
            if not stored.is_success:
                raise ImageStepError(stored.status_code, "internal_error", f"Download from storage failed ({stored.status_code})", True, request_url=location)
            return stored.content
        core.interpret(response, url)
        raise ImageStepError(response.status_code, "internal_error", "content answered without a redirect", True, request_url=url)

    async def get(self, asset_id: str) -> Asset:
        return (await self._client.get(f"/api/v1/assets/{asset_id}")).data

    async def list(self, **params: Any) -> Page:
        result = await self._client.get(f"/api/v1/assets{_query(params)}")
        return Page(result.data, result.meta)

    def iterate(self, **params: Any) -> AsyncIterator[AssetSummary]:
        """Every asset the filters match, a row at a time, paging as it goes (imagestep#437):
        `async for asset in client.assets.iterate(collection="shoot-01"): ...`."""
        return _awalk(self.list, params)

    async def collections(self, **params: Any) -> Page:
        result = await self._client.get(f"/api/v1/assets/collections{_query(params)}")
        return Page(result.data, result.meta)

    def iterate_collections(self, **params: Any) -> AsyncIterator[dict[str, Any]]:
        """Every collection, one at a time, paging as it goes (imagestep#437)."""
        return _awalk(self.collections, params)

    async def rename_collection(self, from_: str, to: str | None, *, idempotency_key: str | None = None) -> CollectionRenamed:
        body = {"from": from_, "to": to or ""}
        return (await self._client.post("/api/v1/assets/collections/rename", body, idempotency_key=idempotency_key)).data

    async def publish(self, ids: str | list[str], published: bool = True) -> list[Asset]:
        return (await self._client.post("/api/v1/assets/update", {"ids": _ids(ids), "published": published})).data

    async def unpublish(self, ids: str | list[str]) -> list[Asset]:
        return await self.publish(ids, False)

    async def set_collection(self, ids: str | list[str], collection: str | None) -> list[Asset]:
        return (await self._client.post("/api/v1/assets/update", {"ids": _ids(ids), "collection": collection or ""})).data

    async def tag(self, ids: str | list[str], tags: list[str]) -> list[Asset]:
        return (await self._client.post("/api/v1/assets/update", {"ids": _ids(ids), "tags": list(tags)})).data

    async def delete(self, ids: str | list[str]) -> dict[str, Any]:
        items = _ids(ids)
        if len(items) == 1:
            await self._client.delete(f"/api/v1/assets/{items[0]}")
            return {"deleted": 1}
        return (await self._client.post("/api/v1/assets/delete", {"ids": items})).data


class AsyncJobs:
    def __init__(self, client: AsyncImageStep):
        self._client = client

    async def submit(self, request: dict[str, Any], **opts: Any) -> Job:
        return (await self._client.post("/api/v1/jobs", request, **opts)).data

    async def estimate(self, request: dict[str, Any], **opts: Any) -> JobEstimate:
        return (await self._client.post("/api/v1/jobs?dryRun=true", request, **opts)).data

    async def get(self, job_id: str, *, wait: float | None = None) -> Job:
        """See `Jobs.get`."""
        timeout = max(self._client.timeout, _server_wait_seconds(wait) + WAIT_GRACE_SECONDS) if wait else None
        return (await self._client.get(_job_path(job_id, wait), timeout=timeout)).data

    async def _submit_and_wait(self, body: dict[str, Any], wait: bool | dict[str, Any], *, idempotency_key: str | None = None) -> Job:
        """See `Jobs._submit_and_wait`."""
        if not wait:
            return (await self._client.post("/api/v1/jobs", body, idempotency_key=idempotency_key)).data
        opts = _wait_kwargs(wait)
        seconds = _server_wait_seconds(opts.get("timeout"))
        started = time.monotonic()
        job = (await self._client.post(
            "/api/v1/jobs", {**body, "wait": seconds}, idempotency_key=idempotency_key,
            timeout=max(self._client.timeout, seconds + WAIT_GRACE_SECONDS),
        )).data
        if "timeout" in opts:
            opts["timeout"] = max(0.0, opts["timeout"] - (time.monotonic() - started))
        return await self.wait(job["id"], **opts, _known=job)

    async def list(self, **params: Any) -> Page:
        result = await self._client.get(f"/api/v1/jobs{_query(params)}")
        return Page(result.data, result.meta)

    async def items(self, job_id: str, **params: Any) -> Page:
        """`JobsAPI.items` for the async client: one page of a job's items (imagestep#440)."""
        result = await self._client.get(f"/api/v1/jobs/{job_id}/items{_query(params)}")
        return Page(result.data, result.meta)

    def iterate_items(self, job_id: str, **params: Any) -> AsyncIterator[JobItem]:
        """Every item of a job, one at a time, paging as it goes (imagestep#437)."""
        return _awalk(lambda **page_params: self.items(job_id, **page_params), params)

    def iterate(self, **params: Any) -> AsyncIterator[JobSummary]:
        """Every job the filters match, a row at a time, paging as it goes (imagestep#437)."""
        return _awalk(self.list, params)

    async def cancel(self, job_id: str) -> Job:
        return (await self._client.post(f"/api/v1/jobs/{job_id}/cancel")).data

    async def resume(self, job_id: str) -> Job:
        return (await self._client.post(f"/api/v1/jobs/{job_id}/resume")).data

    async def wait(
        self,
        job_id: str,
        *,
        interval: float = 1.0,
        timeout: float = 600.0,
        on_progress: Callable[[Job], Any] | None = None,
        throw_on_failure: bool = True,
        _known: Job | None = None,
    ) -> Job:
        """See `Jobs.wait`; `on_progress` may be a coroutine function."""
        deadline = time.monotonic() + timeout
        job = _known
        while True:
            asked = time.monotonic()
            if job is None:
                try:
                    job = await self.get(job_id, wait=max(1.0, deadline - asked))
                except ImageStepError as error:
                    if not self._client._core.worth_retrying(error) or time.monotonic() >= deadline:
                        raise
                    await asyncio.sleep(_wait_pause(error, interval, deadline))
                    continue
            await _notify(on_progress, job)
            if _settled(job, job_id, throw_on_failure):
                return job
            if time.monotonic() >= deadline:
                raise JobFailedError(job, f"Job {job_id} still {job.get('status')} after {timeout} s")
            if _known is None:
                await asyncio.sleep(max(0.0, min(interval - (time.monotonic() - asked), deadline - time.monotonic())))
            job = _known = None

    async def outputs(self, job: Job | dict[str, Any]) -> list[AssetSummary]:
        """`JobsAPI.outputs` for the async client: one paged listing of the run, in item order (imagestep#441)."""
        rows = [asset async for asset in self._client.assets.iterate(job_id=job.get("id"))]
        return _in_item_order(rows, job)


class AsyncAgent:
    def __init__(self, client: AsyncImageStep):
        self._client = client

    async def guidelines(self) -> dict[str, Any]:
        return (await self._client.get("/api/v1/agent-guidelines")).data

    async def feedback(
        self,
        *,
        kind: str,
        message: str,
        op: str | None = None,
        context: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        body = {"kind": kind, "message": message}
        if op is not None:
            body["op"] = op
        if context is not None:
            body["context"] = context
        return (await self._client.post("/api/v1/feedback", body, idempotency_key=idempotency_key)).data

    def iterate_reports(self, **params: Any) -> AsyncIterator[Feedback]:
        """Every report this account has filed, one at a time, paging as it goes (imagestep#437)."""
        return _awalk(self.reports, params)

    async def reports(self, **params: Any) -> Page:
        result = await self._client.get(f"/api/v1/feedback{_query(params)}")
        return Page(result.data, result.meta)


class AsyncUsage:
    def __init__(self, client: AsyncImageStep):
        self._client = client

    async def get(
        self,
        *,
        from_: str | None = None,
        to: str | None = None,
        group_by: str = "op",
    ) -> dict[str, Any]:
        return (
            await self._client.get(
                f"/api/v1/usage{_query({'from': from_, 'to': to, 'groupBy': group_by})}"
            )
        ).data


class AsyncPresets:
    def __init__(self, client: AsyncImageStep):
        self._client = client

    async def list(self, filter: str | None = None, *, include_versions: bool = False) -> list[PresetData]:
        """Each row is the current version; pass ``include_versions=True`` for the export shape (imagestep#444)."""
        return (
            await self._client.get(
                f"/api/v1/presets{_query({'filter': filter, 'includeVersions': include_versions or None})}"
            )
        ).data

    async def get(self, slug: str) -> PresetData:
        return (await self._client.get(f"/api/v1/presets/{slug}")).data

    async def create(self, preset: dict[str, Any], *, idempotency_key: str | None = None) -> PresetData:
        return (await self._client.post("/api/v1/presets", preset, idempotency_key=idempotency_key)).data

    async def update(self, slug: str, preset: dict[str, Any]) -> PresetData:
        return (await self._client.put(f"/api/v1/presets/{slug}", preset)).data

    async def delete(self, slug: str) -> None:
        await self._client.delete(f"/api/v1/presets/{slug}")

    async def delete_version(self, slug: str, version: int) -> None:
        """Drop one superseded version — `slug@version` stops resolving, and that is how room is made at the
        50-version ceiling (imagestep#445)."""
        await self._client.delete(f"/api/v1/presets/{slug}/versions/{version}")

    async def import_(self, presets: list[dict[str, Any]]) -> dict[str, Any]:
        return (await self._client.post("/api/v1/presets/import", presets)).data

    async def run(
        self,
        preset_id: str,
        asset_ids: str | list[str],
        *,
        collection: str | None = None,
        retention_days: int | None = None,
        prompt: str | None = None,
        count: int | None = None,
        dry_run: bool = False,
        image_count: int | None = None,
        wait: bool | dict[str, Any] = False,
        idempotency_key: str | None = None,
    ) -> Job | JobEstimate:
        """See `Presets.run`."""
        body: dict[str, Any] = {"presetId": preset_id, "assetIds": _ids(asset_ids)}
        if collection is not None:
            body["collection"] = collection
        if retention_days is not None:
            body["retentionDays"] = retention_days
        if prompt is not None:
            body["prompt"] = prompt
        if count is not None:
            body["count"] = count
        if image_count is not None:
            body["imageCount"] = image_count
        if dry_run:
            return (await self._client.post(_jobs_path(True), body, idempotency_key=idempotency_key)).data
        return await self._client.jobs._submit_and_wait(body, wait, idempotency_key=idempotency_key)


class AsyncTemplates:
    """See `Templates`."""

    def __init__(self, client: AsyncImageStep):
        self._client = client

    async def list(self, filter: str | None = None, **params: Any) -> Page:
        result = await self._client.get(f"/api/v1/templates{_query({'filter': filter, **params})}")
        return Page(result.data, result.meta)

    def iterate(self, filter: str | None = None) -> AsyncIterator[TemplateSummary]:
        return _awalk(lambda **p: self.list(filter, **p), {})

    async def get(self, template_id: str) -> TemplateData:
        return (await self._client.get(f"/api/v1/templates/{template_id}")).data

    async def versions(self, template_id: str) -> list[TemplateData]:
        return (await self._client.get(f"/api/v1/templates/{template_id}/versions")).data

    async def create(self, template: dict[str, Any]) -> TemplateData:
        return (await self._client.post("/api/v1/templates", template)).data

    async def update(self, template_id: str, template: dict[str, Any]) -> TemplateData:
        return (await self._client.put(f"/api/v1/templates/{template_id}", template)).data

    async def delete(self, template_id: str) -> None:
        await self._client.delete(f"/api/v1/templates/{template_id}")

    async def import_(self, templates: list[dict[str, Any]]) -> dict[str, Any]:
        return (await self._client.post("/api/v1/templates/import", templates)).data


class AsyncModels:
    """See `Models`."""

    def __init__(self, client: AsyncImageStep):
        self._client = client

    async def list(self, mode: str = "ai_image") -> list[ModelDTO]:
        return (await self._client.get(f"/api/v1/ai-models{_query({'mode': mode})}")).data


class AsyncWebhooks:
    def __init__(self, client: AsyncImageStep):
        self._client = client

    async def list(self) -> list[WebhookEndpoint]:
        return (await self._client.get("/api/v1/webhook-endpoints")).data

    async def get(self, endpoint_id: str) -> WebhookEndpoint:
        return (await self._client.get(f"/api/v1/webhook-endpoints/{endpoint_id}")).data

    async def create(
        self,
        url: str,
        events: list[str] | None = None,
        description: str | None = None,
        enabled: bool | None = None,
    ) -> WebhookEndpoint:
        body = _compact({"url": url, "events": events, "description": description, "enabled": enabled})
        return (await self._client.post("/api/v1/webhook-endpoints", body)).data

    async def update(self, endpoint_id: str, patch: dict[str, Any]) -> WebhookEndpoint:
        return (await self._client.put(f"/api/v1/webhook-endpoints/{endpoint_id}", patch)).data

    async def delete(self, endpoint_id: str) -> None:
        await self._client.delete(f"/api/v1/webhook-endpoints/{endpoint_id}")

    async def rotate_secret(self, endpoint_id: str) -> WebhookEndpoint:
        return (await self._client.post(f"/api/v1/webhook-endpoints/{endpoint_id}/rotate-secret")).data

    async def test(self, endpoint_id: str) -> WebhookDeliverySummary:
        return (await self._client.post(f"/api/v1/webhook-endpoints/{endpoint_id}/test")).data

    async def deliveries(self, endpoint_id: str, **params: Any) -> Page:
        result = await self._client.get(f"/api/v1/webhook-endpoints/{endpoint_id}/deliveries{_query(params)}")
        return Page(result.data, result.meta)

    def iterate_deliveries(self, endpoint_id: str, **params: Any) -> AsyncIterator[WebhookDeliverySummary]:
        """Every delivery to one endpoint, newest first, one at a time, paging as it goes (imagestep#437)."""
        return _awalk(functools.partial(self.deliveries, endpoint_id), params)

    verify = staticmethod(Webhooks.verify)
    construct_event = staticmethod(Webhooks.construct_event)
