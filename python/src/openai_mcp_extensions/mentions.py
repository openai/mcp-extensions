"""App-visible composer mention search."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from typing import Annotated, Any, Literal

from mcp.server.extension import ToolBinding
from mcp.server.mcpserver.context import Context
from mcp_types import CallToolResult, Icon, ResourceLink, ToolAnnotations
from pydantic import Field

from openai_mcp_extensions._handlers import call_handler
from openai_mcp_extensions._models import NonBlankString, OpenAIModel, OpenAIStrictModel


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


class OpenAIMentions:
    """Register one app-visible mention-search handler."""

    def __init__(self) -> None:
        self._handler: OpenAIMentionSearchHandler | None = None

    def search(self, handler: OpenAIMentionSearchHandler) -> OpenAIMentionSearchHandler:
        """Register or replace a handler; synchronous handlers run in a worker thread."""

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
            assert handler is not None  # tools() only binds this tool after registration.
            result = await call_handler(handler, params, ctx)

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
