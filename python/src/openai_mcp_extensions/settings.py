"""Structured settings over ordinary MCP tools."""

from __future__ import annotations

import copy
from collections.abc import Awaitable, Callable, Sequence
from typing import Annotated, Any, Generic, Literal, TypeVar, cast

from mcp.server.context import CallNext, HandlerResult, ServerRequestContext
from mcp.server.extension import Extension, ToolBinding
from mcp.server.mcpserver.context import Context
from mcp_types import CallToolResult, InitializeResult, ToolAnnotations
from pydantic import (
    BaseModel,
    Field,
    JsonValue,
    ValidationError,
    create_model,
    field_validator,
    model_validator,
)
from typing_extensions import Self

from openai_mcp_extensions._handlers import call_handler
from openai_mcp_extensions._models import NonBlankString, OpenAIStrictModel

OPENAI_SETTINGS_CAPABILITY_KEY = "openai/settings"


class OpenAISettingsCapability(OpenAIStrictModel):
    read_tool: NonBlankString
    update_tool: NonBlankString


class OpenAISettingsProperty(OpenAIStrictModel):
    """Reference a schema property by its wire key, including any Pydantic alias."""

    kind: Literal["property"] = "property"
    property: str


class OpenAISettingsTool(OpenAIStrictModel):
    """A layout button invoking a same-server tool accepting an empty object."""

    kind: Literal["tool"] = "tool"
    tool: NonBlankString
    title: NonBlankString
    description: str | None = Field(default=None, exclude_if=lambda value: value is None)


SettingsLayoutLeaf = Annotated[
    OpenAISettingsProperty | OpenAISettingsTool, Field(discriminator="kind")
]


class OpenAISettingsGroup(OpenAIStrictModel):
    """An ordered section of settings and buttons. Groups cannot contain groups."""

    kind: Literal["group"] = "group"
    title: NonBlankString
    items: list[SettingsLayoutLeaf]


OpenAISettingsLayoutItem = OpenAISettingsGroup


class OpenAISettingsFieldPresentation(OpenAIStrictModel):
    title: NonBlankString
    description: str | None = None


class OpenAISettingsReadResult(OpenAIStrictModel):
    settings_schema: dict[str, JsonValue] = Field(alias="schema")
    layout: list[OpenAISettingsLayoutItem] | None = None
    values: dict[str, JsonValue]

    @field_validator("settings_schema")
    @classmethod
    def validate_object_root(cls, schema: dict[str, JsonValue]) -> dict[str, JsonValue]:
        if schema.get("type") != "object":
            raise ValueError('Settings schema must have type "object".')
        return schema

    @model_validator(mode="after")
    def validate_layout_references(self) -> Self:
        properties = self.settings_schema.get("properties", {})
        seen: set[str] = set()
        for item in self.layout or []:
            for entry in item.items:
                if not isinstance(entry, OpenAISettingsProperty):
                    continue
                if (
                    not isinstance(properties, dict)
                    or entry.property not in properties
                    or entry.property in seen
                ):
                    raise ValueError(f"Unknown or duplicate settings key: {entry.property}")
                seen.add(entry.property)
        return self


class OpenAISettingsUpdateArguments(OpenAIStrictModel):
    set: dict[str, JsonValue] = Field(min_length=1)


class OpenAISettingsUpdateResult(OpenAIStrictModel):
    values: dict[str, JsonValue]


ValuesT = TypeVar("ValuesT", bound=BaseModel)
ReadHandler = Callable[[Context[Any, Any]], ValuesT | Awaitable[ValuesT]]
UpdateHandler = Callable[[dict[str, Any], Context[Any, Any]], ValuesT | Awaitable[ValuesT]]


class OpenAISettings(Extension, Generic[ValuesT]):
    identifier = OPENAI_SETTINGS_CAPABILITY_KEY

    def __init__(
        self,
        *,
        schema: type[ValuesT],
        read_tool: str = "settings.read",
        update_tool: str = "settings.update",
        layout: Sequence[OpenAISettingsLayoutItem] | None = None,
    ) -> None:
        if not read_tool.strip() or not update_tool.strip() or read_tool == update_tool:
            raise ValueError("Settings tools must have distinct, nonblank names.")
        if schema.model_config.get("extra") == "allow":
            raise ValueError("Native settings models must not allow extra fields.")
        if any(field.default_factory is not None for field in schema.model_fields.values()):
            raise ValueError("Native settings do not support default factories.")
        definition = schema.model_json_schema(by_alias=True)
        for name, field in definition.get("properties", {}).items():
            enum = field.get("enum")
            if (
                field.get("type") not in ("boolean", "string", "number", "integer")
                or any(key in field for key in ("$ref", "anyOf", "oneOf", "allOf"))
                or (
                    "enum" in field
                    and (
                        field.get("type") != "string"
                        or not isinstance(enum, list)
                        or not enum
                        or any(not isinstance(value, str) for value in cast(list[object], enum))
                    )
                )
            ):
                raise ValueError(
                    f"Unsupported native setting {name!r}: use a boolean, string, "
                    "string enum, number, or integer field."
                )
            if "default" in field:
                raise ValueError("Native settings do not support schema defaults.")
            presentation = {key: field[key] for key in ("title", "description") if key in field}
            try:
                OpenAISettingsFieldPresentation.model_validate(presentation, strict=True)
            except ValidationError as error:
                raise ValueError(f"Invalid presentation for setting {name!r}: {error}") from error
        self._schema = schema
        self._read_tool = read_tool
        self._update_tool = update_tool
        self._layout = OpenAISettingsReadResult.model_validate(
            {"schema": definition, "layout": layout, "values": {}}
        ).layout
        definition["additionalProperties"] = False
        self._definition = definition
        self._read: ReadHandler[ValuesT] | None = None
        self._update: UpdateHandler[ValuesT] | None = None

    def read(self, handler: ReadHandler[ValuesT]) -> ReadHandler[ValuesT]:
        self._read = handler
        return handler

    def update(self, handler: UpdateHandler[ValuesT]) -> UpdateHandler[ValuesT]:
        """Receive only supplied fields, using Python field names, and persist before returning."""
        self._update = handler
        return handler

    def settings(self) -> dict[str, Any]:
        return OpenAISettingsCapability(
            read_tool=self._read_tool, update_tool=self._update_tool
        ).model_dump(by_alias=True)

    async def advertise_legacy_capability(
        self, ctx: ServerRequestContext[Any, Any], call_next: CallNext
    ) -> HandlerResult:
        """Pass as MCPServer middleware alongside extensions=[self] for legacy discovery."""
        result = await call_next(ctx)
        if ctx.method != "initialize":
            return result
        # Python v2 omits extensions from legacy responses. Use its public middleware seam.
        # https://py.sdk.modelcontextprotocol.io/advanced/extensions/#using-an-extension
        initialized = InitializeResult.model_validate(result)
        initialized.capabilities.experimental = {
            **(initialized.capabilities.experimental or {}),
            self.identifier: self.settings(),
        }
        return initialized

    def tools(self) -> Sequence[ToolBinding]:
        read_handler, update_handler = self._read, self._update
        if read_handler is None or update_handler is None:
            raise ValueError(
                "Register both settings read and update handlers before creating the server."
            )

        fields: dict[str, Any] = {}
        for name, original in self._schema.model_fields.items():
            field = copy.copy(original)
            field.default = None
            field.validate_default = False
            field.json_schema_extra = _omit_default
            fields[name] = (field.annotation, field)
        # Whole-model validators require the complete state and belong in the save handler.
        # Keep callbacks bound to the original class so their class helpers remain available.
        validators: dict[str, Callable[..., Any]] = {}
        for name, validator in self._schema.__pydantic_decorators__.field_validators.items():
            info = validator.info
            if info.mode == "after":
                decorate = field_validator(
                    *info.fields, mode="after", check_fields=info.check_fields
                )
            elif info.mode == "wrap":
                decorate = field_validator(
                    *info.fields,
                    mode="wrap",
                    check_fields=info.check_fields,
                    json_schema_input_type=info.json_schema_input_type,
                )
            else:
                decorate = field_validator(
                    *info.fields,
                    mode=info.mode,
                    check_fields=info.check_fields,
                    json_schema_input_type=info.json_schema_input_type,
                )
            validators[name] = decorate(staticmethod(validator.func))
        patch_config = self._schema.model_config.copy()
        patch_config.update(extra="forbid", strict=True, json_schema_extra={"minProperties": 1})
        patch_schema = create_model(
            "SettingsPatch",
            __config__=patch_config,
            __validators__=validators,
            **fields,
        )
        read_result_schema = create_model(
            "SettingsReadResult", __base__=OpenAISettingsReadResult, values=(self._schema, ...)
        )
        update_result_schema = create_model(
            "SettingsUpdateResult", __base__=OpenAISettingsUpdateResult, values=(self._schema, ...)
        )

        async def read_settings(ctx: Context[Any, Any]) -> CallToolResult:
            values = await call_handler(read_handler, ctx)
            values = self._schema.model_validate(values.model_dump(by_alias=True), strict=True)
            result = read_result_schema.model_validate(
                {
                    "schema": self._definition,
                    "layout": self._layout,
                    "values": values,
                }
            )
            payload = result.model_dump(by_alias=True, mode="json")
            if self._layout is None:
                payload.pop("layout")
            return CallToolResult(content=[], structured_content=payload)

        async def update_settings(set: BaseModel, ctx: Context[Any, Any]) -> CallToolResult:
            supplied = set.model_dump(exclude_unset=True, by_alias=False)
            if not supplied:
                raise ValueError("Set at least one setting.")
            values = await call_handler(update_handler, supplied, ctx)
            values = self._schema.model_validate(values.model_dump(by_alias=True), strict=True)
            result = update_result_schema.model_validate({"values": values})
            return CallToolResult(
                content=[], structured_content=result.model_dump(by_alias=True, mode="json")
            )

        read_settings.__annotations__["return"] = Annotated[CallToolResult, read_result_schema]
        update_settings.__annotations__["set"] = patch_schema
        update_settings.__annotations__["return"] = Annotated[CallToolResult, update_result_schema]
        return (
            ToolBinding(
                fn=read_settings,
                kwargs={
                    "name": self._read_tool,
                    "annotations": ToolAnnotations(read_only_hint=True),
                },
            ),
            ToolBinding(fn=update_settings, kwargs={"name": self._update_tool}),
        )


def _omit_default(schema: dict[str, Any]) -> None:
    schema.pop("default", None)
