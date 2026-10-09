import pytest
from mcp_types import Icon
from pydantic import ValidationError

from openai_mcp_extensions import (
    OpenAIGlobalEntrypoint,
    OpenAIUiQuickAction,
    OpenAIUiQuickActionToolTarget,
    OpenAIUiToolMetadata,
)


def test_quick_action_serializes_the_shared_wire_contract() -> None:
    metadata = OpenAIUiToolMetadata(
        entrypoints=[
            OpenAIGlobalEntrypoint(
                quick_action=OpenAIUiQuickAction(
                    title="New issue",
                    icons=[Icon(src="https://example.com/plus.svg")],
                    target=OpenAIUiQuickActionToolTarget(
                        type="tool",
                        name="create_issue",
                        arguments={"labels": ["bug", "desktop"], "notify": False},
                    ),
                )
            )
        ]
    )

    wire = metadata.model_dump(mode="json", by_alias=True, exclude_none=True)
    assert wire == {
        "entrypoints": [
            {
                "type": "global",
                "quickAction": {
                    "title": "New issue",
                    "icons": [{"src": "https://example.com/plus.svg"}],
                    "target": {
                        "type": "tool",
                        "name": "create_issue",
                        "arguments": {"labels": ["bug", "desktop"], "notify": False},
                    },
                },
            }
        ]
    }
    assert OpenAIUiToolMetadata.model_validate(wire) == metadata
    assert OpenAIGlobalEntrypoint().model_dump(by_alias=True, exclude_none=True) == {
        "type": "global"
    }
    assert OpenAIUiQuickActionToolTarget(name="start_recording").model_dump(
        by_alias=True, exclude_none=True
    ) == {"type": "tool", "name": "start_recording"}


@pytest.mark.parametrize(
    "override",
    [
        {"title": " "},
        {"icons": []},
        {"target": {"type": "tool", "name": " "}},
        {"target": {"type": "tool"}},
        {"target": {"name": "create_issue"}},
        {"target": {"type": "url", "name": "create_issue"}},
        {"target": {"type": "tool", "name": "create_issue", "arguments": []}},
        {"deepLink": {"path": ["new"], "query": []}},
        {"target": "create_issue"},
    ],
)
def test_quick_action_rejects_invalid_wire_values(override: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        OpenAIUiQuickAction.model_validate(
            {
                "title": "New issue",
                "icons": [{"src": "https://example.com/plus.svg"}],
                "target": {"type": "tool", "name": "create_issue"},
                **override,
            }
        )


@pytest.mark.parametrize("entrypoint_type", ["settings", "thread", "file"])
def test_only_global_entrypoints_accept_quick_actions(entrypoint_type: str) -> None:
    with pytest.raises(ValidationError):
        OpenAIUiToolMetadata.model_validate(
            {
                "entrypoints": [
                    {
                        "type": entrypoint_type,
                        **({"extensions": [".frog"]} if entrypoint_type == "file" else {}),
                        "quickAction": {
                            "title": "New issue",
                            "icons": [{"src": "https://example.com/plus.svg"}],
                            "target": {"type": "tool", "name": "create_issue"},
                        },
                    }
                ]
            }
        )
