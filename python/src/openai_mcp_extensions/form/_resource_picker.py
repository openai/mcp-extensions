"""Resource-picker metadata for Pydantic fields."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Literal

from mcp_types import Resource
from pydantic import JsonValue
from typing_extensions import NotRequired, TypedDict

OPENAI_INPUT_KEY = "x-openai-input"


class UserResourceOptions(TypedDict):
    """Settings for adding user-selected files or directories."""

    kind: NotRequired[Literal["file", "directory"]]
    accept: NotRequired[list[str]]


FileUserOptions = UserResourceOptions


def resource_input(
    *,
    options: Sequence[Resource] = (),
    selection: Literal["implicit", "explicit"] | None = None,
    user_options: UserResourceOptions | None = None,
) -> dict[str, JsonValue]:
    """Build resource-picker metadata for ``Field(json_schema_extra=...)``.

    Implicit selection always allows user-selected files. Otherwise, pass
    ``UserResourceOptions()`` to allow them. The field's type determines single or multiple
    selection.
    """
    return _input("resource", options, selection, user_options)


def file_input(
    *,
    options: Sequence[Resource] = (),
    selection: Literal["implicit", "explicit"] | None = None,
    user_options: UserResourceOptions | None = None,
) -> dict[str, JsonValue]:
    """Build file-picker metadata with the legacy ``file`` discriminator."""
    return _input("file", options, selection, user_options)


def _input(
    input_type: Literal["resource", "file"],
    options: Sequence[Resource],
    selection: Literal["implicit", "explicit"] | None,
    user_options: UserResourceOptions | None,
) -> dict[str, JsonValue]:
    metadata: dict[str, Any] = {
        "type": input_type,
        "options": [
            option.model_dump(mode="json", by_alias=True, exclude_none=True) for option in options
        ],
    }
    if selection is not None:
        metadata["selection"] = selection
    if user_options is not None:
        metadata["userOptions"] = user_options
    return {OPENAI_INPUT_KEY: metadata}
