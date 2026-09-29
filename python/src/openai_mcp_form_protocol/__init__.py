"""Shared OpenAI form schemas and validation of unchanged JSON answers."""

from __future__ import annotations

import math
import re
from collections.abc import Collection, Mapping, Sequence
from datetime import date, datetime
from typing import Annotated, Generic, Literal, TypeVar, cast
from urllib.parse import urlsplit

from email_validator import validate_email
from mcp_types import Icon, Resource, ResourceLink
from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator
from rfc3986_validator import validate_rfc3986

__all__ = [
    "FormField",
    "FormModel",
    "FormSchema",
    "McpAppToolTarget",
    "PreviewTarget",
    "complete_field_submission",
    "is_valid_value",
    "prepare_field_submission",
    "validate_file_selections",
    "validate_form_selections",
]


class FormModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class McpAppToolTarget(FormModel):
    type: Literal["mcp_app_tool"] = "mcp_app_tool"
    name: str = Field(pattern=r"\S")
    arguments: dict[str, JsonValue] | None = None


PreviewTarget = Annotated[McpAppToolTarget | ResourceLink, Field(discriminator="type")]


class _OptionAnnotations(FormModel):
    thumbnail: Icon | None = Field(default=None, alias="x-openai-thumbnail")
    preview: Icon | None = Field(default=None, alias="x-openai-preview")

    @model_validator(mode="after")
    def validate_annotations(self) -> _OptionAnnotations:
        for name, icon in (("thumbnail", self.thumbnail), ("preview", self.preview)):
            if icon is None:
                if name in self.model_fields_set:
                    raise ValueError("Form thumbnail must be an icon")
                continue
            src = icon.src
            url = urlsplit(src)
            if not (
                (url.scheme == "https" and url.netloc)
                or re.fullmatch(r"data:image/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/]+={0,2}", src)
            ):
                raise ValueError("Form thumbnail requires HTTPS or an image data URI")
        return self


class _FormOption(_OptionAnnotations):
    const: str
    title: str
    description: str | None = None


class _StringConstraints(FormModel):
    min_length: int | None = Field(default=None, alias="minLength", ge=0)
    max_length: int | None = Field(default=None, alias="maxLength", ge=0)
    pattern: str | None = None
    format: Literal["email", "uri", "date", "date-time"] | None = None
    suggestions: list[_FormOption] | None = Field(default=None, alias="x-openai-suggestions")

    @model_validator(mode="after")
    def validate_string_constraints(self) -> _StringConstraints:
        if "pattern" in self.model_fields_set and self.pattern is None:
            raise ValueError("Form pattern must be a string")
        if self.min_length is not None and self.max_length is not None:
            if self.min_length > self.max_length:
                raise ValueError("Form field has inconsistent bounds")
        return self


class _StringSchema(_StringConstraints):
    type: Literal["string"]
    title: str | None = None
    description: str | None = None
    default: str | None = None

    @model_validator(mode="after")
    def validate_default(self) -> _StringSchema:
        if "default" in self.model_fields_set and (
            self.default is None or not _valid_string(self, self.default)
        ):
            raise ValueError("Form item has an invalid default")
        return self


class _UserResourceOptions(FormModel):
    kind: Literal["file", "directory"] = "file"
    accept: list[str] | None = None

    @model_validator(mode="after")
    def validate_accept(self) -> _UserResourceOptions:
        if self.accept is None:
            if "accept" in self.model_fields_set:
                raise ValueError("File accept must be a string array")
            return self

        mime_token = r"[!#$%&'*+.^_`|~0-9A-Za-z-]+"
        ascii_lower = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")
        seen: set[str] = set()
        for token in self.accept:
            # Each array entry is one HTML accept token, without surrounding whitespace.
            if (
                not token
                or token != token.strip(" \t\n\r\f")
                or "," in token
                or not (token.startswith(".") or re.fullmatch(f"{mime_token}/{mime_token}", token))
            ):
                raise ValueError("File accept contains an invalid token")
            normalized = token.translate(ascii_lower)
            if normalized in seen:
                raise ValueError("File accept contains duplicate tokens")
            seen.add(normalized)
        return self


class _ResourceOption(Resource):
    model_config = ConfigDict(extra="allow", strict=True)


class _ResourceInput(FormModel):
    type: Literal["resource", "file"]
    options: list[_ResourceOption]
    selection: Literal["explicit", "implicit"] | None = None
    user_options: _UserResourceOptions | None = Field(default=None, alias="userOptions")

    @model_validator(mode="after")
    def validate_options(self) -> _ResourceInput:
        if self.selection == "implicit" and self.user_options is None:
            self.user_options = _UserResourceOptions()
        if any(not _valid_uri(option.uri) for option in self.options):
            raise ValueError("Resource input contains an invalid URI")
        if len({option.uri for option in self.options}) != len(self.options):
            raise ValueError("Resource input contains duplicate choices")
        return self


class _ArrayOptions(FormModel):
    type: Literal["string"] | None = None
    enum: list[str] | None = None
    any_of: list[_FormOption] | None = Field(default=None, alias="anyOf")

    @model_validator(mode="after")
    def validate_options(self) -> _ArrayOptions:
        if (self.enum is None) == (self.any_of is None):
            raise ValueError("Multi-select requires one set of choices")
        if self.any_of is not None:
            _validate_options(self.any_of)
        elif not self.enum or len(set(self.enum)) != len(self.enum):
            raise ValueError("Multi-select choices must be nonempty and unique")
        return self


class FormField(_StringConstraints):
    type: Literal["string", "integer", "number", "boolean", "array"]
    title: str | None = None
    description: str | None = None
    default: JsonValue = None
    examples: list[JsonValue] | None = None
    comment: str | None = Field(default=None, alias="$comment")
    meta: dict[str, JsonValue] | None = Field(default=None, alias="_meta")
    deprecated: bool | None = None
    read_only: bool | None = Field(default=None, alias="readOnly")
    write_only: bool | None = Field(default=None, alias="writeOnly")
    minimum: int | float | None = Field(default=None, allow_inf_nan=False)
    maximum: int | float | None = Field(default=None, allow_inf_nan=False)
    enum: list[JsonValue] | None = None
    enum_names: list[str] | None = Field(default=None, alias="enumNames")
    one_of: list[_FormOption] | None = Field(default=None, alias="oneOf")
    items: _ArrayOptions | _StringSchema | None = None
    min_items: int | None = Field(default=None, alias="minItems", ge=0)
    max_items: int | None = Field(default=None, alias="maxItems", ge=0)
    unique_items: bool | None = Field(default=None, alias="uniqueItems")
    file_input: _ResourceInput | None = Field(default=None, alias="x-openai-input")

    @property
    def options(self) -> Sequence[_FormOption]:
        if isinstance(self.items, _ArrayOptions):
            return self.items.any_of or ()
        if isinstance(self.items, _StringSchema):
            return self.items.suggestions or ()
        return self.one_of or self.suggestions or ()

    @property
    def has_pattern(self) -> bool:
        return "pattern" in self.model_fields_set or (
            isinstance(self.items, _StringSchema) and self.items.pattern is not None
        )

    @property
    def has_previews(self) -> bool:
        return any(
            option.thumbnail is not None or option.preview is not None for option in self.options
        )

    @property
    def has_custom_values(self) -> bool:
        return self.suggestions is not None or (
            self.file_input is None and isinstance(self.items, _StringSchema)
        )

    @model_validator(mode="after")
    def validate_constraints(self) -> FormField:
        for types, constraints in (
            (
                {"string"},
                {
                    "min_length",
                    "max_length",
                    "pattern",
                    "format",
                    "one_of",
                    "suggestions",
                    "enum_names",
                },
            ),
            ({"number", "integer"}, {"minimum", "maximum"}),
            ({"array"}, {"items", "min_items", "max_items", "unique_items"}),
        ):
            if self.type not in types and self.model_fields_set & constraints:
                raise ValueError("Form constraint does not apply to this field type")
        for lower, upper in (
            (self.minimum, self.maximum),
            (self.min_items, self.max_items),
        ):
            if lower is not None and upper is not None and lower > upper:
                raise ValueError("Form field has inconsistent bounds")
        if self.type == "array" and self.items is None:
            raise ValueError("Array field requires an item schema")
        if isinstance(self.items, _ArrayOptions) and self.unique_items is False:
            raise ValueError("Multi-select choices must be unique")
        if "file_input" in self.model_fields_set and self.file_input is None:
            raise ValueError("Resource input must be an object")
        if self.file_input is not None:
            resource_field = self.items if isinstance(self.items, _StringSchema) else self
            if resource_field.type != "string" or resource_field.format != "uri":
                raise ValueError("Resource input requires a URI string or array")
            if self.file_input.selection is not None and self.type != "array":
                raise ValueError("Resource selection mode requires an array")
            if self.file_input.selection == "implicit" and "default" in self.model_fields_set:
                raise ValueError("Implicit resource selection cannot specify a default")
        if self.one_of is not None:
            _validate_options(self.one_of)
        if self.enum_names is not None and (
            self.enum is None or len(self.enum_names) != len(self.enum)
        ):
            raise ValueError("Enum labels must match its choices")
        if self.enum is not None and (
            not self.enum or any(not _valid_value(self, option) for option in self.enum)
        ):
            raise ValueError("Form field has invalid enum choices")
        if "default" in self.model_fields_set and not _valid_value(self, self.default):
            raise ValueError("Form field has an invalid default")
        return self


FieldT = TypeVar("FieldT", bound=FormModel)


class FormSchema(FormModel, Generic[FieldT]):
    schema_uri: str | None = Field(default=None, alias="$schema")
    type: Literal["object"]
    title: str | None = None
    description: str | None = None
    properties: dict[str, FieldT]
    required: list[str] = Field(default_factory=list)
    additional_properties: Literal[False] | None = Field(default=None, alias="additionalProperties")

    @model_validator(mode="after")
    def validate_fields(self) -> FormSchema[FieldT]:
        if not set(self.required).issubset(self.properties):
            raise ValueError("Form requires an unknown field")
        return self

    def validate_submission_fields(self, submitted: Collection[str]) -> None:
        if not set(self.required).issubset(submitted) or not set(submitted).issubset(
            self.properties
        ):
            raise ValueError("Invalid form fields")


def prepare_field_submission(
    field: FormField,
    name: str,
    content: Mapping[str, JsonValue],
    *,
    pending_uploads: int = 0,
) -> tuple[str, ...] | None:
    """Validate an answer before uploads and return its upload accept filters."""
    if pending_uploads < 0:
        raise ValueError("Invalid form fields")
    if pending_uploads:
        file_options = field.file_input.user_options if field.file_input else None
        if file_options is None:
            raise ValueError("Form field does not accept files")
        if field.type == "array":
            if not is_valid_value(field, content.get(name, []), pending_uploads=pending_uploads):
                raise ValueError("Invalid form value")
        elif pending_uploads != 1 or name in content:
            raise ValueError("Invalid form fields")
        return tuple(file_options.accept) if file_options.accept is not None else None

    if name in content and not is_valid_value(field, content[name]):
        raise ValueError("Invalid form value")
    return None


def complete_field_submission(
    field: FormField,
    name: str,
    content: Mapping[str, JsonValue],
    uploaded_uris: tuple[str, ...],
) -> JsonValue:
    """Combine selections with host-authorized uploads and validate the final answer."""
    if not uploaded_uris:
        raise ValueError("Invalid form fields")
    prepare_field_submission(field, name, content, pending_uploads=len(uploaded_uris))
    value: JsonValue = uploaded_uris[0]
    if field.type == "array":
        selected = content.get(name, [])
        assert isinstance(selected, list)
        value = [*selected, *uploaded_uris]
    if not is_valid_value(field, value, uploaded_uris=uploaded_uris):
        raise ValueError("Uploaded file does not match the form constraints")
    return value


def is_valid_value(
    field: FormField,
    value: object,
    *,
    pending_uploads: int = 0,
    uploaded_uris: tuple[str, ...] = (),
) -> bool:
    """Validate JSON without coercion or defaults; patterns require another validator."""
    if field.has_pattern:
        raise ValueError("Form patterns require an ECMA-262 validator")
    return _valid_value(
        field,
        value,
        pending_uploads=pending_uploads,
        uploaded_uris=uploaded_uris,
    )


def validate_file_selections(schema: FormSchema[FormField], content: Mapping[str, object]) -> None:
    """Check returned resource URIs before the server's typed model validation."""
    for name, field in schema.properties.items():
        if (
            field.file_input is not None
            and name in content
            and not _valid_value(field, content[name], allow_user_files=True)
        ):
            raise ValueError(f"Invalid resource selection for {name!r}")


def validate_form_selections(schema: FormSchema[FormField], content: Mapping[str, object]) -> None:
    """Check resource and choice constraints before the server's typed model validation."""
    validate_file_selections(schema, content)
    for name, field in schema.properties.items():
        if field.options and name in content and not _valid_value(field, content[name]):
            raise ValueError(f"Invalid selection for {name!r}")


def _valid_value(
    field: FormField,
    value: object,
    *,
    pending_uploads: int = 0,
    uploaded_uris: tuple[str, ...] = (),
    allow_user_files: bool = False,
) -> bool:
    if field.file_input is not None and not (
        allow_user_files and field.file_input.user_options is not None
    ):
        choices = {option.uri for option in field.file_input.options}
        choices.update(uploaded_uris)
        selected = cast(list[object], value) if isinstance(value, list) else [value]
        if any(not isinstance(uri, str) or uri not in choices for uri in selected):
            return False
    if (
        not pending_uploads
        and field.enum is not None
        and not any(
            value == option and isinstance(value, bool) == isinstance(option, bool)
            for option in field.enum
        )
    ):
        return False
    if field.type == "string":
        return (
            isinstance(value, str)
            and (field.one_of is None or any(option.const == value for option in field.one_of))
            and _valid_string(field, value)
        )
    if field.type == "boolean":
        return isinstance(value, bool)
    if field.type == "array":
        if not isinstance(value, list) or field.items is None:
            return False
        value = cast(list[object], value)
        count = len(value) + pending_uploads
        if (field.min_items is not None and count < field.min_items) or (
            field.max_items is not None and count > field.max_items
        ):
            return False
        if isinstance(field.items, _StringSchema):
            return all(
                isinstance(item, str) and _valid_string(field.items, item) for item in value
            ) and (not field.unique_items or len(set(value)) == len(value))
        return all(
            isinstance(item, str)
            and (
                item in field.items.enum
                if field.items.enum is not None
                else any(option.const == item for option in field.items.any_of or [])
            )
            for item in value
        ) and len(set(value)) == len(value)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if field.type == "integer" and not isinstance(value, int):
        return False
    if isinstance(value, float) and not math.isfinite(value):
        return False
    return (field.minimum is None or value >= field.minimum) and (
        field.maximum is None or value <= field.maximum
    )


def _validate_options(options: Sequence[_FormOption]) -> None:
    choices = [option.const for option in options]
    if not choices or len(set(choices)) != len(choices):
        raise ValueError("Selection requires nonempty, unique supplied choices")


def _valid_uri(value: str) -> bool:
    # The RFC3986 validator incorrectly accepts a trailing newline.
    return bool(validate_rfc3986(value)) and not value.endswith("\n")


def _valid_string(field: _StringConstraints, value: str) -> bool:
    if (field.min_length is not None and len(value) < field.min_length) or (
        field.max_length is not None and len(value) > field.max_length
    ):
        return False
    try:
        if field.format == "email":
            validate_email(value, check_deliverability=False, test_environment=True)
        elif field.format == "uri":
            return _valid_uri(value)
        elif field.format == "date":
            if re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value) is None:
                return False
            date.fromisoformat(value)
        elif field.format == "date-time":
            pattern = (
                r"[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}"
                r"(?:\.[0-9]+)?(?:[Zz]|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])"
            )
            if re.fullmatch(pattern, value) is None:
                return False
            datetime.fromisoformat(value[:19])
    except ValueError:
        return False
    return True
