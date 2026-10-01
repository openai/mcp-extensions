# OpenAI MCP Extensions for Python

The Python SDK provides server-side OpenAI extensions for the official MCP Python SDK. Use `@openai/mcp-extensions/app` for MCP App extensions.

## Installation

Install the Python extension SDK from PyPI.

```sh
uv add openai-mcp-extensions
```

## Server Setup

Initialize the MCP Apps and OpenAI extensions for use with an MCP Server.

```python
from mcp.server.apps import Apps
from mcp.server.mcpserver import MCPServer

from openai_mcp_extensions import OpenAIExtensions

apps = Apps()
openai_extensions = OpenAIExtensions()
```

Register extension handlers and resources before constructing `MCPServer`.

The following examples are separate configurations. Include each extension your server uses in its `extensions` list.

## [Structured Settings](../docs/spec.md#structured-settings)

```python
from typing import Any, Literal

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.context import Context
from pydantic import BaseModel, Field

from openai_mcp_extensions import (
    OpenAISettings,
    OpenAISettingsGroup,
    OpenAISettingsProperty,
)
from preferences import load_preferences, update_preferences


class Preferences(BaseModel):
    units: Literal["mm", "in"] = Field(title="Measurement units")
    show_grid: bool = Field(alias="showGrid", title="Show grid")


settings = OpenAISettings(
    schema=Preferences,
    # Optionally arrange fields into groups.
    # Omitted properties appear in an "Other settings" group below the listed groups.
    layout=[
        OpenAISettingsGroup(
            title="Display",
            items=[OpenAISettingsProperty(property="units"), OpenAISettingsProperty(property="showGrid")],
        ),
    ],
)


# Synchronous handlers run in a worker thread. Async handlers run on the event loop.
@settings.read
async def read_settings(context: Context[Any, Any]) -> Preferences:
    return await load_preferences(context)


# Synchronous handlers run in a worker thread. Async handlers run on the event loop.
@settings.update
async def update_settings(set: dict[str, Any], context: Context[Any, Any]) -> Preferences:
    return await update_preferences(set, context)


server = MCPServer(
    "viewer",
    extensions=[settings],
    # Only needed if your server does not support the 2026-07-28 spec and/or supports
    # the legacy initialize handshake.
    # https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#initialization
    middleware=[settings.advertise_legacy_capability],
)
```

## [UI Entrypoints](../docs/spec.md#mcp-app-entrypoints)

```python
from mcp.server.apps import APP_MIME_TYPE
from mcp.server.mcpserver.resources import TextResource
from mcp_types import Icon

from openai_mcp_extensions import (
    OpenAIFileEntrypoint,
    OpenAIGlobalEntrypoint,
    OpenAISettingsEntrypoint,
    OpenAIThreadEntrypoint,
    OpenAIUiQuickAction,
    OpenAIUiQuickActionToolTarget,
    OpenAIUiResourceMetadata,
    OpenAIUiToolMetadata,
)

apps.add_resource(
    TextResource(
        uri="ui://table/viewer",
        name="table",
        mime_type=APP_MIME_TYPE,
        text="<!doctype html><title>Table</title><main>Table viewer</main>",
        meta={
            "openai/ui": OpenAIUiResourceMetadata(
                preferred_display_mode="fullscreen",
                available_display_modes=["inline", "fullscreen"],
            ).model_dump(by_alias=True, exclude_none=True),
        },
    ),
)


@apps.tool(
    resource_uri="ui://table/viewer",
    meta={
        "openai/ui": OpenAIUiToolMetadata(
            entrypoints=[
                OpenAIGlobalEntrypoint(
                    quick_action=OpenAIUiQuickAction(
                        title="New table",
                        icons=[Icon(src="https://example.com/plus.svg")],
                        target=OpenAIUiQuickActionToolTarget(name="create_table", arguments={}),
                    ),
                ),
                OpenAIThreadEntrypoint(),
                OpenAIFileEntrypoint(extensions=[".csv", ".tsv"]),
            ],
        ).model_dump(by_alias=True, exclude_none=True),
    },
)
def open_table() -> str:
    return "Open the table viewer."


server = MCPServer("my-server", extensions=[apps, openai_extensions])
```

## [Filesystem Access](../docs/spec.md#filesystem-access)

```python
from typing import Any

from mcp.server.mcpserver.context import Context

from openai_mcp_extensions import get_resource_path


def opened_file_path(context: Context[Any, Any]) -> str | None:
    return get_resource_path(context.request_context.meta)
```

## [Composer Mentions](../docs/spec.md#composer-at-mentions)

Synchronous search handlers run in worker threads so blocking searches do not stall the server's event loop. Multiple searches can overlap, so shared state must be thread-safe. Use an async handler for resources tied to the event loop or to the thread that created them. Async handlers, including async callable objects, run on the event loop. If a synchronous handler returns an awaitable, it is awaited on the event loop as well. The synchronous call itself has no running event loop; use an async handler if it needs to create asyncio tasks or futures.

```python
from typing import Any

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.context import Context
from mcp_types import ResourceLink

from openai_mcp_extensions import (
    OpenAIExtensions,
    OpenAIMentionSearchParams,
    OpenAIMentionSearchResult,
)

openai_extensions = OpenAIExtensions()


@openai_extensions.mentions.search
async def search_mentions(
    params: OpenAIMentionSearchParams,
    context: Context[Any, Any],
) -> OpenAIMentionSearchResult:
    return OpenAIMentionSearchResult(
        items=[
            ResourceLink(
                uri=f"mcp://issues/{params.query}",
                name=params.query,
            ),
        ],
    )


server = MCPServer("issue-tracker", extensions=[openai_extensions])
```

## [Form Elicitation](../docs/spec.md#openai-form-elicitation)

**NOTE:** OpenAI-registered MCP servers require [MRTR for form elicitation](../docs/spec.md#openai-form-elicitation). Direct MCP connections still support legacy forms through `elicit_input`, which does not implement MRTR.

### Suggested Values

Users can enter values that are not listed. The same field constraints apply to suggested and entered values.

```python
from typing import Annotated

from pydantic import BaseModel, Field


class ReviewForm(BaseModel):
    purpose: str = Field(
        min_length=1,
        json_schema_extra={
            "x-openai-suggestions": [{"const": "prototype", "title": "Prototype"}],
        },
    )
    checks: list[
        Annotated[
            str,
            Field(
                min_length=1,
                json_schema_extra={
                    "x-openai-suggestions": [{"const": "clearance", "title": "Clearance"}],
                },
            ),
        ]
    ]
```

### Resource Selection

```python
from typing import Any

from mcp.server.elicitation import ElicitationResult
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.context import Context
from mcp_types import Resource
from pydantic import BaseModel, Field, FileUrl

from openai_mcp_extensions import OpenAIExtensions
from openai_mcp_extensions.form import UserResourceOptions, resource_input

openai_extensions = OpenAIExtensions()
server = MCPServer("presentations", extensions=[openai_extensions])


class PresentationForm(BaseModel):
    images: list[FileUrl] = Field(
        default_factory=list,
        max_length=5,
        json_schema_extra={
            **resource_input(
                options=[
                    Resource(
                        uri="file:///images/sales.png",
                        name="sales.png",
                        title="Sales image",
                        meta={
                            "openai/thumbnail": {"src": "https://example.com/sales.png"},
                            "openai/preview": {
                                "target": {
                                    "type": "resource_link",
                                    "uri": "file:///images/sales.png",
                                    "name": "sales.png",
                                    "mimeType": "image/png",
                                },
                            },
                        },
                    ),
                ],
                user_options=UserResourceOptions(accept=["image/*"]),
            ),
            "default": ["file:///images/sales.png"],
        },
    )


@server.tool()
async def choose_images(context: Context[Any, Any]) -> ElicitationResult[PresentationForm]:
    return await openai_extensions.elicit_input(
        context,
        mode="form",
        message="Choose reference images",
        schema=PresentationForm,
    )
```
