"""Native MCP Python SDK integration for OpenAI server extensions."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Literal

from mcp.server.elicitation import ElicitationResult, ElicitSchemaModelT
from mcp.server.extension import Extension, ToolBinding
from mcp.server.mcpserver.context import Context
from typing_extensions import deprecated

from openai_mcp_extensions._middleware import middleware
from openai_mcp_extensions.form import elicit_form, request_form_input
from openai_mcp_extensions.mentions import OpenAIMentions


class OpenAIExtensions(Extension):
    """Compose OpenAI-specific server behavior into an MCP Python server."""

    identifier = "openai/extensions"
    middleware = staticmethod(middleware)
    request_input = staticmethod(request_form_input)

    def __init__(self) -> None:
        self.mentions = OpenAIMentions()

    def tools(self) -> Sequence[ToolBinding]:
        """Contribute only the OpenAI tools explicitly configured by the server."""

        return self.mentions.tools()

    async def elicit_input_legacy(
        self,
        context: Context[Any, Any],
        *,
        mode: Literal["form"],
        message: str,
        schema: type[ElicitSchemaModelT],
    ) -> ElicitationResult[ElicitSchemaModelT]:
        """Request input on connections that predate MCP 2026-07-28.

        Tool handlers on newer connections should use request_input for MRTR.
        """

        if mode != "form":
            raise ValueError("Unsupported OpenAI elicitation mode")
        return await elicit_form(context, message=message, schema=schema)

    @deprecated("Use elicit_input_legacy.")
    async def elicit_input(
        self,
        context: Context[Any, Any],
        *,
        mode: Literal["form"],
        message: str,
        schema: type[ElicitSchemaModelT],
    ) -> ElicitationResult[ElicitSchemaModelT]:
        return await self.elicit_input_legacy(context, mode=mode, message=message, schema=schema)
