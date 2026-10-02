"""Exercise settings handler dispatch through the real MCP SDK."""

from __future__ import annotations

import asyncio
import threading
import unittest
from collections.abc import Awaitable
from typing import Any
from unittest.mock import patch

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.context import Context
from mcp.server.mcpserver.exceptions import UnexpectedToolError
from pydantic import BaseModel

from openai_mcp_extensions import OpenAISettings


class SettingsValues(BaseModel):
    enabled: bool


class SettingsHandlerTests(unittest.IsolatedAsyncioTestCase):
    async def test_sync_read_and_async_update_use_expected_threads(self) -> None:
        settings = OpenAISettings(schema=SettingsValues)
        loop = asyncio.get_running_loop()
        loop_thread = threading.get_ident()
        read_threads: list[int] = []
        updates: list[dict[str, Any]] = []

        @settings.read
        def read(ctx: Context[Any, Any]) -> SettingsValues:
            self.assertIs(ctx.mcp_server, server)
            read_threads.append(threading.get_ident())
            return SettingsValues(enabled=True)

        @settings.update
        async def update(supplied: dict[str, Any], ctx: Context[Any, Any]) -> SettingsValues:
            self.assertIs(ctx.mcp_server, server)
            self.assertIs(asyncio.get_running_loop(), loop)
            self.assertEqual(threading.get_ident(), loop_thread)
            updates.append(supplied)
            return SettingsValues(enabled=supplied["enabled"])

        server = MCPServer("settings", extensions=[settings])
        result = await server.call_tool("settings.read", {})
        self.assertEqual(len(read_threads), 1)
        self.assertNotEqual(read_threads[0], loop_thread)
        self.assertEqual(result.structured_content["values"], {"enabled": True})

        with patch(
            "anyio.to_thread.run_sync",
            side_effect=AssertionError("async handlers must not be offloaded"),
        ):
            result = await server.call_tool("settings.update", {"set": {"enabled": False}})
        self.assertEqual(updates, [{"enabled": False}])
        self.assertEqual(result.structured_content, {"values": {"enabled": False}})

    async def test_async_read_functions_and_callable_objects_stay_on_loop(self) -> None:
        loop = asyncio.get_running_loop()
        loop_thread = threading.get_ident()
        observations: list[tuple[asyncio.AbstractEventLoop, int]] = []

        async def read(ctx: Context[Any, Any]) -> SettingsValues:
            observations.append((asyncio.get_running_loop(), threading.get_ident()))
            return SettingsValues(enabled=True)

        class AsyncRead:
            async def __call__(self, ctx: Context[Any, Any]) -> SettingsValues:
                return await read(ctx)

        for handler in (read, AsyncRead()):
            with self.subTest(handler=type(handler).__name__):
                settings = OpenAISettings(schema=SettingsValues)
                settings.read(handler)

                @settings.update
                async def update(
                    supplied: dict[str, Any], ctx: Context[Any, Any]
                ) -> SettingsValues:
                    return SettingsValues(enabled=supplied["enabled"])

                server = MCPServer("settings", extensions=[settings])
                with patch(
                    "anyio.to_thread.run_sync",
                    side_effect=AssertionError("async handlers must not be offloaded"),
                ):
                    result = await server.call_tool("settings.read", {})
                self.assertEqual(result.structured_content["values"], {"enabled": True})
        self.assertEqual(observations, [(loop, loop_thread), (loop, loop_thread)])

    async def test_sync_update_returning_awaitable_is_awaited_on_loop(self) -> None:
        settings = OpenAISettings(schema=SettingsValues)
        loop = asyncio.get_running_loop()
        loop_thread = threading.get_ident()
        handler_threads: list[int] = []
        awaited_threads: list[int] = []

        @settings.read
        async def read(ctx: Context[Any, Any]) -> SettingsValues:
            return SettingsValues(enabled=True)

        async def finish(enabled: bool) -> SettingsValues:
            self.assertIs(asyncio.get_running_loop(), loop)
            awaited_threads.append(threading.get_ident())
            return SettingsValues(enabled=enabled)

        @settings.update
        def update(supplied: dict[str, Any], ctx: Context[Any, Any]) -> Awaitable[SettingsValues]:
            self.assertIs(ctx.mcp_server, server)
            handler_threads.append(threading.get_ident())
            return finish(supplied["enabled"])

        server = MCPServer("settings", extensions=[settings])
        result = await server.call_tool("settings.update", {"set": {"enabled": False}})
        self.assertEqual(len(handler_threads), 1)
        self.assertNotEqual(handler_threads[0], loop_thread)
        self.assertEqual(awaited_threads, [loop_thread])
        self.assertEqual(result.structured_content, {"values": {"enabled": False}})

    async def test_sync_exception_keeps_sdk_error_cause(self) -> None:
        settings = OpenAISettings(schema=SettingsValues)
        error = ValueError("read failed")

        @settings.read
        def read(ctx: Context[Any, Any]) -> SettingsValues:
            raise error

        @settings.update
        async def update(supplied: dict[str, Any], ctx: Context[Any, Any]) -> SettingsValues:
            return SettingsValues(enabled=supplied["enabled"])

        server = MCPServer("settings", extensions=[settings])
        with self.assertRaises(UnexpectedToolError) as raised:
            await server.call_tool("settings.read", {})
        self.assertIs(raised.exception.__cause__, error)


if __name__ == "__main__":
    unittest.main()
