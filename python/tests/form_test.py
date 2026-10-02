from typing import Annotated, Any, Literal
from unittest.mock import AsyncMock, MagicMock

import pytest
from mcp.server.elicitation import AcceptedElicitation
from mcp.server.mcpserver.context import Context
from mcp_types import ClientCapabilities, ElicitResult, Icon, Resource
from pydantic import AliasPath, BaseModel, Field, JsonValue, field_validator

from openai_mcp_extensions import OpenAIExtensions
from openai_mcp_extensions.form import FileUserOptions, elicit_form, file_input
from openai_mcp_extensions.form._schema import render_form_schema


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def _context(content: dict[str, Any]) -> MagicMock:
    context = MagicMock(spec=Context)
    context.client_capabilities = ClientCapabilities(
        extensions={"openai/elicitation": {"form": {}}}
    )
    context.request_context.request_id = 7
    context.session.send_request = AsyncMock(
        return_value=ElicitResult(action="accept", content=content)
    )
    return context


def test_schema_preserves_aliases_patterns_and_optional_defaults() -> None:
    class Form(BaseModel):
        label: str = Field(alias="displayName", pattern="^[A-Z]+$")
        choice: Literal["summary"]
        count: int = 2
        note: str | None = None

    form = render_form_schema(Form)
    assert form["required"] == ["displayName", "choice"]
    assert form["properties"]["displayName"]["pattern"] == "^[A-Z]+$"
    assert form["properties"]["choice"]["enum"] == ["summary"]
    assert form["properties"]["count"]["default"] == 2
    assert form["properties"]["note"]["type"] == "string"
    assert "default" not in form["properties"]["note"]


def test_schema_rejects_nested_aliases() -> None:
    class Form(BaseModel):
        label: str = Field(validation_alias=AliasPath("nested", "label"))

    with pytest.raises(ValueError, match="flat validation aliases"):
        render_form_schema(Form)


@pytest.mark.parametrize(
    "extra",
    [
        {"minLength": 3, "maxLength": 2},
        {"enum": ["a"], "default": "b"},
        {"x-openai-input": {"type": "file", "options": []}},
    ],
)
def test_schema_generation_uses_shared_protocol_constraints(extra: dict[str, Any]) -> None:
    class Form(BaseModel):
        answer: str = Field(json_schema_extra=extra)

    with pytest.raises(ValueError):
        render_form_schema(Form)


@pytest.mark.parametrize("accept", [None, ["pdf"]])
def test_schema_rejects_invalid_file_accept_tokens(accept: Any) -> None:
    class Form(BaseModel):
        report: str = Field(
            json_schema_extra={
                **file_input(user_options=FileUserOptions(accept=accept)),
                "format": "uri",
            }
        )

    with pytest.raises(ValueError, match="accept"):
        render_form_schema(Form)


@pytest.mark.anyio
async def test_elicitation_keeps_pydantic_coercion_defaults_and_custom_validation() -> None:
    class Form(BaseModel):
        count: int
        label: str = Field(alias="displayName", pattern="^[A-Z]+$")
        enabled: bool = True

        @field_validator("label")
        @classmethod
        def normalize_label(cls, value: str) -> str:
            return value.lower()

    context = _context({"count": "2", "displayName": "REPORT"})
    result = await OpenAIExtensions().elicit_input_legacy(
        context, mode="form", message="Choose a report", schema=Form
    )
    assert isinstance(result, AcceptedElicitation)
    assert result.data.count == 2
    assert result.data.label == "report"
    assert result.data.enabled is True
    request = context.session.send_request.call_args.args[0]
    assert request.method == "openai/elicitation/create"
    assert request.params.requested_schema == render_form_schema(Form)


@pytest.mark.anyio
async def test_elicitation_still_runs_pydantic_pattern_validation() -> None:
    class Form(BaseModel):
        label: str = Field(pattern="^[A-Z]+$")

    with pytest.raises(ValueError, match="content does not match"):
        await elicit_form(_context({"label": "lowercase"}), message="Name", schema=Form)


@pytest.mark.anyio
@pytest.mark.parametrize("selected", ["https://example.com", "https://example.com/"])
async def test_file_selection_checks_raw_uri_before_pydantic_validators(selected: str) -> None:
    class Form(BaseModel):
        report: str = Field(
            json_schema_extra={
                **file_input(options=[Resource(uri="https://example.com", name="Report")]),
                "format": "uri",
            },
        )

        @field_validator("report", mode="before")
        @classmethod
        def strip_trailing_slash(cls, value: str) -> str:
            return value.rstrip("/")

    form = render_form_schema(Form)
    assert (
        form["properties"]["report"]["x-openai-input"]["options"][0]["uri"] == "https://example.com"
    )
    if selected.endswith("/"):
        with pytest.raises(ValueError):
            await elicit_form(_context({"report": selected}), message="Report", schema=Form)
    else:
        result = await elicit_form(_context({"report": selected}), message="Report", schema=Form)
        assert isinstance(result, AcceptedElicitation)
        assert result.data.report == selected


@pytest.mark.anyio
async def test_sdk_directory_selection_remains_supported() -> None:
    class Form(BaseModel):
        directory: str = Field(
            json_schema_extra={
                **file_input(user_options=FileUserOptions(kind="directory")),
                "format": "uri",
            }
        )

    result = await elicit_form(
        _context({"directory": "file:///workspace/reports"}), message="Directory", schema=Form
    )
    assert isinstance(result, AcceptedElicitation)
    assert result.data.directory == "file:///workspace/reports"


@pytest.mark.anyio
@pytest.mark.parametrize("selection", ["implicit", "explicit"])
@pytest.mark.parametrize("selected", [["reports://annual"], [], ["reports://annual"] * 2])
async def test_sdk_file_arrays_enforce_shared_constraints(
    selection: Literal["implicit", "explicit"], selected: list[str]
) -> None:
    class Form(BaseModel):
        reports: list[Annotated[str, Field(json_schema_extra={"format": "uri"})]] = Field(
            min_length=1,
            max_length=2,
            json_schema_extra={
                **file_input(
                    options=[Resource(uri="reports://annual", name="Annual report")],
                    selection=selection,
                ),
                "uniqueItems": True,
            },
        )

    if len(selected) != 1:
        with pytest.raises(ValueError, match="Invalid resource selection"):
            await elicit_form(_context({"reports": selected}), message="Reports", schema=Form)
    else:
        result = await elicit_form(_context({"reports": selected}), message="Reports", schema=Form)
        assert isinstance(result, AcceptedElicitation)
        assert result.data.reports == selected


def test_sdk_keeps_file_and_option_preview_metadata() -> None:
    preview: dict[str, JsonValue] = {"src": "https://example.com/report.png", "theme": "dark"}
    choice_metadata: dict[str, JsonValue] = {
        "oneOf": [{"const": "report", "title": "Report", "x-openai-preview": preview}]
    }

    class Form(BaseModel):
        choice: str = Field(json_schema_extra=choice_metadata)
        report: str = Field(
            json_schema_extra={
                **file_input(
                    options=[
                        Resource(
                            uri="reports://annual",
                            name="Report",
                            icons=[Icon.model_validate(preview)],
                        )
                    ]
                ),
                "format": "uri",
            }
        )

    fields = render_form_schema(Form)["properties"]
    assert fields["choice"]["oneOf"][0]["x-openai-preview"] == preview
    assert fields["report"]["x-openai-input"]["options"][0]["icons"] == [preview]
