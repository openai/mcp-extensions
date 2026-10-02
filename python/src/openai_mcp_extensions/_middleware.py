"""Shared middleware for OpenAI server extensions."""

from typing import Any

from mcp.server.context import CallNext, HandlerResult, ServerRequestContext

from openai_mcp_extensions.form._elicitation import OPENAI_ELICITATION_EXTENSION_ID
from openai_mcp_extensions.form._mrtr import request_schemas


async def middleware(ctx: ServerRequestContext[Any, Any], call_next: CallNext) -> HandlerResult:
    """Preserve OpenAI form fields in MCP responses."""
    # Keep form schemas separate for each server request.
    schemas: dict[str, dict[str, Any]] = {}
    token = request_schemas.set(schemas)
    try:
        result = await call_next(ctx)
        # The Python SDK drops form metadata when preparing the response.
        # Put it back until the SDK preserves it.
        # https://github.com/modelcontextprotocol/python-sdk/blob/f1b6589088534632fef92238ee9750951e3c0185/src/mcp/server/runner.py#L341
        if isinstance(result, dict) and result.get("resultType") == "input_required":
            for key, request in result.get("inputRequests", {}).items():
                # Restore only forms created by request_form_input.
                if key in schemas and request["method"] == "elicitation/create":
                    request["params"].setdefault("_meta", {})[OPENAI_ELICITATION_EXTENSION_ID] = {
                        "requestedSchema": schemas[key]
                    }
        return result
    finally:
        # Restore the previous request context, even after errors.
        request_schemas.reset(token)
