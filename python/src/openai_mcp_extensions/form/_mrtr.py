from __future__ import annotations

from contextvars import ContextVar
from typing import Any

from mcp.server.elicitation import ElicitationResult, ElicitSchemaModelT
from mcp.server.mcpserver.context import Context
from mcp_types import ElicitRequest, ElicitRequestFormParams, ElicitResult, InputRequiredResult
from mcp_types.version import MODERN_PROTOCOL_VERSIONS

from openai_mcp_extensions.form._elicitation import (
    OPENAI_ELICITATION_EXTENSION_ID,
    validate_form_result,
)
from openai_mcp_extensions.form._schema import render_form_schema

request_schemas: ContextVar[dict[str, dict[str, Any]] | None] = ContextVar(
    "openai_elicitation_schemas", default=None
)


def request_form_input(
    context: Context[Any, Any],
    *,
    key: str,
    message: str,
    schema: type[ElicitSchemaModelT],
    request_state: str | None = None,
) -> ElicitationResult[ElicitSchemaModelT] | InputRequiredResult:
    """Return a form request, or validate its answer when the client retries."""
    if context.protocol_version not in MODERN_PROTOCOL_VERSIONS:
        raise ValueError(
            "MRTR requires MCP 2026-07-28 or later; use elicit_input_legacy for older clients"
        )
    schemas = request_schemas.get()
    if schemas is None:
        raise RuntimeError(
            "Register OpenAIExtensions.middleware on MCPServer before requesting MRTR forms"
        )
    capabilities = context.client_capabilities
    settings = (
        (capabilities.extensions or {}).get(OPENAI_ELICITATION_EXTENSION_ID)
        if capabilities
        else None
    )
    form: dict[str, Any] | None = settings.get("form") if isinstance(settings, dict) else None
    if (
        capabilities is None
        or capabilities.elicitation is None
        or capabilities.elicitation.form is None
        or not isinstance(form, dict)
    ):
        raise ValueError("The MCP client does not support openai/elicitation form MRTR")
    requested_schema = render_form_schema(schema)
    response = context.input_responses.get(key) if context.input_responses is not None else None
    if response is not None:
        if not isinstance(response, ElicitResult):
            raise ValueError(f"Expected an elicitation response for {key!r}")
        return validate_form_result(response, schema, requested_schema)

    # Save the schema so middleware can restore metadata dropped by the SDK.
    schemas[key] = requested_schema
    return InputRequiredResult(
        input_requests={
            key: ElicitRequest(
                params=ElicitRequestFormParams(
                    message=message,
                    # The full OpenAI form schema goes in _meta.
                    requested_schema={"type": "object", "properties": {}},
                    _meta={OPENAI_ELICITATION_EXTENSION_ID: {"requestedSchema": requested_schema}},
                )
            )
        },
        request_state=request_state,
    )
