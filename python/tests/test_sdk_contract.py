"""Public SDK behavior exercised with explicit requests and controlled peers."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Literal

import pytest
from mcp import Client
from mcp.client import advertise
from mcp.server.elicitation import AcceptedElicitation, CancelledElicitation, DeclinedElicitation
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.context import Context
from mcp_types import (
    CallToolResult,
    ClientCapabilities,
    ElicitResult,
    InputRequiredResult,
    Resource,
)
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from openai_mcp_extensions import OpenAIExtensions, OpenAIFileEntrypointInput, OpenAIMentionResource, OpenAIMentionSearchResult, OpenAISettings, OpenAIUiResourceMetadata, OpenAIUiToolMetadata, get_resource_path
from openai_mcp_extensions.form import elicit_form, file_input, request_form_input, resource_input


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"




def test_resource_paths_allow_unrelated_metadata_but_reject_bad_paths() -> None:
    assert get_resource_path() is None
    assert get_resource_path({"future": True}) is None
    assert (
        get_resource_path({"openai/resource": {"path": "/workspace/drawing.stl", "future": True}})
        == "/workspace/drawing.stl"
    )
    with pytest.raises(ValidationError):
        get_resource_path({"openai/resource": {"path": 1}})


@pytest.mark.anyio
@pytest.mark.parametrize("asynchronous", [False, True])
async def test_mentions_contribute_tools_and_preserve_handler_results(asynchronous: bool) -> None:
    extensions = OpenAIExtensions()
    assert extensions.tools() == ()
    calls: list[tuple[str, Any]] = []

    def search(params: Any, context: Any) -> OpenAIMentionSearchResult:
        calls.append((params.query, context))
        return OpenAIMentionSearchResult(
            items=[OpenAIMentionResource(resource_uri="cad://bolt", title="Bolt")]
        )

    async def async_search(params: Any, context: Any) -> OpenAIMentionSearchResult:
        return search(params, context)

    extensions.mentions.search(async_search if asynchronous else search)
    assert extensions.mentions.settings() == {"searchTool": "search_mentions"}
    server = MCPServer("mentions", extensions=[extensions])
    async with Client(server, raise_exceptions=True) as client:
        tools = (await client.list_tools()).tools
        tool = next(tool for tool in tools if tool.name == "search_mentions")
        assert tool.meta["ui"] == {"visibility": ["app"]}
        assert tool.annotations.read_only_hint is True
        result = await client.call_tool("search_mentions", {"query": "bolt"})
        assert [query for query, _context in calls] == ["bolt"]
        assert result.structured_content == {
            "items": [{"type": "resource", "resourceUri": "cad://bolt", "title": "Bolt"}]
        }
        extensions.mentions.search(lambda _params, _ctx: OpenAIMentionSearchResult(items=[]))
        assert (
            await client.call_tool("search_mentions", {"query": "bolt"})
        ).structured_content == {"items": []}


class Preferences(BaseModel):
    model_config = ConfigDict(extra="forbid")
    units: Literal["mm", "in"] = Field(title="Units")
    show_grid: bool = Field(alias="showGrid", title="Grid")


@pytest.mark.anyio
async def test_settings_read_and_partial_update_preserve_aliases_and_other_values() -> None:
    settings = OpenAISettings(schema=Preferences)
    values = Preferences(units="mm", showGrid=True)
    updates: list[dict[str, Any]] = []

    @settings.read
    def read(_context: Any) -> Preferences:
        return values

    @settings.update
    async def update(set: dict[str, Any], _context: Any) -> Preferences:
        nonlocal values
        updates.append(set)
        current = values.model_dump()
        current.update(set)
        values = Preferences.model_validate(current, by_name=True)
        return values

    server = MCPServer("settings", extensions=[settings])
    assert updates == []
    async with Client(server, raise_exceptions=True) as client:
        assert client.server_capabilities.extensions["openai/settings"] == {
            "readTool": "settings.read",
            "updateTool": "settings.update",
        }
        result = await client.call_tool("settings.read", {})
        assert result.structured_content["values"] == {"units": "mm", "showGrid": True}
        assert result.structured_content["schema"]["additionalProperties"] is False
        result = await client.call_tool("settings.update", {"set": {"showGrid": False}})
        assert updates == [{"show_grid": False}]
        assert result.structured_content == {"values": {"units": "mm", "showGrid": False}}
        for invalid in [{}, {"showGrid": "false"}, {"unknown": True}]:
            result = await client.call_tool("settings.update", {"set": invalid})
            assert result.is_error is True
        assert updates == [{"show_grid": False}]


def test_settings_require_handlers_and_reject_schema_defaults() -> None:
    with pytest.raises(ValueError, match="both settings"):
        OpenAISettings(schema=Preferences).tools()

    class WithDefault(BaseModel):
        grid: bool = Field(default=True, title="Grid")

    with pytest.raises(ValueError, match="defaults"):
        OpenAISettings(schema=WithDefault)


class PartForm(BaseModel):
    name: str = Field(min_length=1)
    quantity: int = Field(ge=1)
    source: str = Field(
        json_schema_extra={
            "format": "uri",
            **resource_input(options=[Resource(uri="file:///drawing.stl", name="Drawing")]),
        }
    )


def form_context(reply: ElicitResult) -> tuple[Any, list[dict[str, Any]]]:
    calls: list[dict[str, Any]] = []

    async def send_request(request: Any, _result_type: Any, **_kwargs: Any) -> ElicitResult:
        calls.append(request.model_dump(by_alias=True, exclude_none=True, mode="json"))
        return reply

    return SimpleNamespace(
        client_capabilities=ClientCapabilities.model_validate(
            {
                "elicitation": {"form": {}},
                "extensions": {"openai/elicitation": {"form": {}}},
            }
        ),
        session=SimpleNamespace(send_request=send_request),
        request_context=SimpleNamespace(request_id="tool-1"),
        protocol_version="2026-07-28",
        input_responses=None,
    ), calls


@pytest.mark.anyio
async def test_legacy_form_sends_extended_schema_and_returns_validated_model() -> None:
    answer = {"name": "bolt", "quantity": 2, "source": "file:///drawing.stl"}
    context, calls = form_context(ElicitResult(action="accept", content=answer))
    result = await elicit_form(context, message="Name the part", schema=PartForm)
    assert isinstance(result, AcceptedElicitation)
    assert result.data == PartForm.model_validate(answer)
    request = calls[0]
    assert request["method"] == "openai/elicitation/create"
    assert request["params"]["message"] == "Name the part"
    assert request["params"]["requestedSchema"]["properties"]["source"]["x-openai-input"] == {
        "type": "resource",
        "options": [{"uri": "file:///drawing.stl", "name": "Drawing"}],
    }
    context.client_capabilities = None
    with pytest.raises(ValueError, match="does not support"):
        await elicit_form(context, message="Name the part", schema=PartForm)
    assert len(calls) == 1


@pytest.mark.anyio
@pytest.mark.parametrize(
    "action,expected", [("cancel", CancelledElicitation), ("decline", DeclinedElicitation)]
)
async def test_forms_preserve_cancel_and_decline(action: str, expected: type[Any]) -> None:
    context, _calls = form_context(ElicitResult.model_validate({"action": action}))
    assert isinstance(
        await elicit_form(context, message="Name the part", schema=PartForm), expected
    )


@pytest.mark.anyio
@pytest.mark.parametrize(
    "content",
    [
        {"name": "", "quantity": 2, "source": "file:///drawing.stl"},
        {"name": "bolt", "quantity": 0, "source": "file:///drawing.stl"},
        {"name": "bolt", "quantity": 2, "source": "file:///other.stl"},
    ],
)
async def test_forms_reject_invalid_answers(content: dict[str, Any]) -> None:
    context, _calls = form_context(ElicitResult(action="accept", content=content))
    with pytest.raises(ValueError):
        await elicit_form(context, message="Name the part", schema=PartForm)


@pytest.mark.anyio
async def test_mrtr_preserves_schema_through_upstream_dispatch_and_retry() -> None:
    extensions = OpenAIExtensions()
    server = MCPServer("forms", middleware=[extensions.middleware])
    saved: list[dict[str, Any]] = []
    received: list[dict[str, Any]] = []
    answer = {"name": "bolt", "quantity": 2, "source": "file:///drawing.stl"}

    @server.tool()
    async def choose_part(context: Context[Any, Any]) -> CallToolResult | InputRequiredResult:
        result = extensions.request_input(
            context, key="part", message="Name the part", schema=PartForm, request_state="resume-1"
        )
        if isinstance(result, InputRequiredResult):
            return result
        if result.action != "accept":
            return CallToolResult(content=[], structured_content={"action": result.action})
        saved.append(result.data.model_dump())
        assert context.request_state == "resume-1"
        return CallToolResult(content=[], structured_content=saved[-1])

    async def respond(_context: Any, params: Any) -> ElicitResult:
        received.append(params.model_dump(by_alias=True, exclude_none=True, mode="json"))
        return ElicitResult(action="accept", content=answer)

    async with Client(
        server,
        raise_exceptions=True,
        elicitation_callback=respond,
        extensions=[advertise("openai/elicitation", {"form": {}})],
    ) as client:
        result = await client.call_tool("choose_part", {})
        assert result.structured_content == answer
        assert saved == [answer]
        (params,) = received
        assert params["requestedSchema"] == {"type": "object", "properties": {}}
        picker = params["_meta"]["openai/elicitation"]["requestedSchema"]["properties"]["source"][
            "x-openai-input"
        ]
        assert picker == {
            "type": "resource",
            "options": [{"uri": "file:///drawing.stl", "name": "Drawing"}],
        }
        answer = {"name": "bolt", "quantity": 2, "source": "file:///other.stl"}
        assert (await client.call_tool("choose_part", {})).is_error is True
        assert len(saved) == 1

    context, _calls = form_context(ElicitResult(action="cancel"))
    with pytest.raises(RuntimeError, match="middleware"):
        request_form_input(context, key="part", message="Name the part", schema=PartForm)


def test_resource_picker_keeps_legacy_discriminator_and_user_options() -> None:
    options = [Resource(uri="file:///drawing.stl", name="Drawing")]
    metadata = resource_input(options=options, user_options={"kind": "file", "accept": [".stl"]})
    assert metadata == {
        "x-openai-input": {
            "type": "resource",
            "options": [{"uri": "file:///drawing.stl", "name": "Drawing"}],
            "userOptions": {"kind": "file", "accept": [".stl"]},
        }
    }
    assert file_input(options=options)["x-openai-input"]["type"] == "file"
