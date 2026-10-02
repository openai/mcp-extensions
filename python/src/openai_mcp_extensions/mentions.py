"""App-visible composer mention search."""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable, Sequence
from typing import Annotated, Any, Literal

from mcp.server.extension import Extension, ToolBinding
from mcp.server.mcpserver.context import Context
from mcp_types import CallToolResult, Icon, ResourceLink, ToolAnnotations
from pydantic import Field

from openai_mcp_extensions._models import NonBlankString, OpenAIModel, OpenAIStrictModel

OPENAI_MENTIONS_CAPABILITY_KEY = "openai/mentions"


class OpenAIMentionsCapability(OpenAIModel):
    search_tool: NonBlankString


class OpenAIMentionResource(OpenAIStrictModel):
    """One selectable MCP resource returned by mention search."""

    type: Literal["resource"] = "resource"
    resource_uri: NonBlankString
    title: NonBlankString
    subtitle: NonBlankString | None = None
    icons: list[Icon] | None = None


OpenAIMentionItem = Annotated[
    ResourceLink | OpenAIMentionResource,
    Field(discriminator="type"),
]


class OpenAIMentionSearchParams(OpenAIModel):
    """A composer mention-search request."""

    query: str


class OpenAIMentionSearchResult(OpenAIStrictModel):
    """Selectable resources returned by mention search."""

    items: list[OpenAIMentionItem]


OpenAIMentionSearchHandler = Callable[
    [OpenAIMentionSearchParams, Context[Any, Any]],
    OpenAIMentionSearchResult | Awaitable[OpenAIMentionSearchResult],
]


class OpenAIMentions(Extension):
    """Register one app-visible mention-search handler."""

    identifier = OPENAI_MENTIONS_CAPABILITY_KEY

    def __init__(self) -> None:
        self._handler: OpenAIMentionSearchHandler | None = None

    def settings(self) -> dict[str, Any]:
        if self._handler is None:
            raise ValueError("Register a mention search handler before adding the extension.")
        return OpenAIMentionsCapability(search_tool="search_mentions").model_dump(by_alias=True)

    def search(self, handler: OpenAIMentionSearchHandler) -> OpenAIMentionSearchHandler:
        """Register or replace the mention-search handler."""

        self._handler = handler
        return handler

    def tools(self) -> Sequence[ToolBinding]:
        """Contribute mention search only when a handler has been registered."""

        if self._handler is None:
            return ()

        async def search_mentions(
            query: str,
            ctx: Context[Any, Any],
        ) -> Annotated[CallToolResult, OpenAIMentionSearchResult]:
            params = OpenAIMentionSearchParams(query=query)
            handler = self._handler
            if handler is None:
                result = OpenAIMentionSearchResult(items=[])
            else:
                handled = handler(params, ctx)
                result = await handled if inspect.isawaitable(handled) else handled

            return CallToolResult(
                content=[],
                structured_content=result.model_dump(by_alias=True, exclude_none=True, mode="json"),
            )

        return (
            ToolBinding(
                fn=search_mentions,
                kwargs={"annotations": ToolAnnotations(read_only_hint=True)},
                meta={
                    "openai/extensions": {"mentions/search": {}},
                    "ui": {"visibility": ["app"]},
                },
            ),
        )
