"""Stdio server for cross-SDK form elicitation tests."""

from typing import Any

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.context import Context
from mcp_types import CallToolResult, InputRequiredResult, Resource
from pydantic import AnyUrl, BaseModel, Field

from openai_mcp_extensions import OpenAIExtensions
from openai_mcp_extensions.form import resource_input


class Submission(BaseModel):
    code: str = Field(
        pattern="^[A-Z]{3}$",
        json_schema_extra={"x-openai-suggestions": [{"const": "ABC", "title": "Example"}]},
    )
    images: list[AnyUrl] = Field(
        min_length=1,
        max_length=2,
        json_schema_extra=resource_input(
            options=[
                Resource(
                    uri="file:///image.png",
                    name="image.png",
                    _meta={"openai/thumbnail": {"src": "https://example.com/image.png"}},
                )
            ]
        ),
    )


class Confirmation(BaseModel):
    confirmed: bool


extensions = OpenAIExtensions()
server = MCPServer("mrtr-python", middleware=[extensions.middleware])


@server.tool()
async def choose(
    context: Context[Any, Any], label: str = "form", confirm: bool = False
) -> CallToolResult | InputRequiredResult:
    state = context.request_state
    if state is None:
        result = extensions.request_input(context, key="details", message=label, schema=Submission)
        if isinstance(result, InputRequiredResult):
            return result
        if result.action != "accept":
            return CallToolResult(content=[], structured_content={"action": result.action})
        submission = result.data
        if not confirm:
            return CallToolResult(
                content=[],
                structured_content={
                    "action": "accept",
                    "content": submission.model_dump(mode="json"),
                },
            )
    else:
        submission = Submission.model_validate_json(state)

    confirmation = extensions.request_input(
        context,
        key="confirmation",
        message="Confirm",
        schema=Confirmation,
        request_state=submission.model_dump_json(),
    )
    if isinstance(confirmation, InputRequiredResult):
        return confirmation
    return CallToolResult(
        content=[],
        structured_content={
            "action": confirmation.action,
            "content": submission.model_dump(mode="json"),
            "confirmed": confirmation.data.confirmed if confirmation.action == "accept" else False,
        },
    )


if __name__ == "__main__":
    server.run()
