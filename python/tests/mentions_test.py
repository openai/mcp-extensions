from typing import Any

import httpx2
import pytest
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.context import Context
from mcp_types import CallToolResult
from pydantic import ValidationError

from openai_mcp_extensions import (
    OpenAIExtensions,
    OpenAIMentionResource,
    OpenAIMentions,
    OpenAIMentionSearchParams,
    OpenAIMentionSearchResult,
)


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def test_mention_models_accept_query_only_and_reject_groups() -> None:
    assert OpenAIMentionSearchParams.model_validate({"query": ""}).query == ""
    with pytest.raises(ValidationError):
        OpenAIMentionSearchResult.model_validate(
            {"items": [{"type": "group", "id": "recent", "title": "Recent issues"}]}
        )


@pytest.mark.anyio
@pytest.mark.parametrize("extra_arguments", [{}, {"path": []}])
async def test_registered_mention_tool_accepts_query_without_path(
    extra_arguments: dict[str, list[str]],
) -> None:
    extensions = OpenAIExtensions()

    @extensions.mentions.search
    async def search_mentions(
        params: OpenAIMentionSearchParams,
        context: Context[Any, Any],
    ) -> OpenAIMentionSearchResult:
        return OpenAIMentionSearchResult(
            items=[
                OpenAIMentionResource(
                    resource_uri=f"mcp://issues/{params.query}",
                    title=params.query,
                )
            ]
        )

    server = MCPServer("mentions-test", extensions=[extensions])
    tools = await server.list_tools()
    assert len(tools) == 1
    assert tools[0].input_schema["required"] == ["query"]
    assert tools[0].annotations is not None
    assert tools[0].annotations.read_only_hint is True

    result = await server.call_tool("search_mentions", {"query": "APP-104", **extra_arguments})
    assert isinstance(result, CallToolResult)
    assert not result.is_error
    assert result.content == []
    assert result.structured_content is not None
    assert result.structured_content["items"][0]["resourceUri"] == "mcp://issues/APP-104"
    assert result.structured_content["items"][0]["type"] == "resource"


def test_unconfigured_native_mentions_are_rejected() -> None:
    with pytest.raises(ValueError, match="Register a mention search handler"):
        MCPServer("unconfigured", extensions=[OpenAIMentions()])


@pytest.mark.anyio
async def test_native_mentions_capability_coexists_with_general_extensions() -> None:
    mentions = OpenAIMentions()

    @mentions.search
    async def search_mentions(
        params: OpenAIMentionSearchParams,
        context: Context[Any, Any],
    ) -> OpenAIMentionSearchResult:
        return OpenAIMentionSearchResult(items=[])

    server = MCPServer("mentions-test", extensions=[OpenAIExtensions(), mentions])
    app = server.streamable_http_app(stateless_http=True, json_response=True)
    async with server.session_manager.run():
        async with httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app), base_url="http://127.0.0.1:8000"
        ) as client:
            response = await client.post(
                "/mcp",
                headers={
                    "Accept": "application/json, text/event-stream",
                    "MCP-Protocol-Version": "2026-07-28",
                    "MCP-Method": "server/discover",
                },
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "server/discover",
                    "params": {
                        "_meta": {
                            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                            "io.modelcontextprotocol/clientCapabilities": {},
                        }
                    },
                },
            )
            assert response.status_code == 200
            assert response.json()["result"]["capabilities"]["extensions"]["openai/mentions"] == {
                "searchTool": "search_mentions"
            }
    tools = await server.list_tools()
    assert len(tools) == 1
    assert tools[0].name == "search_mentions"
    assert tools[0].annotations is not None and tools[0].annotations.read_only_hint is True
    result = await server.call_tool("search_mentions", {"query": "bolt"})
    assert isinstance(result, CallToolResult)
    assert not result.is_error
    assert result.structured_content == {"items": []}
