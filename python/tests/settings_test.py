from contextvars import ContextVar
from threading import get_ident
from typing import Any, Literal

import anyio
import httpx2
import pytest
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.context import Context
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import CallToolResult
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    create_model,
    field_validator,
    model_validator,
)

from openai_mcp_extensions import (
    OpenAISettings,
    OpenAISettingsCapability,
    OpenAISettingsGroup,
    OpenAISettingsProperty,
    OpenAISettingsReadResult,
    OpenAISettingsTool,
    OpenAISettingsUpdateArguments,
)


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


class Preferences(BaseModel):
    units: Literal["mm", "in"] = Field(title="Units")
    show_grid: bool = Field(alias="showGrid", title="Grid")


@pytest.mark.anyio
@pytest.mark.parametrize(
    "names",
    [
        {},
        {"read_tool": "custom.read"},
        {"update_tool": "custom.update"},
        {"read_tool": "custom.read", "update_tool": "custom.update"},
    ],
)
@pytest.mark.parametrize("protocol_version", ["2025-11-25", "2026-07-28"])
async def test_registered_settings_validate_patches_and_return_complete_values(
    names: dict[str, str],
    protocol_version: str,
) -> None:
    read_tool = names.get("read_tool", "settings.read")
    update_tool = names.get("update_tool", "settings.update")
    settings = OpenAISettings(
        schema=Preferences,
        **names,
        layout=[
            OpenAISettingsGroup(
                title="Display",
                items=[
                    OpenAISettingsProperty(property="units"),
                    OpenAISettingsTool(tool="connection.test"),
                ],
            )
        ],
    )
    values = Preferences(units="mm", showGrid=True)
    updates: list[dict[str, Any]] = []

    @settings.read
    def read(context: Context[Any, Any]) -> Preferences:
        return values

    @settings.update
    async def update(set: dict[str, Any], context: Context[Any, Any]) -> Preferences:
        nonlocal values
        updates.append(set)
        values = Preferences.model_validate(
            {
                **values.model_dump(by_alias=True),
                **{"showGrid" if key == "show_grid" else key: value for key, value in set.items()},
            }
        )
        return values

    assert callable(read) and callable(update)
    server = MCPServer(
        "settings", extensions=[settings], middleware=[settings.advertise_legacy_capability]
    )
    tools = await server.list_tools()
    assert len(tools) == 2
    assert tools[0].name == read_tool
    assert tools[1].name == update_tool
    app = server.streamable_http_app(stateless_http=True, json_response=True)
    async with server.session_manager.run():
        async with httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app), base_url="http://127.0.0.1:8000"
        ) as client:
            modern = protocol_version == "2026-07-28"
            method = "server/discover" if modern else "initialize"
            response = await client.post(
                "/mcp",
                headers={
                    "Accept": "application/json, text/event-stream",
                    "MCP-Protocol-Version": protocol_version,
                    "MCP-Method": method,
                },
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": method,
                    "params": (
                        {
                            "_meta": {
                                "io.modelcontextprotocol/protocolVersion": protocol_version,
                                "io.modelcontextprotocol/clientCapabilities": {},
                            }
                        }
                        if modern
                        else {
                            "protocolVersion": protocol_version,
                            "capabilities": {},
                            "clientInfo": {"name": "settings-test", "version": "1"},
                        }
                    ),
                },
            )
            assert response.status_code == 200
            capabilities = response.json()["result"]["capabilities"]
            assert capabilities["extensions" if modern else "experimental"]["openai/settings"] == {
                "readTool": read_tool,
                "updateTool": update_tool,
            }
    assert tools[0].annotations is not None and tools[0].annotations.read_only_hint
    assert all(tool.output_schema for tool in tools)
    read_result = await server.call_tool(read_tool, {})
    assert isinstance(read_result, CallToolResult)
    result = OpenAISettingsReadResult.model_validate(read_result.structured_content)
    assert result.values == {"units": "mm", "showGrid": True}
    assert result.layout == [
        OpenAISettingsGroup(
            title="Display",
            items=[
                OpenAISettingsProperty(property="units"),
                OpenAISettingsTool(tool="connection.test"),
            ],
        )
    ]
    assert result.settings_schema["additionalProperties"] is False
    properties = result.settings_schema["properties"]
    assert isinstance(properties, dict)
    assert list(properties) == ["units", "showGrid"]

    for set_values in [
        {},
        {"units": "cm"},
        {"unknown": True},
        {"showGrid": None},
        {"showGrid": "true"},
    ]:
        with pytest.raises(ToolError):
            await server.call_tool(update_tool, {"set": set_values})
    assert updates == []

    saved = await server.call_tool(update_tool, {"set": {"showGrid": False}})
    assert isinstance(saved, CallToolResult) and not saved.is_error
    assert saved.structured_content == {"values": {"units": "mm", "showGrid": False}}
    assert updates == [{"show_grid": False}]


@pytest.mark.anyio
@pytest.mark.parametrize("handler_style", ["sync", "async", "async_callable"])
async def test_settings_handlers_follow_mcp_execution_conventions(handler_style: str) -> None:
    loop_thread = get_ident()
    request_marker: ContextVar[str] = ContextVar("settings_request_marker")
    token = request_marker.set("request context")
    calls: list[tuple[int, str]] = []

    def sync_handler(*args: Any) -> Preferences:
        calls.append((get_ident(), request_marker.get()))
        return Preferences(units="mm", showGrid=True)

    async def async_handler(*args: Any) -> Preferences:
        await anyio.sleep(0)
        return sync_handler(*args)

    class AsyncHandler:
        async def __call__(self, *args: Any) -> Preferences:
            return await async_handler(*args)

    handler = (
        sync_handler
        if handler_style == "sync"
        else async_handler
        if handler_style == "async"
        else AsyncHandler()
    )
    settings = OpenAISettings(schema=Preferences)
    settings.read(handler)
    settings.update(handler)
    server = MCPServer("settings", extensions=[settings])
    try:
        for tool, arguments in [
            ("settings.read", {}),
            ("settings.update", {"set": {"units": "mm"}}),
        ]:
            result = await server.call_tool(tool, arguments)
            assert isinstance(result, CallToolResult) and not result.is_error
        assert len(calls) == 2
        for thread, marker in calls:
            assert (thread == loop_thread) == (handler_style != "sync")
            assert marker == "request context"
    finally:
        request_marker.reset(token)


@pytest.mark.anyio
async def test_partial_updates_preserve_field_validators_and_configuration() -> None:
    class ValidatedPreferences(BaseModel):
        model_config = ConfigDict(
            str_strip_whitespace=True,
            str_max_length=8,
            validate_default=True,
            serialize_by_alias=True,
        )
        display_name: str = Field(alias="displayName", title="Name")
        limit: int = Field(title="Limit", validate_default=True)

        @field_validator("display_name")
        @classmethod
        def reject_blocked_name(cls, value: str) -> str:
            if value == "blocked":
                raise ValueError("Name is blocked")
            return value

        @field_validator("limit")
        @classmethod
        def require_positive_limit(cls, value: int) -> int:
            if value <= 0:
                raise ValueError("Limit must be positive")
            return value

        @model_validator(mode="after")
        def check_name_fits_limit(self) -> "ValidatedPreferences":
            if len(self.display_name) > self.limit:
                raise ValueError("Name exceeds limit")
            return self

    class InheritedPreferences(ValidatedPreferences):
        @field_validator("display_name", mode="before")
        @classmethod
        def remove_prefix(cls, value: Any) -> Any:
            return value.removeprefix("name:") if isinstance(value, str) else value

    settings = OpenAISettings(schema=InheritedPreferences)
    values = InheritedPreferences(displayName="ready", limit=10)
    updates: list[dict[str, Any]] = []
    settings.read(lambda context: values)

    @settings.update
    def save(set: dict[str, Any], context: Context[Any, Any]) -> InheritedPreferences:
        nonlocal values
        updates.append(set)
        values = InheritedPreferences.model_validate(
            {**values.model_dump(by_alias=False), **set}, by_name=True
        )
        return values

    assert callable(save)
    server = MCPServer("settings", extensions=[settings])
    for patch in [
        {"displayName": "blocked"},
        {"displayName": "too long a name"},
        {"limit": -1},
        {"displayName": None},
    ]:
        with pytest.raises(ToolError):
            await server.call_tool("settings.update", {"set": patch})
    assert updates == []

    result = await server.call_tool("settings.update", {"set": {"displayName": "name: ok "}})
    assert isinstance(result, CallToolResult) and not result.is_error
    assert updates == [{"display_name": "ok"}]
    assert result.structured_content == {"values": {"displayName": "ok", "limit": 10}}


@pytest.mark.parametrize("title", [None, "Legacy action label"])
def test_protocol_models_use_wire_names(title: str | None) -> None:
    assert OpenAISettingsCapability(read_tool="read", update_tool="save").model_dump(
        by_alias=True
    ) == {"readTool": "read", "updateTool": "save"}
    payload = {
        "kind": "tool",
        "tool": "connection.test",
    }
    if title is not None:
        payload["title"] = title
    action = OpenAISettingsTool.model_validate(payload)
    assert action.model_dump(by_alias=True) == payload
    with pytest.raises(ValidationError):
        OpenAISettingsUpdateArguments(set={})


@pytest.mark.parametrize("schema", [{}, {"type": "string"}, {"type": ["object", "null"]}])
def test_read_result_rejects_schemas_without_an_object_root(schema: dict[str, Any]) -> None:
    with pytest.raises(ValidationError, match='must have type "object"'):
        OpenAISettingsReadResult.model_validate({"schema": schema, "values": {}})


def test_read_result_preserves_object_schema_keywords() -> None:
    schema = {
        "type": "object",
        "properties": {"units": {"type": "string", "enum": ["mm", "in"], "title": "Units"}},
        "required": ["units"],
        "additionalProperties": False,
    }
    result = {"schema": schema, "values": {"units": "mm"}}
    parsed = OpenAISettingsReadResult.model_validate(result)
    assert parsed.model_dump(by_alias=True, exclude_none=True) == result


def test_layout_references_and_omitted_settings() -> None:
    result = {
        "schema": {
            "type": "object",
            "properties": {"units": {"type": "string"}, "grid": {"type": "boolean"}},
        },
        "values": {"units": "mm", "grid": True},
    }
    assert OpenAISettingsReadResult.model_validate(result).layout is None
    for layout in [
        [],
        [
            {
                "kind": "group",
                "title": "Display",
                "items": [{"kind": "property", "property": "units"}],
            }
        ],
    ]:
        parsed = OpenAISettingsReadResult.model_validate({**result, "layout": layout})
        assert parsed.model_dump()["layout"] == layout
    for layout in [
        [
            {
                "kind": "group",
                "title": "Display",
                "items": [{"kind": "property", "property": "missing"}],
            }
        ],
        [
            {
                "kind": "group",
                "title": "Display",
                "items": [{"kind": "property", "property": "units"}],
            },
            {
                "kind": "group",
                "title": "Display",
                "items": [{"kind": "property", "property": "units"}],
            },
        ],
    ]:
        with pytest.raises(ValidationError, match="Unknown or duplicate"):
            OpenAISettingsReadResult.model_validate({**result, "layout": layout})


def test_layout_keys_use_pydantic_wire_aliases() -> None:
    OpenAISettings(
        schema=Preferences,
        layout=[
            OpenAISettingsGroup(
                title="Display", items=[OpenAISettingsProperty(property="showGrid")]
            )
        ],
    )
    with pytest.raises(ValueError, match="show_grid"):
        OpenAISettings(
            schema=Preferences,
            layout=[
                OpenAISettingsGroup(
                    title="Display", items=[OpenAISettingsProperty(property="show_grid")]
                )
            ],
        )


def test_invalid_layout_is_rejected_before_registration() -> None:
    for layout in [
        [OpenAISettingsGroup(title="Display", items=[OpenAISettingsProperty(property="missing")])],
        [
            OpenAISettingsGroup(title="Display", items=[OpenAISettingsProperty(property="units")]),
            OpenAISettingsGroup(title="Display", items=[OpenAISettingsProperty(property="units")]),
        ],
    ]:
        with pytest.raises(ValueError, match="Unknown or duplicate"):
            OpenAISettings(schema=Preferences, layout=layout)


def test_incomplete_registration_is_rejected() -> None:
    settings = OpenAISettings(schema=Preferences, read_tool="read", update_tool="update")
    with pytest.raises(ValueError, match="both settings"):
        MCPServer("settings", extensions=[settings])


def test_default_factory_is_rejected_during_registration() -> None:
    class FactoryPreferences(BaseModel):
        units: str = Field(default_factory=lambda: "mm", title="Units")

    with pytest.raises(ValueError, match="default factories"):
        OpenAISettings(schema=FactoryPreferences)


def test_extra_allow_is_rejected_during_registration() -> None:
    class ExtraPreferences(BaseModel):
        model_config = ConfigDict(extra="allow")
        units: str = Field(title="Units")

    with pytest.raises(ValueError, match="must not allow extra fields"):
        OpenAISettings(schema=ExtraPreferences)


@pytest.mark.parametrize(
    ("annotation", "value"),
    [
        ("title", ""),
        ("title", "   "),
        ("title", 7),
        ("description", 7),
    ],
)
def test_invalid_presentation_is_rejected_during_registration(annotation: str, value: Any) -> None:
    class InvalidPresentationPreferences(BaseModel):
        units: str = Field(title="Units", json_schema_extra={annotation: value})

    with pytest.raises(ValueError, match="units") as error:
        OpenAISettings(schema=InvalidPresentationPreferences)
    assert annotation in str(error.value)


def test_presentation_validation_allows_value_constraints() -> None:
    class UngroupedPreferences(BaseModel):
        units: Literal["mm", "in"] = Field(
            title="Units",
            description="Measurement units",
        )

    OpenAISettings(schema=UngroupedPreferences)


@pytest.mark.anyio
async def test_handler_cannot_return_an_unvalidated_incomplete_model() -> None:
    settings = OpenAISettings(schema=Preferences, read_tool="read", update_tool="update")
    settings.read(lambda context: Preferences.model_construct(units="mm"))
    settings.update(lambda set, context: Preferences.model_construct(units="mm"))
    server = MCPServer("settings", extensions=[settings])
    with pytest.raises(ToolError):
        await server.call_tool("read", {})
    with pytest.raises(ToolError):
        await server.call_tool("update", {"set": {"units": "in"}})


@pytest.mark.parametrize(
    "annotation", [list[str], dict[str, str], str | bool, str | None, Literal[1, 2]]
)
def test_unsupported_native_fields_fail_before_registration(annotation: Any) -> None:
    schema = create_model(
        "UnsupportedPreferences", unsupported=(annotation, Field(title="Unsupported"))
    )
    with pytest.raises(ValueError, match="Unsupported native setting 'unsupported'"):
        OpenAISettings(schema=schema)


def test_layout_rejects_ungrouped_entries_and_nested_groups() -> None:
    property_entry = {"kind": "property", "property": "units"}
    tool = {"kind": "tool", "tool": "connection.test"}
    group = {"kind": "group", "title": "Display", "items": [property_entry, tool]}
    result = {
        "schema": {"type": "object", "properties": {"units": {"type": "string"}}},
        "values": {"units": "mm"},
    }
    for layout in [[property_entry], [tool], [{**group, "items": [group]}]]:
        with pytest.raises(ValidationError):
            OpenAISettingsReadResult.model_validate({**result, "layout": layout})
