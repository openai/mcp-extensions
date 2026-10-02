import os
import sys
from pathlib import Path
from typing import Any, Literal

import pytest
from mcp import Client
from mcp.client.extension import advertise
from mcp.client.session import ClientRequestContext
from mcp.client.stdio import StdioServerParameters, stdio_client
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.context import Context
from mcp_types import (
    ElicitRequestFormParams,
    ElicitRequestParams,
    ElicitResult,
    InputRequiredResult,
)
from pydantic import BaseModel

from openai_mcp_extensions import OpenAIExtensions

CONTENT: dict[str, str | int | float | bool | list[str] | None] = {
    "code": "ABC",
    "images": ["file:///image.png"],
}


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(params=["python", "typescript"])
def server_parameters(request: pytest.FixtureRequest) -> StdioServerParameters:
    if request.param == "python":
        return StdioServerParameters(
            command=sys.executable, args=[str(Path(__file__).parent / "fixtures/mrtr_server.py")]
        )
    path = os.environ.get("MCP_MRTR_TS_SERVER")
    if path is None:
        pytest.skip(
            "Set MCP_MRTR_TS_SERVER to the compiled TypeScript fixture for interoperability tests"
        )
    return StdioServerParameters(command="node", args=[path])


@pytest.mark.anyio
@pytest.mark.parametrize("action", ["accept", "decline", "cancel"])
@pytest.mark.parametrize("confirm", [False, True])
async def test_mrtr_over_stdio(
    server_parameters: StdioServerParameters,
    action: Literal["accept", "decline", "cancel"],
    confirm: bool,
) -> None:
    messages: list[str] = []

    async def answer(context: ClientRequestContext, params: ElicitRequestParams) -> ElicitResult:
        assert isinstance(params, ElicitRequestFormParams)
        assert params.meta is not None
        form = params.meta["openai/elicitation"]["requestedSchema"]
        messages.append(params.message)
        if params.message == "Confirm":
            return ElicitResult(action="accept", content={"confirmed": True})
        assert form["properties"]["code"]["pattern"] == "^[A-Z]{3}$"
        assert form["properties"]["code"]["x-openai-suggestions"] == [
            {"const": "ABC", "title": "Example"}
        ]
        resource = form["properties"]["images"]["x-openai-input"]["options"][0]
        assert resource["_meta"]["openai/thumbnail"] == {"src": "https://example.com/image.png"}
        return ElicitResult(action=action, content=CONTENT if action == "accept" else None)

    async with Client(
        stdio_client(server_parameters),
        mode="2026-07-28",
        elicitation_callback=answer,
        extensions=[advertise("openai/elicitation", {"form": {}})],
    ) as client:
        result = await client.call_tool("choose", {"confirm": confirm})
    assert not result.is_error, result
    expected: dict[str, Any] = {"action": action}
    if action == "accept":
        expected["content"] = CONTENT
        if confirm:
            expected["confirmed"] = True
    assert result.structured_content == expected
    assert messages == (["form", "Confirm"] if confirm and action == "accept" else ["form"])


@pytest.mark.anyio
async def test_missing_middleware_fails_before_sending_a_form() -> None:
    class Form(BaseModel):
        name: str

    server = MCPServer("missing-middleware")
    extensions = OpenAIExtensions()

    @server.tool()
    async def choose(context: Context[Any, Any]) -> InputRequiredResult:
        result = extensions.request_input(context, key="form", message="Name", schema=Form)
        assert isinstance(result, InputRequiredResult)
        return result

    async def answer(context: ClientRequestContext, params: ElicitRequestParams) -> ElicitResult:
        pytest.fail("A server without middleware must not send an incomplete form")

    async with Client(
        server,
        mode="2026-07-28",
        elicitation_callback=answer,
        extensions=[advertise("openai/elicitation", {"form": {}})],
    ) as client:
        result = await client.call_tool("choose")
    assert result.is_error
