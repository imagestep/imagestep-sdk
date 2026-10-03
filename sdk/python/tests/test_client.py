"""Mirrors sdk/js/test/client.test.js — the same contract, checked over httpx.MockTransport."""
from __future__ import annotations

import hashlib
import hmac
import json
import re
from typing import Any

import httpx
import pytest

import imagestep.client as client_module

from imagestep import (
    AsyncImageStep,
    ImageStep,
    ImageStepError,
    JobFailedError,
    WebhookSignatureError,
    construct_webhook_event,
    verify_webhook_signature,
)

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def envelope(data: Any, meta: Any = None) -> httpx.Response:
    return httpx.Response(200, json={"success": True, "data": data, "meta": meta})


def error_response(status: int, error: dict[str, Any], headers: dict[str, str] | None = None) -> httpx.Response:
    return httpx.Response(status, json={"success": False, "error": error}, headers=headers or {})


class Recorder:
    """A MockTransport handler that records every request and answers from a queue or a router."""

    def __init__(self, *responses: Any, router=None):
        self.responses = list(responses)
        self.router = router
        self.calls: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        if self.router:
            return self.router(request)
        answer = self.responses.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


def client(handler: Recorder, **opts: Any) -> ImageStep:
    opts = {"max_retries": 0, **opts}
    return ImageStep("is_sk_test", base_url="https://api.test", transport=httpx.MockTransport(handler), **opts)


def aclient(handler: Recorder, **opts: Any) -> AsyncImageStep:
    opts = {"max_retries": 0, **opts}
    return AsyncImageStep("is_sk_test", base_url="https://api.test", transport=httpx.MockTransport(handler), **opts)


# ───────────────────────────────────── request contract ─────────────────────────────────────


def test_sends_apikey_header_unwraps_envelope_and_adds_idempotency_key_to_writes():
    rec = Recorder(envelope({"id": "job_1"}))
    job = client(rec).jobs.submit({"type": "process", "presetId": "p", "assetIds": ["a"]})
    assert job["id"] == "job_1"
    req = rec.calls[0]
    assert str(req.url) == "https://api.test/api/v1/jobs"
    assert req.headers["Authorization"] == "ApiKey is_sk_test"
    assert UUID_RE.match(req.headers["Idempotency-Key"])
    assert req.headers["Content-Type"] == "application/json"
    assert req.headers["User-Agent"].startswith("imagestep-python/")


def test_gets_carry_no_idempotency_key_and_list_returns_items_plus_meta():
    rec = Recorder(envelope([{"id": "a1"}], {"total": 1, "page": 0, "perPage": 12, "hasMore": False}))
    items, meta = client(rec).assets.list(collection="shoot", per_page=12)
    assert len(items) == 1
    assert meta["total"] == 1
    req = rec.calls[0]
    assert str(req.url) == "https://api.test/api/v1/assets?collection=shoot&perPage=12"
    assert "Idempotency-Key" not in req.headers


def test_maps_an_error_body_to_imagestep_error():
    rec = Recorder(error_response(400, {"code": "invalid_param", "message": "width must be between 1 and 16384", "retryable": False, "param": "width"}))
    with pytest.raises(ImageStepError) as excinfo:
        client(rec).ops.resize("a1", {"width": 0})
    err = excinfo.value
    assert err.status == 400
    assert err.code == "invalid_param"
    assert err.param == "width"
    assert err.retryable is False
    assert "16384" in str(err)
    assert len(rec.calls) == 1


def test_error_carries_the_request_id_from_the_body_else_the_header():
    body = Recorder(error_response(404, {"code": "job_not_found", "message": "no", "retryable": False, "requestId": "req-body"}, {"X-Request-Id": "req-header"}))
    with pytest.raises(ImageStepError) as excinfo:
        client(body).jobs.get("j")
    assert excinfo.value.request_id == "req-body"

    # A body that is not the contract's (a proxy's HTML 502) still has the header.
    header_only = Recorder(httpx.Response(502, text="<html>bad gateway</html>", headers={"X-Request-Id": "req-header"}))
    with pytest.raises(ImageStepError) as excinfo:
        client(header_only).jobs.get("j")
    assert excinfo.value.request_id == "req-header"


@pytest.mark.parametrize("status, retryable", [(502, True), (429, True), (404, False)])
def test_an_answer_without_an_envelope_is_retryable_as_a_429_or_a_5xx(status, retryable):
    # #568: the JS SDK's rule — Python counted only a 5xx, so a bare 429 from a proxy was final.
    rec = Recorder(httpx.Response(status, text="<h1>proxy</h1>", headers={"content-type": "text/html"}))
    with pytest.raises(ImageStepError) as excinfo:
        client(rec).jobs.get("j")
    assert (excinfo.value.status, excinfo.value.retryable) == (status, retryable)


def test_retries_a_retryable_error_honouring_retry_after_with_the_same_idempotency_key():
    rec = Recorder(
        error_response(429, {"code": "rate_limited", "message": "slow down", "retryable": True}, {"Retry-After": "0"}),
        envelope({"id": "job_2"}),
    )
    job = client(rec, max_retries=1).ops.remove_bg("a1")
    assert job["id"] == "job_2"
    assert len(rec.calls) == 2
    assert rec.calls[0].headers["Idempotency-Key"] == rec.calls[1].headers["Idempotency-Key"]
    assert rec.calls[0].content == rec.calls[1].content


def test_retention_days_rides_in_the_body_of_every_call_that_makes_assets():
    # #591: how long to keep what a call makes is the caller's to shorten.
    rec = Recorder(envelope({"id": "job_1"}), envelope({"id": "job_2"}), envelope([{"url": "https://x.test/a.png", "id": "ast_1", "status": "DONE"}]))
    c = client(rec)
    c.ops.run("resize", asset_ids="a1", parameters={"width": 10}, retention_days=7)
    c.presets.run("web-optimize", "a1", retention_days=7)
    c.assets.from_url(["https://x.test/a.png"], retention_days=7, wait=False)
    assert [json.loads(call.content)["retentionDays"] for call in rec.calls] == [7, 7, 7]


def test_a_refusal_for_credit_is_sent_once_and_carries_the_top_up_link():
    # #589: a wall answers with what clears it, and the error hands it to the caller untouched.
    details = {"requiredCredits": 20, "topUpUrl": "https://imagestep.dev/usage/credits"}
    rec = Recorder(error_response(402, {"code": "insufficient_credit", "message": "Not enough credit", "retryable": False, "details": details}))
    with pytest.raises(ImageStepError) as excinfo:
        client(rec, max_retries=3).ops.run("resize", asset_ids=["a1"])
    assert excinfo.value.code == "insufficient_credit"
    assert excinfo.value.retryable is False
    assert excinfo.value.details == details
    assert len(rec.calls) == 1


def test_does_not_retry_a_non_retryable_error():
    rec = Recorder(error_response(402, {"code": "insufficient_credit", "message": "no", "retryable": False}))
    with pytest.raises(ImageStepError) as excinfo:
        client(rec, max_retries=3).ops.generate("x")
    assert excinfo.value.code == "insufficient_credit"
    assert len(rec.calls) == 1


def test_retries_a_transport_error_then_gives_up_with_the_httpx_exception(monkeypatch):
    waits: list[float] = []
    monkeypatch.setattr(client_module.time, "sleep", waits.append)
    rec = Recorder(httpx.ConnectError("refused"), envelope({"id": "j"}))
    assert client(rec, max_retries=1).jobs.get("j")["id"] == "j"
    assert len(rec.calls) == 2

    rec = Recorder(httpx.ReadTimeout("slow"), httpx.ReadTimeout("slow"))
    with pytest.raises(httpx.ReadTimeout):
        client(rec, max_retries=1).jobs.get("j")
    assert len(rec.calls) == 2
    assert waits == [0.25, 0.25]  # the transport backoff, not slept for real


def test_non_envelope_json_and_204_pass_through():
    rec = Recorder(httpx.Response(200, json={"status": "ok"}), httpx.Response(204))
    c = client(rec)
    assert c.get("/health").data == {"status": "ok"}
    assert c.delete("/api/v1/jobs/j").data is None


def test_a_caller_supplied_idempotency_key_is_sent_verbatim():
    rec = Recorder(envelope({"id": "j"}))
    client(rec).ops.run("upscale", asset_ids="a", idempotency_key="order-42")
    assert rec.calls[0].headers["Idempotency-Key"] == "order-42"


# ──────────────────────────────────────────── ops ────────────────────────────────────────────


def test_run_posts_the_op_vocabulary_and_dry_run_goes_to_dryrun_true():
    rec = Recorder(envelope({"totalItems": 2, "estimatedCredits": 60}))
    est = client(rec).ops.estimate("upscale", asset_ids=["a", "b"], parameters={"scaleFactor": 2})
    assert est["estimatedCredits"] == 60
    req = rec.calls[0]
    assert str(req.url) == "https://api.test/api/v1/jobs?dryRun=true"
    assert json.loads(req.content) == {"op": "upscale", "assetIds": ["a", "b"], "parameters": {"scaleFactor": 2}}


def test_generate_and_collection_map_to_the_wire_names():
    rec = Recorder(envelope({"id": "j"}))
    client(rec).ops.generate("a red bicycle", count=2, collection="shots")
    assert json.loads(rec.calls[0].content) == {"op": "generate", "prompt": "a red bicycle", "count": 2, "collection": "shots"}


def test_set_collection_sends_the_name_and_none_takes_the_assets_out():
    rec = Recorder(envelope([{"id": "a"}]), envelope([{"id": "a"}]))
    c = client(rec)
    c.assets.set_collection("a", "shoot-01")
    c.assets.set_collection(["a", "b"], None)
    assert [json.loads(r.content) for r in rec.calls] == [
        {"ids": ["a"], "collection": "shoot-01"},
        {"ids": ["a", "b"], "collection": ""},
    ]


def test_collections_lists_with_the_filter_and_rename_moves_them_none_meaning_out():
    rec = Recorder(
        envelope([{"collection": "shoot-01", "count": 2, "lastCreatedAt": 1}], {"total": 1, "page": 0, "perPage": 20, "hasMore": False}),
        envelope({"from": "shoot-01", "updated": 2}),
    )
    c = client(rec)
    items, meta = c.assets.collections(q="shoot", per_page=20)
    assert items[0]["count"] == 2 and meta["total"] == 1
    c.assets.rename_collection("shoot-01", None, idempotency_key="k1")
    assert str(rec.calls[0].url) == "https://api.test/api/v1/assets/collections?q=shoot&perPage=20"
    assert str(rec.calls[1].url) == "https://api.test/api/v1/assets/collections/rename"
    assert json.loads(rec.calls[1].content) == {"from": "shoot-01", "to": ""}
    assert rec.calls[1].headers["Idempotency-Key"] == "k1"


def test_preset_run_sends_the_collection_the_outputs_go_in():
    rec = Recorder(envelope({"id": "j"}))
    client(rec).presets.run("web-optimize@1", ["a"], collection="shots")
    assert json.loads(rec.calls[0].content) == {"presetId": "web-optimize@1", "assetIds": ["a"], "collection": "shots"}


def test_wait_polls_the_job_to_completed_and_raises_on_failed():
    rec = Recorder(
        envelope({"id": "j", "status": "PENDING"}),
        envelope({"id": "j", "status": "PROCESSING"}),
        envelope({"id": "j", "status": "COMPLETED", "items": [{"status": "COMPLETED", "resultAssetId": "out"}]}),
    )
    seen: list[str] = []
    job = client(rec).ops.remove_bg("a1", wait={"interval": 0, "on_progress": lambda j: seen.append(j["status"])})
    assert job["status"] == "COMPLETED"
    assert seen == ["PENDING", "PROCESSING", "COMPLETED"]
    # The SERVICE waits (imagestep#355): on the submit — 60 s is its ceiling — and on every read after it.
    assert json.loads(rec.calls[0].content) == {"op": "remove_bg", "assetIds": ["a1"], "wait": 60}
    assert [str(call.url) for call in rec.calls[1:]] == ["https://api.test/api/v1/jobs/j?wait=60"] * 2

    failing = Recorder(envelope({"id": "k", "status": "PENDING"}), envelope({"id": "k", "status": "FAILED"}))
    with pytest.raises(JobFailedError) as excinfo:
        client(failing).ops.remove_bg("a1", wait={"interval": 0})
    assert excinfo.value.job["status"] == "FAILED"


def test_wait_asks_again_after_a_read_turned_away_for_now(monkeypatch):
    # #568: a 429 rate_limited (the account's share of open waits, contract §5.1) or a 503 ended the wait at once;
    # the JS SDK asks again after the Retry-After for as long as the wait has left.
    waits: list[float] = []
    monkeypatch.setattr(client_module.time, "sleep", waits.append)
    busy = error_response(429, {"code": "rate_limited", "message": "too many waits", "retryable": True}, {"Retry-After": "3"})
    rec = Recorder(busy, httpx.Response(503), envelope({"id": "j", "status": "COMPLETED"}))
    assert client(rec).jobs.wait("j", interval=0.5)["status"] == "COMPLETED"
    assert len(rec.calls) == 3
    assert waits[:2] == [3.0, 0.5]  # the Retry-After, then the interval for an answer that named none

    gone = Recorder(error_response(404, {"code": "job_not_found", "message": "no such job", "retryable": False}))
    with pytest.raises(ImageStepError) as excinfo:
        client(gone).jobs.wait("j", interval=0)
    assert excinfo.value.code == "job_not_found" and len(gone.calls) == 1

    lenient = Recorder(envelope({"id": "k", "status": "CANCELLED"}))
    assert client(lenient).jobs.wait("k", interval=0, throw_on_failure=False)["status"] == "CANCELLED"


def test_a_job_finished_at_the_submit_costs_no_read_and_wait_is_never_sent_unasked():
    done = Recorder(envelope({"id": "j", "status": "COMPLETED", "items": []}))
    assert client(done).presets.run("web-optimize", "a1", wait=True)["status"] == "COMPLETED"
    assert len(done.calls) == 1
    assert json.loads(done.calls[0].content) == {"presetId": "web-optimize", "assetIds": ["a1"], "wait": 60}

    short = Recorder(envelope({"id": "j", "status": "COMPLETED"}))
    client(short).ops.remove_bg("a1", wait={"timeout": 8})
    assert json.loads(short.calls[0].content)["wait"] == 8

    plain = Recorder(envelope({"id": "j", "status": "PENDING"}))
    client(plain).ops.remove_bg("a1")
    assert json.loads(plain.calls[0].content) == {"op": "remove_bg", "assetIds": ["a1"]}

    dry = Recorder(envelope({"totalItems": 1}))
    client(dry).ops.remove_bg("a1", dry_run=True, wait=True)
    assert str(dry.calls[0].url) == "https://api.test/api/v1/jobs?dryRun=true"
    assert "wait" not in json.loads(dry.calls[0].content)


def test_outputs_is_one_paged_listing_of_the_run_in_item_order():
    """imagestep#441 — the run's products come from `GET /assets?jobId=`, not one GET per item."""
    rec = Recorder(
        envelope([{"id": "o2"}], {"total": 2, "page": 0, "perPage": 1, "hasMore": True, "nextCursor": "c1"}),
        envelope([{"id": "o1"}], {"perPage": 1, "hasMore": False, "nextCursor": None}),
    )
    job = {"id": "j1", "items": [{"resultAssetId": "o1"}, {"status": "FAILED"}, {"resultAssetId": "o2"}]}

    assert [a["id"] for a in client(rec).jobs.outputs(job)] == ["o1", "o2"]
    assert len(rec.calls) == 2, "two pages, not one request per item"
    assert rec.calls[0].url.params["jobId"] == "j1"
    assert "/api/v1/assets" in str(rec.calls[0].url)


def test_outputs_skips_an_output_deleted_since_the_run():
    rec = Recorder(envelope([{"id": "o1"}], {"total": 1, "page": 0, "perPage": 100, "hasMore": False}))
    job = {"id": "j1", "items": [{"resultAssetId": "gone"}, {"resultAssetId": "o1"}]}
    assert [a["id"] for a in client(rec).jobs.outputs(job)] == ["o1"]


def test_read_metadata_is_a_get_on_the_asset_never_a_job():
    rec = Recorder(envelope({"id": "a1", "image": {"width": 10}, "metadata": {"exif": {}}}))
    m = client(rec).ops.read_metadata("a1")
    assert m["image"]["width"] == 10
    assert str(rec.calls[0].url) == "https://api.test/api/v1/assets/a1"
    assert rec.calls[0].method == "GET"


def test_a_job_has_no_mode_to_choose():
    """imagestep#331: every output is a new asset, so `mode` is not a keyword any more — passing it is a TypeError
    here rather than a 400 from the service."""
    rec = Recorder(envelope({"id": "j"}))
    with pytest.raises(TypeError):
        client(rec).ops.run("resize", asset_ids="a1", mode="REPLACE_MEDIA")
    with pytest.raises(TypeError):
        client(rec).presets.run("web-optimize", "a1", mode="NEW_MEDIA")
    assert rec.calls == []


def test_presets_run_leaves_the_job_type_to_the_preset():
    rec = Recorder(envelope({"id": "j"}))
    client(rec).presets.run("preset-1@2", "a1")
    assert json.loads(rec.calls[0].content) == {"presetId": "preset-1@2", "assetIds": ["a1"]}


def test_presets_run_sends_this_runs_prompt_and_count():
    """imagestep#461 — a consistency preset is the same subject, a new scene each run: the scene is the run's prompt."""
    rec = Recorder(envelope({"id": "j"}), envelope({"id": "j2"}))
    client(rec).presets.run("bottle-shots@2", [], prompt="{{subject.bottle}} on a beach at dusk", count=3)
    client(rec).presets.run("bottle-shots", [])
    assert json.loads(rec.calls[0].content) == {
        "presetId": "bottle-shots@2",
        "assetIds": [],
        "prompt": "{{subject.bottle}} on a beach at dusk",
        "count": 3,
    }
    assert json.loads(rec.calls[1].content) == {"presetId": "bottle-shots", "assetIds": []}


async def test_async_presets_run_sends_this_runs_prompt_and_count():
    rec = Recorder(envelope({"id": "j"}))
    await aclient(rec).presets.run("bottle-shots", [], prompt="{{subject.bottle}} in the snow", count=2)
    assert json.loads(rec.calls[0].content) == {
        "presetId": "bottle-shots",
        "assetIds": [],
        "prompt": "{{subject.bottle}} in the snow",
        "count": 2,
    }


def test_presets_routes_every_call_at_the_one_resource():
    """imagestep#247 — create → update → run @1, and the version rides on the path, never re-parsed here."""
    rec = Recorder(
        envelope({"id": "pre_1", "slug": "web-optimize", "version": 1}),
        envelope({"id": "pre_1", "slug": "web-optimize", "version": 2}),
        envelope([{"slug": "web-optimize"}]),
        envelope({"slug": "web-optimize", "version": 1, "steps": [{"op": "resize", "parameters": {"width": 1600}}]}),
        envelope({"id": "j"}),
        envelope(None),
    )
    c = client(rec)
    steps = [{"op": "resize", "parameters": {"width": 1600}}, {"operation": "sharpen", "params": {"sigma": 0.5}}]

    created = c.presets.create({"name": "web-optimize", "steps": steps})
    updated = c.presets.update("web-optimize", {"name": "web-optimize", "steps": steps[:1]})
    c.presets.list("user")
    pinned = c.presets.get("web-optimize@1")
    c.presets.run("web-optimize@1", ["a1", "a2"])
    c.presets.delete_version("web-optimize", 2)

    assert created["version"] == 1
    assert updated["version"] == 2, "new steps are a new version"
    assert pinned["steps"] == [{"op": "resize", "parameters": {"width": 1600}}]
    assert [(r.method, str(r.url)) for r in rec.calls] == [
        ("POST", "https://api.test/api/v1/presets"),
        ("PUT", "https://api.test/api/v1/presets/web-optimize"),
        ("GET", "https://api.test/api/v1/presets?filter=user"),
        ("GET", "https://api.test/api/v1/presets/web-optimize@1"),
        ("POST", "https://api.test/api/v1/jobs"),
        # imagestep#445 — one stored version, on its own path segment rather than as an `@` on the slug.
        ("DELETE", "https://api.test/api/v1/presets/web-optimize/versions/2"),
    ]
    assert json.loads(rec.calls[0].content)["steps"] == steps
    assert json.loads(rec.calls[4].content) == {"presetId": "web-optimize@1", "assetIds": ["a1", "a2"]}


def test_a_chain_estimate_comes_back_with_its_per_segment_detail():
    """imagestep#246 / #247 — the dry run of a multi-segment preset is priced step by step (contract §5)."""
    rec = Recorder(
        envelope(
            {
                "type": "chain",
                "totalItems": 2,
                "costPerItem": 400,
                "estimatedCredits": 800,
                "creditBalance": 5000,
                "sufficientCredit": True,
                "assetCountLeft": 100,
                "processPerItem": 1,
                "steps": [
                    {"index": 0, "op": "remove_bg", "model": "fal-ai/bria/background/remove", "costPerItem": 200},
                    {"index": 1, "op": "process", "costPerItem": 0},
                    {"index": 2, "op": "upscale", "model": "fal-ai/clarity-upscaler", "costPerItem": 200, "bound": True},
                ],
            }
        )
    )

    estimate = client(rec).presets.run("cut-out@2", ["a1", "a2"], dry_run=True)

    assert str(rec.calls[0].url) == "https://api.test/api/v1/jobs?dryRun=true"
    assert estimate["type"] == "chain"
    assert sum(step["costPerItem"] for step in estimate["steps"]) == estimate["costPerItem"]
    assert estimate["steps"][2]["bound"] is True


def test_presets_create_sends_the_idempotency_key_it_was_given():
    """imagestep#316 — without it a retried save is a SECOND preset, and MCP's save_preset retries."""
    rec = Recorder(envelope({"id": "pst_1", "version": 1}))

    client(rec).presets.create({"name": "web-optimize"}, idempotency_key="key-42")

    assert rec.calls[0].headers["idempotency-key"] == "key-42"


def test_images_keeps_its_shared_shapes_private():
    """imagestep#316 — `_ImagesCore`'s staticmethods were inherited as PUBLIC names on client.images."""
    images = client(Recorder()).images
    assert not [name for name in dir(images) if not name.startswith("_") and name not in vars(type(images))]


# ─────────────────────────────────────── assets.upload ───────────────────────────────────────


def upload_router(exists: bool = False, existing_id: str | None = None):
    def route(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/stage-upload"):
            stage = {"objectId": "obj-1", "url": "https://bucket/obj-1?sig", "exists": exists}
            if existing_id:
                stage["existingAssetId"] = existing_id
            return envelope([stage])
        if url.endswith("/assets/ast_old"):
            return envelope({"id": "ast_old", "status": "DONE"})
        if url.startswith("https://bucket/"):
            return httpx.Response(200)
        if url.endswith("/finish-upload"):
            return envelope([{"id": "ast_1", "status": "PROCESSING"}])
        if url.endswith("/assets/status"):
            return envelope({"items": [{"id": "ast_1", "status": "DONE"}]})
        if url.endswith("/assets/ast_1"):
            return envelope({"id": "ast_1", "status": "DONE", "image": {"width": 2}})
        raise AssertionError("unexpected " + url)

    return route


def test_upload_stages_puts_the_bytes_with_the_mime_type_finishes_and_waits_for_done():
    rec = Recorder(router=upload_router())
    png = bytes([137, 80, 78, 71])
    asset = client(rec).assets.upload(png, name="pixel.png", collection="smoke", tags=["hero"])
    assert asset["status"] == "DONE"

    stage = json.loads(rec.calls[0].content)[0]
    assert stage["fileName"] == "pixel.png" and stage["fileSize"] == 4
    assert stage["sha1Hash"] == hashlib.sha1(png).hexdigest()

    put = rec.calls[1]
    assert put.method == "PUT" and str(put.url) == "https://bucket/obj-1?sig"
    assert put.headers["Content-Type"] == "image/png"
    assert put.content == png
    assert "Authorization" not in put.headers

    finish = json.loads(rec.calls[2].content)[0]
    # #232: the object, the name, the label and the tags (#334) — nothing the service can work out for itself.
    assert set(finish) == {"objectId", "name", "collection", "tags"} and finish["name"] == "pixel.png" and finish["collection"] == "smoke"
    assert finish["tags"] == ["hero"]
    # #233: one batch-status poll, then one read of the whole asset
    assert rec.calls[3].method == "POST" and str(rec.calls[3].url).endswith("/assets/status")
    assert rec.calls[4].method == "GET" and str(rec.calls[4].url).endswith("/assets/ast_1")


def test_upload_reuses_the_existing_asset_when_the_bytes_were_ingested_before():
    rec = Recorder(router=upload_router(exists=True, existing_id="ast_old"))
    asset = client(rec).assets.upload(b"\x01\x02\x03", name="x.jpg", wait=False)
    assert asset["id"] == "ast_old"
    assert not any(r.method == "PUT" for r in rec.calls)
    assert [str(r.url).rsplit("/", 1)[-1] for r in rec.calls] == ["stage-upload", "ast_old"]


def test_upload_always_puts_when_a_fresh_copy_is_wanted():
    # `exists` alone means the caller has the bytes somewhere; the presigned slot is still empty.
    rec = Recorder(router=upload_router(exists=True, existing_id="ast_old"))
    client(rec).assets.upload(b"\x01\x02\x03", name="x.jpg", wait=False, reuse_existing=False)
    assert any(r.method == "PUT" for r in rec.calls)
    assert [str(r.url).rsplit("/", 1)[-1] for r in rec.calls][-1] == "finish-upload"


def test_upload_reads_a_path_and_a_binary_file_object(tmp_path):
    photo = tmp_path / "photo.JPG"
    photo.write_bytes(b"jpegbytes")

    rec = Recorder(router=upload_router())
    client(rec).assets.upload(photo, wait=False)
    assert json.loads(rec.calls[0].content)[0]["fileName"] == "photo.JPG"
    assert rec.calls[1].headers["Content-Type"] == "image/jpeg"

    rec = Recorder(router=upload_router())
    with open(photo, "rb") as f:
        client(rec).assets.upload(f, wait=False)
    assert json.loads(rec.calls[0].content)[0]["fileName"] == "photo.JPG"

    with pytest.raises(TypeError):
        client(Recorder()).assets.upload(42)


def test_upload_surfaces_a_stage_error_and_a_failed_put():
    rec = Recorder(envelope([{"error": "file too large"}]))
    with pytest.raises(ImageStepError) as excinfo:
        client(rec).assets.upload(b"x", name="big.png")
    assert excinfo.value.code == "invalid_param" and excinfo.value.param == "file"

    def route(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/stage-upload"):
            return envelope([{"objectId": "obj-1", "url": "https://bucket/obj-1", "exists": False}])
        return httpx.Response(403)

    with pytest.raises(ImageStepError) as excinfo:
        client(Recorder(router=route)).assets.upload(b"x", name="x.png")
    assert excinfo.value.status == 403 and excinfo.value.retryable is True


# ────────────────────────────────────────── async ──────────────────────────────────────────


async def test_async_client_has_the_same_request_contract():
    rec = Recorder(
        error_response(429, {"code": "rate_limited", "message": "slow down", "retryable": True}, {"Retry-After": "0"}),
        envelope({"id": "job_2"}),
    )
    async with aclient(rec, max_retries=1) as c:
        job = await c.ops.remove_bg("a1")
    assert job["id"] == "job_2"
    assert len(rec.calls) == 2
    assert rec.calls[0].headers["Authorization"] == "ApiKey is_sk_test"
    assert rec.calls[0].headers["Idempotency-Key"] == rec.calls[1].headers["Idempotency-Key"]


async def test_async_wait_and_outputs():
    rec = Recorder(
        envelope({"id": "j", "status": "PENDING"}),
        envelope({"id": "j", "status": "COMPLETED", "items": [{"resultAssetId": "out"}]}),
        # The outputs are one listing of the run now (imagestep#441), not a GET per item.
        envelope([{"id": "out", "status": "DONE"}], {"total": 1, "page": 0, "perPage": 100, "hasMore": False}),
    )
    seen: list[str] = []

    async def progress(job):
        seen.append(job["status"])

    c = aclient(rec)
    job = await c.ops.upscale("a1", wait={"interval": 0, "on_progress": progress})
    outputs = await c.jobs.outputs(job)
    assert seen == ["PENDING", "COMPLETED"]
    assert outputs[0]["id"] == "out"
    assert json.loads(rec.calls[0].content)["wait"] == 60 and str(rec.calls[1].url).endswith("/api/v1/jobs/j?wait=60")

    failing = Recorder(envelope({"id": "k", "status": "FAILED"}))
    with pytest.raises(JobFailedError):
        await aclient(failing).jobs.wait("k", interval=0)

    busy = error_response(429, {"code": "rate_limited", "message": "too many waits", "retryable": True}, {"Retry-After": "0"})
    rec = Recorder(busy, envelope({"id": "j", "status": "COMPLETED"}))
    assert (await aclient(rec).jobs.wait("j", interval=0))["status"] == "COMPLETED"
    assert len(rec.calls) == 2


async def test_async_upload_and_error_mapping():
    rec = Recorder(router=upload_router())
    asset = await aclient(rec).assets.upload(b"\x89PNG", name="pixel.png")
    assert asset["status"] == "DONE"
    assert rec.calls[1].method == "PUT" and rec.calls[1].headers["Content-Type"] == "image/png"

    rec = Recorder(error_response(404, {"code": "asset_not_found", "message": "gone", "retryable": False}))
    with pytest.raises(ImageStepError) as excinfo:
        await aclient(rec).assets.get("nope")
    assert excinfo.value.code == "asset_not_found"


# ───────────────────────────────────────── webhooks ─────────────────────────────────────────


def sign(body: str, secret: str, t: int) -> str:
    mac = hmac.new(secret.encode(), f"{t}.{body}".encode(), hashlib.sha256).hexdigest()
    return f"t={t},v1={mac}"


def test_verifies_a_good_signature_and_rejects_a_tampered_body_or_a_stale_timestamp():
    body = json.dumps({"id": "evt_1", "type": "job.completed", "createdAt": "2026-09-08T00:00:00Z", "data": {"jobId": "j"}})
    now = 1_800_000_000
    header = sign(body, "whsec_x", now)
    assert verify_webhook_signature(body, header, "whsec_x", now=now) is True
    assert verify_webhook_signature(body.encode(), header, "whsec_x", now=now) is True
    assert verify_webhook_signature(body + " ", header, "whsec_x", now=now) is False
    assert verify_webhook_signature(body, header, "whsec_x", now=now + 3600) is False
    assert verify_webhook_signature(body, "garbage", "whsec_x", now=now) is False
    assert verify_webhook_signature(body, None, "whsec_x", now=now) is False

    event = construct_webhook_event(body, header, "whsec_x", now=now)
    assert event["type"] == "job.completed"
    with pytest.raises(WebhookSignatureError, match="signature"):
        construct_webhook_event(body, header, "whsec_other", now=now)

    c = client(Recorder())
    assert c.webhooks.verify(body, header, "whsec_x", now=now) is True
    assert c.webhooks.construct_event(body, header, "whsec_x", now=now)["id"] == "evt_1"
    assert AsyncImageStep("k", base_url="https://api.test").webhooks.verify(body, header, "whsec_x", now=now) is True


def test_a_missing_webhook_secret_raises_instead_of_verifying_a_forgery():
    # #479: with secret="" the HMAC is one anybody can compute, so a receiver whose env var was unset accepted it.
    body, now = "{}", 1_800_000_000
    forged = sign(body, "", now)
    for secret in ("", None, b""):
        with pytest.raises(ValueError, match="secret"):
            verify_webhook_signature(body, forged, secret, now=now)  # type: ignore[arg-type]
        with pytest.raises(ValueError, match="secret"):
            construct_webhook_event(body, forged, secret, now=now)  # type: ignore[arg-type]


def test_webhooks_create_drops_unset_fields():
    rec = Recorder(envelope({"id": "wh_1", "secret": "whsec_once"}))
    client(rec).webhooks.create("https://example.com/hook", events=["job.completed"])
    assert json.loads(rec.calls[0].content) == {"url": "https://example.com/hook", "events": ["job.completed"]}


# ── the synchronous face (#81) ────────────────────────────────────────────────────────────────


def _ops_body(sync_endpoint="POST /api/v1/images/transform"):
    return {
        "success": True,
        "data": [
            {"op": "resize", "kind": "deterministic", "syncEndpoint": sync_endpoint},
            {"op": "generate", "kind": "ai", "syncEndpoint": None},
        ],
    }


def test_images_transform_returns_bytes_and_sends_no_idempotency_key():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if "/ops" in str(request.url):
            return httpx.Response(200, json=_ops_body())
        seen["url"] = str(request.url)
        seen["headers"] = dict(request.headers)
        return httpx.Response(200, content=b"\x01\x02", headers={"content-type": "image/webp"})

    with ImageStep("k", transport=httpx.MockTransport(handler)) as client:
        out = client.images.transform("resize", file=b"\x09", parameters={"width": 40})

    assert out == b"\x01\x02"
    assert "op=resize" in seen["url"] and "width=40" in seen["url"]
    # Contract §9: the synchronous endpoints are the documented exception to idempotency keys.
    assert "idempotency-key" not in seen["headers"]


def test_images_transform_never_reads_a_file_named_among_the_parameters(monkeypatch):
    # #470: one keyword namespace for the input and the op's parameters meant `transform(op, **bag)` over a bag the
    # caller did not write could name a local file for this process to read. A parameter is only ever a query value.
    import imagestep.client as client_module

    reads = []
    real = client_module._read_source
    monkeypatch.setattr(client_module, "_read_source", lambda *a: reads.append(a) or real(*a))
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if "/ops" in str(request.url):
            return httpx.Response(200, json=_ops_body())
        seen.setdefault("url", request.url)
        seen.setdefault("body", request.content)
        return httpx.Response(200, content=b"\x01", headers={"content-type": "image/webp"})

    with ImageStep("k", transport=httpx.MockTransport(handler)) as client:
        client.images.transform("resize", url="https://e.dev/a.jpg", parameters={"file": "/etc/hostname", "width": 4})
        seen["body"] = json.loads(seen["body"])
        assert reads == []
        assert seen["body"] == {"url": "https://e.dev/a.jpg"}
        assert seen["url"].params["file"] == "/etc/hostname"
        # The seam: the same spy does see a path given as the input.
        client.images.transform("resize", file=__file__, parameters={"width": 4})
        assert len(reads) == 1

        with pytest.raises(TypeError):
            client.images.transform("resize", file=b"\x09", width=40)  # type: ignore[call-arg]


def test_images_transform_refuses_a_parameter_named_after_a_query_key():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json=_ops_body())

    with ImageStep("k", transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(ImageStepError) as err:
            client.images.transform("resize", file=b"\x09", parameters={"response": "url"})
    assert err.value.code == "invalid_param"
    assert err.value.param == "parameters.response"
    assert not [c for c in calls if "/images/" in str(c.url)]


def test_images_asks_the_catalogue_rather_than_carrying_its_own_list():
    def handler(request: httpx.Request) -> httpx.Response:
        if "/ops" in str(request.url):
            return httpx.Response(200, json=_ops_body(sync_endpoint=None))
        raise AssertionError("must not send a request the catalogue says is not synchronous")

    with ImageStep("k", transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(ImageStepError) as excinfo:
            client.images.transform("resize", file=b"\x09")

    assert excinfo.value.code == "invalid_param"
    assert "client.ops.run" in str(excinfo.value)


def test_images_refuses_an_ai_op():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_ops_body())

    with ImageStep("k", transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(ImageStepError):
            client.images.transform("generate", file=b"\x09")


def test_images_error_envelope_becomes_a_typed_error():
    def handler(request: httpx.Request) -> httpx.Response:
        if "/ops" in str(request.url):
            return httpx.Response(200, json=_ops_body())
        return httpx.Response(
            413,
            json={
                "success": False,
                "error": {"code": "payload_too_large", "message": "too big", "retryable": False,
                          "details": {"limit": 100}},
            },
        )

    with ImageStep("k", transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(ImageStepError) as excinfo:
            client.images.transform("resize", file=b"\x09")

    assert excinfo.value.status == 413
    assert excinfo.value.code == "payload_too_large"
    assert excinfo.value.retryable is False
    assert excinfo.value.details["limit"] == 100


def test_images_retries_a_retryable_refusal_and_honours_retry_after():
    # §9's premise — the input is still in your hand, so re-sending costs nothing and creates
    # nothing — is what makes this the path that SHOULD retry; it was the only one that did not
    # (#98). The body is already bytes here, so a replay is exact.
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if "/ops" in str(request.url):
            return httpx.Response(200, json=_ops_body())
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(
                429,
                json={"success": False, "error": {"code": "rate_limited", "message": "slow", "retryable": True}},
                headers={"Retry-After": "0"},
            )
        return httpx.Response(200, content=b"\x01\x02", headers={"content-type": "image/webp"})

    with ImageStep("k", transport=httpx.MockTransport(handler)) as client:
        assert client.images.transform("resize", file=b"\x09") == b"\x01\x02"
    assert len(calls) == 2


def test_images_retries_a_proxy_answer_without_an_envelope():
    # #568: `bool(error.get("retryable"))` made an envelope-less 502 false, so `images.*` never retried a proxy.
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if "/ops" in str(request.url):
            return httpx.Response(200, json=_ops_body())
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(502, text="<html>bad gateway</html>", headers={"content-type": "text/html", "Retry-After": "0"})
        return httpx.Response(200, content=b"\x01", headers={"content-type": "image/webp"})

    with ImageStep("k", transport=httpx.MockTransport(handler)) as client:
        assert client.images.transform("resize", file=b"\x09") == b"\x01"
    assert len(calls) == 2


def test_images_gives_up_after_max_retries():
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if "/ops" in str(request.url):
            return httpx.Response(200, json=_ops_body())
        calls.append(request)
        return httpx.Response(
            503,
            json={"success": False, "error": {"code": "provider_unavailable", "retryable": True,
                                              "details": {"reason": "capacity"}}},
            headers={"Retry-After": "0"},
        )

    with ImageStep("k", max_retries=1, transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(ImageStepError) as excinfo:
            client.images.transform("resize", file=b"\x09")

    assert excinfo.value.code == "provider_unavailable"
    assert excinfo.value.retry_after == 0
    assert len(calls) == 2


def test_images_does_not_retry_what_a_retry_cannot_fix():
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if "/ops" in str(request.url):
            return httpx.Response(200, json=_ops_body())
        calls.append(request)
        return httpx.Response(400, json={"success": False, "error": {"code": "invalid_param", "retryable": False}})

    with ImageStep("k", transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(ImageStepError):
            client.images.transform("resize", file=b"\x09")
    assert len(calls) == 1


def test_images_sends_a_refusal_for_credit_once():
    # #592: past the allowance a sync call is paid; a balance that cannot pay is refused once — the body is the whole image.
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if "/ops" in str(request.url):
            return httpx.Response(200, json=_ops_body())
        calls.append(request)
        return httpx.Response(402, json={"success": False, "error": {"code": "insufficient_credit", "retryable": False}})

    with ImageStep("k", transport=httpx.MockTransport(handler), max_retries=3) as client:
        with pytest.raises(ImageStepError):
            client.images.transform("resize", file=b"\x09")
    assert len(calls) == 1


async def test_async_images_retries_the_same_way():
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if "/ops" in str(request.url):
            return httpx.Response(200, json=_ops_body())
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(
                503,
                json={"success": False, "error": {"code": "provider_unavailable", "retryable": True}},
                headers={"Retry-After": "0"},
            )
        return httpx.Response(200, content=b"OK", headers={"content-type": "image/webp"})

    async with AsyncImageStep("k", transport=httpx.MockTransport(handler)) as c:
        assert await c.images.transform("resize", file=b"\x09") == b"OK"
    assert len(calls) == 2


def test_images_metadata_returns_the_object():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["accept"] == "application/json"
        return httpx.Response(200, json={"success": True, "data": {"image": {"width": 5}}})

    with ImageStep("k", transport=httpx.MockTransport(handler)) as client:
        meta = client.images.metadata(b"\x09")

    assert meta["image"]["width"] == 5


def test_images_transform_result_keeps_what_the_service_measured():
    # `transform` answers "give me the bytes" and drops the rest, which left anyone who has to NAME
    # the result — an extension, a reported size — deriving it from the bytes again (#95).
    def handler(request: httpx.Request) -> httpx.Response:
        if "/ops" in str(request.url):
            return httpx.Response(200, json=_ops_body())
        return httpx.Response(
            200,
            content=b"\x01\x02",
            headers={"content-type": "image/webp", "X-ImageStep-Width": "40", "X-ImageStep-Height": "20"},
        )

    with ImageStep("k", transport=httpx.MockTransport(handler)) as client:
        result = client.images.transform_result("resize", file=b"\x09", parameters={"width": 40})

    assert result.content == b"\x01\x02"
    assert result.content_type == "image/webp"
    assert (result.width, result.height) == (40, 20)
    assert result.json is None


def test_images_transform_result_tolerates_a_service_that_measured_nothing():
    def handler(request: httpx.Request) -> httpx.Response:
        if "/ops" in str(request.url):
            return httpx.Response(200, json=_ops_body())
        return httpx.Response(200, content=b"\x01", headers={"content-type": "image/webp", "X-ImageStep-Width": ""})

    with ImageStep("k", transport=httpx.MockTransport(handler)) as client:
        result = client.images.transform_result("resize", file=b"\x09")
    assert (result.width, result.height) == (None, None)


def test_images_render_posts_the_template_and_one_row():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, content=b"PNG", headers={"content-type": "image/png"})

    with ImageStep("k", transport=httpx.MockTransport(handler)) as client:
        client.images.render("builtin-template-og-image", {"title": "hi"})

    assert seen["body"] == {"templateId": "builtin-template-og-image", "data": {"title": "hi"}}


# ── the synchronous face, awaited (#97) ───────────────────────────────────────────────────────
#
# `AsyncImageStep` had every namespace except `images`, so the one face that exists because a
# caller is holding an image and waiting for it back was reachable only from the client that
# blocks. These mirror the sync cases above rather than inventing new ones: the point is that the
# two clients answer the same, not that the async one works at all.


async def test_async_images_transform_returns_bytes_and_sends_no_idempotency_key():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if "/ops" in str(request.url):
            return httpx.Response(200, json=_ops_body())
        seen["url"] = str(request.url)
        seen["headers"] = dict(request.headers)
        return httpx.Response(200, content=b"\x01\x02", headers={"content-type": "image/webp"})

    async with AsyncImageStep("k", transport=httpx.MockTransport(handler)) as c:
        out = await c.images.transform("resize", file=b"\x09", parameters={"width": 40})

    assert out == b"\x01\x02"
    assert "op=resize" in seen["url"] and "width=40" in seen["url"]
    assert "idempotency-key" not in seen["headers"]


async def test_async_images_asks_the_catalogue_rather_than_carrying_its_own_list():
    def handler(request: httpx.Request) -> httpx.Response:
        if "/ops" in str(request.url):
            return httpx.Response(200, json=_ops_body(sync_endpoint=None))
        raise AssertionError("must not send a request the catalogue says is not synchronous")

    async with AsyncImageStep("k", transport=httpx.MockTransport(handler)) as c:
        assert await c.images.supports("resize") is False
        with pytest.raises(ImageStepError) as excinfo:
            await c.images.transform("resize", file=b"\x09")

    assert excinfo.value.code == "invalid_param"
    assert "client.ops.run" in str(excinfo.value)


async def test_async_images_error_envelope_becomes_a_typed_error():
    def handler(request: httpx.Request) -> httpx.Response:
        if "/ops" in str(request.url):
            return httpx.Response(200, json=_ops_body())
        return httpx.Response(
            413,
            json={"success": False, "error": {"code": "payload_too_large", "message": "too big",
                                              "retryable": False, "details": {"limit": 100}}},
        )

    async with AsyncImageStep("k", transport=httpx.MockTransport(handler)) as c:
        with pytest.raises(ImageStepError) as excinfo:
            await c.images.transform("resize", file=b"\x09")

    assert excinfo.value.status == 413
    assert excinfo.value.code == "payload_too_large"
    assert excinfo.value.details["limit"] == 100


async def test_async_images_metadata_and_render_and_reference_form():
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/ops"):
            return httpx.Response(200, json=_ops_body())
        if path.endswith("/metadata"):
            assert request.headers["accept"] == "application/json"
            return httpx.Response(200, json={"success": True, "data": {"image": {"width": 5}}})
        if path.endswith("/render"):
            assert json.loads(request.content) == {"templateId": "t1", "data": {"title": "hi"}}
            return httpx.Response(200, content=b"PNG", headers={"content-type": "image/png"})
        # transform, reference form: the input is a reference, so everything is in the body.
        assert json.loads(request.content) == {"assetId": "ast_1"}
        return httpx.Response(200, content=b"\x01", headers={"content-type": "image/webp"})

    async with AsyncImageStep("k", transport=httpx.MockTransport(handler)) as c:
        assert (await c.images.metadata(b"\x09"))["image"]["width"] == 5
        assert await c.images.render("t1", {"title": "hi"}) == b"PNG"
        assert await c.images.transform("resize", asset_id="ast_1", parameters={"width": 40}) == b"\x01"


def test_both_clients_expose_the_same_namespaces():
    # The README's promise is "same surface, every method awaitable" — a namespace missing from one
    # side is how that stops being true without any test noticing (#97).
    sync = {n for n in vars(ImageStep("k")) if not n.startswith("_") and n not in ("base_url", "timeout", "max_retries")}
    async_ = {n for n in vars(AsyncImageStep("k")) if not n.startswith("_") and n not in ("base_url", "timeout", "max_retries")}
    assert sync == async_
    for name in ("transform", "render", "metadata", "supports", "sync_endpoints"):
        assert hasattr(AsyncImageStep("k").images, name)


# ── the agent contract face (imagestep#127) ──────────────────────────────────────────────────
# It is on the client rather than left to a raw request because the contract's §7 asks an agent to
# report a gap instead of routing around it, and a rule whose only implementation is "build your own
# HTTP call" loses to the workaround.


def test_agent_reads_the_contract_from_the_public_endpoint():
    handler = Recorder(envelope({"version": 1, "updated": "2026-09-12", "markdown": "# Rules"}))

    guidelines = client(handler).agent.guidelines()

    assert guidelines["markdown"] == "# Rules"
    assert handler.calls[0].method == "GET"
    assert str(handler.calls[0].url) == "https://api.test/api/v1/agent-guidelines"


def test_agent_feedback_sends_only_the_fields_given_and_is_idempotent():
    handler = Recorder(envelope({"id": "fbk_1", "kind": "capability_gap"}))

    saved = client(handler).agent.feedback(
        kind="capability_gap", message="No such op; I need one.", op="detect_faces", context={"tried": "generate"}
    )

    assert saved["id"] == "fbk_1"
    request = handler.calls[0]
    assert str(request.url) == "https://api.test/api/v1/feedback"
    assert json.loads(request.content) == {
        "kind": "capability_gap",
        "message": "No such op; I need one.",
        "op": "detect_faces",
        "context": {"tried": "generate"},
    }
    assert request.headers["idempotency-key"]


def test_agent_feedback_omits_optional_fields_rather_than_sending_nulls():
    handler = Recorder(envelope({"id": "fbk_2"}))

    client(handler).agent.feedback(kind="bug", message="m")

    assert json.loads(handler.calls[0].content) == {"kind": "bug", "message": "m"}


def test_agent_reports_is_a_page_like_every_other_list():
    """imagestep#316 — it used to hand back the raw RequestResult, the one list method that did."""
    handler = Recorder(envelope([{"id": "fbk_1"}], {"total": 1, "page": 0, "perPage": 20, "hasNext": False}))

    page = client(handler).agent.reports(page=0, per_page=20)

    assert page.items == [{"id": "fbk_1"}]
    assert page.meta["total"] == 1
    assert str(handler.calls[0].url) == "https://api.test/api/v1/feedback?page=0&perPage=20"


@pytest.mark.asyncio
async def test_async_agent_reports_is_a_page_too():
    handler = Recorder(envelope([{"id": "fbk_1"}], {"total": 1}))

    page = await aclient(handler).agent.reports()

    assert page.items == [{"id": "fbk_1"}]
    assert page.meta["total"] == 1


def test_variants_reach_the_wire():
    """imagestep#152 — one call, one asset per variant. A named keyword drops silently if missing."""
    rec = Recorder(envelope({"id": "job_1", "status": "PENDING"}))
    client(rec).ops.run(
        "resize",
        asset_ids="a1",
        parameters={"fit": "cover"},
        variants=[{"name": "ig", "parameters": {"width": 1080}}],
    )
    body = json.loads(rec.calls[0].content)
    assert body["variants"] == [{"name": "ig", "parameters": {"width": 1080}}]
    assert body["parameters"] == {"fit": "cover"}, "the shared half still travels"


def test_from_url_lets_the_service_fetch_and_keeps_each_urls_outcome():
    def route(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/assets/from-url"):
            return envelope(
                [
                    {"url": "https://cdn.example/a.png", "id": "ast_1", "status": "PROCESSING"},
                    {"url": "http://10.0.0.7/x.png", "error": {"code": "invalid_param", "message": "private", "retryable": False, "param": "url"}},
                ]
            )
        if url.endswith("/assets/status"):
            return envelope({"items": [{"id": "ast_1", "status": "DONE"}]})
        if url.endswith("/assets/ast_1"):
            return envelope({"id": "ast_1", "status": "DONE"})
        raise AssertionError("unexpected " + url)

    rec = Recorder(router=route)
    out = client(rec).assets.from_url(["https://cdn.example/a.png", "http://10.0.0.7/x.png"], collection="shoot", tags=["hero"])

    assert json.loads(rec.calls[0].content) == {
        "urls": ["https://cdn.example/a.png", "http://10.0.0.7/x.png"],
        "collection": "shoot",
        "tags": ["hero"],
    }
    assert out[0] == {"url": "https://cdn.example/a.png", "asset": {"id": "ast_1", "status": "DONE"}}
    assert out[1]["error"]["param"] == "url"
    # one POST, one batch-status poll (#233) and one read: nothing fetched client-side, the failed URL is not polled
    assert len(rec.calls) == 3


def _ingesting_service(ticks: int = 1):
    """A service that answers from-url, stage-upload, storage PUTs, finish-upload, status and GET for any number of assets;
    every asset leaves PROCESSING on status tick `ticks`."""
    seen: dict[str, Any] = {"from_url": [], "status": 0, "get": 0, "stage": [], "put": 0, "finish": []}

    def route(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/assets/from-url"):
            urls = json.loads(request.content)["urls"]
            seen["from_url"].append(len(urls))
            return envelope([{"url": u, "id": "ast_" + u.rsplit("/", 1)[-1], "status": "PROCESSING"} for u in urls])
        if url.endswith("/assets/status"):
            seen["status"] += 1
            ids = json.loads(request.content)["ids"]
            status = "DONE" if seen["status"] >= ticks else "PROCESSING"
            return envelope({"items": [{"id": i, "status": status} for i in ids]})
        if url.endswith("/assets/stage-upload"):
            items = json.loads(request.content)
            seen["stage"].append(len(items))
            return envelope([{"objectId": f"obj{n}", "url": f"https://storage.test/obj{n}", "contentType": "image/png"} for n in range(len(items))])
        if url.startswith("https://storage.test/"):
            seen["put"] += 1
            return httpx.Response(200)
        if url.endswith("/assets/finish-upload"):
            items = json.loads(request.content)
            seen["finish"].append(len(items))
            return envelope([{"id": "ast_" + i["objectId"], "name": i["name"], "status": "PROCESSING"} for i in items])
        if "/assets/ast_" in url:
            seen["get"] += 1
            return envelope({"id": url.rsplit("/", 1)[-1], "status": "DONE"})
        raise AssertionError("unexpected " + url)

    return route, seen


def test_from_url_sends_twenty_to_a_request_and_waits_with_one_status_call_per_tick(monkeypatch):
    # #525: the service refuses more than twenty URLs whole; twenty ingesting assets were twenty polls a tick.
    monkeypatch.setattr(client_module.time, "sleep", lambda seconds: None)
    route, seen = _ingesting_service(ticks=3)
    urls = [f"https://cdn.example/{n}.png" for n in range(25)]
    out = client(Recorder(router=route)).assets.from_url(urls)
    assert seen["from_url"] == [20, 5]
    assert seen["status"] == 3
    assert seen["get"] == 25
    assert [r["url"] for r in out] == urls
    assert all(r["asset"]["status"] == "DONE" for r in out)


def test_upload_many_is_one_stage_one_finish_and_a_status_call_per_tick(tmp_path):
    paths = []
    for n in range(10):
        path = tmp_path / f"f{n}.png"
        path.write_bytes(bytes([n, 1, 2]))
        paths.append(path)
    route, seen = _ingesting_service(ticks=1)
    out = client(Recorder(router=route)).assets.upload_many(paths, concurrency=3, collection="shoot")
    assert seen["stage"] == [10]
    assert seen["put"] == 10
    assert seen["finish"] == [10]
    assert seen["status"] == 1
    assert [r["name"] for r in out] == [p.name for p in paths]
    assert all(r["asset"]["status"] == "DONE" for r in out)


def test_upload_many_keeps_a_refused_file_as_its_own_result():
    route, seen = _ingesting_service()

    def refusing(request: httpx.Request) -> httpx.Response:
        if str(request.url).endswith("/assets/stage-upload"):
            return envelope(
                [
                    {"objectId": "obj0", "url": "https://storage.test/obj0", "contentType": "image/png"},
                    {"error": "File exceeds the 100 MB limit"},
                ]
            )
        return route(request)

    out = client(Recorder(router=refusing)).assets.upload_many([b"\x00", b"\x01"], wait=False)
    assert out[1] == {"name": "upload.bin", "error": {"code": "invalid_param", "message": "File exceeds the 100 MB limit", "retryable": False, "param": "file"}}
    assert out[0]["asset"]["id"] == "ast_obj0"
    assert seen["finish"] == [1]


async def test_async_bulk_ingest_batches_the_same_way(monkeypatch):
    async def no_sleep(seconds: float) -> None:
        return None

    monkeypatch.setattr(client_module.asyncio, "sleep", no_sleep)
    route, seen = _ingesting_service(ticks=2)
    async with aclient(Recorder(router=route)) as c:
        out = await c.assets.from_url([f"https://cdn.example/{n}.png" for n in range(21)])
        many = await c.assets.upload_many([bytes([n]) for n in range(5)])
    assert seen["from_url"] == [20, 1]
    assert len(out) == 21 and all("asset" in r for r in out)
    assert seen["stage"] == [5] and seen["finish"] == [5]
    assert all(r["asset"]["status"] == "DONE" for r in many)


def test_tag_replaces_the_tags_through_the_batch_update():
    rec = Recorder(envelope([{"id": "ast_1"}]), envelope([{"id": "ast_1"}, {"id": "ast_2"}]))
    client(rec).assets.tag("ast_1", ["hero", "sale"])
    client(rec).assets.tag(["ast_1", "ast_2"], [])
    assert str(rec.calls[0].url).endswith("/api/v1/assets/update")
    assert json.loads(rec.calls[0].content) == {"ids": ["ast_1"], "tags": ["hero", "sale"]}
    assert json.loads(rec.calls[1].content) == {"ids": ["ast_1", "ast_2"], "tags": []}


def test_download_follows_the_content_redirect_without_the_api_key():
    def route(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "/assets/ast_1/content" in url:
            return httpx.Response(302, headers={"Location": "https://bucket/obj?sig=1"})
        if url == "https://bucket/obj?sig=1":
            return httpx.Response(200, content=b"\x01\x02\x03", headers={"Content-Type": "image/png"})
        raise AssertionError("unexpected " + url)

    rec = Recorder(router=route)
    data = client(rec).assets.download("ast_1", variant="preview")

    assert data == b"\x01\x02\x03"
    assert str(rec.calls[0].url).endswith("/api/v1/assets/ast_1/content?variant=preview")
    assert rec.calls[0].headers["Authorization"].startswith("ApiKey ")
    assert "Authorization" not in rec.calls[1].headers


def test_the_storage_legs_are_retried_like_any_request(monkeypatch):
    # #567: the PUT and both download legs were one attempt — a dropped connection or a 503 from storage ended them.
    waits: list[float] = []
    monkeypatch.setattr(client_module.time, "sleep", waits.append)
    stage = envelope([{"objectId": "o", "url": "https://bucket/o", "exists": False}])
    rec = Recorder(stage, httpx.ConnectError("reset"), httpx.Response(503), httpx.Response(200), envelope([{"id": "ast_1", "status": "DONE"}]))
    assert client(rec, max_retries=2).assets.upload(b"xy", name="p.png", wait=False)["id"] == "ast_1"
    assert [r.method for r in rec.calls] == ["POST", "PUT", "PUT", "PUT", "POST"]
    assert all(r.content == b"xy" for r in rec.calls[1:4])
    assert waits == [0.25, 1.0]  # the transport backoff, then the error backoff of a second attempt

    rec = Recorder(
        httpx.ConnectError("reset"),
        httpx.Response(302, headers={"Location": "https://bucket/obj?sig=1"}),
        httpx.Response(502),
        httpx.Response(200, content=b"\x09"),
    )
    assert client(rec, max_retries=1).assets.download("ast_1") == b"\x09"
    assert "Authorization" not in rec.calls[3].headers


def test_templates_list_is_a_page_and_iterate_walks_them():
    # imagestep#497: the listing is paged summaries, like every other listing.
    def route(request: httpx.Request) -> httpx.Response:
        at = 1 if request.url.params.get("cursor") == "c1" else 0
        return httpx.Response(200, json={"success": True, "data": [{"id": f"tpl_{at}"}],
                                         "meta": {"perPage": 1, "hasMore": at == 0, "nextCursor": "c1" if at == 0 else None}})

    rec = Recorder(router=route)
    templates = client(rec).templates
    first = templates.list("user", per_page=1)
    assert [t["id"] for t in first.items] == ["tpl_0"]
    assert [t["id"] for t in templates.iterate("user")] == ["tpl_0", "tpl_1"]


def test_templates_client_speaks_every_template_route():
    def route(request: httpx.Request) -> httpx.Response:
        return httpx.Response(204) if request.method == "DELETE" else envelope({"id": "tpl_1", "version": 2})

    rec = Recorder(router=route)
    templates = client(rec).templates
    templates.list("user")
    templates.get("tpl_1@1")
    templates.versions("tpl_1")
    templates.create({"name": "card", "html": "<h1>{{ title }}</h1>", "width": 600, "height": 300})
    templates.update("tpl_1", {"name": "card", "html": "<h2>{{ title }}</h2>", "width": 600, "height": 300})
    templates.delete("tpl_1")
    templates.import_([{"name": "card", "html": "<p></p>", "width": 1, "height": 1}])

    assert [(r.method, r.url.raw_path.decode()) for r in rec.calls] == [
        ("GET", "/api/v1/templates?filter=user"),
        ("GET", "/api/v1/templates/tpl_1@1"),
        ("GET", "/api/v1/templates/tpl_1/versions"),
        ("POST", "/api/v1/templates"),
        ("PUT", "/api/v1/templates/tpl_1"),
        ("DELETE", "/api/v1/templates/tpl_1"),
        ("POST", "/api/v1/templates/import"),
    ]
    assert json.loads(rec.calls[3].content)["html"] == "<h1>{{ title }}</h1>"


# imagestep#437 — `list()` hands back one page; `iterate()` is the loop nobody should have to write. Since #493 it
# follows `meta.nextCursor` rather than counting pages: the next page is wherever the ANSWER says it starts, and a page
# number sent after the first would make the service re-read and re-count every earlier row.
def test_iterate_follows_the_cursor_the_answer_carries_with_the_same_filters() -> None:
    rec = Recorder(
        envelope([{"id": "a1"}, {"id": "a2"}], {"total": 3, "page": 0, "perPage": 2, "hasMore": True, "nextCursor": "c2"}),
        envelope([{"id": "a3"}], {"perPage": 2, "hasMore": False, "nextCursor": None}),
    )
    seen = [asset["id"] for asset in client(rec).assets.iterate(collection="shoot", per_page=2)]

    assert seen == ["a1", "a2", "a3"]
    assert [r.url.params.get("cursor") for r in rec.calls] == [None, "c2"]
    assert [r.url.params.get("page") for r in rec.calls] == [None, None]
    assert rec.calls[1].url.params.get("collection") == "shoot"


def test_iterate_resumes_from_a_page_or_a_cursor_and_continues_by_cursor() -> None:
    rec = Recorder(
        envelope([{"id": "a1"}], {"total": 4, "page": 2, "perPage": 1, "hasMore": True, "nextCursor": "c3"}),
        envelope([{"id": "a2"}], {"perPage": 1, "hasMore": False, "nextCursor": None}),
    )
    assert [a["id"] for a in client(rec).assets.iterate(page=7, per_page=1)] == ["a1", "a2"]
    assert [r.url.params.get("page") for r in rec.calls] == ["7", None]
    assert [r.url.params.get("cursor") for r in rec.calls] == [None, "c3"]

    rec = Recorder(
        envelope([{"id": "a5"}], {"perPage": 1, "hasMore": True, "nextCursor": "c6"}),
        envelope([{"id": "a6"}], {"perPage": 1, "hasMore": False, "nextCursor": None}),
    )
    assert [a["id"] for a in client(rec).jobs.iterate(cursor="c5")] == ["a5", "a6"]
    assert [r.url.params.get("cursor") for r in rec.calls] == ["c5", "c6"]


def test_a_listing_that_says_more_without_saying_where_is_an_error() -> None:
    rec = Recorder(envelope([{"id": "a1"}], {"total": 2, "page": 0, "perPage": 1, "hasMore": True}))
    with pytest.raises(RuntimeError, match="nextCursor"):
        list(client(rec).assets.iterate())


def test_every_listing_has_an_iterator() -> None:
    walks = [
        lambda c: c.assets.iterate_collections(q="sh"),
        lambda c: c.jobs.iterate(type="process"),
        lambda c: c.jobs.iterate_items("job_1", status="FAILED"),
        lambda c: c.agent.iterate_reports(),
        lambda c: c.templates.iterate("user"),
        lambda c: c.webhooks.iterate_deliveries("whe_1"),
    ]
    for walk in walks:
        rec = Recorder(
            envelope([{"id": "r1"}], {"total": 2, "page": 0, "perPage": 1, "hasMore": True, "nextCursor": "c1"}),
            envelope([{"id": "r2"}], {"perPage": 1, "hasMore": False, "nextCursor": None}),
        )
        assert len(list(walk(client(rec)))) == 2
        assert [r.url.params.get("cursor") for r in rec.calls] == [None, "c1"]


@pytest.mark.asyncio
async def test_the_async_client_walks_the_same_way() -> None:
    rec = Recorder(
        envelope([{"id": "a1"}], {"total": 2, "page": 0, "perPage": 1, "hasMore": True, "nextCursor": "c1"}),
        envelope([{"id": "a2"}], {"perPage": 1, "hasMore": False, "nextCursor": None}),
    )
    seen = [asset["id"] async for asset in aclient(rec).assets.iterate(per_page=1)]

    assert seen == ["a1", "a2"]
    assert [r.url.params.get("cursor") for r in rec.calls] == [None, "c1"]
