"""imagestep#761: every annotation on the public client resolves, and the answers the API documents are typed as such.

The package ships `py.typed` and says it is typed with TypedDicts generated from the API's OpenAPI document. An
annotation that names a type the module never imported reads fine — `from __future__ import annotations` keeps it a
string — until something resolves it: `typing.get_type_hints` (pydantic, FastAPI, documentation generators) raises
`NameError`, and pyright / mypy report the name as undefined. `Assets.iterate`, `Jobs.iterate` and `Jobs.iterate_items`
shipped that way. Resolving every public method's hints is that check, with no type checker to install.
"""

import inspect
import typing

import pytest

import imagestep
from imagestep import _generated, client

CLASSES = [
    cls
    for name, cls in inspect.getmembers(client, inspect.isclass)
    if cls.__module__ == client.__name__ and not name.startswith("_")
]


def _public_methods():
    for cls in CLASSES:
        for name, member in inspect.getmembers(cls, inspect.isfunction):
            if not name.startswith("_") or name == "__init__":
                yield pytest.param(member, id=f"{cls.__name__}.{name}")


def test_reads_the_resource_classes():
    names = {cls.__name__ for cls in CLASSES}
    assert {"ImageStep", "AsyncImageStep", "Assets", "AsyncAssets", "Jobs", "AsyncJobs", "Usage"} <= names


@pytest.mark.parametrize("method", list(_public_methods()))
def test_every_annotation_resolves(method):
    typing.get_type_hints(method)


@pytest.mark.parametrize(
    ("method", "answer"),
    [
        (client.Assets.status, list[_generated.AssetStatus]),
        (client.AsyncAssets.status, list[_generated.AssetStatus]),
        (client.Assets.iterate, typing.Iterator[_generated.AssetSummary]),
        (client.Jobs.iterate, typing.Iterator[_generated.JobSummary]),
        (client.Jobs.iterate_items, typing.Iterator[_generated.JobItem]),
        (client.Agent.feedback, _generated.Feedback),
        (client.AsyncAgent.feedback, _generated.Feedback),
        (client.Usage.get, _generated.Usage),
        (client.AsyncUsage.get, _generated.Usage),
        (client.Presets.import_, _generated.BatchImportResultDTOPresetData),
        (client.Templates.import_, _generated.BatchImportResultDTOTemplateData),
        (client.AsyncPresets.import_, _generated.BatchImportResultDTOPresetData),
        (client.AsyncTemplates.import_, _generated.BatchImportResultDTOTemplateData),
        (client.Images.metadata, _generated.ImageMetadata),
        (client.AsyncImages.metadata, _generated.ImageMetadata),
        (client.Images.transform, bytes | _generated.SyncUrlResult),
        (client.AsyncImages.transform, bytes | _generated.SyncUrlResult),
    ],
    ids=lambda value: getattr(value, "__qualname__", None),
)
def test_documented_answers_are_their_generated_types(method, answer):
    assert typing.get_type_hints(method)["return"] == answer


def test_the_resource_types_are_importable_from_the_package():
    for name in ("Asset", "AssetSummary", "Job", "JobItem", "JobSummary", "JobEstimate", "PresetData", "TemplateData",
                 "ImageMetadata", "SyncUrlResult"):
        assert getattr(imagestep, name) is getattr(_generated, name), name
        assert name in imagestep.__all__
    assert imagestep.UsageSummary is _generated.Usage
    assert imagestep.WebhookEndpoint is _generated.WebhookEndpoint


def test_a_webhook_event_is_the_generated_union():
    # imagestep#752 — `data` used to be `dict[str, Any]`; the body is one of three generated events, told apart by `type`.
    assert typing.get_type_hints(imagestep.construct_webhook_event)["return"] == (
        _generated.JobEvent | _generated.JobItemEvent | _generated.WebhookTestEvent
    )
    assert imagestep.WebhookEvent == typing.get_type_hints(imagestep.construct_webhook_event)["return"]
    assert typing.get_type_hints(client.Webhooks.construct_event)["return"] == imagestep.WebhookEvent
    assert "WebhookEvent" in imagestep.__all__
