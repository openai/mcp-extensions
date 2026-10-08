"""OpenAI MCP App entrypoint and display metadata."""

from __future__ import annotations

from typing import Annotated, Literal

from mcp_types import Icon
from pydantic import Field, JsonValue, StringConstraints
from typing_extensions import deprecated

from openai_mcp_extensions._models import NonBlankString, OpenAIStrictModel

FileExtension = Annotated[str, StringConstraints(strip_whitespace=True, pattern=r"^\.")]
SearchTerm = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class OpenAIUiQuickActionToolTarget(OpenAIStrictModel):
    """A tool in the entrypoint's app and its fixed arguments."""

    type: Literal["tool"] = "tool"
    name: NonBlankString
    arguments: dict[str, JsonValue] | None = None


class OpenAIUiQuickAction(OpenAIStrictModel):
    """A sidebar shortcut that invokes a tool in the same MCP App."""

    title: NonBlankString
    icons: list[Icon] = Field(min_length=1)
    target: OpenAIUiQuickActionToolTarget = Field(discriminator="type")


class OpenAIFileEntrypoint(OpenAIStrictModel):
    """Open an MCP App when a supported file is selected."""

    type: Literal["file"] = "file"
    extensions: list[FileExtension]


class OpenAIGlobalEntrypoint(OpenAIStrictModel):
    """Open an MCP App from the global sidebar."""

    type: Literal["global"] = "global"
    quick_action: OpenAIUiQuickAction | None = None


@deprecated("Use structured settings via openai/settings.", category=None)
class OpenAISettingsEntrypoint(OpenAIStrictModel):
    """Deprecated settings app entrypoint, retained for compatibility."""

    type: Literal["settings"] = "settings"
    search_terms: list[SearchTerm] | None = None


class OpenAIThreadEntrypoint(OpenAIStrictModel):
    """Open an MCP App from a conversation side panel."""

    type: Literal["thread"] = "thread"


OpenAIUiEntrypoint = Annotated[
    OpenAIFileEntrypoint
    | OpenAIGlobalEntrypoint
    | OpenAISettingsEntrypoint
    | OpenAIThreadEntrypoint,
    Field(discriminator="type"),
]


class OpenAIUiToolMetadata(OpenAIStrictModel):
    """Tool metadata carried in ``_meta["openai/ui"]``."""

    entrypoints: list[OpenAIUiEntrypoint] | None = None
    preferred_model_display_mode: Literal["inline", "fullscreen"] | None = None


class OpenAIUiResourceMetadata(OpenAIStrictModel):
    """UI resource content metadata carried in ``_meta["openai/ui"]``."""

    available_display_modes: list[Literal["inline", "fullscreen", "pip"]] | None = None
    preferred_display_mode: Literal["inline", "fullscreen", "pip"] | None = None
