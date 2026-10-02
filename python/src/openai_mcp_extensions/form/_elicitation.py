"""OpenAI form elicitation with validated MCP responses."""

from __future__ import annotations

from typing import Any, Literal, cast

from mcp.server.elicitation import (
    AcceptedElicitation,
    CancelledElicitation,
    DeclinedElicitation,
    ElicitationResult,
    ElicitSchemaModelT,
)
from mcp.server.mcpserver.context import Context
from mcp.shared.message import ServerMessageMetadata
from mcp_types import ElicitRequestFormParams, ElicitResult, Request, ServerRequest
from pydantic import ValidationError

from openai_mcp_extensions.form._schema import render_form_schema
from openai_mcp_form_protocol import FormField, FormSchema, validate_form_selections

OPENAI_ELICITATION_EXTENSION_ID = "openai/elicitation"
OPENAI_ELICITATION_METHOD = "openai/elicitation/create"


class _OpenAIFormRequest(Request[ElicitRequestFormParams, Literal["openai/elicitation/create"]]):
    method: Literal["openai/elicitation/create"] = OPENAI_ELICITATION_METHOD


async def elicit_form(
    context: Context[Any, Any],
    *,
    message: str,
    schema: type[ElicitSchemaModelT],
) -> ElicitationResult[ElicitSchemaModelT]:
    """Request a form and return the validated Pydantic model."""

    capabilities = context.client_capabilities
    settings = (
        (capabilities.extensions or {}).get(OPENAI_ELICITATION_EXTENSION_ID)
        if capabilities
        else None
    )
    if not isinstance(settings, dict) or not isinstance(settings.get("form"), dict):
        raise ValueError(
            f"The MCP client does not support {OPENAI_ELICITATION_EXTENSION_ID} form requests"
        )

    requested_schema = render_form_schema(schema)
    request = _OpenAIFormRequest(
        params=ElicitRequestFormParams(
            message=message,
            requested_schema=requested_schema,
        ),
    )
    result = await context.session.send_request(
        cast(ServerRequest, request),
        ElicitResult,
        metadata=ServerMessageMetadata(
            related_request_id=context.request_context.request_id,
        ),
    )

    return validate_form_result(result, schema, requested_schema)


def validate_form_result(
    result: ElicitResult,
    schema: type[ElicitSchemaModelT],
    requested_schema: dict[str, Any],
) -> ElicitationResult[ElicitSchemaModelT]:
    if result.action == "accept":
        if result.content is None:
            raise ValueError("Received an accepted elicitation with no content")
        validate_form_selections(
            FormSchema[FormField].model_validate(requested_schema), result.content
        )
        try:
            validated_data = schema.model_validate(result.content)
        except ValidationError as error:
            raise ValueError(
                "Received an accepted elicitation whose content does not match the requested schema"
            ) from error
        return AcceptedElicitation(data=validated_data)
    if result.action == "decline":
        return DeclinedElicitation()
    return CancelledElicitation()
